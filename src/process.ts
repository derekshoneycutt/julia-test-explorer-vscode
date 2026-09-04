import { spawn } from 'node:child_process';
import * as vscode from 'vscode';

/** Captured result of a completed child process. */
export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a child process without shell interpolation.
 * @param command Executable path.
 * @param args Process arguments.
 * @param token Optional cancellation token that terminates the child process.
 * @param onOutput Optional callback invoked for each stdout or stderr chunk.
 * @returns Captured process result.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  token?: vscode.CancellationToken,
  onOutput?: (text: string) => void,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const cancellation = token?.onCancellationRequested(() => child.kill());

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      onOutput?.(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      onOutput?.(text);
    });
    child.once('error', (error) => {
      cancellation?.dispose();
      reject(error);
    });
    child.once('close', (exitCode) => {
      cancellation?.dispose();
      resolve({ exitCode: exitCode ?? -1, stdout, stderr });
    });

    if (token?.isCancellationRequested) {
      child.kill();
    }
  });
}

/**
 * Normalizes process output for VS Code's terminal renderer.
 * @param text Raw process output.
 * @returns CRLF-normalized output.
 */
export function normalizeOutput(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}