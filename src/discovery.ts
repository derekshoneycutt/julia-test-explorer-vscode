import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** A one-based Julia source location. */
export interface SourcePosition {
  readonly line: number;
  readonly column: number;
}

/** A statically discovered named Julia test set. */
export interface DiscoveredTest {
  readonly project_path: string;
  readonly name: string;
  readonly test_path: readonly string[];
  readonly file_path: string;
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

/** Versioned response returned by the Julia discovery helper. */
export interface DiscoveryResponse {
  readonly version: 1;
  readonly tests: readonly DiscoveredTest[];
}

/** Julia files grouped under their nearest package environment or workspace root. */
export interface DiscoveryTarget {
  readonly projectPath: string;
  readonly filePaths: readonly string[];
  readonly suites: readonly TestSuite[];
}

/** User-defined Julia test suite with explicit execution ownership. */
export interface TestSuiteConfiguration {
  readonly name: string;
  readonly entrypoint: string;
  readonly project: string;
  readonly cwd?: string;
}

/** A Julia test suite executed through one conventional entrypoint. */
export interface TestSuite {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly entrypointPath: string;
  readonly projectPath: string;
  readonly workingDirectory: string;
}

/** Resolves configured suite paths relative to their containing workspace. */
export function resolveConfiguredSuites(
  workspacePath: string,
  configurations: readonly TestSuiteConfiguration[],
): TestSuite[] {
  return configurations.map((configuration) => {
    if (!configuration.name || !configuration.entrypoint || !configuration.project) {
      throw new Error('Each juliaTestExplorer.testSuites entry requires name, entrypoint, and project');
    }
    const entrypointPath = resolveWorkspacePath(workspacePath, configuration.entrypoint);
    return {
      id: createTestId('suite', entrypointPath),
      name: configuration.name,
      rootPath: path.dirname(entrypointPath),
      entrypointPath,
      projectPath: resolveWorkspacePath(workspacePath, configuration.project),
      workingDirectory: resolveWorkspacePath(workspacePath, configuration.cwd ?? configuration.project),
    };
  });
}

/** A discovered test paired with its execution boundary. */
export interface RunnableTest extends DiscoveredTest {
  readonly suite: TestSuite | undefined;
  readonly executionPath: string;
  readonly workingDirectory: string;
}

/**
 * Validates and parses a discovery-helper response.
 * @param text Helper stdout.
 * @returns The validated response.
 */
export function parseDiscoveryResponse(text: string): DiscoveryResponse {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.tests)) {
    throw new Error('Unsupported Julia discovery response');
  }
  return { version: 1, tests: value.tests.map(parseDiscoveredTest) };
}

/**
 * Finds non-excluded Julia files and groups them by environment or workspace root.
 * @returns Discovery targets with explicit source paths.
 */
export async function findDiscoveryTargets(): Promise<DiscoveryTarget[]> {
  const groups = new Map<string, { filePaths: string[]; suites: TestSuite[] }>();
  for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
    const configuration = vscode.workspace.getConfiguration(
      'juliaTestExplorer', workspaceFolder.uri);
    const exclude = configuration.get<string>(
      'exclude', '**/{.git,node_modules,out,dist}/**');
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceFolder, '**/*.jl'), exclude);
    const suites = resolveConfiguredSuites(
      workspaceFolder.uri.fsPath,
      configuration.get<TestSuiteConfiguration[]>('testSuites', []),
    );
    for (const file of files) {
      if (vscode.workspace.getWorkspaceFolder(file)?.uri.fsPath !== workspaceFolder.uri.fsPath) {
        continue;
      }
      const configuredSuite = suites
        .filter((suite) => isWithin(file.fsPath, suite.rootPath))
        .sort((left, right) => right.rootPath.length - left.rootPath.length)[0];
      const projectPath = configuredSuite?.projectPath
        ?? await findNearestProjectPath(file.fsPath, workspaceFolder.uri.fsPath);
      const group = groups.get(projectPath) ?? { filePaths: [], suites: [] };
      group.filePaths.push(file.fsPath);
      for (const suite of suites.filter((candidate) => candidate.projectPath === projectPath)) {
        if (!group.suites.some((candidate) => candidate.id === suite.id)) {
          group.suites.push(suite);
        }
      }
      groups.set(projectPath, group);
    }
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([projectPath, group]) => ({
      projectPath,
      filePaths: group.filePaths.sort(),
      suites: group.suites,
    }));
}

/**
 * Resolves conventional suites and assigns each test to its nearest containing suite.
 * @param projectPath Julia environment associated with the discovered files.
 * @param filePaths Julia files considered during discovery.
 * @param tests Statically discovered tests in the environment.
 * @returns Tests enriched with suite-aware execution metadata.
 */
export function resolveRunnableTests(
  projectPath: string,
  filePaths: readonly string[],
  tests: readonly DiscoveredTest[],
  configuredSuites: readonly TestSuite[] = [],
): RunnableTest[] {
  const conventionalSuites = filePaths
    .filter((filePath) => path.basename(filePath) === 'runtests.jl'
      && path.basename(path.dirname(filePath)) === 'test')
    .filter((entrypointPath) => !configuredSuites.some((suite) => (
      path.resolve(suite.entrypointPath) === path.resolve(entrypointPath)
    )))
    .map((entrypointPath): TestSuite => {
      const normalizedEntrypoint = path.resolve(entrypointPath);
      const rootPath = path.dirname(normalizedEntrypoint);
      return {
        id: createTestId('suite', normalizedEntrypoint),
        name: path.relative(projectPath, rootPath) || path.basename(rootPath),
        rootPath,
        entrypointPath: normalizedEntrypoint,
        projectPath: path.resolve(projectPath),
        workingDirectory: path.resolve(projectPath),
      };
    })
    .sort((left, right) => right.rootPath.length - left.rootPath.length);
  const suites = [...configuredSuites, ...conventionalSuites]
    .sort((left, right) => right.rootPath.length - left.rootPath.length);

  return tests.map((test) => {
    const filePath = path.resolve(test.file_path);
    const suite = suites.find((candidate) => isWithin(filePath, candidate.rootPath));
    return {
      ...test,
      suite,
      executionPath: suite?.entrypointPath ?? filePath,
      workingDirectory: suite?.workingDirectory ?? path.resolve(projectPath),
    };
  });
}

/** Resolves an absolute or workspace-relative configured path. */
function resolveWorkspacePath(workspacePath: string, configuredPath: string): string {
  return path.isAbsolute(configuredPath)
    ? path.normalize(configuredPath)
    : path.resolve(workspacePath, configuredPath);
}

/**
 * Finds the nearest Project.toml without requiring one to exist.
 * @param filePath Julia source path.
 * @param workspacePath Workspace root where the upward search stops.
 * @returns Nearest Julia project directory or the workspace folder.
 */
async function findNearestProjectPath(filePath: string, workspacePath: string): Promise<string> {
  let directory = path.dirname(filePath);
  while (isWithin(directory, workspacePath)) {
    const hasProject = await fs.access(path.join(directory, 'Project.toml')).then(() => true, () => false);
    if (hasProject) {
      return directory;
    }
    if (directory === workspacePath) {
      break;
    }
    directory = path.dirname(directory);
  }
  return workspacePath;
}

/**
 * Checks whether a path is contained by a workspace folder.
 * @param candidate Candidate directory.
 * @param parent Workspace directory.
 * @returns Whether the candidate is within the parent.
 */
function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Creates a stable identifier for a project, file, or test.
 * @param kind Test tree level represented by the ID.
 * @param parts Identity components encoded to prevent delimiter collisions.
 * @returns Stable item identifier.
 */
export function createTestId(kind: 'project' | 'suite' | 'file' | 'test', ...parts: string[]): string {
  return `${kind}:${parts.map(encodeURIComponent).join(':')}`;
}

/**
 * Converts an unknown value to a discovered test.
 * @param value Candidate object.
 * @returns Validated discovered test.
 */
function parseDiscoveredTest(value: unknown): DiscoveredTest {
  if (!isRecord(value)
    || !isString(value.project_path)
    || !isString(value.name)
    || !isStringArray(value.test_path)
    || !isString(value.file_path)
    || !isPosition(value.start)
    || !isPosition(value.end)) {
    throw new Error('Invalid test in Julia discovery response');
  }
  return value as unknown as DiscoveredTest;
}

/**
 * Checks whether a value is a source position.
 * @param value Candidate value.
 * @returns Whether the value is valid.
 */
function isPosition(value: unknown): value is SourcePosition {
  return isRecord(value)
    && Number.isInteger(value.line)
    && Number.isInteger(value.column)
    && Number(value.line) > 0
    && Number(value.column) > 0;
}

/**
 * Checks whether a value is an array of strings.
 * @param value Candidate value.
 * @returns Whether the value is valid.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
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
 * Checks whether a value is a string.
 * @param value Candidate value.
 * @returns Whether the value is a string.
 */
function isString(value: unknown): value is string {
  return typeof value === 'string';
}