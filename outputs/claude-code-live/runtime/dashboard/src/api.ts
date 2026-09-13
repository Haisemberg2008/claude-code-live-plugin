// Same-origin API client. The session cookie is HttpOnly and sent
// automatically; every action carries the CSRF header the broker requires.
import type { EventRecord, StatusResponse, TaskView, TransientFrame } from '../../src/shared/types.ts';

const ACTION_HEADERS = { 'x-requested-with': 'codeorquestra', 'content-type': 'application/json' };

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string });
  if (!response.ok) throw new ApiError(response.status, body.error ?? `HTTP_${response.status}`);
  return body;
}

export async function getStatus(): Promise<StatusResponse> {
  return parse<StatusResponse>(await fetch('/api/status', { credentials: 'same-origin' }));
}

export async function getTask(taskId: string): Promise<TaskView> {
  return parse<TaskView>(await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { credentials: 'same-origin' }));
}

export interface EventPageResponse {
  events: EventRecord[];
  cursor: number;
  gapped: boolean;
  /** Present on backward pages: older events still exist beyond this one. */
  more?: boolean;
  cursorEpoch: string;
  task: TaskView;
}

export async function getEvents(taskId: string, cursor: number, limit = 2000): Promise<EventPageResponse> {
  return parse<EventPageResponse>(await fetch(`/api/tasks/${encodeURIComponent(taskId)}/events?cursor=${cursor}&limit=${limit}&waitMs=0`, { credentials: 'same-origin' }));
}

/** Fetches the page of history immediately before `beforeSeq` from the broker. */
export async function getEventsBefore(taskId: string, beforeSeq: number, limit = 500): Promise<EventPageResponse> {
  return parse<EventPageResponse>(await fetch(`/api/tasks/${encodeURIComponent(taskId)}/events?before=${beforeSeq}&limit=${limit}&waitMs=0`, { credentials: 'same-origin' }));
}

export async function postAction(taskId: string, action: string, body: Record<string, unknown>): Promise<unknown> {
  return parse<unknown>(await fetch(`/api/tasks/${encodeURIComponent(taskId)}/${action}`, { method: 'POST', credentials: 'same-origin', headers: ACTION_HEADERS, body: JSON.stringify(body) }));
}

export async function getBlobPage(taskId: string, blobId: string, page: number): Promise<{ page: number; pages: number; text: string; truncated: boolean; totalChars: number }> {
  return parse(await fetch(`/api/tasks/${encodeURIComponent(taskId)}/blobs/${encodeURIComponent(blobId)}?page=${page}`, { credentials: 'same-origin' }));
}

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'unauthorized';

export interface StreamHandlers {
  onEvent: (event: EventRecord) => void;
  onTask: (task: TaskView) => void;
  onTransient: (frame: TransientFrame) => void;
  onState: (state: ConnectionState) => void;
  onReset: (info: { reason: string; epoch: string }) => void;
  onReady: (info: { cursor: number; epoch: string }) => void;
}

/**
 * SSE subscription with cursor-based reconnect. The server deduplicates by
 * sequence and announces a reset when it cannot cover the cursor, so the
 * client never silently believes it has a complete history.
 */
export function subscribe(handlers: StreamHandlers, getCursor: () => number, getEpoch: () => string | null): () => void {
  let source: EventSource | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  const open = () => {
    if (closed) return;
    handlers.onState(source ? 'reconnecting' : 'connecting');
    const epoch = getEpoch();
    source = new EventSource(`/api/events?cursor=${getCursor()}${epoch ? `&epoch=${encodeURIComponent(epoch)}` : ''}`);
    source.addEventListener('ready', (message) => {
      attempts = 0;
      handlers.onState('open');
      handlers.onReady(JSON.parse((message as MessageEvent).data) as { cursor: number; epoch: string });
    });
    source.addEventListener('reset', (message) => handlers.onReset(JSON.parse((message as MessageEvent).data) as { reason: string; epoch: string }));
    source.addEventListener('event', (message) => handlers.onEvent(JSON.parse((message as MessageEvent).data) as EventRecord));
    source.addEventListener('task', (message) => handlers.onTask(JSON.parse((message as MessageEvent).data) as TaskView));
    source.addEventListener('transient', (message) => handlers.onTransient(JSON.parse((message as MessageEvent).data) as TransientFrame));
    source.onerror = () => {
      source?.close();
      source = null;
      if (closed) return;
      attempts += 1;
      // The session cookie is one-time and can expire; after repeated
      // failures, check whether we are simply no longer authenticated.
      void fetch('/api/health', { credentials: 'same-origin' }).then((response) => {
        if (response.status === 401) {
          handlers.onState('unauthorized');
          closed = true;
          return;
        }
        handlers.onState('reconnecting');
        retry = setTimeout(open, Math.min(10000, 500 * attempts));
      }).catch(() => {
        handlers.onState('reconnecting');
        retry = setTimeout(open, Math.min(10000, 500 * attempts));
      });
    };
  };
  open();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    source?.close();
  };
}
