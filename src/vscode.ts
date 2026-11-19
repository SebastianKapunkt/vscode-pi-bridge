import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { Bridge, Route } from './server';
import { capture } from './capture';
import { Envelope, Reference, State, instructionError, validateEnvelope } from './protocol';

let bridge: Bridge | undefined;
export async function activate(context: vscode.ExtensionContext) {
  if (vscode.env.remoteName || process.platform !== 'darwin') {
    const unavailable = () => vscode.window.showErrorMessage('Pi Bridge v1 supports local macOS VS Code windows only.');
    for (const id of ['piBridge.ask', 'piBridge.select', 'piBridge.recover']) context.subscriptions.push(vscode.commands.registerCommand(id, unavailable));
    return;
  }
  const server = new Bridge();
  bridge = server;
  let binding: Route | undefined;
  let composing = false;
  const retained = new Map<string, { envelope: Envelope; state: State; destination: string }>();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.command = 'piBridge.select';
  context.subscriptions.push(status);
  function showBinding() {
    status.text = binding ? `$(plug) Pi: ${binding.name}` : '$(debug-disconnect) Pi: select session';
    status.tooltip = binding ? `${binding.cwd}\nSession ${binding.sessionId}\nConnection ${binding.connectionId}` : 'Run /vscode connect in Pi, then select that conversation here.';
    status.show();
  }
  server.onRoutesChanged = () => {
    if (binding && !server.routes.has(binding.connectionId)) binding = undefined;
    showBinding();
  };
  async function select(): Promise<Route | undefined> {
    const routes = [...server.routes.values()];
    if (!routes.length) {
      void vscode.window.showInformationMessage('Connect Pi first: run /vscode connect in the intended Pi terminal and choose this VS Code window.');
      return;
    }
    const choice = await vscode.window.showQuickPick(routes.map(route => ({
      label: route.name,
      description: route.cwd,
      detail: `Session ${route.sessionId} · connection ${route.connectionId} · VS Code window ${server.runtimeId}`,
      route,
    })), { title: 'Select Pi session…', placeHolder: 'Explicit destination for this VS Code window', matchOnDescription: true, matchOnDetail: true });
    if (!choice) return;
    if (server.routes.get(choice.route.connectionId) !== choice.route) throw new Error('That Pi conversation disconnected. Select a live session again.');
    binding = choice.route;
    showBinding();
    return binding;
  }
  async function copyRecovery(saved: { envelope: Envelope }) {
    await vscode.env.clipboard.writeText(JSON.stringify({ instruction: saved.envelope.instruction, reference: saved.envelope.reference }, null, 2));
    void vscode.window.showInformationMessage('Instruction and captured reference copied. Nothing was sent.');
  }
  server.onStatus = (id, state, reason) => {
    const saved = retained.get(id);
    if (saved) saved.state = state;
    if (state === 'submitted') {
      void vscode.window.setStatusBarMessage('Pi: submitted; waiting for insertion acknowledgement…', 5000);
    } else if (state === 'delivered') {
      void vscode.window.showInformationMessage(`Pi: Delivered — inserted into the selected conversation, not agent completion. [${id.slice(0, 8)}]`);
    } else {
      void vscode.window.showWarningMessage(`Pi: ${state === 'unknown' ? 'Unknown delivery' : 'Not submitted'} — ${reason} [${id.slice(0, 8)}]`, 'Recover request…').then(choice => {
        if (choice) void vscode.commands.executeCommand('piBridge.recover');
      });
    }
  };
  function submit(reference: Reference, instruction: string, route: Route) {
    const envelope: Envelope = { version: 1, runtimeId: server.runtimeId, connectionId: route.connectionId, sessionId: route.sessionId, requestId: randomUUID(), instruction, reference };
    if (retained.size >= 500) throw new Error('500 retained requests reached. Copy any needed requests, then deliberately reload this window.');
    retained.set(envelope.requestId, { envelope, state: 'failed', destination: `${route.name} — ${route.cwd} (${route.sessionId})` });
    validateEnvelope(envelope);
    server.submit(envelope);
  }
  async function ask() {
    if (composing) { void vscode.window.showInformationMessage('An Ask Pi input is already open. Submit it or press Escape to cancel.'); return; }
    composing = true;
    try {
      const reference = capture();
      const route = binding ?? await select();
      if (!route) return;
      const instruction = await vscode.window.showInputBox({
        title: `Ask Pi: ${route.name}`,
        prompt: `${route.cwd} · ${reference.path}:${reference.start.line}:${reference.start.column} · Enter submits; Escape cancels`,
        placeHolder: 'Instruction for this reference',
        ignoreFocusOut: true,
        validateInput: instructionError,
      });
      if (instruction === undefined) return;
      const error = instructionError(instruction);
      if (error) throw new Error(error);
      submit(reference, instruction, route);
    } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Pi request failed.'); }
    finally { composing = false; }
  }
  async function recover() {
    if (!retained.size) { void vscode.window.showInformationMessage('No retained requests in this window. Requests are not persisted.'); return; }
    const request = await vscode.window.showQuickPick([...retained.values()].reverse().map(saved => ({
      label: `${saved.state} · ${saved.envelope.requestId.slice(0, 8)}`,
      description: saved.destination,
      detail: `${saved.envelope.reference.path}:${saved.envelope.reference.start.line}`,
      saved,
    })), { title: 'Recover a Pi request (newest first)' });
    if (!request) return;
    const saved = request.saved;
    const choice = await vscode.window.showQuickPick(['Copy instruction and reference', 'Resend with new request ID…'], { title: `${saved.state} → ${saved.destination}` });
    if (choice === 'Copy instruction and reference') { await copyRecovery(saved); return; }
    if (choice !== 'Resend with new request ID…') return;
    const confirm = await vscode.window.showWarningMessage('The earlier request may already have run or may still be queued. Resending can duplicate work. Check Pi first. The original reference snapshot will be reused.', { modal: true }, 'Select destination and resend');
    if (!confirm) return;
    const route = await select();
    if (route) submit(saved.envelope.reference, saved.envelope.instruction, route);
  }
  const handled = (action: () => Promise<unknown>) => async () => {
    try { await action(); }
    catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Pi Bridge operation failed.'); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('piBridge.ask', ask),
    vscode.commands.registerCommand('piBridge.select', handled(select)),
    vscode.commands.registerCommand('piBridge.recover', handled(recover)),
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, {
      provideCodeActions(document, _range, actionContext) {
        const kind = vscode.CodeActionKind.Refactor.append('pi');
        if (actionContext.only && !actionContext.only.contains(kind)) return [];
        if (document.isDirty || vscode.window.activeTextEditor?.document !== document) return [];
        const action = new vscode.CodeAction('Ask Pi…', kind);
        action.command = { command: 'piBridge.ask', title: 'Ask Pi…' };
        return [action];
      },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.Refactor.append('pi')] }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      // The advertised workspace snapshot no longer describes this window; require deliberate re-pairing after reload.
      void server.close();
      binding = undefined;
      showBinding();
      void vscode.window.showWarningMessage('Workspace folders changed. Reload this window to restart Pi Bridge; nothing will reconnect automatically.');
    }),
  );
  try {
    const folders = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath).join(', ') || 'No workspace';
    await server.start(`${vscode.workspace.name || 'VS Code'} — ${folders}`);
    showBinding();
  } catch {
    await server.close();
    void vscode.window.showErrorMessage('Pi Bridge listener could not start. Check owner-only permissions on ~/.vscode-pi-bridge/runtime, then reload this window.');
  }
}
export async function deactivate() { await bridge?.close(); bridge = undefined; }
