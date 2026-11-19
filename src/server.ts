import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { Envelope, MAX_FRAME, MAX_REQUESTS, State, keys, parseFrame, text, uuid, validateEnvelope } from './protocol';
import { runtimeDirectory, secureDirectory } from './runtime';

export interface Route { connectionId: string; sessionId: string; name: string; cwd: string; socket: WebSocket }
interface RecordEntry { hash: string; route: Route; state: State; timer: NodeJS.Timeout }

/** Hosts one VS Code window's opted-in routes. Disconnects invalidate destinations; records are never evicted to permit replay. */
export class Bridge {
  readonly runtimeId = randomUUID();
  readonly routes = new Map<string, Route>();
  private token = randomBytes(32).toString('hex');
  private records = new Map<string, RecordEntry>();
  private http = createServer((_req, response) => { response.writeHead(404); response.end(); });
  private sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  private descriptor = path.join(runtimeDirectory, `${this.runtimeId}.json`);
  private heartbeat?: NodeJS.Timeout;
  private port = 0;
  onRoutesChanged = () => {};
  onStatus = (_id: string, _state: State, _reason: string) => {};

  async start(label: string) {
    await secureDirectory(true);
    this.http.headersTimeout = 5000;
    this.http.requestTimeout = 5000;
    this.http.on('upgrade', (request, socket, head) => {
      if (request.url !== '/pi' || request.headers.host !== `127.0.0.1:${this.port}` ||
          request.headers.origin !== undefined || request.headers['sec-websocket-protocol'] !== 'vscode-pi-v1' ||
          request.socket.remoteAddress !== '127.0.0.1' || this.sockets.clients.size >= 32) { socket.destroy(); return; }
      this.sockets.handleUpgrade(request, socket, head, client => this.accept(client));
    });
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(0, '127.0.0.1', () => { this.http.removeListener('error', reject); resolve(); });
    });
    this.http.on('error', () => { void this.close(); });
    this.port = (this.http.address() as { port: number }).port;
    try {
      await writeFile(this.descriptor, JSON.stringify({ version: 1, runtimeId: this.runtimeId, token: this.token, port: this.port, pid: process.pid, label }), { flag: 'wx', mode: 0o600 });
    } catch (error) { await this.close(); throw error; }
    this.heartbeat = setInterval(() => {
      for (const socket of this.sockets.clients) {
        if (!this.alive.has(socket)) socket.terminate();
        else { this.alive.delete(socket); socket.ping(); }
      }
    }, 15000);
  }
  private alive = new Set<WebSocket>();
  private accept(socket: WebSocket) {
    let route: Route | undefined;
    this.alive.add(socket);
    const deadline = setTimeout(() => socket.terminate(), 5000);
    socket.on('pong', () => this.alive.add(socket));
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      clearTimeout(deadline);
      this.alive.delete(socket);
      if (!route) return;
      this.routes.delete(route.connectionId);
      for (const [id, entry] of this.records) if (entry.route === route && !['delivered', 'failed'].includes(entry.state)) this.update(id, 'unknown', 'Connection lost; accepted follow-ups were not cancelled. Check Pi before resending.');
      this.onRoutesChanged();
    });
    socket.on('message', (raw, binary) => {
      try {
        const m = parseFrame(raw as Buffer, binary);
        if (!route) {
          keys(m, ['type', 'version', 'runtimeId', 'token', 'sessionId', 'name', 'cwd']);
          if (m.type !== 'hello' || m.version !== 1 || m.runtimeId !== this.runtimeId ||
              typeof m.token !== 'string' || !/^[a-f0-9]{64}$/.test(m.token) ||
              !timingSafeEqual(Buffer.from(m.token, 'hex'), Buffer.from(this.token, 'hex')) ||
              !uuid(m.sessionId) || !text(m.name, 512) || !text(m.cwd, 4096) || !path.isAbsolute(m.cwd)) throw new Error('Invalid hello');
          route = { connectionId: randomUUID(), sessionId: m.sessionId, name: m.name, cwd: m.cwd, socket };
          this.routes.set(route.connectionId, route);
          clearTimeout(deadline);
          socket.send(JSON.stringify({ type: 'connected', version: 1, runtimeId: this.runtimeId, connectionId: route.connectionId, sessionId: route.sessionId }));
          this.onRoutesChanged();
          return;
        }
        keys(m, ['type', 'requestId', 'state', 'reason']);
        if (m.type !== 'status' || !uuid(m.requestId) || typeof m.state !== 'string' || !['submitted', 'delivered', 'failed', 'unknown'].includes(m.state) || !text(m.reason, 512)) throw new Error('Invalid status');
        const entry = this.records.get(m.requestId);
        if (!entry || entry.route !== route) throw new Error('Invalid request identity');
        this.update(m.requestId, m.state as State, m.reason);
      } catch { socket.close(1008, 'Invalid bridge frame'); }
    });
  }
  private update(id: string, state: State, reason: string) {
    const entry = this.records.get(id)!;
    if (['delivered', 'failed'].includes(entry.state) || (entry.state === 'unknown' && state === 'submitted')) return;
    entry.state = state;
    if (state !== 'submitted') clearTimeout(entry.timer);
    this.onStatus(id, state, reason);
  }
  submit(envelope: Envelope) {
    validateEnvelope(envelope);
    if (envelope.runtimeId !== this.runtimeId) throw new Error('VS Code runtime changed. Select a session again.');
    const hash = createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
    const previous = this.records.get(envelope.requestId);
    if (previous) {
      if (previous.hash !== hash) throw new Error('Request ID/content mismatch');
      return;
    }
    if (this.records.size >= MAX_REQUESTS) throw new Error('500-request runtime limit reached. Restart deliberately; nothing was sent.');
    const route = this.routes.get(envelope.connectionId);
    if (!route || route.sessionId !== envelope.sessionId || route.socket.readyState !== WebSocket.OPEN) throw new Error('Selected Pi session disconnected. Select explicitly again; nothing was sent.');
    const timer = setTimeout(() => this.update(envelope.requestId, 'unknown', 'No matching insertion observed within 30 seconds. Check Pi; do not assume non-delivery.'), 30000);
    this.records.set(envelope.requestId, { hash, route, state: 'submitted', timer });
    this.onStatus(envelope.requestId, 'submitted', 'Awaiting matching Pi user-message insertion.');
    try {
      route.socket.send(JSON.stringify({ type: 'request', envelope }), error => {
        if (error) this.update(envelope.requestId, 'unknown', 'Transport failed after sending was attempted. Check Pi before resending.');
      });
    } catch { this.update(envelope.requestId, 'unknown', 'Transport failed after sending was attempted. Check Pi before resending.'); }
  }
  async close() {
    clearInterval(this.heartbeat);
    for (const entry of this.records.values()) clearTimeout(entry.timer);
    for (const socket of this.sockets.clients) socket.terminate();
    this.sockets.close();
    this.http.close();
    this.http.closeAllConnections();
    await unlink(this.descriptor).catch(() => {});
  }
}
