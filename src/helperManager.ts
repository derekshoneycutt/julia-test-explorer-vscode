import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DiscoveryResponse, parseDiscoveryResponse } from './discovery';
import { runProcess } from './process';

/** Locates and invokes the bundled Julia helper scripts. */
export class HelperManager {
  /**
   * Creates a helper manager for the active extension installation.
   * @param context Extension paths and storage context.
   */
  public constructor(private readonly context: vscode.ExtensionContext) {}

  /**
    * Discovers named test sets in explicit Julia source files.
    * @param projectPath Workspace or Julia environment used to parse the files.
    * @param filePaths Absolute Julia source paths to inspect.
   * @returns Discovered tests and protocol metadata.
   */
  public async discover(projectPath: string, filePaths: readonly string[]): Promise<DiscoveryResponse> {
    const result = await runProcess(this.getJuliaPath(projectPath), [
      '--startup-file=no',
      `--project=${projectPath}`,
      this.getHelperPath('discovery.jl'),
      projectPath,
      ...filePaths,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Discovery helper exited with code ${result.exitCode}`);
    }
    return parseDiscoveryResponse(result.stdout);
  }

  /**
    * Resolves the Julia executable from extension settings and local installations.
    * @returns Julia executable command or absolute path.
   */
  public getJuliaPath(resourcePath?: string): string {
    const resource = resourcePath ? vscode.Uri.file(resourcePath) : undefined;
    const configuredPath = vscode.workspace.getConfiguration(
      'juliaTestExplorer', resource).get<string>('juliaPath', 'julia');
    const juliaExtensionPath = vscode.workspace.getConfiguration(
      'julia', resource).get<string>('executablePath', '');
    return resolveJuliaPath(configuredPath, juliaExtensionPath, process.env.PATH, homedir());
  }

  /**
   * Returns the installed test runner script path.
   * @returns Absolute runner script path.
   */
  public getRunnerPath(): string {
    return this.getHelperPath('runner.jl');
  }

  /**
   * Resolves one script in the bundled helper directory.
    * @param name Helper filename relative to the extension's helper directory.
   * @returns Absolute helper path.
   */
  private getHelperPath(name: string): string {
    return vscode.Uri.joinPath(this.context.extensionUri, 'helper', name).fsPath;
  }
}

/**
 * Resolves Julia when a GUI Extension Host may not inherit the user's shell PATH.
 * @param configuredPath Value of `juliaTestExplorer.juliaPath`.
 * @param juliaExtensionPath Value of the Julia extension's `julia.executablePath`.
 * @param pathEnvironment Extension Host PATH value.
 * @param homeDirectory Current user's home directory.
 * @returns First configured or existing Julia executable, or the `julia` command.
 */
export function resolveJuliaPath(
  configuredPath: string,
  juliaExtensionPath: string,
  pathEnvironment: string | undefined,
  homeDirectory: string,
): string {
  const configured = configuredPath.trim();
  if (configured !== '' && configured !== 'julia') {
    return expandHome(configured, homeDirectory);
  }

  const languageExtension = juliaExtensionPath.trim();
  if (languageExtension !== '') {
    return expandHome(languageExtension, homeDirectory);
  }

  const executableName = process.platform === 'win32' ? 'julia.exe' : 'julia';
  const pathCandidates = (pathEnvironment ?? '')
    .split(path.delimiter)
    .filter((directory) => directory !== '')
    .map((directory) => path.join(directory, executableName));
  const fallbackCandidates = process.platform === 'win32'
    ? []
    : [
      path.join(homeDirectory, '.juliaup', 'bin', 'julia'),
      path.join(homeDirectory, '.julia', 'bin', 'julia'),
    ];
  return [...pathCandidates, ...fallbackCandidates].find(existsSync) ?? 'julia';
}

/**
 * Expands a leading `~` in a configured executable path.
 * @param value Configured executable path.
 * @param homeDirectory User home directory.
 * @returns Expanded path.
 */
function expandHome(value: string, homeDirectory: string): string {
  return value === '~' || value.startsWith(`~${path.sep}`)
    ? path.join(homeDirectory, value.slice(2))
    : value;
}