// Local identities: the per-user secret (CLI and MCP), one-time bootstrap
// tokens that become HttpOnly browser sessions (optionally scoped to one
// task), and unguessable task handles minted by the registration bootstrap.
// Note: any process running as the same OS user can read the secret file;
// this is an application-level routing boundary, not process isolation.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ActionSource } from '../shared/types.ts';

/** Lifetime of a one-time dashboard link. */
export const BOOTSTRAP_TOKEN_TTL_MS = 10 * 60_000;

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface Identity {
  source: ActionSource;
  /** Task the browser session is limited to; null means all tasks (human local action). */
  taskScope: string | null;
  sessionId: string | null;
}

export interface BrowserSession {
  sessionId: string;
  cookie: string;
  taskScope: string | null;
  createdAt: string;
}

interface BootstrapToken {
  taskScope: string | null;
  createdAt: number;
  used: boolean;
}

export class IdentityRegistry {
  private secret = '';
  private readonly secretFile: string;
  private readonly bootstrapTokens = new Map<string, BootstrapToken>();
  private readonly sessions = new Map<string, BrowserSession>();

  constructor(brokerDir: string) {
    this.secretFile = path.join(brokerDir, 'secret');
  }

  get secretPath(): string {
    return this.secretFile;
  }

  async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.secretFile), { recursive: true });
    try {
      const existing = (await fs.readFile(this.secretFile, 'utf8')).trim();
      if (/^[A-Za-z0-9_-]{43,}$/.test(existing)) {
        this.secret = existing;
        return;
      }
    } catch {
      // create below
    }
    this.secret = randomToken(32);
    await fs.writeFile(this.secretFile, `${this.secret}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  verifySecret(candidate: string): boolean {
    return this.secret.length > 0 && safeEqual(candidate, this.secret);
  }

  /** Drops expired tokens. `keep` is evaluated by the caller, so its own expiry stays reportable. */
  private pruneBootstrapTokens(now = Date.now(), keep?: string): void {
    for (const [key, value] of this.bootstrapTokens) {
      if (key !== keep && now - value.createdAt > BOOTSTRAP_TOKEN_TTL_MS) this.bootstrapTokens.delete(key);
    }
  }

  mintBootstrapToken(taskScope: string | null): string {
    const token = randomToken(32);
    this.pruneBootstrapTokens();
    this.bootstrapTokens.set(token, { taskScope, createdAt: Date.now(), used: false });
    return token;
  }

  /** Single use AND time limited: an old unused link stops working on its own. */
  redeemBootstrapToken(token: string, now = Date.now()): { ok: true; session: BrowserSession } | { ok: false; code: 'BOOTSTRAP_TOKEN_INVALID' | 'BOOTSTRAP_TOKEN_USED' | 'BOOTSTRAP_TOKEN_EXPIRED' } {
    this.pruneBootstrapTokens(now, token);
    const entry = this.bootstrapTokens.get(token);
    if (!entry) return { ok: false, code: 'BOOTSTRAP_TOKEN_INVALID' };
    if (entry.used) return { ok: false, code: 'BOOTSTRAP_TOKEN_USED' };
    if (now - entry.createdAt > BOOTSTRAP_TOKEN_TTL_MS) {
      this.bootstrapTokens.delete(token);
      return { ok: false, code: 'BOOTSTRAP_TOKEN_EXPIRED' };
    }
    entry.used = true;
    const session: BrowserSession = { sessionId: `sess-${randomToken(8)}`, cookie: randomToken(32), taskScope: entry.taskScope, createdAt: new Date().toISOString() };
    this.sessions.set(session.cookie, session);
    return { ok: true, session };
  }

  sessionForCookie(cookie: string): BrowserSession | null {
    return this.sessions.get(cookie) ?? null;
  }
}

export function mintTaskHandle(): { handle: string; hash: string } {
  const handle = randomToken(32);
  return { handle, hash: sha256(handle) };
}

export function verifyTaskHandle(handle: string, hash: string | null): boolean {
  if (!hash || typeof handle !== 'string' || !/^[A-Za-z0-9_-]{43,}$/.test(handle)) return false;
  return safeEqual(sha256(handle), hash);
}

export const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function taskIdForThread(threadId: string): string {
  return `task-${sha256(threadId.toLowerCase()).slice(0, 16)}`;
}
