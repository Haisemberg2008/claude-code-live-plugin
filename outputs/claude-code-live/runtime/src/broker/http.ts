// HTTP plumbing for the loopback broker: security headers, host/origin/CSRF
// validation, identity resolution, JSON bodies and a fixed static allowlist.
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Identity, IdentityRegistry } from './identity.ts';

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
export const SESSION_COOKIE = 'codeorquestra_session';
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'codeorquestra';
export const CLIENT_HEADER = 'x-codeorquestra-client';

export class HttpError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, code: string, extra: Record<string, unknown> = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('cache-control', 'no-store');
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(text));
  res.end(text);
}

export function sendError(res: ServerResponse, error: HttpError): void {
  sendJson(res, error.status, { error: error.code, ...error.extra });
}

export function assertHost(req: IncomingMessage, port: number): void {
  const host = (req.headers.host ?? '').trim().toLowerCase();
  if (host !== `127.0.0.1:${port}`) throw new HttpError(403, 'HOST_NOT_ALLOWED');
}

function parseCookies(header: string | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    output[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return output;
}

export function resolveIdentity(req: IncomingMessage, registry: IdentityRegistry): Identity | null {
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    const token = authorization.slice('Bearer '.length).trim();
    if (registry.verifySecret(token)) {
      const client = String(req.headers[CLIENT_HEADER] ?? '').toLowerCase();
      return { source: client === 'mcp' ? 'mcp' : 'local-secret', taskScope: null, sessionId: null };
    }
    return null;
  }
  const cookies = parseCookies(req.headers.cookie);
  const cookie = cookies[SESSION_COOKIE];
  if (cookie) {
    const session = registry.sessionForCookie(cookie);
    if (session) return { source: 'browser', taskScope: session.taskScope, sessionId: session.sessionId };
  }
  return null;
}

export function assertActionAllowed(req: IncomingMessage, identity: Identity, baseUrl: string): void {
  if (identity.source !== 'browser') return;
  const header = String(req.headers[CSRF_HEADER] ?? '');
  if (header !== CSRF_VALUE) throw new HttpError(403, 'CSRF_HEADER_REQUIRED');
  const origin = String(req.headers.origin ?? '');
  if (origin !== baseUrl) throw new HttpError(403, 'ORIGIN_NOT_ALLOWED');
}

export async function readJsonBody(req: IncomingMessage, limit = 1_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new HttpError(413, 'BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'BODY_INVALID');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'BODY_INVALID');
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Fixed allowlist of static files discovered once at startup. */
export class StaticAssets {
  private readonly files = new Map<string, string>();
  readonly dir: string | null;

  constructor(dir: string | null) {
    this.dir = dir;
  }

  async load(): Promise<void> {
    if (!this.dir) return;
    const walk = async (current: string, prefix: string): Promise<void> => {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        const url = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) await walk(full, url);
        else if (entry.isFile()) this.files.set(url, full);
      }
    };
    await walk(this.dir, '');
  }

  resolve(urlPath: string): string | null {
    const key = urlPath === '/' ? '/index.html' : urlPath;
    if (!/^\/[A-Za-z0-9._\-/]+$/.test(key) || key.includes('..') || key.includes('//')) return null;
    return this.files.get(key) ?? null;
  }

  async serve(urlPath: string, res: ServerResponse): Promise<boolean> {
    const file = this.resolve(urlPath);
    if (!file) return false;
    const content = await fs.readFile(file);
    res.statusCode = 200;
    res.setHeader('content-type', CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('content-length', content.length);
    res.end(content);
    return true;
  }
}
