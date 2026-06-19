/**
 * Control-plane HTTP server — read status AND drive every action over JSON + SSE.
 * No polling: the user's clicks (POSTs) advance the flow. This is the data plane
 * the orchestrator commands hang off; it runs headless (browser) and is the same
 * surface the Electron renderer loads.
 *
 *   GET  /                → SPA placeholder (Svelte renderer lands next)
 *   GET  /api/state       → { issues, pending, events }
 *   GET  /api/candidates  → on-demand tracker fetch
 *   GET  /api/diffs?id=   → diffs for an issue
 *   POST /api/start       → { identifier }
 *   POST /api/complete    → { identifier, force? }
 *   POST /api/retry       → { identifier }
 *   POST /api/refine      → { identifier, focus }
 *   POST /api/action      → { id, type:'approve'|'feedback', selection?, text? }
 *   GET  /events          → SSE live stream
 *
 * Lifted from upstream (renamed SymphonyEvent → CorralEvent; start() is async so the
 * bound port is known — useful for ephemeral-port tests).
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import type { WebChannel } from '../channel/web.js';
import { bus, type CorralEvent } from '../core/events.js';
import type { IssueRuntime } from '../core/issue-state.js';
import { logger } from '../core/logger.js';

export interface DashboardDeps {
  snapshot: () => Array<IssueRuntime & { cost: number }>;
  channel: WebChannel;
  listCandidates: () => Promise<Array<{ identifier: string; title: string; state: string; inFlight: boolean }>>;
  startIssue: (identifier: string) => Promise<{ ok: boolean; message?: string }>;
  completeIssue: (identifier: string, force: boolean) => Promise<{ ok: boolean; merged?: boolean; message?: string }>;
  retryIssue: (identifier: string) => Promise<{ ok: boolean; message?: string }>;
  refineIssue: (identifier: string, focus: string) => Promise<{ ok: boolean; message?: string }>;
}

export class DashboardServer {
  private server?: Server;
  /** Actual listening port (differs from the requested one when 0 is passed). */
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
        const json = (code: number, body: unknown): void => {
          res.writeHead(code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        };

        void (async () => {
          try {
            if (method === 'GET' && (url === '/' || url.startsWith('/?'))) {
              this.serveRenderer('/index.html', res);
            } else if (method === 'GET' && url.startsWith('/assets/')) {
              this.serveRenderer((url.split('?')[0] ?? url), res);
            } else if (url.startsWith('/api/state')) {
              json(200, { issues: this.deps.snapshot(), pending: this.deps.channel.getPending(), events: bus.recent() });
            } else if (url.startsWith('/api/candidates')) {
              json(200, { candidates: await this.deps.listCandidates() });
            } else if (url.startsWith('/api/diffs')) {
              const id = new URL(url, 'http://x').searchParams.get('id') ?? '';
              json(200, { diffs: this.deps.channel.getDiffs(id) });
            } else if (url === '/api/start' && method === 'POST') {
              const b = await readBody(req);
              json(200, await this.deps.startIssue(String(b.identifier)));
            } else if (url === '/api/complete' && method === 'POST') {
              const b = await readBody(req);
              json(200, await this.deps.completeIssue(String(b.identifier), b.force === true));
            } else if (url === '/api/retry' && method === 'POST') {
              const b = await readBody(req);
              json(200, await this.deps.retryIssue(String(b.identifier)));
            } else if (url === '/api/refine' && method === 'POST') {
              const b = await readBody(req);
              json(200, await this.deps.refineIssue(String(b.identifier), String(b.focus ?? '')));
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
            logger.error('dashboard request failed', String(err));
            json(500, { ok: false, message: String(err) });
          }
        })();
      });
      this.server.on('error', (err) => reject(err)); // e.g. EADDRINUSE — fail cleanly, don't crash
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

  /** Serve the built Svelte renderer (renderer/dist) for headless/browser use.
   * In the packaged desktop app the renderer is loaded via file:// instead. */
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
      res.end(PAGE); // renderer not built — show the placeholder
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  }
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

/** Placeholder page until the Svelte renderer is built and served (next step). */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Corral</title></head>
<body style="font-family:system-ui,sans-serif;max-width:48rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a">
<h1>Corral control plane</h1>
<p>The API is up. The dashboard UI is built in the next step.</p>
<p>Endpoints: <code>/api/state</code>, <code>/api/candidates</code>, <code>/api/start</code>,
<code>/api/action</code>, and <code>/events</code> (SSE).</p>
</body></html>`;
