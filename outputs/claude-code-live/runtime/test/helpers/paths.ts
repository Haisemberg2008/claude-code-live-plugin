import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of outputs/claude-code-live/runtime. */
export const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Absolute path of outputs/claude-code-live (the installable plugin bundle). */
export const pluginRoot = path.resolve(runtimeRoot, '..');
export const srcDir = path.join(runtimeRoot, 'src');
export const distDir = path.join(runtimeRoot, 'dist');
export const testHelpersDir = path.join(runtimeRoot, 'test', 'helpers');

export function srcEntry(...segments: string[]): string {
  return path.join(srcDir, ...segments);
}
