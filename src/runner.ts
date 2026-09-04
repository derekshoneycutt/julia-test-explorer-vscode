import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DiscoveredTest } from './discovery';
import { HelperManager } from './helperManager';
import { normalizeOutput, runProcess } from './process';

/** One test-set result emitted by the Julia runner helper. */
export interface ReportTest {
  /** Absolute path to the executed Julia source file. */
  readonly file_path: string;
  /** Best-effort one-based runtime source line. */
  readonly line: number;
  /** Names from the outermost test set through this result. */
  readonly test_path: readonly string[];
  /** Aggregate state after reducing nested results. */
  readonly status: 'passed' | 'failed' | 'errored';
  /** Printable failure and error details. */
  readonly message: string;
  /** Elapsed test-set execution time in milliseconds. */
  readonly duration_ms: number;
}

/** Versioned Julia runner report. */
export interface TestReport {
  /** Result protocol version understood by this extension. */
  readonly version: 1;
  /** Completed test-set results. */
  readonly tests: readonly ReportTest[];
  /** Top-level source loading error, or an empty string. */
  readonly error: string;
}

/**
 * Runs selected Julia test sets and publishes their results.
 * @param controller Test controller that owns the items.
 * @param request Requested test inclusions and exclusions.
 * @param token Cancellation token.
 * @param metadata Discovered test metadata keyed by TestItem ID.
 * @param helper Julia helper manager.
 * @param storageUri Extension storage location.
 * @returns A promise completed after the test run ends.
 */
export async function runTests(
  controller: vscode.TestController,
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
  metadata: ReadonlyMap<string, DiscoveredTest>,
  helper: HelperManager,
  storageUri: vscode.Uri,
): Promise<void> {
  const run = controller.createTestRun(request);
  try {
    const tests = collectRequestedTests(controller, request, metadata);
    tests.forEach(({ item }) => run.enqueued(item));

    const groups = new Map<string, typeof tests>();
    for (const selectedTest of tests) {
      const group = groups.get(selectedTest.test.project_path) ?? [];
      group.push(selectedTest);
      groups.set(selectedTest.test.project_path, group);
    }
    for (const [projectPath, projectTests] of groups) {
      if (token.isCancellationRequested) {
        break;
      }
      projectTests.forEach(({ item }) => run.started(item));
      try {
        await runProject(run, token, projectPath, projectTests, helper, storageUri);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        projectTests.forEach(({ item }) => run.errored(item, new vscode.TestMessage(message)));
      }
    }
  } finally {
    run.end();
  }
}

/**
 * Validates and parses a Julia runner report.
 * @param text JSON report emitted by the Julia runner helper.
 * @returns Validated test report.
 */
export function parseTestReport(text: string): TestReport {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)
    || value.version !== 1
    || !Array.isArray(value.tests)
    || typeof value.error !== 'string') {
    throw new Error('Invalid Julia test report');
  }
  return { version: 1, tests: value.tests.map(parseReportTest), error: value.error };
}

/**
 * Collects leaf tests selected by a request.
 * @param controller Owning test controller.
 * @param request Requested selection.
 * @param metadata Leaf metadata map.
 * @returns Selected test items and metadata.
 */
function collectRequestedTests(
  controller: vscode.TestController,
  request: vscode.TestRunRequest,
  metadata: ReadonlyMap<string, DiscoveredTest>,
): Array<{ item: vscode.TestItem; test: DiscoveredTest }> {
  const selected: Array<{ item: vscode.TestItem; test: DiscoveredTest }> = [];
  const excluded = new Set(request.exclude?.map((item) => item.id));

  /**
   * Visits a selected tree node and records discovered leaves.
   * @param item Project, file, or test item to visit.
   * @returns Nothing.
   */
  const visit = (item: vscode.TestItem): void => {
    if (excluded.has(item.id)) {
      return;
    }
    const test = metadata.get(item.id);
    if (test) {
      selected.push({ item, test });
      return;
    }
    item.children.forEach(visit);
  };

  const roots = request.include ?? collectionToArray(controller.items);
  roots.forEach(visit);
  return selected;
}

/**
 * Runs selected files in one Julia environment and maps their structured results.
 * @param run Active VS Code run.
 * @param token Cancellation token.
 * @param projectPath Workspace or Julia environment directory.
 * @param tests Selected tests associated with the environment.
 * @param helper Helper that resolves Julia and the bundled runner.
 * @param storageUri Extension storage location.
 * @returns A promise completed after result publication.
 */
async function runProject(
  run: vscode.TestRun,
  token: vscode.CancellationToken,
  projectPath: string,
  tests: Array<{ item: vscode.TestItem; test: DiscoveredTest }>,
  helper: HelperManager,
  storageUri: vscode.Uri,
): Promise<void> {
  await fs.mkdir(storageUri.fsPath, { recursive: true });
  const reportName = `${createHash('sha256').update(projectPath).digest('hex')}.json`;
  const reportPath = path.join(storageUri.fsPath, reportName);
  await fs.rm(reportPath, { force: true });

  const configuration = vscode.workspace.getConfiguration('juliaTestExplorer');
  const extraArguments = configuration.get<string[]>('testArguments', []);
  const filePaths = [...new Set(tests.map(({ test }) => test.file_path))];
  const args = [
    '--startup-file=no',
    `--project=${projectPath}`,
    ...extraArguments,
    helper.getRunnerPath(),
    projectPath,
    reportPath,
    ...filePaths,
  ];
  const result = await runProcess(helper.getJuliaPath(), args, token, (text) => {
    run.appendOutput(normalizeOutput(text));
  });

  if (token.isCancellationRequested) {
    tests.forEach(({ item }) => run.skipped(item));
    await fs.rm(reportPath, { force: true });
    return;
  }

  try {
    const report = parseTestReport(await fs.readFile(reportPath, 'utf8'));
    const results = new Map<string, ReportTest[]>();
    for (const test of report.tests) {
      const key = reportKey(test.file_path, test.test_path);
      const matches = results.get(key) ?? [];
      matches.push(test);
      results.set(key, matches);
    }

    for (const { item, test } of tests) {
      const matches = results.get(reportKey(test.file_path, test.test_path)) ?? [];
      const testResult = worstResult(matches);
      if (!testResult) {
        const message = report.error || result.stderr.trim() || 'Julia did not execute this test set';
        run.errored(item, new vscode.TestMessage(message));
      } else if (testResult.status === 'passed') {
        run.passed(item, testResult.duration_ms);
      } else if (testResult.status === 'failed') {
        run.failed(item, new vscode.TestMessage(testResult.message || 'Julia test failed'), testResult.duration_ms);
      } else {
        run.errored(item, new vscode.TestMessage(testResult.message || 'Julia test errored'), testResult.duration_ms);
      }
    }
  } catch (error) {
    const message = result.stderr.trim()
      || (error instanceof Error ? error.message : String(error))
      || `Julia exited with code ${result.exitCode}`;
    tests.forEach(({ item }) => run.errored(item, new vscode.TestMessage(message)));
  } finally {
    await fs.rm(reportPath, { force: true });
  }
}

/**
 * Selects the most severe result when a generated test-set path repeats in one file.
 * @param results Matching runtime results.
 * @returns Highest-severity result (`errored`, then `failed`), or the first result.
 */
function worstResult(results: readonly ReportTest[]): ReportTest | undefined {
  return results.find((result) => result.status === 'errored')
    ?? results.find((result) => result.status === 'failed')
    ?? results[0];
}

/**
 * Creates the shared discovery/runtime result identity.
 * @param filePath Absolute test source path.
 * @param testPath Nested test-set names.
 * @returns Stable result key.
 */
function reportKey(filePath: string, testPath: readonly string[]): string {
  return JSON.stringify([path.resolve(filePath), testPath]);
}

/**
 * Validates one runtime test result.
 * @param value Candidate result.
 * @returns Validated runtime result.
 */
function parseReportTest(value: unknown): ReportTest {
  if (!isRecord(value)
    || typeof value.file_path !== 'string'
    || !Number.isInteger(value.line)
    || Number(value.line) < 1
    || !Array.isArray(value.test_path)
    || !value.test_path.every((part) => typeof part === 'string')
    || !isStatus(value.status)
    || typeof value.message !== 'string'
    || typeof value.duration_ms !== 'number'
    || !Number.isFinite(value.duration_ms)
    || value.duration_ms < 0) {
    throw new Error('Invalid test in Julia test report');
  }
  return value as unknown as ReportTest;
}

/**
 * Checks a Julia test status value.
 * @param value Candidate status.
 * @returns Whether the status is supported.
 */
function isStatus(value: unknown): value is ReportTest['status'] {
  return value === 'passed' || value === 'failed' || value === 'errored';
}

/**
 * Checks whether a value is a non-null object.
 * @param value Candidate value.
 * @returns Whether the value is a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Copies a VS Code test collection into an array.
 * @param collection Test item collection.
 * @returns Collection items.
 */
function collectionToArray(collection: vscode.TestItemCollection): vscode.TestItem[] {
  const items: vscode.TestItem[] = [];
  collection.forEach((item) => items.push(item));
  return items;
}