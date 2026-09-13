// Bounded, surrogate-safe previews with explicit truncation and paging.

export const PREVIEW_MAX_CHARS = 4096;
/** Upper bound for stored large payloads (blobs) before explicit truncation. */
export const BLOB_MAX_CHARS = 512 * 1024;

export interface Preview {
  preview: string;
  truncated: boolean;
  totalChars: number;
  pages: number;
}

function cutSafe(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

export function boundedPreview(text: string, maxChars = PREVIEW_MAX_CHARS): Preview {
  const totalChars = text.length;
  const preview = cutSafe(text, maxChars);
  return {
    preview,
    truncated: preview.length < totalChars,
    totalChars,
    pages: Math.max(1, Math.ceil(totalChars / maxChars)),
  };
}

export function previewPage(text: string, page: number, maxChars = PREVIEW_MAX_CHARS): { page: number; pages: number; text: string } {
  const pages = Math.max(1, Math.ceil(text.length / maxChars));
  const index = Math.min(Math.max(1, page), pages);
  const start = (index - 1) * maxChars;
  return { page: index, pages, text: text.slice(start, start + maxChars) };
}

export function boundBlob(text: string, maxChars = BLOB_MAX_CHARS): { text: string; truncated: boolean; totalChars: number } {
  const bounded = cutSafe(text, maxChars);
  return { text: bounded, truncated: bounded.length < text.length, totalChars: text.length };
}
