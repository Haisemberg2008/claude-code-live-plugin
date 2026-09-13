import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface TempRoot {
  root: string;
  cleanup(): Promise<void>;
}

/** Creates an isolated temporary directory; callers must await cleanup(). */
export async function makeTempRoot(prefix = 'codeorquestra-test-'): Promise<TempRoot> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    root,
    async cleanup() {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${options.description ?? 'condition'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
