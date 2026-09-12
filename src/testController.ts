import * as path from 'node:path';
import * as vscode from 'vscode';
import { createTestId, findDiscoveryTargets, resolveRunnableTests, RunnableTest } from './discovery';
import { HelperManager } from './helperManager';
import { runTests } from './runner';

/** Owns Julia test discovery, the VS Code test tree, and the run profile. */
export class JuliaTestController implements vscode.Disposable {
  private readonly controller = vscode.tests.createTestController('juliaTestExplorer', 'Julia Tests');
  private readonly metadata = new Map<string, RunnableTest>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshPromise: Promise<void> | undefined;

  /**
   * Creates and registers the Julia test controller.
   * @param context Extension lifecycle and storage context.
  * @param helper Helper used for Julia discovery and execution paths.
  * @param output Output channel for discovery diagnostics.
   */
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly helper: HelperManager,
    private readonly output: vscode.OutputChannel,
  ) {
    this.controller.resolveHandler = async () => this.refresh();
    this.controller.createRunProfile(
      'Run Julia Tests',
      vscode.TestRunProfileKind.Run,
      async (request, token) => runTests(
        this.controller,
        request,
        token,
        this.metadata,
        this.helper,
        this.context.globalStorageUri,
      ),
      true,
    );

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{jl,toml}');
    watcher.onDidCreate(() => this.scheduleRefresh());
    watcher.onDidChange(() => this.scheduleRefresh());
    watcher.onDidDelete(() => this.scheduleRefresh());
    const configurationWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('juliaTestExplorer')) {
        this.scheduleRefresh();
      }
    });
    const workspaceWatcher = vscode.workspace.onDidChangeWorkspaceFolders(
      () => this.scheduleRefresh());
    context.subscriptions.push(watcher, configurationWatcher, workspaceWatcher);
    void this.refresh();
  }

  /**
   * Disposes the test controller and pending refresh timer.
   * @returns Nothing.
   */
  public dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.controller.dispose();
  }

  /**
   * Schedules discovery after saved-file activity settles.
   * @returns Nothing.
   */
  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 250);
  }

  /**
  * Refreshes all Julia tests while sharing any in-flight discovery pass.
   * @returns A promise completed after discovery.
   */
  private async refresh(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.performRefresh().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  /**
  * Discovers every workspace target and atomically replaces the published tree.
   * @returns A promise completed after publication.
   */
  private async performRefresh(): Promise<void> {
    const targets = await findDiscoveryTargets();
    this.output.appendLine(`Discovering Julia tests in ${targets.length} workspace target(s).`);
    const roots: vscode.TestItem[] = [];
    const nextMetadata = new Map<string, RunnableTest>();

    for (const target of targets) {
      try {
        const response = await this.helper.discover(target.projectPath, target.filePaths);
        this.output.appendLine(
          `Discovered ${response.tests.length} test set(s) in ${target.filePaths.length} Julia file(s) under ${target.projectPath}.`,
        );
        if (response.tests.length > 0) {
          const tests = resolveRunnableTests(
            target.projectPath, target.filePaths, response.tests, target.suites);
          const suitePaths = new Set(tests.flatMap((test) => test.suite ? [test.suite.entrypointPath] : []));
          this.output.appendLine(`Resolved ${suitePaths.size} conventional test suite(s) under ${target.projectPath}.`);
          roots.push(this.createProjectItem(target.projectPath, tests, nextMetadata));
        }
      } catch (error) {
        this.output.appendLine(`Discovery failed for ${target.projectPath}: ${String(error)}`);
      }
    }

    this.metadata.clear();
    nextMetadata.forEach((value, key) => this.metadata.set(key, value));
    this.controller.items.replace(roots);
    this.output.appendLine(`Published ${nextMetadata.size} Julia test set(s).`);
  }

  /**
   * Creates one project subtree.
   * @param projectDirectory Absolute project path.
   * @param tests Tests in the project.
   * @param metadata Destination metadata map.
   * @returns Project TestItem.
   */
  private createProjectItem(
    projectDirectory: string,
    tests: readonly RunnableTest[],
    metadata: Map<string, RunnableTest>,
  ): vscode.TestItem {
    const projectItem = this.controller.createTestItem(
      createTestId('project', projectDirectory),
      path.basename(projectDirectory),
      vscode.Uri.file(projectDirectory),
    );
    const groups = new Map<string, { label: string; tests: RunnableTest[] }>();
    for (const test of tests) {
      const key = test.suite?.id ?? 'direct';
      const group = groups.get(key) ?? {
        label: test.suite?.name ?? 'Direct files',
        tests: [],
      };
      group.tests.push(test);
      groups.set(key, group);
    }

    for (const [groupId, group] of groups) {
      const groupItem = this.controller.createTestItem(
        groupId === 'direct' ? createTestId('suite', projectDirectory, groupId) : groupId,
        group.label,
      );
      const files = new Map<string, RunnableTest[]>();
      for (const test of group.tests) {
        const fileTests = files.get(test.file_path) ?? [];
        fileTests.push(test);
        files.set(test.file_path, fileTests);
      }
      for (const [filePath, fileTests] of files) {
        const fileItem = this.controller.createTestItem(
          createTestId('file', filePath),
          path.basename(filePath),
          vscode.Uri.file(filePath),
        );
        for (const test of fileTests) {
          const testItem = this.controller.createTestItem(
            createTestId('test', test.file_path, String(test.start.line), ...test.test_path),
            test.test_path.join(' > '),
            vscode.Uri.file(test.file_path),
          );
          testItem.range = new vscode.Range(
            test.start.line - 1,
            test.start.column - 1,
            test.end.line - 1,
            test.end.column - 1,
          );
          metadata.set(testItem.id, test);
          fileItem.children.add(testItem);
        }
        groupItem.children.add(fileItem);
      }
      projectItem.children.add(groupItem);
    }
    return projectItem;
  }
}