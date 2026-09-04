import * as assert from 'node:assert';
import { createTestId, findDiscoveryTargets, parseDiscoveryResponse } from '../discovery';
import { resolveJuliaPath } from '../helperManager';
import { normalizeOutput } from '../process';
import { parseTestReport } from '../runner';

/** Exercises pure extension boundaries without starting a Julia process. */
suite('Julia Test Explorer', () => {
  /** Verifies discovery sees tests outside a conventional test directory. */
  test('finds Julia test files in this workspace', async () => {
    const targets = await findDiscoveryTargets();
    const filePaths = targets.flatMap((target) => target.filePaths);
    assert.ok(filePaths.some((filePath) => filePath.endsWith('/helper/discovery_test.jl')));
    assert.ok(filePaths.some((filePath) => filePath.endsWith('/helper/runner_test.jl')));
  });

  /** Verifies GUI hosts can locate Juliaup when Julia is absent from PATH. */
  test('resolves a Juliaup executable outside PATH', () => {
    const resolved = resolveJuliaPath('julia', '', '/usr/bin', process.env.HOME ?? '');
    assert.strictEqual(resolved, `${process.env.HOME}/.juliaup/bin/julia`);
  });

  /** Verifies the supported discovery protocol is accepted. */
  test('parses a valid discovery response', () => {
    const response = parseDiscoveryResponse(JSON.stringify({
      version: 1,
      tests: [{
        project_path: '/workspace/sample',
        name: 'arithmetic',
        test_path: ['math', 'arithmetic'],
        file_path: '/workspace/sample/test/runtests.jl',
        start: { line: 5, column: 3 },
        end: { line: 5, column: 11 },
      }],
    }));
    assert.strictEqual(response.tests[0].name, 'arithmetic');
  });

  /** Verifies incompatible discovery versions fail explicitly. */
  test('rejects an unsupported discovery response', () => {
    assert.throws(
      () => parseDiscoveryResponse('{"version":2,"tests":[]}'),
      /Unsupported Julia discovery response/,
    );
  });

  /** Verifies structured runtime reports are validated. */
  test('parses a valid test report', () => {
    const report = parseTestReport(JSON.stringify({
      version: 1,
      tests: [{
        file_path: '/workspace/sample/test/runtests.jl',
        line: 5,
        test_path: ['arithmetic'],
        status: 'passed',
        message: '',
        duration_ms: 1.5,
      }],
      error: '',
    }));
    assert.strictEqual(report.tests[0].status, 'passed');
  });

  /** Verifies ID components cannot collide with separators. */
  test('creates unambiguous stable IDs', () => {
    assert.strictEqual(
      createTestId('test', '/workspace/test.jl', '5', 'math:arithmetic'),
      'test:%2Fworkspace%2Ftest.jl:5:math%3Aarithmetic',
    );
  });

  /** Verifies streamed output uses VS Code's expected terminal line endings. */
  test('normalizes output to CRLF', () => {
    assert.strictEqual(normalizeOutput('one\ntwo\r\n'), 'one\r\ntwo\r\n');
  });
});