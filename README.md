# JUnit Summary

A GitHub Action that turns one or more JUnit XML files into:

- A rich **markdown job summary** (failures expanded with stack traces, a table of every test case).
- Per-failure **error annotations** that land on the right file + line in the PR diff view.
- Step **outputs** (`total`, `passed`, `failed`, `skipped`) so downstream steps can branch on the result.

It's designed to be fast, zero-config for most jest/vitest/pytest/go/rspec JUnit reports, and small enough to read in one sitting.

## Usage

```yaml
- name: Run tests
  run: pnpm test -- --reporters=jest-junit
  continue-on-error: true

- name: Publish JUnit summary
  if: always()
  uses: flipdishbytes/github-actions-junit-summary@v1
  with:
    path: '**/junit*.xml'
    title: 'Unit tests'
    fail-on-error: 'true'
```

## Inputs

| Name            | Default           | Description |
|-----------------|-------------------|-------------|
| `path`          | `**/junit*.xml`   | File, directory, or glob. Newline-separated for multiple patterns. Directories are walked recursively for `*.xml`. |
| `title`         | `Test Results`    | Heading shown at the top of the markdown summary. |
| `fail-on-error` | `false`           | If `true`, the action exits with failure when any test failed or errored. |

## Outputs

| Name      | Description                                        |
|-----------|----------------------------------------------------|
| `total`   | Total number of test cases discovered.             |
| `passed`  | Number of passing tests.                           |
| `failed`  | Number of failures + errors.                       |
| `skipped` | Number of skipped tests.                           |

## Supported XML shapes

- `<testsuites><testsuite><testcase/>…` (jest-junit, vitest, mocha, pytest, gotestsum, rspec)
- A lone `<testsuite>` root (some older tools)
- Arbitrary nesting of `<testsuite>` elements
- `<testcase>` children: `<failure>`, `<error>`, `<skipped>`
- File/line hints are pulled from the stack trace body when present; if the runner sets `file=` / `line=` attributes on the `<testcase>`, those win.

## Development

```bash
pnpm install
pnpm test        # Node's built-in test runner
pnpm typecheck
pnpm build       # bundles dist/index.js via esbuild
pnpm check       # all three, the same thing CI runs
```

The source is one small module — [`src/main.ts`](src/main.ts). Tests live next to it in [`src/main.test.ts`](src/main.test.ts) and run against the fixtures in [`test-fixtures/`](test-fixtures/). When the action fails at runtime, the full stack is surfaced via `core.setFailed`, so the GHA log is usually enough to debug it.

The bundled entry point at `dist/index.js` is committed to the repo because GitHub Actions needs to run it directly. CI verifies that `dist/` matches the build output — if it doesn't, you forgot `pnpm build`.

## License

[MIT](LICENSE)
