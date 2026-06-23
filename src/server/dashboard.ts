/**
 * Control-plane HTTP server — read status AND drive every action over JSON + SSE.
 * Runs even when Corral is NOT yet configured: in that state it serves the setup
 * wizard and accepts POST /api/setup (write config + secrets), then the entrypoint
 * brings the orchestrator up. No external program or pre-set config is required to
 * start. Same surface the Electron renderer loads.
 *
 *   GET  /                → built renderer (wizard if unconfigured, else dashboard)
 *   GET  /api/status      → { configured }
 *   POST /api/setup       → { config (yaml), secrets:[{service,account,value}] }
 *   GET  /api/state       → { issues, pending, events }
 *   GET  /api/candidates  → on-demand tracker fetch
 *   GET  /api/diffs?id=   → diffs for an issue
 *   GET  /api/history     → past runs (?id= one record, else list; ?outcome=&limit=&offset=)
 *   POST /api/start|complete|retry|remove|restart|refine|action
 *   GET  /events          → SSE live stream
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import type { WebChannel } from '../channel/web.js';
import { bus, type CorralEvent } from '../core/events.js';
import { logger } from '../core/logger.js';
import type { Orchestrator } from '../orchestrator.js';

export interface SetupInput {
  /** corral.yaml contents. */
  config: string;
  /** Secrets to persist to the credential store (keychain / file). */
  secrets: Array<{ service: string; account: string; value: string }>;
}

export interface DashboardDeps {
  channel: WebChannel;
  /** The orchestrator once configured; undefined in setup mode. */
  orchestrator: () => Orchestrator | undefined;
  /** Persist config + secrets, then bring the orchestrator up. */
  setup: (input: SetupInput) => Promise<{ ok: boolean; message?: string }>;
}

const NOT_CONFIGURED = { ok: false, message: 'Corral is not configured yet — finish setup first.' };

export class DashboardServer {
  private server?: Server;
  boundPort = 0;

  constructor(
    private readonly port: number,
    private readonly deps: DashboardDeps,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        const url = req.url ?? '/';
        const method = req.method ?? 'GET';
        // The Electron renderer is loaded from file:// (origin "null"); allow it to
        // reach this localhost control plane (and SSE) across origins.
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }
        const json = (code: number, body: unknown): void => {
          res.writeHead(code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        };

        void (async () => {
          try {
            const o = this.deps.orchestrator();
            if (method === 'GET' && (url === '/' || url.startsWith('/?'))) {
              this.serveRenderer('/index.html', res);
            } else if (method === 'GET' && url.startsWith('/assets/')) {
              this.serveRenderer(url.split('?')[0] ?? url, res);
            } else if (url.startsWith('/api/status')) {
              json(200, { configured: !!o });
            } else if (url === '/api/setup' && method === 'POST') {
              json(200, await this.deps.setup((await readBody(req)) as unknown as SetupInput));
            } else if (url.startsWith('/api/state')) {
              json(200, { issues: o ? o.snapshot() : [], pending: this.deps.channel.getPending(), events: bus.recent() });
            } else if (url.startsWith('/api/candidates')) {
              json(200, { candidates: o ? await o.listCandidates() : [] });
            } else if (url.startsWith('/api/diffs')) {
              const id = new URL(url, 'http://x').searchParams.get('id') ?? '';
              json(200, { diffs: this.deps.channel.getDiffs(id) });
            } else if (url.startsWith('/api/history')) {
              const q = new URL(url, 'http://x').searchParams;
              const id = q.get('id');
              if (id) {
                json(200, { record: o ? o.getHistory(id) : undefined });
              } else {
                const outcome = q.get('outcome') as 'completed' | 'removed' | 'failed' | null;
                const limit = q.get('limit') ? Number(q.get('limit')) : undefined;
                const offset = q.get('offset') ? Number(q.get('offset')) : undefined;
                json(200, { records: o ? o.listHistory({ limit, offset, outcome: outcome ?? undefined }) : [] });
              }
            } else if (url === '/api/start' && method === 'POST') {
              const b = await readBody(req);
              json(200, o ? await o.startIssue(String(b.identifier)) : NOT_CONFIGURED);
            } else if (url === '/api/complete' && method === 'POST') {
              const b = await readBody(req);
              json(200, o ? await o.completeByUser(String(b.identifier), b.force === true) : NOT_CONFIGURED);
            } else if (url === '/api/retry' && method === 'POST') {
              const b = await readBody(req);
              json(200, o ? await o.retry(String(b.identifier)) : NOT_CONFIGURED);
            } else if (url === '/api/remove' && method === 'POST') {
              const b = await readBody(req);
              json(200, o ? await o.removeIssue(String(b.identifier)) : NOT_CONFIGURED);
            } else if (url === '/api/restart' && method === 'POST') {
              const b = await readBody(req);
              json(200, o ? await o.restartIssue(String(b.identifier)) : NOT_CONFIGURED);
            } else if (url === '/api/refine' && method === 'POST') {
              const b = await readBody(req);
              json(200, o ? await o.refinePlan(String(b.identifier), String(b.focus ?? '')) : NOT_CONFIGURED);
            } else if (url === '/api/action' && method === 'POST') {
              const b = await readBody(req);
              const ok =
                b.type === 'approve'
                  ? this.deps.channel.submitApprove(String(b.id), { selection: b.selection as string, notes: b.text as string })
                  : this.deps.channel.submitFeedback(String(b.id), String(b.text ?? ''));
              json(200, { ok });
            } else if (url.startsWith('/events')) {
              res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
              res.write('retry: 3000\n\n');
              const send = (e: CorralEvent): void => void res.write(`data: ${JSON.stringify(e)}\n\n`);
              const unsub = bus.subscribe(send);
              const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
              req.on('close', () => {
                clearInterval(ping);
                unsub();
              });
            } else {
              res.writeHead(404);
              res.end('not found');
            }
          } catch (err) {
            logger.error('control-plane request failed', String(err));
            json(500, { ok: false, message: String(err) });
          }
        })();
      });
      this.server.on('error', (err) => reject(err));
      this.server.listen(this.port, () => {
        const addr = this.server?.address();
        if (addr && typeof addr === 'object') this.boundPort = addr.port;
        logger.info(`control plane on http://localhost:${this.boundPort}`);
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.close();
  }

  /** Serve the built Svelte renderer (renderer/dist) for headless/browser use. */
  private serveRenderer(rel: string, res: ServerResponse): void {
    const dist = resolve(process.env.CORRAL_RENDERER_DIST ?? 'renderer/dist');
    const file = join(dist, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(dist)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    if (existsSync(file)) {
      res.writeHead(200, { 'Content-Type': contentType(file) });
      res.end(readFileSync(file));
    } else if (rel === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE); // renderer not built — placeholder
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  }
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function contentType(file: string): string {
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    }[extname(file)] ?? 'application/octet-stream'
  );
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Corral</title></head>
<body style="font-family:system-ui,sans-serif;max-width:48rem;margin:3rem auto;padding:0 1rem">
<h1>Corral control plane</h1>
<p>The API is up. Build the renderer (<code>pnpm -C renderer build</code>) to see the UI.</p>
</body></html>`;
