import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { discover } from './runtime';
import { MAX_FRAME, MAX_REQUESTS, State, keys, parseFrame, promptFor, uuid, validateEnvelope } from './protocol';

/* Loading the companion registers commands and guards only. /vscode connect is the sole socket-opening path. */
export default function (pi: ExtensionAPI) {
  let socket: WebSocket | undefined;
  let connectionId = '';
  let generation = 0;
  let closing = false;
  let compacting = false;
  const requests = new Map<string, { hash: string; prompt: string; sessionId: string; state: State }>();
  const pending = () => [...requests.values()].some(r => r.state === 'submitted' || r.state === 'unknown');
  function report(id: string, state: State, reason = '') {
    const entry = requests.get(id);
    if (entry) entry.state = state;
    if (socket?.readyState === WebSocket.OPEN && connectionId) socket.send(JSON.stringify({ type: 'status', requestId: id, state, reason }));
  }
  function disconnect(ctx: ExtensionContext) {
    generation++;
    const previous = socket;
    socket = undefined;
    connectionId = '';
    previous?.terminate();
    ctx.ui.setStatus('vscode-pi', undefined);
  }
  function beforeChange(ctx: ExtensionContext) {
    disconnect(ctx);
    if (pending()) {
      ctx.ui.notify('VS Code route revoked. Navigation blocked: a submitted follow-up remains unconfirmed. Wait for insertion, inspect the native queue, or deliberately reload Pi. Disconnect does not cancel queued work.', 'warning');
      return { cancel: true };
    }
  }
  pi.on('session_before_switch', (_e, ctx) => beforeChange(ctx));
  pi.on('session_before_fork', (_e, ctx) => beforeChange(ctx));
  pi.on('session_before_tree', (_e, ctx) => beforeChange(ctx));
  pi.on('session_shutdown', (_e, ctx) => { closing = true; disconnect(ctx); });
  pi.on('session_before_compact', () => { compacting = true; });
  pi.on('session_compact', () => { compacting = false; });
  pi.on('session_compact_failed', () => { compacting = false; });
  pi.on('session_info_changed', (_e, ctx) => disconnect(ctx));
  pi.on('agent_settled', () => {
    for (const [id, entry] of requests) if (entry.state === 'submitted') report(id, 'unknown', 'Pi settled without a matching user-message insertion.');
  });
  pi.on('message_start', (event, ctx) => {
    if (event.message.role !== 'user') return;
    const content = event.message.content;
    const message = typeof content === 'string' ? content : content.filter(p => p.type === 'text').map(p => p.text).join('\n');
    for (const [id, entry] of requests) {
      if (entry.prompt !== message || entry.state === 'delivered' || entry.state === 'failed') continue;
      if (ctx.sessionManager.getSessionId() === entry.sessionId) {
        report(id, 'delivered');
        entry.prompt = '';
      } else report(id, 'unknown', 'Insertion observed in a different conversation.');
    }
  });
  pi.registerCommand('vscode', {
    description: 'VS Code bridge: connect | disconnect | status (never connects automatically)',
    handler: async (args, ctx) => {
      if (ctx.mode !== 'tui') { ctx.ui.notify('VS Code pairing requires an interactive Pi terminal.', 'error'); return; }
      const command = args.trim();
      if (command === 'disconnect') {
        disconnect(ctx);
        ctx.ui.notify('Disconnected. Already accepted follow-ups can still run; nothing was cancelled.', 'info');
        return;
      }
      if (command === 'status') {
        ctx.ui.notify(`VS Code: ${connectionId ? 'connected' : socket ? 'connecting' : 'disconnected'}; unconfirmed requests: ${pending() ? 'yes' : 'no'}. Replies stay in Pi.`, 'info');
        return;
      }
      if (command !== 'connect') { ctx.ui.notify('Usage: /vscode connect | disconnect | status', 'info'); return; }
      try {
        if (pending()) throw new Error('An earlier request remains unconfirmed. Inspect Pi before reconnecting; no replay is performed.');
        disconnect(ctx);
        const attempt = generation;
        const sessionId = ctx.sessionManager.getSessionId();
        const candidates = await discover();
        if (!candidates.length) throw new Error('No local VS Code bridge found. Open VS Code with Pi Bridge enabled, then explicitly connect again.');
        const labels = candidates.map(d => `${d.label} — window ${d.runtimeId} (pid ${d.pid}, port ${d.port})`);
        const chosen = await ctx.ui.select('Select VS Code window (stale windows may fail to connect)', labels);
        if (chosen === undefined || attempt !== generation || closing || sessionId !== ctx.sessionManager.getSessionId()) return;
        const descriptor = candidates[labels.indexOf(chosen)];
        if (!descriptor) return;
        const client = new WebSocket(`ws://127.0.0.1:${descriptor.port}/pi`, 'vscode-pi-v1', { maxPayload: MAX_FRAME, handshakeTimeout: 5000, perMessageDeflate: false, followRedirects: false });
        socket = client;
        const deadline = setTimeout(() => client.terminate(), 6000);
        client.on('open', () => {
          if (client !== socket || attempt !== generation || closing) { client.terminate(); return; }
          client.send(JSON.stringify({ type: 'hello', version: 1, runtimeId: descriptor.runtimeId, token: descriptor.token, sessionId, name: (pi.getSessionName() || 'Unnamed Pi session').slice(0, 128), cwd: ctx.cwd }));
        });
        client.on('error', () => {
          if (client === socket && !closing) ctx.ui.notify('VS Code bridge unavailable or stale. Select the correct live window with /vscode connect; no automatic reconnect.', 'error');
          client.terminate();
        });
        client.on('close', () => {
          clearTimeout(deadline);
          if (client !== socket) return;
          disconnect(ctx);
          if (!closing) ctx.ui.notify('VS Code disconnected. Accepted follow-ups were not cancelled. No requests will be replayed.', 'warning');
        });
        client.on('message', (raw, binary) => {
          if (client !== socket || closing || attempt !== generation) return;
          try {
            const m = parseFrame(raw as Buffer, binary);
            if (!connectionId) {
              keys(m, ['type', 'version', 'runtimeId', 'connectionId', 'sessionId']);
              if (m.type !== 'connected' || m.version !== 1 || m.runtimeId !== descriptor.runtimeId || m.sessionId !== sessionId || !uuid(m.connectionId)) throw new Error('Invalid connection acknowledgement');
              connectionId = m.connectionId;
              clearTimeout(deadline);
              ctx.ui.setStatus('vscode-pi', `VS Code: ${descriptor.label}`);
              ctx.ui.notify('This conversation is selectable in that VS Code window. Ask Pi can start model turns with normal costs and permissions.', 'info');
              return;
            }
            keys(m, ['type', 'envelope']);
            if (m.type !== 'request') throw new Error('Unexpected frame');
            validateEnvelope(m.envelope);
            const e = m.envelope;
            if (e.runtimeId !== descriptor.runtimeId || e.connectionId !== connectionId || e.sessionId !== sessionId || ctx.sessionManager.getSessionId() !== sessionId) throw new Error('Destination mismatch');
            const hash = createHash('sha256').update(JSON.stringify(e)).digest('hex');
            const previous = requests.get(e.requestId);
            if (previous) {
              if (previous.hash !== hash) throw new Error('Request ID/content mismatch');
              report(e.requestId, previous.state);
              return;
            }
            if (requests.size >= MAX_REQUESTS) {
              report(e.requestId, 'failed', 'Pi runtime reached 500 requests; deliberately reload before new work. Nothing submitted.');
              return;
            }
            const prompt = promptFor(e);
            requests.set(e.requestId, { hash, prompt, sessionId, state: compacting ? 'failed' : 'submitted' });
            if (compacting) { report(e.requestId, 'failed', 'Pi is compacting. Nothing submitted; explicitly resend later.'); return; }
            // Register before the API call: idle insertion can be observed before it returns.
            report(e.requestId, 'submitted');
            try { pi.sendUserMessage(prompt, { deliverAs: 'followUp', expandPromptTemplates: false }); }
            catch { if (requests.get(e.requestId)?.state !== 'delivered') report(e.requestId, 'unknown', 'Pi submission threw without an observed insertion. Check the terminal before resending.'); }
          } catch { client.close(1008, 'Invalid bridge frame'); }
        });
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : 'VS Code pairing failed.', 'error'); }
    },
  });
}
