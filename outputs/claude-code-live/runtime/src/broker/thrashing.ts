// A loop is a shape in the recent tool history, not a feeling. This module
// names two shapes and nothing else: the same call again and again, and a run
// of failures. It decides nothing — the broker records the verdict as an
// alert, and the coordinator chooses the rung: restrict, end after the turn,
// or let it run. Supervision only alerts.
import type { ThrashingVerdict } from '../shared/types.ts';

export interface ToolTrailEntry {
  toolUseId: string;
  /** `${name}:${inputHash}`; the hash comes from the worker, never from a preview comparison. */
  sig: string;
  name: string;
  inputPreview: string;
  /** null while the call is still open; blocked counts as an error. */
  error: boolean | null;
}

/** How much history the detector looks at; older calls are forgotten. */
export const TRAIL_LIMIT = 20;
/** Consecutive failed calls, whatever they are, before it is an error storm. */
export const ERROR_STORM_LENGTH = 5;
/** The same failing call, repeated this often in the window, is a retry loop. */
export const REPEAT_FAILING_MIN = 3;
/** The same call, succeeding or not, repeated this often is a loop regardless. */
export const REPEAT_ANY_MIN = 5;
const REPEAT_WINDOW = 10;

/**
 * Looks at completed calls only: an open call has no outcome yet, and
 * counting it would let a single slow command look like a storm. Repeats are
 * checked first because "the same command five times" says more than "five
 * failures". Three successful reads of one file are routine and stay silent;
 * five identical calls of anything are not.
 */
export function detectThrashing(trail: readonly ToolTrailEntry[]): (ThrashingVerdict & { sig: string }) | null {
  const done = trail.filter((entry) => entry.error !== null);
  const window = done.slice(-REPEAT_WINDOW);
  const bySig = new Map<string, ToolTrailEntry[]>();
  for (const entry of window) {
    const list = bySig.get(entry.sig) ?? [];
    list.push(entry);
    bySig.set(entry.sig, list);
  }
  for (const entries of bySig.values()) {
    const allFailed = entries.every((entry) => entry.error === true);
    if (entries.length >= REPEAT_ANY_MIN || (entries.length >= REPEAT_FAILING_MIN && allFailed)) {
      const last = entries[entries.length - 1]!;
      return { pattern: 'repeat', tool: last.name, inputPreview: last.inputPreview, count: entries.length, sig: last.sig };
    }
  }
  const tail = done.slice(-ERROR_STORM_LENGTH);
  if (tail.length === ERROR_STORM_LENGTH && tail.every((entry) => entry.error === true)) {
    const last = tail[tail.length - 1]!;
    return { pattern: 'error_storm', tool: last.name, inputPreview: last.inputPreview, count: ERROR_STORM_LENGTH, sig: `error_storm:${last.sig}` };
  }
  return null;
}
