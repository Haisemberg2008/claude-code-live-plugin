// Crash-safe state files with Windows sharing-mode awareness. Readers that
// hold a file without FILE_SHARE_DELETE (PowerShell Get-Content, editors)
// make the atomic rename fail with EPERM/EBUSY; the writer retries within a
// bound and reports the failure instead of crashing the caller.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export class StateFileError extends Error {
  code: string;
  path: string;
  attempts: number;
  innerCode: string | null;
  constructor(code: string, filePath: string, attempts: number, inner?: unknown) {
    const innerCode = inner && typeof inner === 'object' && 'code' in inner ? String((inner as { code: unknown }).code) : null;
    super(`${code}: ${path.basename(filePath)} (${attempts} tentativas${innerCode ? `, erro interno ${innerCode}` : ''})`);
    this.name = 'StateFileError';
    this.code = code;
    this.path = filePath;
    this.attempts = attempts;
    this.innerCode = innerCode;
  }
}

export interface AtomicWriteOptions {
  maxWaitMs?: number;
  retryDelayMs?: number;
  createDirectory?: boolean;
}

export interface AtomicWriteOutcome {
  attempts: number;
  waitedMs: number;
}

const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EEXIST', 'ETXTBSY']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function writeFileAtomic(filePath: string, content: string | Uint8Array, options: AtomicWriteOptions = {}): Promise<AtomicWriteOutcome> {
  const maxWaitMs = options.maxWaitMs ?? 3000;
  const retryDelayMs = options.retryDelayMs ?? 25;
  if (options.createDirectory !== false) await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temp, content, typeof content === 'string' ? { encoding: 'utf8' } : undefined);
  const started = Date.now();
  let attempts = 0;
  let lastError: unknown;
  for (;;) {
    attempts += 1;
    try {
      await fs.rename(temp, filePath);
      return { attempts, waitedMs: Date.now() - started };
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string }).code ?? '';
      const elapsed = Date.now() - started;
      if (!TRANSIENT_CODES.has(code) || elapsed >= maxWaitMs) break;
      await sleep(Math.min(retryDelayMs, Math.max(1, maxWaitMs - elapsed)));
    }
  }
  await fs.rm(temp, { force: true }).catch(() => undefined);
  const code = (lastError as { code?: string }).code ?? '';
  throw new StateFileError(TRANSIENT_CODES.has(code) ? 'STATE_FILE_BUSY' : 'STATE_FILE_WRITE_FAILED', filePath, attempts, lastError);
}

export type ReadJsonResult<T> = { status: 'ok'; value: T } | { status: 'missing' } | { status: 'invalid'; error: string };

export async function readJsonShared<T = unknown>(filePath: string, options: { retryMs?: number } = {}): Promise<ReadJsonResult<T>> {
  const retryMs = options.retryMs ?? 250;
  const started = Date.now();
  for (;;) {
    try {
      const text = await fs.readFile(filePath, 'utf8');
      try {
        return { status: 'ok', value: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as T };
      } catch (error) {
        if (Date.now() - started < retryMs) {
          await sleep(10);
          continue;
        }
        return { status: 'invalid', error: (error as Error).message };
      }
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      if (code === 'ENOENT') {
        if (Date.now() - started < 50) {
          await sleep(5);
          continue;
        }
        return { status: 'missing' };
      }
      if (TRANSIENT_CODES.has(code) && Date.now() - started < retryMs) {
        await sleep(10);
        continue;
      }
      return { status: 'invalid', error: code || (error as Error).message };
    }
  }
}

export async function appendTextSafe(filePath: string, text: string, options: { maxWaitMs?: number } = {}): Promise<void> {
  const maxWaitMs = options.maxWaitMs ?? 2000;
  const started = Date.now();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  for (;;) {
    try {
      await fs.appendFile(filePath, text, 'utf8');
      return;
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      if (!TRANSIENT_CODES.has(code) || Date.now() - started >= maxWaitMs) throw new StateFileError('STATE_FILE_BUSY', filePath, 1, error);
      await sleep(20);
    }
  }
}

export interface TelemetryFailure {
  file: string;
  code: string;
  innerCode: string | null;
  at: string;
}

export interface StateWriterOptions {
  directory: string;
  telemetryMaxWaitMs?: number;
  finalMaxWaitMs?: number;
  fallbackFileName?: string;
  createDirectory?: boolean;
  onTelemetryFailure?: (failure: TelemetryFailure) => void;
}

export type TelemetryOutcome = { ok: true; file: string } | { ok: false; file: string; code: string };
export type FinalResultOutcome = { ok: true; path: string; fallback: boolean; attempts: number };

/** Distinguishes nonfatal telemetry (status.json) from the final result. */
export class StateWriter {
  readonly directory: string;
  readonly failures: TelemetryFailure[] = [];
  private readonly telemetryMaxWaitMs: number;
  private readonly finalMaxWaitMs: number;
  private readonly fallbackFileName: string;
  private readonly createDirectory: boolean;
  private readonly onTelemetryFailure: ((failure: TelemetryFailure) => void) | undefined;

  constructor(options: StateWriterOptions) {
    this.directory = options.directory;
    this.telemetryMaxWaitMs = options.telemetryMaxWaitMs ?? 1500;
    this.finalMaxWaitMs = options.finalMaxWaitMs ?? 15000;
    this.fallbackFileName = options.fallbackFileName ?? 'resultado.fallback.json';
    this.createDirectory = options.createDirectory !== false;
    this.onTelemetryFailure = options.onTelemetryFailure;
  }

  async writeTelemetry(fileName: string, record: unknown): Promise<TelemetryOutcome> {
    const target = path.join(this.directory, fileName);
    try {
      await writeFileAtomic(target, JSON.stringify(record, null, 2), { maxWaitMs: this.telemetryMaxWaitMs, createDirectory: this.createDirectory });
      return { ok: true, file: fileName };
    } catch (error) {
      const code = error instanceof StateFileError ? error.code : 'STATE_FILE_WRITE_FAILED';
      const failure: TelemetryFailure = { file: fileName, code, innerCode: error instanceof StateFileError ? error.innerCode : null, at: new Date().toISOString() };
      this.failures.push(failure);
      this.onTelemetryFailure?.(failure);
      return { ok: false, file: fileName, code };
    }
  }

  writeStatus(record: unknown): Promise<TelemetryOutcome> {
    return this.writeTelemetry('status.json', record);
  }

  async writeFinalResult(record: Record<string, unknown>, fileName = 'resultado.json'): Promise<FinalResultOutcome> {
    const primary = path.join(this.directory, fileName);
    try {
      const outcome = await writeFileAtomic(primary, JSON.stringify(record, null, 2), { maxWaitMs: this.finalMaxWaitMs, createDirectory: this.createDirectory });
      return { ok: true, path: primary, fallback: false, attempts: outcome.attempts };
    } catch (primaryError) {
      const primaryCode = primaryError instanceof StateFileError ? primaryError.code : 'STATE_FILE_WRITE_FAILED';
      const fallbackPath = path.join(this.directory, this.fallbackFileName);
      const fallbackRecord = {
        ...record,
        persistence: {
          primaryFile: fileName,
          code: primaryCode,
          innerCode: primaryError instanceof StateFileError ? primaryError.innerCode : null,
          fallbackWrittenAt: new Date().toISOString(),
          note: 'O arquivo primário permaneceu ocupado por outro processo; este fallback é o resultado final durável.',
        },
      };
      try {
        const outcome = await writeFileAtomic(fallbackPath, JSON.stringify(fallbackRecord, null, 2), { maxWaitMs: this.finalMaxWaitMs, createDirectory: this.createDirectory });
        return { ok: true, path: fallbackPath, fallback: true, attempts: outcome.attempts };
      } catch (fallbackError) {
        const error = new StateFileError('FINAL_RESULT_NOT_PERSISTED', primary, primaryError instanceof StateFileError ? primaryError.attempts : 1, fallbackError);
        error.message = `FINAL_RESULT_NOT_PERSISTED: nem ${fileName} nem ${this.fallbackFileName} puderam ser gravados (${primaryCode}; fallback ${(fallbackError as { code?: string }).code ?? 'desconhecido'}).`;
        throw error;
      }
    }
  }
}
