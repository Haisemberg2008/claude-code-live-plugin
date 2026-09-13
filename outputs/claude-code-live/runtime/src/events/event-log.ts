// Durable append-only JSONL event log with sequence numbers, crash recovery
// at exact byte boundaries, cursor replay and live subscription.
//
// One admission policy governs both ends: a record larger than MAX_RECORD_BYTES
// is refused at append time, so recovery never discards a record that was
// previously accepted. Caches and replay pages are bounded by bytes as well as
// by count, and a replay that cannot reach the caller's cursor says so instead
// of silently skipping events.
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { EventInput, EventRecord } from '../shared/types.ts';

export class EventLogError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EventLogError';
    this.code = code;
  }
}

const FORBIDDEN_KEYS = new Set(['thinking', 'redacted_thinking', 'signature', 'api_key', 'apikey', 'authorization', 'cookie', 'set-cookie', 'password', 'secret', 'private_key', 'privatekey']);
export const HIDDEN_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking', 'thinking_delta', 'signature_delta']);

/** Largest single record accepted and recovered, in bytes. */
export const MAX_RECORD_BYTES = 1024 * 1024;
const CACHE_MAX_RECORDS = 5000;
const CACHE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Keeps at most `limit` records and `byteBudget` bytes of the MOST RECENT
 * events seen, discarding older ones as it goes. Reading a log therefore costs
 * the budget, never the log size, and `dropped` states honestly that something
 * older than the returned page existed.
 */
class RollingWindow {
  private readonly records: EventRecord[] = [];
  private readonly sizes: number[] = [];
  private bytes = 0;
  private readonly limit: number;
  private readonly byteBudget: number;
  dropped = false;

  constructor(limit: number, byteBudget: number) {
    this.limit = limit;
    this.byteBudget = byteBudget;
  }

  push(event: EventRecord): void {
    const size = Buffer.byteLength(JSON.stringify(event), 'utf8');
    this.records.push(event);
    this.sizes.push(size);
    this.bytes += size;
    while (this.records.length > this.limit || (this.bytes > this.byteBudget && this.records.length > 1)) {
      this.records.shift();
      this.bytes -= this.sizes.shift() ?? 0;
      this.dropped = true;
    }
  }

  get events(): EventRecord[] {
    return this.records;
  }
}
const REPLAY_MAX_BYTES = 8 * 1024 * 1024;
const READ_CHUNK = 64 * 1024;

function scanForbidden(value: unknown, trail: string[] = []): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = scanForbidden(value[index], [...trail, String(index)]);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.type === 'string' && HIDDEN_BLOCK_TYPES.has(record.type)) return [...trail, `type=${record.type}`].join('.');
    for (const [key, child] of Object.entries(record)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) return [...trail, key].join('.');
      const hit = scanForbidden(child, [...trail, key]);
      if (hit) return hit;
    }
  }
  return null;
}

export interface RecoveryInfo {
  recovered: number;
  droppedPartialLine: boolean;
  corruptLines: number;
}

export interface EventPage {
  events: EventRecord[];
  /**
   * True when older events after the caller's cursor could not be included
   * within the page budget. The caller must treat its view as reset rather
   * than assume continuity.
   */
  gapped: boolean;
  /** Sequence of the first event in the page, or null for an empty page. */
  firstSeq: number | null;
}

export class EventLog {
  readonly file: string;
  recovery: RecoveryInfo = { recovered: 0, droppedPartialLine: false, corruptLines: 0 };
  private nextSeq = 1;
  private cache: EventRecord[] = [];
  private cacheBytes = 0;
  private cacheStartSeq = 1;
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(event: EventRecord) => void>();
  private closed = false;
  private needsSeparator = false;

  private constructor(file: string) {
    this.file = file;
  }

  static async open(file: string): Promise<EventLog> {
    const log = new EventLog(file);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await log.load();
    return log;
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  private pushCache(record: EventRecord, bytes: number): void {
    this.cache.push(record);
    this.cacheBytes += bytes;
    while (this.cache.length > CACHE_MAX_RECORDS || (this.cacheBytes > CACHE_MAX_BYTES && this.cache.length > 1)) {
      const dropped = this.cache.shift();
      if (!dropped) break;
      this.cacheBytes -= Buffer.byteLength(JSON.stringify(dropped), 'utf8');
      this.cacheStartSeq = this.cache[0]?.seq ?? this.nextSeq;
    }
    if (this.cache.length === 1) this.cacheStartSeq = record.seq;
  }

  private async load(): Promise<void> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.file, 'r');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        await fs.writeFile(this.file, '', 'utf8');
        return;
      }
      throw error;
    }
    let recovered = 0;
    let corrupt = 0;
    let last: EventRecord | null = null;
    const recent: Array<{ record: EventRecord; bytes: number }> = [];
    let recentBytes = 0;
    let truncateAt: number | null = null;
    let needsSeparator = false;
    try {
      const size = (await handle.stat()).size;
      const chunk = Buffer.alloc(READ_CHUNK);
      let position = 0;
      let pending: Buffer[] = [];
      let pendingBytes = 0;
      let pendingTooLong = false;
      let lineStart = 0;
      const consume = (bytes: Buffer): void => {
        if (bytes.length === 0) return;
        try {
          const parsed = JSON.parse(bytes.toString('utf8')) as EventRecord;
          if (typeof parsed.seq !== 'number' || typeof parsed.type !== 'string') throw new Error('registro sem seq/type');
          recovered += 1;
          last = parsed;
          recent.push({ record: parsed, bytes: bytes.length });
          recentBytes += bytes.length;
          // Both budgets are enforced WHILE recovering: 5000 records of any
          // size is not a memory bound, so bytes cap it too.
          while (recent.length > CACHE_MAX_RECORDS || (recentBytes > CACHE_MAX_BYTES && recent.length > 1)) {
            const dropped = recent.shift();
            if (!dropped) break;
            recentBytes -= dropped.bytes;
          }
        } catch {
          corrupt += 1;
        }
      };
      while (position < size) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        const base = position;
        position += bytesRead;
        let start = 0;
        for (let index = 0; index < bytesRead; index += 1) {
          if (chunk[index] !== 0x0a) continue;
          if (pendingTooLong) {
            corrupt += 1;
          } else {
            pending.push(Buffer.from(chunk.subarray(start, index)));
            consume(Buffer.concat(pending));
          }
          pending = [];
          pendingBytes = 0;
          pendingTooLong = false;
          lineStart = base + index + 1;
          start = index + 1;
        }
        if (start < bytesRead) {
          const remainder = bytesRead - start;
          if (pendingTooLong || pendingBytes + remainder > MAX_RECORD_BYTES) {
            pendingTooLong = true;
            pending = [];
            pendingBytes = 0;
          } else {
            pending.push(Buffer.from(chunk.subarray(start, bytesRead)));
            pendingBytes += remainder;
          }
        }
      }
      if (pendingTooLong) {
        truncateAt = lineStart;
      } else if (pendingBytes > 0) {
        const tail = Buffer.concat(pending);
        let valid = false;
        try {
          const parsed = JSON.parse(tail.toString('utf8')) as EventRecord;
          if (typeof parsed.seq === 'number' && typeof parsed.type === 'string') {
            recovered += 1;
            last = parsed;
            recent.push({ record: parsed, bytes: tail.length });
            recentBytes += tail.length;
            while (recent.length > CACHE_MAX_RECORDS || (recentBytes > CACHE_MAX_BYTES && recent.length > 1)) {
              const dropped = recent.shift();
              if (!dropped) break;
              recentBytes -= dropped.bytes;
            }
            valid = true;
          }
        } catch {
          valid = false;
        }
        if (valid) needsSeparator = true; else truncateAt = lineStart;
      }
    } finally {
      await handle.close();
    }
    if (truncateAt !== null) await fs.truncate(this.file, truncateAt);
    this.recovery = { recovered, droppedPartialLine: truncateAt !== null, corruptLines: corrupt };
    this.needsSeparator = needsSeparator;
    const lastRecord = last as EventRecord | null;
    this.nextSeq = (lastRecord?.seq ?? 0) + 1;
    this.cache = [];
    this.cacheBytes = 0;
    this.cacheStartSeq = this.nextSeq;
    for (const entry of recent) this.pushCache(entry.record, entry.bytes);
  }

  append(input: EventInput & { gseq?: number }): Promise<EventRecord> {
    const run = async (): Promise<EventRecord> => {
      if (this.closed) throw new EventLogError('EVENT_LOG_CLOSED', 'O log de eventos foi fechado.');
      // Clone at the boundary: the caller keeps no reference into the log.
      const data = JSON.parse(JSON.stringify(input.data ?? {})) as Record<string, unknown>;
      const forbidden = scanForbidden(data);
      if (forbidden) throw new EventLogError('EVENT_FORBIDDEN_FIELD', `Conteúdo oculto ou sensível em evento: ${forbidden}`);
      const record: EventRecord = {
        seq: this.nextSeq,
        ...(input.gseq !== undefined ? { gseq: input.gseq } : {}),
        ts: new Date().toISOString(),
        type: input.type,
        taskId: input.taskId,
        runId: input.runId,
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
        ...(input.toolUseId !== undefined ? { toolUseId: input.toolUseId } : {}),
        data,
      };
      const serialized = JSON.stringify(record);
      const bytes = Buffer.byteLength(serialized, 'utf8');
      if (bytes > MAX_RECORD_BYTES) {
        throw new EventLogError('EVENT_RECORD_TOO_LARGE', `Evento ${input.type} com ${bytes} bytes excede o limite de ${MAX_RECORD_BYTES}; use uma prévia limitada com armazenamento externo.`);
      }
      await fs.appendFile(this.file, `${this.needsSeparator ? '\n' : ''}${serialized}\n`, 'utf8');
      this.needsSeparator = false;
      this.nextSeq += 1;
      this.pushCache(record, bytes);
      for (const listener of this.listeners) {
        try {
          listener(structuredClone(record));
        } catch {
          // listeners must not break the writer
        }
      }
      return structuredClone(record);
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Convenience reader used by derivation and tests; unbounded by design. */
  async readFrom(cursor: number, limit = 100000): Promise<EventRecord[]> {
    return (await this.readPage(cursor, limit, Number.MAX_SAFE_INTEGER)).events;
  }

  /**
   * Reads events after `cursor`. When the page budget cannot cover everything,
   * the NEWEST events are returned and `gapped` is true, so the caller can
   * signal a view reset instead of silently losing history.
   */
  async readPage(cursor: number, limit = 2000, byteBudget = REPLAY_MAX_BYTES): Promise<EventPage> {
    await this.chain.catch(() => undefined);
    // The budgets are applied WHILE reading, through a rolling window: a log of
    // any size is paged without ever materialising it in memory.
    const window = new RollingWindow(limit, byteBudget);
    if (cursor + 1 >= this.cacheStartSeq) {
      for (const event of this.cache) if (event.seq > cursor) window.push(structuredClone(event));
    } else {
      const reader = readline.createInterface({ input: createReadStream(this.file, { encoding: 'utf8' }), crlfDelay: Infinity });
      try {
        for await (const line of reader) {
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as EventRecord;
            if (parsed.seq > cursor) window.push(parsed);
          } catch {
            // skip corrupt line
          }
        }
      } finally {
        reader.close();
      }
    }
    const page = window.events;
    return { events: page, gapped: window.dropped, firstSeq: page[0]?.seq ?? null };
  }

  /**
   * Reads the page immediately BEFORE `seq`, so a client can walk backwards
   * through history it never received instead of being told it is unavailable.
   * `more` reports whether older events still exist beyond this page.
   */
  async readBefore(seq: number, limit = 200, byteBudget = REPLAY_MAX_BYTES): Promise<{ events: EventRecord[]; more: boolean }> {
    await this.chain.catch(() => undefined);
    if (seq <= 1) return { events: [], more: false };
    const window = new RollingWindow(limit, byteBudget);
    let oldestSeen: number | null = null;
    const consider = (event: EventRecord): void => {
      if (event.seq >= seq) return;
      if (oldestSeen === null || event.seq < oldestSeen) oldestSeen = event.seq;
      window.push(event);
    };
    if (this.cacheStartSeq <= 1 || seq > this.cacheStartSeq) {
      for (const event of this.cache) consider(structuredClone(event));
    }
    if (this.cacheStartSeq > 1) {
      const reader = readline.createInterface({ input: createReadStream(this.file, { encoding: 'utf8' }), crlfDelay: Infinity });
      const disk = new RollingWindow(limit, byteBudget);
      let diskOldest: number | null = null;
      try {
        for await (const line of reader) {
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as EventRecord;
            if (parsed.seq >= seq) continue;
            if (diskOldest === null || parsed.seq < diskOldest) diskOldest = parsed.seq;
            disk.push(parsed);
          } catch {
            // skip corrupt line
          }
        }
      } finally {
        reader.close();
      }
      if (disk.events.length) return { events: disk.events, more: (disk.events[0]?.seq ?? 1) > 1 };
    }
    const events = window.events;
    return { events, more: (events[0]?.seq ?? 1) > 1 };
  }

  subscribe(listener: (event: EventRecord) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async close(): Promise<void> {
    await this.chain.catch(() => undefined);
    this.closed = true;
    this.listeners.clear();
  }
}
