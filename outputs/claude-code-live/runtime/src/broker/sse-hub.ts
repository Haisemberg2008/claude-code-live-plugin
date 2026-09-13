// Server-sent events with cursor replay. Subscribers are registered BEFORE
// history is replayed and live events are deduplicated by sequence, so an
// event appended during the history fetch is neither lost nor duplicated.
import type { ServerResponse } from 'node:http';
import type { EventRecord, TaskView, TransientFrame } from '../shared/types.ts';

export interface SseClient {
  res: ServerResponse;
  taskId: string | null;
  taskScope: string | null;
  lastGseq: number;
  buffered: EventRecord[];
  bufferedBytes: number;
  /** Set when live events outgrew the replay buffer; the client must resync. */
  overflowed: boolean;
  replaying: boolean;
  heartbeat: NodeJS.Timeout;
}

const MAX_BUFFERED_BYTES = 1024 * 1024;
/**
 * Budgets for events that arrive WHILE history is being replayed. Without them
 * a busy task could buffer without limit in the gap between subscribing and
 * finishing the replay. When the budget is exceeded the client is told to
 * resync instead of being handed a silently incomplete stream.
 */
const MAX_REPLAY_BUFFER_EVENTS = 2000;
const MAX_REPLAY_BUFFER_BYTES = 4 * 1024 * 1024;

export class SseHub {
  private readonly clients = new Set<SseClient>();

  get size(): number {
    return this.clients.size;
  }

  async attach(res: ServerResponse, options: {
    taskId: string | null;
    taskScope: string | null;
    cursor: number;
    epoch: string;
    replay: (cursor: number, taskId: string | null, taskScope: string | null) => Promise<{ events: EventRecord[]; gapped: boolean }>;
    snapshots: () => TaskView[];
  }): Promise<SseClient> {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();
    const client: SseClient = {
      res,
      taskId: options.taskId,
      taskScope: options.taskScope,
      lastGseq: options.cursor,
      buffered: [],
      bufferedBytes: 0,
      overflowed: false,
      replaying: true,
      heartbeat: setInterval(() => { if (!res.writableEnded) res.write(': keep-alive\n\n'); }, 15000),
    };
    client.heartbeat.unref();
    this.clients.add(client);
    res.on('close', () => this.detach(client));
    this.write(client, `event: ready\ndata: ${JSON.stringify({ cursor: options.cursor, epoch: options.epoch })}\n\n`);
    for (const view of options.snapshots()) if (this.visible(client, view.taskId)) this.write(client, `event: task\ndata: ${JSON.stringify(view)}\n\n`);
    // History after the subscription was registered (live events buffer meanwhile).
    const history = await options.replay(options.cursor, options.taskId, options.taskScope);
    if (history.gapped) {
      // Continuity cannot be promised for this cursor; say so instead of
      // letting the client believe it has the full history.
      this.write(client, `event: reset\ndata: ${JSON.stringify({ reason: 'HISTORY_GAP', from: history.events[0]?.gseq ?? null, epoch: options.epoch })}\n\n`);
      client.lastGseq = Math.max(0, (history.events[0]?.gseq ?? 1) - 1);
    }
    for (const event of history.events) this.deliver(client, event);
    client.replaying = false;
    if (client.overflowed) {
      this.write(client, `event: reset\ndata: ${JSON.stringify({ reason: 'REPLAY_BUFFER_OVERFLOW', from: null, epoch: options.epoch })}\n\n`);
      client.buffered.length = 0;
      client.bufferedBytes = 0;
      // This connection has an irreparable hole: keeping it alive would let
      // later events continue after the discarded interval. Close it after the
      // explicit reset so EventSource reconnects from the reset cursor and
      // obtains one coherent replay.
      res.end();
      this.detach(client);
      return client;
    }
    for (const event of client.buffered.splice(0)) this.deliver(client, event);
    client.bufferedBytes = 0;
    return client;
  }

  private visible(client: SseClient, taskId: string): boolean {
    if (client.taskScope && client.taskScope !== taskId) return false;
    if (client.taskId && client.taskId !== taskId) return false;
    return true;
  }

  private deliver(client: SseClient, event: EventRecord): void {
    const gseq = event.gseq ?? 0;
    if (gseq <= client.lastGseq) return;
    client.lastGseq = gseq;
    this.write(client, `id: ${gseq}\nevent: event\ndata: ${JSON.stringify(event)}\n\n`);
  }

  private write(client: SseClient, chunk: string): void {
    const res = client.res;
    if (res.writableEnded || res.destroyed) return;
    const ok = res.write(chunk);
    if (!ok && res.writableLength > MAX_BUFFERED_BYTES) {
      // Backpressure: drop the slow client; it reconnects with its cursor.
      res.end();
      this.detach(client);
    }
  }

  detach(client: SseClient): void {
    clearInterval(client.heartbeat);
    this.clients.delete(client);
  }

  broadcastEvent(event: EventRecord): void {
    for (const client of this.clients) {
      if (!this.visible(client, event.taskId)) continue;
      if (!client.replaying) {
        this.deliver(client, event);
        continue;
      }
      if (client.overflowed) continue;
      client.buffered.push(event);
      client.bufferedBytes += Buffer.byteLength(JSON.stringify(event), 'utf8');
      if (client.buffered.length > MAX_REPLAY_BUFFER_EVENTS || client.bufferedBytes > MAX_REPLAY_BUFFER_BYTES) {
        // Too much arrived during the replay to hold. Drop the buffer and say
        // so: a reset is honest, a truncated stream would not be.
        client.overflowed = true;
        client.buffered.length = 0;
        client.bufferedBytes = 0;
      }
    }
  }

  broadcastTask(view: TaskView): void {
    for (const client of this.clients) if (this.visible(client, view.taskId)) this.write(client, `event: task\ndata: ${JSON.stringify(view)}\n\n`);
  }

  broadcastTransient(frame: TransientFrame): void {
    for (const client of this.clients) if (this.visible(client, frame.taskId) && !client.replaying) this.write(client, `event: transient\ndata: ${JSON.stringify(frame)}\n\n`);
  }

  closeAll(): void {
    for (const client of this.clients) {
      clearInterval(client.heartbeat);
      try { client.res.end(); } catch { /* ignore */ }
    }
    this.clients.clear();
  }
}
