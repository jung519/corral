/**
 * Structured logging. Writes a single system-wide log plus one log file per issue
 * identifier (logs/<identifier>.log) — the per-issue file is the debugging entrypoint.
 *
 * Lifted from upstream.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;
const LOG_DIR = resolve('logs');

let dirReady = false;
function ensureDir(): void {
  if (dirReady) return;
  mkdirSync(LOG_DIR, { recursive: true });
  dirReady = true;
}

function write(file: string, line: string): void {
  try {
    ensureDir();
    appendFileSync(resolve(LOG_DIR, file), line + '\n');
  } catch {
    /* logging must never throw */
  }
}

function emit(level: Level, scope: string | undefined, msg: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const tag = scope ? `[${scope}] ` : '';
  const detail = extra === undefined ? '' : ' ' + safeJson(extra);
  const line = `${ts} ${level.toUpperCase().padEnd(5)} ${tag}${msg}${detail}`;

  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  sink(line);
  write('corral.log', line);
  if (scope) write(`${scope}.log`, line);
}

function safeJson(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
  /** Child logger scoped to an issue identifier (also writes logs/<id>.log). */
  child(scope: string): Logger;
}

export function makeLogger(scope?: string): Logger {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
    child: (s) => makeLogger(s),
  };
}

export const logger = makeLogger();
