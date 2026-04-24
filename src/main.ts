import * as fs from "node:fs";
import * as path from "node:path";
import * as core from "@actions/core";
import fg from "fast-glob";
import { XMLParser } from "fast-xml-parser";

export interface TestCase {
	classname: string;
	name: string;
	time: number;
	status: "passed" | "failed" | "errored" | "skipped";
	message?: string;
	body?: string;
	file?: string;
	line?: number;
}

export interface ParsedReport {
	file: string;
	cases: TestCase[];
}

export interface RunOptions {
	patterns: string[];
	title: string;
	failOnError: boolean;
	cwd?: string;
	summaryPath?: string | null;
	log?: (line: string) => void;
	setOutput?: (name: string, value: string | number) => void;
	setFailed?: (message: string) => void;
}

export interface RunResult {
	total: number;
	passed: number;
	failed: number;
	skipped: number;
	files: number;
	markdown: string;
}

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "",
	textNodeName: "#text",
	parseAttributeValue: false,
	trimValues: true,
	isArray: (name) =>
		["testsuite", "testcase", "failure", "error", "skipped"].includes(name),
});

export function parseJunitXml(xml: string): TestCase[] {
	const doc = parser.parse(xml) as Record<string, unknown>;
	const suites = collectSuites(doc);
	const cases: TestCase[] = [];
	for (const suite of suites) {
		const tcs = (suite.testcase ?? []) as Record<string, unknown>[];
		for (const tc of tcs) {
			cases.push(toTestCase(tc, String(suite.name ?? "")));
		}
	}
	return cases;
}

function collectSuites(
	doc: Record<string, unknown>,
): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	const visit = (node: unknown): void => {
		if (!node || typeof node !== "object") return;
		const obj = node as Record<string, unknown>;
		if (Array.isArray(obj.testsuite)) {
			for (const s of obj.testsuite) {
				out.push(s as Record<string, unknown>);
				visit(s);
			}
		}
	};
	// testsuites root, testsuite root, or an already-wrapped document
	visit(doc);
	if (doc.testsuites) visit(doc.testsuites);
	// A lone top-level <testsuite> with no <testsuites> wrapper
	if (out.length === 0 && doc.testsuite) {
		const ts = doc.testsuite;
		if (Array.isArray(ts)) out.push(...(ts as Record<string, unknown>[]));
	}
	return out;
}

function toTestCase(tc: Record<string, unknown>, suiteName: string): TestCase {
	const failures = tc.failure as Record<string, unknown>[] | undefined;
	const errors = tc.error as Record<string, unknown>[] | undefined;
	const skipped = tc.skipped as Record<string, unknown>[] | undefined;
	let status: TestCase["status"] = "passed";
	let message: string | undefined;
	let body: string | undefined;
	if (failures && failures.length > 0) {
		status = "failed";
		({ message, body } = extractDetail(failures[0]!));
	} else if (errors && errors.length > 0) {
		status = "errored";
		({ message, body } = extractDetail(errors[0]!));
	} else if (skipped && skipped.length > 0) {
		status = "skipped";
		({ message, body } = extractDetail(skipped[0]!));
	}
	const classname = String(tc.classname ?? suiteName ?? "");
	const name = String(tc.name ?? "");
	const time = Number(tc.time ?? 0) || 0;
	const location = extractLocation(body);
	const fileAttr = typeof tc.file === "string" ? tc.file : undefined;
	const lineAttr = tc.line != null ? Number(tc.line) : undefined;
	return {
		classname,
		name,
		time,
		status,
		message,
		body,
		file: fileAttr ?? location?.file,
		line: lineAttr ?? location?.line,
	};
}

function extractDetail(node: Record<string, unknown>): {
	message?: string;
	body?: string;
} {
	const message = typeof node.message === "string" ? node.message : undefined;
	const text = typeof node["#text"] === "string" ? node["#text"] : undefined;
	const body = text ?? message;
	return { message, body };
}

/**
 * Pull a `file:line` hint out of a stack-trace-ish body.
 * Works for node-style `(path/to/file.ts:12:34)` and jest-style `at path/to/file.ts:12:34`.
 */
export function extractLocation(
	body: string | undefined,
): { file: string; line: number } | undefined {
	if (!body) return undefined;
	const patterns = [
		/\(([^():\s]+):(\d+):\d+\)/, // (file:line:col)
		/\bat\s+(?:.*?\s)?([^():\s]+):(\d+):\d+/, // at file:line:col
		/\s([^():\s]+\.[a-zA-Z]+):(\d+):\d+/, // whitespace-separated file:line:col
	];
	for (const re of patterns) {
		const m = body.match(re);
		if (m && m[1] && m[2]) {
			const file = m[1].replace(/^\.\//, "");
			const line = Number(m[2]);
			if (Number.isFinite(line)) return { file, line };
		}
	}
	return undefined;
}

export function buildMarkdown(title: string, reports: ParsedReport[]): string {
	const all = reports.flatMap((r) => r.cases);
	const total = all.length;
	const passed = all.filter((c) => c.status === "passed").length;
	const failed = all.filter(
		(c) => c.status === "failed" || c.status === "errored",
	).length;
	const skipped = all.filter((c) => c.status === "skipped").length;
	const totalTime = all.reduce((s, c) => s + c.time, 0);

	const headline =
		failed === 0
			? `**All ${total} tests passed** in ${totalTime.toFixed(2)}s`
			: `**${passed}/${total} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}** in ${totalTime.toFixed(2)}s`;

	const lines: string[] = [`## ${title}`, headline, ""];

	const failing = all.filter(
		(c) => c.status === "failed" || c.status === "errored",
	);
	if (failing.length > 0) {
		lines.push("### Failures", "");
		for (const c of failing) {
			const where = c.file
				? ` — \`${c.file}${c.line ? `:${c.line}` : ""}\``
				: "";
			lines.push(
				`<details><summary>❌ <code>${escapeHtml(c.classname || c.name)}</code> › ${escapeHtml(c.name)}${where}</summary>`,
			);
			lines.push("");
			lines.push("```");
			lines.push((c.body ?? c.message ?? "").slice(0, 4000));
			lines.push("```");
			lines.push("</details>", "");
		}
	}

	lines.push("### All tests", "");
	lines.push("| Status | Test | Time |");
	lines.push("|--------|------|------|");
	for (const c of all) {
		const icon = statusIcon(c.status);
		const name = c.classname ? `${c.classname} › ${c.name}` : c.name;
		lines.push(`| ${icon} | ${escapeMd(name)} | ${c.time.toFixed(3)}s |`);
	}
	return lines.join("\n") + "\n";
}

function statusIcon(s: TestCase["status"]): string {
	switch (s) {
		case "passed":
			return ":white_check_mark:";
		case "skipped":
			return ":fast_forward:";
		case "errored":
		case "failed":
			return ":x:";
	}
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeMd(s: string): string {
	return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export async function run(opts: RunOptions): Promise<RunResult> {
	const cwd = opts.cwd ?? process.cwd();
	const log = opts.log ?? ((l) => console.log(l));
	const setOutput = opts.setOutput ?? (() => {});
	const setFailed = opts.setFailed ?? (() => {});

	const files = await resolvePatterns(opts.patterns, cwd);
	if (files.length === 0) {
		log(`::warning::No JUnit XML files matched: ${opts.patterns.join(", ")}`);
		const empty: RunResult = {
			total: 0,
			passed: 0,
			failed: 0,
			skipped: 0,
			files: 0,
			markdown: "",
		};
		setOutput("total", 0);
		setOutput("passed", 0);
		setOutput("failed", 0);
		setOutput("skipped", 0);
		return empty;
	}

	const reports: ParsedReport[] = [];
	for (const file of files) {
		const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
		const xml = fs.readFileSync(abs, "utf8");
		try {
			const cases = parseJunitXml(xml);
			reports.push({ file, cases });
		} catch (err) {
			log(
				`::error title=JUnit parse error::Failed to parse ${file}: ${(err as Error).message}`,
			);
		}
	}

	const all = reports.flatMap((r) => r.cases);
	for (const c of all) {
		if (c.status === "failed" || c.status === "errored") {
			emitAnnotation(log, c);
		}
	}

	const markdown = buildMarkdown(opts.title, reports);
	if (opts.summaryPath) {
		fs.appendFileSync(opts.summaryPath, markdown);
	}

	const total = all.length;
	const passed = all.filter((c) => c.status === "passed").length;
	const failed = all.filter(
		(c) => c.status === "failed" || c.status === "errored",
	).length;
	const skipped = all.filter((c) => c.status === "skipped").length;
	setOutput("total", total);
	setOutput("passed", passed);
	setOutput("failed", failed);
	setOutput("skipped", skipped);

	if (opts.failOnError && failed > 0) {
		setFailed(`${failed} test${failed === 1 ? "" : "s"} failed`);
	}

	return { total, passed, failed, skipped, files: files.length, markdown };
}

async function resolvePatterns(
	patterns: string[],
	cwd: string,
): Promise<string[]> {
	const expanded: string[] = [];
	for (const p of patterns) {
		const raw = p.trim();
		if (!raw) continue;
		// Accept comma-separated for convenience.
		const parts = raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		for (const part of parts) {
			const abs = path.isAbsolute(part) ? part : path.resolve(cwd, part);
			if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
				const found = await fg("**/*.xml", {
					cwd: abs,
					onlyFiles: true,
					absolute: false,
				});
				for (const f of found)
					expanded.push(path.relative(cwd, path.join(abs, f)));
			} else if (fs.existsSync(abs)) {
				expanded.push(path.relative(cwd, abs));
			} else {
				const found = await fg(part, { cwd, onlyFiles: true, absolute: false });
				expanded.push(...found);
			}
		}
	}
	return [...new Set(expanded)];
}

function emitAnnotation(log: (l: string) => void, c: TestCase): void {
	const firstLine = (c.message ?? c.body ?? "").split("\n")[0]?.trim() ?? "";
	const msg =
		firstLine.substring(0, 500) ||
		`${c.status === "errored" ? "Error" : "Failure"} in ${c.name}`;
	const fields: string[] = [];
	if (c.file) fields.push(`file=${c.file}`);
	if (c.line) fields.push(`line=${c.line}`);
	const title = `${c.classname ? `${c.classname} › ` : ""}${c.name}`;
	fields.push(`title=${escapeAnnotation(title)}`);
	log(`::error ${fields.join(",")}::${escapeAnnotation(msg)}`);
}

function escapeAnnotation(s: string): string {
	// GitHub workflow commands need these escaped per docs.
	return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export async function runAsAction(): Promise<void> {
	const rawPath = core.getInput("path") || "**/junit*.xml";
	const patterns = rawPath
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter(Boolean);
	const title = core.getInput("title") || "Test Results";
	const failOnError = core.getBooleanInput("fail-on-error");
	core.info(`junit-summary: scanning ${patterns.join(", ")}`);
	try {
		const result = await run({
			patterns,
			title,
			failOnError,
			summaryPath: process.env.GITHUB_STEP_SUMMARY || null,
			log: (l) => process.stdout.write(l + "\n"),
			setOutput: (name, value) => core.setOutput(name, String(value)),
			setFailed: (msg) => core.setFailed(msg),
		});
		core.info(
			`junit-summary: ${result.passed}/${result.total} passed, ${result.failed} failed, ${result.skipped} skipped across ${result.files} file(s)`,
		);
	} catch (err) {
		core.setFailed(
			`junit-summary crashed: ${(err as Error).stack ?? (err as Error).message}`,
		);
	}
}
