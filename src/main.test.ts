import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

import { parseJunitXml, buildMarkdown, extractLocation, run } from './main.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '..', 'test-fixtures');

test('parseJunitXml: reads passing suite', () => {
  const xml = fs.readFileSync(path.join(fixtures, 'passing.xml'), 'utf8');
  const cases = parseJunitXml(xml);
  assert.equal(cases.length, 3);
  assert.ok(cases.every((c) => c.status === 'passed'));
  assert.equal(cases[0]!.name, 'adds numbers');
  assert.equal(cases[0]!.time, 0.012);
});

test('parseJunitXml: captures failures with message and body', () => {
  const xml = fs.readFileSync(path.join(fixtures, 'failing.xml'), 'utf8');
  const cases = parseJunitXml(xml);
  assert.equal(cases.length, 4);
  const failed = cases.filter((c) => c.status === 'failed');
  assert.equal(failed.length, 2);
  assert.ok(failed[0]!.message?.includes('Expected'));
  assert.ok(failed[0]!.body?.includes('at '));
});

test('parseJunitXml: distinguishes failure, error and skipped', () => {
  const xml = fs.readFileSync(path.join(fixtures, 'mixed.xml'), 'utf8');
  const cases = parseJunitXml(xml);
  const counts = {
    passed: cases.filter((c) => c.status === 'passed').length,
    failed: cases.filter((c) => c.status === 'failed').length,
    errored: cases.filter((c) => c.status === 'errored').length,
    skipped: cases.filter((c) => c.status === 'skipped').length,
  };
  assert.deepEqual(counts, { passed: 1, failed: 1, errored: 1, skipped: 1 });
});

test('parseJunitXml: handles nested <testsuites>', () => {
  const xml = fs.readFileSync(path.join(fixtures, 'nested.xml'), 'utf8');
  const cases = parseJunitXml(xml);
  assert.equal(cases.length, 3);
  assert.equal(cases[0]!.classname, 'inner.SuiteA');
});

test('extractLocation: finds file/line in a node-style stack', () => {
  const loc = extractLocation(
    'AssertionError: boom\n    at Object.<anonymous> (src/util.ts:42:7)\n    at Module._compile',
  );
  assert.deepEqual(loc, { file: 'src/util.ts', line: 42 });
});

test('extractLocation: finds file/line in a jest-style stack', () => {
  const loc = extractLocation('Error: nope\n    at src/feature.test.ts:10:5');
  assert.deepEqual(loc, { file: 'src/feature.test.ts', line: 10 });
});

test('extractLocation: returns undefined when nothing matches', () => {
  assert.equal(extractLocation(''), undefined);
  assert.equal(extractLocation('just a plain message'), undefined);
});

test('buildMarkdown: summarizes mixed results with failure detail blocks', () => {
  const xml = fs.readFileSync(path.join(fixtures, 'mixed.xml'), 'utf8');
  const cases = parseJunitXml(xml);
  const md = buildMarkdown('Unit tests', [{ file: 'mixed.xml', cases }]);
  assert.match(md, /## Unit tests/);
  assert.match(md, /failed/);
  assert.match(md, /### Failures/);
  assert.match(md, /### All tests/);
  assert.match(md, /\|\s*:x:\s*\|/);
  assert.match(md, /\|\s*:fast_forward:\s*\|/);
});

test('run: end-to-end over fixtures produces summary, outputs, and annotations', async () => {
  const outputs: Record<string, string> = {};
  const logLines: string[] = [];
  const tmpSummary = path.join(os.tmpdir(), `junit-summary-${Date.now()}.md`);
  try {
    const result = await run({
      patterns: ['passing.xml', 'failing.xml'],
      title: 'Dogfood',
      failOnError: false,
      cwd: fixtures,
      summaryPath: tmpSummary,
      log: (l) => logLines.push(l),
      setOutput: (n, v) => {
        outputs[n] = String(v);
      },
    });
    assert.equal(result.files, 2);
    assert.equal(result.total, 7);
    assert.equal(result.passed, 5);
    assert.equal(result.failed, 2);
    assert.equal(outputs.failed, '2');
    const md = fs.readFileSync(tmpSummary, 'utf8');
    assert.match(md, /## Dogfood/);
    const annotations = logLines.filter((l) => l.startsWith('::error '));
    assert.equal(annotations.length, 2, 'one annotation per failure');
    assert.ok(annotations[0]!.includes('title='));
  } finally {
    fs.rmSync(tmpSummary, { force: true });
  }
});

test('run: fail-on-error triggers setFailed when there are failures', async () => {
  let failMsg: string | undefined;
  await run({
    patterns: ['failing.xml'],
    title: 't',
    failOnError: true,
    cwd: fixtures,
    log: () => {},
    setOutput: () => {},
    setFailed: (m) => {
      failMsg = m;
    },
  });
  assert.ok(failMsg && /failed/.test(failMsg));
});

test('run: emits a workflow warning when nothing matches', async () => {
  const lines: string[] = [];
  const result = await run({
    patterns: ['nothing-here-*.xml'],
    title: 't',
    failOnError: false,
    cwd: fixtures,
    log: (l) => lines.push(l),
    setOutput: () => {},
  });
  assert.equal(result.total, 0);
  assert.ok(lines.some((l) => l.startsWith('::warning::')));
});
