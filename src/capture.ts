import * as vscode from 'vscode';
import { Reference, validateReference } from './protocol';

/** Copies editor data before any picker opens, so focus changes cannot alter a composed request. */
export function capture(): Reference {
  if (vscode.env.remoteName) throw new Error('Remote SSH/container windows are not supported. Use a local VS Code window.');
  const editor = vscode.window.activeTextEditor;
  if (!editor) throw new Error('Open a saved local file first.');
  const document = editor.document;
  if (document.isUntitled || document.uri.scheme !== 'file' || document.uri.authority || document.isDirty) throw new Error('Save this local file first. Pi Bridge never saves documents automatically.');
  if (editor.selections.length !== 1) throw new Error('Multiple selections are not supported. Use one cursor or one exact selection.');
  const selection = editor.selection;
  const range = selection.isEmpty ? document.lineAt(selection.active.line).range : selection;
  const reference: Reference = {
    path: document.uri.fsPath,
    workspace: vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath,
    start: { line: range.start.line + 1, column: range.start.character + 1 },
    end: { line: range.end.line + 1, column: range.end.character + 1 },
    text: document.getText(range),
    kind: selection.isEmpty ? 'line' : 'selection',
  };
  validateReference(reference);
  return reference;
}
