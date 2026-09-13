import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type { CodexRateLimitBucket, CodexRateLimitWindow, CodexUsageView } from '../shared/types.ts';

type Availability = 'reported' | 'estimated' | 'partial' | 'unavailable';

export interface CodexUsageServiceOptions {
  command?: string;
  args?: string[];
  minRefreshMs?: number;
  requestTimeoutMs?: number;
}

export interface CodexUsageReader {
  refresh(threadId: string | null, options?: { force?: boolean }): Promise<CodexUsageView>;
  stop(): Promise<void>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function boundedText(value: unknown, max = 80): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function unavailableCodexUsage(code: string | null = null, queriedAt: string | null = null): CodexUsageView {
  return {
    quality: 'unavailable',
    queriedAt,
    limits: { quality: 'unavailable', buckets: [] },
    activity: { quality: 'unavailable', lifetimeTokens: null, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null, daily: [] },
    task: { quality: 'unavailable', groups: [] },
    failure: code ? { code } : null,
  };
}

function window(value: unknown): CodexRateLimitWindow | null {
  const item = record(value);
  const used = integer(item?.usedPercent);
  if (used === null) return null;
  const usedPercent = Math.min(100, used);
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowDurationMins: integer(item?.windowDurationMins),
    resetsAt: integer(item?.resetsAt),
  };
}

function limits(value: unknown): CodexUsageView['limits'] {
  const response = record(value);
  const multiple = record(response?.rateLimitsByLimitId);
  const candidates: Array<[string, unknown]> = multiple && Object.keys(multiple).length
    ? Object.entries(multiple).slice(0, 16)
    : [['codex', response?.rateLimits]];
  const buckets = candidates.flatMap(([fallbackId, raw]) => {
    const item = record(raw);
    if (!item) return [];
    const primary = window(item.primary);
    const secondary = window(item.secondary);
    if (!primary && !secondary) return [];
    return [{
      id: boundedText(item.limitId) ?? fallbackId.slice(0, 80),
      name: boundedText(item.limitName),
      planType: boundedText(item.planType),
      primary,
      secondary,
    }];
  });
  return { quality: buckets.length ? 'reported' : 'unavailable', buckets };
}

function activity(value: unknown): CodexUsageView['activity'] {
  const response = record(value);
  const summary = record(response?.summary);
  const daily = Array.isArray(response?.dailyUsageBuckets) ? response.dailyUsageBuckets.slice(0, 400).flatMap((raw) => {
    const item = record(raw);
    const startDate = boundedText(item?.startDate, 20);
    const tokens = integer(item?.tokens);
    return startDate && tokens !== null ? [{ startDate, tokens }] : [];
  }) : [];
  const result = {
    quality: 'unavailable' as 'reported' | 'partial' | 'unavailable',
    lifetimeTokens: integer(summary?.lifetimeTokens),
    peakDailyTokens: integer(summary?.peakDailyTokens),
    longestRunningTurnSec: integer(summary?.longestRunningTurnSec),
    currentStreakDays: integer(summary?.currentStreakDays),
    longestStreakDays: integer(summary?.longestStreakDays),
    daily,
  };
  const fields = [result.lifetimeTokens, result.peakDailyTokens, result.longestRunningTurnSec, result.currentStreakDays, result.longestStreakDays];
  if (fields.some((item) => item !== null) || daily.length) result.quality = fields.every((item) => item !== null) ? 'reported' : 'partial';
  return result;
}

function taskUsage(value: unknown): CodexUsageView['task'] {
  const response = record(value);
  const usage = record(response?.threadUsage);
  if (!usage || !Array.isArray(usage.groups)) return { quality: 'unavailable', groups: [] };
  const groups = usage.groups.slice(0, 32).flatMap((raw) => {
    const item = record(raw);
    if (!item) return [];
    return [{
      model: boundedText(item.model),
      reasoningEffort: boundedText(item.reasoningEffort),
      inputTokens: integer(item.inputTokens),
      cachedInputTokens: integer(item.cachedInputTokens),
      netNewInputTokens: integer(item.netNewInputTokens),
      outputTokens: integer(item.outputTokens),
      totalTokens: integer(item.totalTokens),
    }];
  });
  if (!groups.length) return { quality: 'unavailable', groups: [] };
  const complete = groups.every((group) => group.inputTokens !== null && group.outputTokens !== null && group.totalTokens !== null);
  return { quality: complete ? 'estimated' : 'partial', groups };
}

export class CodexUsageService implements CodexUsageReader {
  private readonly command: string;
  private readonly args: string[];
  private readonly minRefreshMs: number;
  private readonly requestTimeoutMs: number;
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private cache = new Map<string, { at: number; value: CodexUsageView }>();
  private refreshes = new Map<string, Promise<CodexUsageView>>();

  constructor(options: CodexUsageServiceOptions = {}) {
    this.command = options.command ?? 'codex';
    this.args = options.args ?? ['app-server', '--listen', 'stdio://'];
    this.minRefreshMs = Math.max(0, options.minRefreshMs ?? 30_000);
    this.requestTimeoutMs = Math.max(100, options.requestTimeoutMs ?? 5_000);
  }

  async refresh(threadId: string | null, options: { force?: boolean } = {}): Promise<CodexUsageView> {
    const key = threadId ?? '';
    const cached = this.cache.get(key);
    if (!options.force && cached && Date.now() - cached.at < this.minRefreshMs) return cached.value;
    const active = this.refreshes.get(key);
    if (active) return active;
    const refresh = this.read(threadId).finally(() => this.refreshes.delete(key));
    this.refreshes.set(key, refresh);
    return refresh;
  }

  private async read(threadId: string | null): Promise<CodexUsageView> {
    try {
      await this.ensureReady();
      const [rateRead, activityRead, taskRead] = await Promise.all([
        this.request('account/rateLimits/read', null).then((value) => ({ ok: true as const, value }), () => ({ ok: false as const, value: null })),
        this.request('account/usage/read', null).then((value) => ({ ok: true as const, value }), () => ({ ok: false as const, value: null })),
        threadId
          ? this.request('account/usage/read', { threadId }).then((value) => ({ ok: true as const, value }), () => ({ ok: false as const, value: null }))
          : Promise.resolve({ ok: true as const, value: null }),
      ]);
      const limitView = rateRead.ok ? limits(rateRead.value) : { quality: 'unavailable' as const, buckets: [] };
      const activityView = activityRead.ok ? activity(activityRead.value) : unavailableCodexUsage().activity;
      const taskView = threadId && taskRead.ok ? taskUsage(taskRead.value) : { quality: 'unavailable' as const, groups: [] };
      const qualities: Availability[] = [limitView.quality, activityView.quality, taskView.quality];
      const quality = qualities.every((item) => item === 'reported' || item === 'estimated') ? 'reported' : qualities.some((item) => item !== 'unavailable') ? 'partial' : 'unavailable';
      const value: CodexUsageView = {
        quality,
        queriedAt: new Date().toISOString(),
        limits: limitView,
        activity: activityView,
        task: taskView,
        failure: [rateRead, activityRead, taskRead].some((item) => !item.ok) ? { code: quality === 'unavailable' ? 'CODEX_USAGE_UNAVAILABLE' : 'CODEX_USAGE_PARTIAL' } : null,
      };
      this.cache.set(threadId ?? '', { at: Date.now(), value });
      return value;
    } catch (error) {
      const code = error instanceof Error && error.message.startsWith('CODEX_USAGE_') ? (error.message.split(':', 1)[0] ?? 'CODEX_USAGE_UNAVAILABLE') : 'CODEX_USAGE_UNAVAILABLE';
      const value = unavailableCodexUsage(code, new Date().toISOString());
      this.cache.set(threadId ?? '', { at: Date.now(), value });
      return value;
    }
  }

  private ensureReady(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const child = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.child = child;
      // Diagnostics are intentionally not persisted; draining prevents a
      // verbose local App Server from blocking on a full stderr pipe.
      child.stderr.resume();
      const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      reader.on('line', (line) => this.onLine(line));
      const fail = (code: string) => {
        const error = new Error(code);
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
        this.pending.clear();
        this.child = null;
        this.ready = null;
        reject(error);
      };
      child.once('error', () => fail('CODEX_USAGE_START_FAILED'));
      child.once('exit', () => fail('CODEX_USAGE_APP_SERVER_EXITED'));
      this.request('initialize', { clientInfo: { name: 'codeorquestra', title: 'CodeOrquestra', version: '0.1.0' }, capabilities: null }, child)
        .then(() => resolve(), () => {
          this.breakConnection('CODEX_USAGE_INITIALIZE_FAILED');
          reject(new Error('CODEX_USAGE_INITIALIZE_FAILED'));
        });
    });
    return this.ready;
  }

  private request(method: string, params: unknown, child = this.child): Promise<unknown> {
    if (!child?.stdin.writable) return Promise.reject(new Error('CODEX_USAGE_NOT_CONNECTED'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CODEX_USAGE_REQUEST_TIMEOUT'));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new Error('CODEX_USAGE_WRITE_FAILED'));
      });
    });
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.breakConnection('CODEX_USAGE_INVALID_RESPONSE');
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error('CODEX_USAGE_REQUEST_REJECTED'));
    else pending.resolve(message.result);
  }

  private breakConnection(code: string): void {
    const error = new Error(code);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.ready = null;
    this.cache.clear();
    this.breakConnection('CODEX_USAGE_STOPPED');
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      timer.unref?.();
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
  }
}
