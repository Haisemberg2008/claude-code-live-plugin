// Best-effort redaction of credential-shaped text and removal of hidden
// reasoning from CLI frames.
//
// Redaction reduces exposure; it is NOT a guarantee. Callers must still keep
// secrets out of prompts, jobs and workspaces. For streamed text the emitter
// withholds any tail that could still grow into a credential, so a secret
// split across transport chunks is not published before it can be recognised;
// a value that matches no known shape is not recognised at all.

export const REDACTED = '[REDIGIDO]';

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

const SECRET_KEYS = 'password|passwd|pwd|senha|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token';
const KEY_VALUE = new RegExp(`\\b(${SECRET_KEYS})(\\s*[=:]\\s*)(?!\\[REDIGIDO\\])("[^"]*"|'[^']*'|\\S+)`, 'gi');
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+(?::[^\s/@]*)?)@/gi;

export function redactUrlUserinfo(text: string): string {
  return text.replace(URL_USERINFO, `$1${REDACTED}@`);
}

export function redactSensitiveText(text: string): string {
  if (!text) return text;
  let output = text;
  for (const pattern of PATTERNS) output = output.replace(pattern, REDACTED);
  output = output.replace(KEY_VALUE, (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`);
  output = redactUrlUserinfo(output);
  return output;
}

/** Moves a streaming cut to the start of any recognised secret it intersects. */
function boundaryOutsideSensitiveSpan(text: string, boundary: number): number {
  let safe = boundary;
  const expressions = [...PATTERNS, KEY_VALUE, URL_USERINFO];
  for (const expression of expressions) {
    const flags = expression.flags.includes('g') ? expression.flags : `${expression.flags}g`;
    const scanner = new RegExp(expression.source, flags);
    for (const match of text.matchAll(scanner)) {
      const start = match.index;
      const end = start + match[0].length;
      if (start < safe && safe < end) safe = start;
    }
  }
  return safe;
}

export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSensitiveText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as T;
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) output[key] = redactDeep(child);
    return output as T;
  }
  return value;
}

/**
 * Tails that could still grow into one of the recognised credential shapes.
 * Each pattern is anchored at the end of the buffer, so a candidate closes as
 * soon as a character arrives that the full shape could not contain.
 */
const OPEN_CANDIDATES: RegExp[] = [
  /sk-[A-Za-z0-9_-]*$/,
  /\bBearer(\s+[A-Za-z0-9._~+/=-]*)?$/,
  /\bAKIA[0-9A-Z]*$/,
  /\bgh[pousr]_[A-Za-z0-9]*$/,
  /\bgithub_pat_[A-Za-z0-9_]*$/,
  /\bxox[baprs]-[A-Za-z0-9-]*$/,
  /\bAIza[0-9A-Za-z_-]*$/,
  /\beyJ[A-Za-z0-9_-]*(\.[A-Za-z0-9_-]*){0,2}$/,
  /-{1,5}$/,
  /-----B(E(G(I(N[A-Z \n\r]*)?)?)?)?$/,
  new RegExp(`\\b(${SECRET_KEYS})(\\s*[=:]?\\s*("[^"]*|'[^']*|\\S*)?)?$`, 'i'),
  // A URL stays open until whitespace ends it: userinfo is only recognisable
  // once the "@" arrives, and closing the candidate at the "@" itself would
  // publish everything before it while the full pattern still needs the tail.
  /\b[a-z][a-z0-9+.-]*:(\/\/\S*)?$/i,
];

/** How far back a NEW candidate is looked for when none is currently open. */
const MAX_CANDIDATE_SCAN = 4096;

/**
 * Index up to which `text` contains no unresolved credential candidate.
 *
 * `scanFrom` extends the search backwards so a candidate that is already known
 * to be open stays fully inside the window however long it grows; without it,
 * a candidate longer than the lookback would fall outside and its prefix would
 * be published.
 */
export function safePrefixLength(text: string, scanFrom?: number): number {
  let end = text.length;
  // An unterminated private-key block withholds everything after its start.
  const beginIndex = text.lastIndexOf('-----BEGIN ');
  if (beginIndex >= 0) {
    const endMarker = text.indexOf('-----', beginIndex + 11);
    const terminated = /-----END [A-Z ]*PRIVATE KEY-----/.test(text.slice(beginIndex));
    if (!terminated && endMarker >= 0) end = Math.min(end, beginIndex);
    else if (!terminated) end = Math.min(end, beginIndex);
  }
  const windowStart = Math.max(0, Math.min(scanFrom ?? text.length, text.length - MAX_CANDIDATE_SCAN));
  const tail = text.slice(windowStart);
  for (const pattern of OPEN_CANDIDATES) {
    const match = pattern.exec(tail);
    if (match && match.index + match[0].length === tail.length && match[0].length > 0) {
      end = Math.min(end, windowStart + match.index);
    }
  }
  if (end > 0 && end <= text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return Math.max(0, end);
}

const HIDDEN_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking', 'thinking_delta', 'signature_delta']);
const HIDDEN_KEYS = new Set(['signature', 'thinking', 'redacted_thinking']);
const REMOVED = Symbol('hidden-removed');

/**
 * Removes thinking/signature content wherever it appears (array items or
 * object positions) in a CLI frame.
 */
export function sanitizeHiddenContent<T>(message: T): { sanitized: T; droppedThinking: number } {
  let droppedThinking = 0;
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      for (const item of value) {
        const visited = visit(item);
        if (visited !== REMOVED) output.push(visited);
      }
      return output;
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.type === 'string' && HIDDEN_BLOCK_TYPES.has(record.type)) {
        droppedThinking += 1;
        return REMOVED;
      }
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(record)) {
        if (HIDDEN_KEYS.has(key)) {
          droppedThinking += 1;
          continue;
        }
        const visited = visit(child);
        if (visited !== REMOVED) output[key] = visited;
      }
      return output;
    }
    return value;
  };
  const visited = visit(message);
  return { sanitized: (visited === REMOVED ? {} : visited) as T, droppedThinking };
}

/**
 * Characters of the tail withheld on top of the candidate boundary.
 *
 * A credential is not recognisable from its first characters: `sk`, `https`,
 * `client_sec` and `-----BEG` look like ordinary text. Publishing them the
 * moment they arrive would force a retraction once the shape completes, which
 * would break the growing-prefix contract. Holding back a short tail keeps the
 * published text strictly growing. This is a live preview only; the complete
 * text is redacted and published by flush() when the block ends.
 */
export const STREAM_HOLDBACK = 24;

/**
 * Largest open candidate that is still buffered while it resolves. Past this
 * size nothing plausible is still "maybe a credential": the value is redacted
 * and the rest of it is consumed without being stored, so a secret of any
 * length neither leaks a prefix nor grows memory.
 */
export const MAX_OPEN_CANDIDATE = 8192;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;
const PEM_CARRY = 64;

/**
 * Accumulates streamed text and exposes a growing, prefix-stable, redacted
 * view: text already shown is never re-interpreted, and an unresolved
 * credential candidate is withheld until it resolves. Best effort, not a
 * guarantee — a value matching no known shape is not recognised at all.
 */
export class TextRedactionStream {
  private buffer = '';
  private safeEnd = 0;
  /** Absolute index where the currently open candidate began, if any. */
  private candidateStart: number | null = null;
  /** Last index proven free of unresolved candidates; the scan floor. */
  private lastBoundary = 0;
  /** Set while an over-long candidate is being consumed instead of buffered. */
  private suppress: { kind: 'token' | 'pem'; carry: string } | null = null;

  push(chunk: string): string {
    const rest = this.suppress ? this.consumeSuppressed(chunk) : chunk;
    if (rest) {
      this.buffer += rest;
      this.trackCandidate();
    }
    return this.visible();
  }

  /**
   * Drops the remainder of a candidate that already grew past the bound, until
   * its terminator arrives. The text is never buffered, so a very long secret
   * costs no memory and cannot be published.
   */
  private consumeSuppressed(chunk: string): string {
    const state = this.suppress!;
    if (state.kind === 'token') {
      const match = /\s/.exec(chunk);
      if (!match) return '';
      this.suppress = null;
      return chunk.slice(match.index);
    }
    const combined = state.carry + chunk;
    const end = PEM_END.exec(combined);
    if (!end) {
      state.carry = combined.slice(-PEM_CARRY);
      return '';
    }
    this.suppress = null;
    return combined.slice(end.index + end[0].length);
  }

  /**
   * Keeps the open candidate's start position across chunks so it is always
   * fully inside the scan window, and stops buffering a candidate that grew
   * beyond any plausible credential: at that size it IS treated as one.
   *
   * The scan always reaches back to the last position proven free of
   * candidates, so a candidate introduced anywhere inside one arbitrarily large
   * chunk is found. Looking only at a fixed tail would miss a candidate that
   * starts earlier in the same chunk and publish its prefix. The work stays
   * bounded: either the boundary advances and only the new text is scanned, or
   * a candidate is open and MAX_OPEN_CANDIDATE caps how far back it goes.
   */
  private trackCandidate(): void {
    const scanFrom = Math.min(this.candidateStart ?? this.lastBoundary, this.lastBoundary);
    const boundary = safePrefixLength(this.buffer, scanFrom);
    this.lastBoundary = boundary;
    this.candidateStart = boundary < this.buffer.length ? boundary : null;
    if (this.candidateStart === null) return;
    if (this.buffer.length - this.candidateStart <= MAX_OPEN_CANDIDATE) return;
    const open = this.buffer.slice(this.candidateStart);
    this.suppress = { kind: open.startsWith('-----BEGIN ') ? 'pem' : 'token', carry: open.slice(-PEM_CARRY) };
    this.buffer = `${this.buffer.slice(0, this.candidateStart)}${REDACTED}`;
    this.candidateStart = null;
    this.lastBoundary = this.buffer.length;
  }

  /** Redacted text that is safe to show before the block completes. */
  visible(): string {
    const limit = this.candidateStart ?? this.buffer.length;
    let boundary = Math.min(limit, Math.max(0, this.buffer.length - STREAM_HOLDBACK));
    // The holdback can land in the middle of an already complete token. If we
    // redact only that truncated prefix, its missing suffix may make it cease
    // to match and leak. Move the cut before every recognised span it crosses.
    boundary = boundaryOutsideSensitiveSpan(this.buffer, boundary);
    // Never split a surrogate pair at the published boundary.
    if (boundary > 0) {
      const code = this.buffer.charCodeAt(boundary - 1);
      if (code >= 0xd800 && code <= 0xdbff) boundary -= 1;
    }
    if (boundary > this.safeEnd) this.safeEnd = boundary;
    return redactSensitiveText(this.buffer.slice(0, this.safeEnd));
  }

  /**
   * Complete redacted text of the block.
   *
   * A candidate that was still "open" was only open because streaming could
   * not know the text had ended. Here it has, so the complete patterns decide:
   * anything that really is a credential is redacted, and ordinary text that
   * merely began like one is published intact.
   */
  flush(): string {
    this.candidateStart = null;
    this.suppress = null;
    this.lastBoundary = this.buffer.length;
    this.safeEnd = this.buffer.length;
    return redactSensitiveText(this.buffer);
  }

  get length(): number {
    return this.buffer.length;
  }
}
