import * as assert from 'node:assert';
import {
  createTestId,
  DiscoveredTest,
  findDiscoveryTargets,
  parseDiscoveryResponse,
  resolveConfiguredSuites,
  resolveRunnableTests,
} from '../discovery';
import { resolveJuliaPath } from '../helperManager';
import { normalizeOutput } from '../process';
import { matchesReportTest, parseTestReport, ReportTest } from '../runner';

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

  /** Verifies conventional suites own only tests beneath their nearest test root. */
  test('resolves multiple conventional test suites', () => {
    const projectPath = '/workspace/sample';
    const discovered = (filePath: string, name: string): DiscoveredTest => ({
      project_path: projectPath,
      name,
      test_path: [name],
      file_path: filePath,
      start: { line: 1, column: 1 },
      end: { line: 1, column: 9 },
    });
    const tests = [
      discovered('/workspace/sample/tools/test/tool_test.jl', 'tooling'),
      discovered('/workspace/sample/src/julia/test/app_test.jl', 'application'),
      discovered('/workspace/sample/tools/analysis/test/engine_test.jl', 'analysis'),
      discovered('/workspace/sample/standalone.jl', 'standalone'),
    ];
    const runnable = resolveRunnableTests(projectPath, [
      '/workspace/sample/tools/test/runtests.jl',
      '/workspace/sample/src/julia/test/runtests.jl',
      '/workspace/sample/tools/analysis/test/runtests.jl',
    ], tests);

    assert.strictEqual(runnable[0].suite?.name, 'tools/test');
    assert.strictEqual(runnable[1].suite?.name, 'src/julia/test');
    assert.strictEqual(runnable[2].suite?.name, 'tools/analysis/test');
    assert.strictEqual(runnable[3].suite, undefined);
    assert.strictEqual(runnable[3].executionPath, '/workspace/sample/standalone.jl');
  });

  /** Verifies a repository tooling suite can use a sibling Julia project. */
  test('resolves configured suite project and working directory', () => {
    const [suite] = resolveConfiguredSuites('/workspace/euclid', [{
      name: 'Tooling',
      entrypoint: 'tools/test/runtests.jl',
      project: 'tools/analysis',
      cwd: '.',
    }]);
    const [test] = resolveRunnableTests('/workspace/euclid/tools/analysis', [
      '/workspace/euclid/tools/test/runtests.jl',
    ], [{
      project_path: '/workspace/euclid/tools/analysis',
      name: 'tooling',
      test_path: ['Euclid tooling'],
      file_path: '/workspace/euclid/tools/test/runtests.jl',
      start: { line: 19, column: 1 },
      end: { line: 19, column: 15 },
    }], [suite]);

    assert.strictEqual(test.suite?.name, 'Tooling');
    assert.strictEqual(test.project_path, '/workspace/euclid/tools/analysis');
    assert.strictEqual(test.executionPath, '/workspace/euclid/tools/test/runtests.jl');
    assert.strictEqual(test.workingDirectory, '/workspace/euclid');
  });

  /** Verifies identical relative suite settings remain workspace-local. */
  test('isolates configured suites between workspace folders', () => {
    const [euclid] = resolveConfiguredSuites('/workspace/euclid', [{
      name: 'Application',
      entrypoint: 'src/julia/test/runtests.jl',
      project: 'src/julia',
    }]);
    const [other] = resolveConfiguredSuites('/workspace/other', [{
      name: 'Application',
      entrypoint: 'src/julia/test/runtests.jl',
      project: 'src/julia',
    }]);

    assert.strictEqual(euclid.projectPath, '/workspace/euclid/src/julia');
    assert.strictEqual(other.projectPath, '/workspace/other/src/julia');
    assert.notStrictEqual(euclid.id, other.id);
  });

  /** Verifies outer suite test sets do not change a discovered test's identity. */
  test('matches runtime test paths beneath entrypoint wrappers', () => {
    const [test] = resolveRunnableTests('/workspace/sample', [
      '/workspace/sample/test/runtests.jl',
    ], [{
      project_path: '/workspace/sample',
      name: 'arithmetic',
      test_path: ['math', 'arithmetic'],
      file_path: '/workspace/sample/test/arithmetic.jl',
      start: { line: 2, column: 1 },
      end: { line: 2, column: 9 },
    }]);
    const runtime: ReportTest = {
      file_path: '/workspace/sample/test/arithmetic.jl',
      line: 2,
      test_path: ['package', 'math', 'arithmetic'],
      status: 'passed',
      message: '',
      duration_ms: 1,
    };

    assert.ok(matchesReportTest(test, runtime));
    assert.ok(!matchesReportTest(test, { ...runtime, file_path: '/workspace/sample/test/other.jl' }));
    assert.ok(!matchesReportTest(test, { ...runtime, test_path: ['package', 'arithmetic'] }));
  });

  /** Verifies streamed output uses VS Code's expected terminal line endings. */
  test('normalizes output to CRLF', () => {
    assert.strictEqual(normalizeOutput('one\ntwo\r\n'), 'one\r\ntwo\r\n');
  });
});