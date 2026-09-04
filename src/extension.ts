import * as vscode from 'vscode';
import { HelperManager } from './helperManager';
import { JuliaTestController } from './testController';

/**
 * Activates Julia Test Explorer.
 * @param context Extension lifecycle context.
 * @returns A promise that resolves after registration.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Julia Test Explorer');
  const helper = new HelperManager(context);
  const controller = new JuliaTestController(context, helper, output);
  context.subscriptions.push(output, controller);
}

/**
 * Deactivates Julia Test Explorer.
 * @returns Nothing.
 */
export function deactivate(): void {}