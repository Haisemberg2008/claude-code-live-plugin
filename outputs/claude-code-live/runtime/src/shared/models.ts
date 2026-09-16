// How big a context window each authorized model runs with.
//
// The CLI never reports this. Every turn's `usage` says how many tokens went
// in; nothing says how many would have fit. So these are a PRESUMPTION, kept
// in one file and labelled as one everywhere it is shown, rather than being
// quietly presented as a measurement. When a model ships with a different
// window, this is the line to correct — and the gauge is wrong until someone
// does, which is exactly why it says "presumida" on screen.
import type { AuthorizedModel } from './types.ts';

export const CONTEXT_WINDOW_TOKENS: Record<AuthorizedModel, number> = {
  'claude-fable-5-1': 200_000,
  'claude-opus-5': 200_000,
};

/** Null for a model this build does not know, so the gauge disappears instead of guessing. */
export function contextWindowFor(model: string | null | undefined): number | null {
  if (!model) return null;
  return CONTEXT_WINDOW_TOKENS[model as AuthorizedModel] ?? null;
}
