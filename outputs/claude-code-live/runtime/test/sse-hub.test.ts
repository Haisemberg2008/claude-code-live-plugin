import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { SseHub } from '../src/broker/sse-hub.ts';
import type { EventRecord } from '../src/shared/types.ts';

class FakeResponse extends EventEmitter {
  statusCode = 0;
  writableEnded = false;
  destroyed = false;
  writableLength = 0;
  readonly chunks: string[] = [];
  setHeader(): void {}
  flushHeaders(): void {}
  write(chunk: string): boolean { this.chunks.push(chunk); return true; }
  end(): void {
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.emit('close');
  }
}

test('an SSE replay-buffer overflow resets and closes so the client must resynchronise', async () => {
  const hub = new SseHub();
  const response = new FakeResponse();
  let release!: (value: { events: EventRecord[]; gapped: boolean }) => void;
  const replay = new Promise<{ events: EventRecord[]; gapped: boolean }>((resolve) => { release = resolve; });
  const attaching = hub.attach(response as unknown as ServerResponse, {
    taskId: null,
    taskScope: null,
    cursor: 0,
    epoch: 'epoch-a',
    replay: async () => replay,
    snapshots: () => [],
  });

  for (let seq = 1; seq <= 2001; seq += 1) {
    hub.broadcastEvent({ seq, gseq: seq, ts: 't', type: 'text_delta', taskId: 'task-a', runId: 'run-a', data: { text: 'x' } });
  }
  release({ events: [], gapped: false });
  await attaching;

  assert.equal(response.writableEnded, true, 'a stream with an irreparable interval is not kept alive');
  assert.match(response.chunks.join(''), /REPLAY_BUFFER_OVERFLOW/);
  assert.equal(hub.size, 0, 'the closed client is detached');
});
