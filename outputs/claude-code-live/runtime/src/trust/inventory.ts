// Inventory of project and user customizations BEFORE any of them executes:
// instructions (CLAUDE.md, CLAUDE.local.md, AGENTS.md, ancestors, children),
// rules, settings, hooks and their local script entrypoints, agents, skills
// and MCP servers. Content is fingerprinted; only structural, sanitized
// details are exposed. Managed (policy) settings are reported separately:
// the CLI applies them regardless and this runtime never controls them.
// Discovery that hits its own limits is reported as incomplete instead of
// silently calling a partial set trusted. The hash covers each resource's own
// content, not the transitive dependencies a script may load at run time.
import { createHash } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSensitiveText } from '../events/redaction.ts';

export type InventoryKind = 'instructions' | 'rules' | 'settings' | 'hook' | 'agent' | 'skill' | 'mcp';
export type InventoryScope = 'ancestor' | 'project' | 'child' | 'user';

export interface InventoryItem {
  kind: InventoryKind;
  scope: InventoryScope;
  relativePath: string;
  sha256: string;
  details?: Record<string, unknown>;
}

export interface InventoryDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface InventoryOptions {
  /** User-level Claude configuration directory; pass null to skip. Defaults to ~/.claude. */
  userConfigDir?: string | null;
  /** User-level ~/.claude.json (only its mcpServers names/transports are inventoried); pass null to skip. */
  userClaudeJsonPath?: string | null;
  maxChildDepth?: number;
  /** Candidate managed-settings paths to report; null disables the report. Defaults to the platform list. */
  managedSettingsPaths?: string[] | null;
  /**
   * Highest directory the ancestor walk may reach, inclusive. Tests set this
   * to their fixture root so discovery never reads directories above it;
   * production leaves it unset to match what the CLI itself loads.
   */
  ancestorBoundary?: string | null;
}

export interface ManagedSettingsReport {
  candidates: string[];
  present: boolean | null;
  note: string;
}

export interface InventorySnapshot {
  workspace: string;
  canonicalWorkspace: string;
  items: InventoryItem[];
  fingerprint: string;
  skipped: Array<{ path: string; reason: string }>;
  incomplete: boolean;
  managedSettings: ManagedSettingsReport;
  collectedAt: string;
}

export interface Inventory extends InventorySnapshot {
  /** Raw approvable MCP configs for launch; never persisted to logs or UI. */
  mcpServerConfigs: Record<string, unknown>;
  diff(other: InventorySnapshot): InventoryDiff;
  toJSON(): InventorySnapshot;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '.next', '.venv', 'venv', '__pycache__', '.codex', 'coverage', '.turbo', '.cache']);
const SCRIPT_EXTENSIONS = /\.(ps1|js|mjs|cjs|py|sh|bash|cmd|bat|rb|pl|php|exe)$/i;

export const MANAGED_SETTINGS_NOTE = 'Políticas gerenciadas (managed settings) são aplicadas pelo CLI independentemente do runtime; não são aprovadas, alteradas nem desativadas aqui.';

function defaultManagedSettingsPaths(): string[] {
  if (process.platform === 'win32') {
    const programData = process.env.ProgramData ?? 'C:\\ProgramData';
    return [path.join(programData, 'ClaudeCode', 'managed-settings.json')];
  }
  if (process.platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
  return ['/etc/claude-code/managed-settings.json'];
}

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** fs.realpathSync.native resolves junctions and symlinks on Windows. */
function realpathNative(target: string): string {
  return realpathSync.native(target);
}

export function canonicalizeWorkspace(workspace: string): string {
  let real: string;
  try {
    real = realpathNative(workspace);
  } catch {
    real = path.resolve(workspace);
  }
  const normalized = real.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readIf(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function rel(root: string, file: string): string {
  return path.relative(root, file).replace(/\\/g, '/');
}

function mcpDetails(config: Record<string, unknown>): Record<string, unknown> {
  const url = typeof config.url === 'string' ? config.url : null;
  const transport = typeof config.type === 'string' ? config.type : url ? 'http' : 'stdio';
  if (url) {
    try {
      return { transport, host: new URL(url).hostname };
    } catch {
      return { transport, host: null };
    }
  }
  return { transport: 'stdio', command: typeof config.command === 'string' ? path.basename(config.command) : null };
}

interface Collector {
  items: InventoryItem[];
  skipped: Array<{ path: string; reason: string }>;
  incomplete: boolean;
  configs: Record<string, unknown>;
}

function commandTokens(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^["']|["']$/g, '')) ?? [];
}

const VARIABLE_PATTERN = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?|%([A-Za-z_][A-Za-z0-9_]*)%/g;

/**
 * Expands the variables the CLI documents for hook commands, without running a
 * shell. Anything still unresolved is reported so the resource is not silently
 * treated as fingerprinted.
 */
export function expandHookVariables(token: string, workspace: string): { value: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const value = token.replace(VARIABLE_PATTERN, (match, dollar: string | undefined, percent: string | undefined) => {
    const name = dollar ?? percent ?? '';
    if (name === 'CLAUDE_PROJECT_DIR') return workspace;
    unresolved.push(name);
    return match;
  });
  return { value, unresolved };
}

async function collectHookScripts(collector: Collector, command: string, root: string, rootCanonical: string, scope: InventoryScope, toRelative: (file: string) => string, referencedBy: string, workspace: string): Promise<Array<string>> {
  const scripts: string[] = [];
  for (const rawToken of commandTokens(command)) {
    const expansion = expandHookVariables(rawToken, workspace);
    const token = expansion.value;
    const looksLikeScript = SCRIPT_EXTENSIONS.test(token) || token.includes('/') || token.includes('\\');
    if (!looksLikeScript || /^https?:\/\//i.test(token)) continue;
    if (expansion.unresolved.length > 0) {
      collector.skipped.push({ path: `${referencedBy} -> ${rawToken}`, reason: `UNRESOLVED_HOOK_ENTRYPOINT:${expansion.unresolved.join(',')}` });
      collector.incomplete = true;
      continue;
    }
    const absolute = path.resolve(root, token);
    let real: string;
    try {
      real = realpathNative(absolute);
    } catch {
      continue;
    }
    const canonical = canonicalizeWorkspace(real);
    if (canonical !== rootCanonical && !canonical.startsWith(`${rootCanonical}/`)) {
      collector.skipped.push({ path: token, reason: 'HOOK_SCRIPT_OUTSIDE_ROOT' });
      collector.incomplete = true;
      continue;
    }
    let content: Buffer;
    try {
      const stat = await fs.stat(real);
      if (!stat.isFile()) continue;
      content = await fs.readFile(real);
    } catch {
      continue;
    }
    const relativePath = toRelative(real);
    scripts.push(relativePath);
    if (!collector.items.some((item) => item.kind === 'hook' && item.relativePath === relativePath)) {
      collector.items.push({ kind: 'hook', scope, relativePath, sha256: sha256(content), details: { referencedBy } });
    }
  }
  return scripts;
}

async function collectSettings(collector: Collector, file: string, relativePath: string, scope: InventoryScope, root: string, toRelative: (file: string) => string, workspace: string): Promise<void> {
  const text = await readIf(file);
  if (text === null) return;
  collector.items.push({ kind: 'settings', scope, relativePath, sha256: sha256(text) });
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    collector.items.push({ kind: 'settings', scope, relativePath: `${relativePath}#parse-error`, sha256: sha256(text), details: { error: 'JSON inválido' } });
    return;
  }
  const hooks = parsed.hooks;
  if (!hooks || typeof hooks !== 'object') return;
  const rootCanonical = canonicalizeWorkspace(root);
  for (const [event, matchers] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    for (let index = 0; index < matchers.length; index += 1) {
      const entry = matchers[index] as Record<string, unknown>;
      const key = `${relativePath}#hooks.${event}[${index}]`;
      const summaries: Array<Record<string, unknown>> = [];
      for (const hook of Array.isArray(entry.hooks) ? (entry.hooks as Array<Record<string, unknown>>) : []) {
        const type = typeof hook.type === 'string' ? hook.type : 'unknown';
        const command = typeof hook.command === 'string' ? hook.command : null;
        const url = typeof hook.url === 'string' ? hook.url : null;
        const summary: Record<string, unknown> = { type };
        if (command) {
          const tokens = commandTokens(redactSensitiveText(command));
          summary.command = tokens.length ? path.basename(expandHookVariables(tokens[0]!, workspace).value) : null;
          summary.argumentCount = Math.max(0, tokens.length - 1);
          summary.scripts = await collectHookScripts(collector, command, root, rootCanonical, scope, toRelative, key, workspace);
        }
        if (url) {
          try {
            summary.host = new URL(url).hostname;
          } catch {
            summary.host = null;
          }
        }
        summaries.push(summary);
      }
      collector.items.push({
        kind: 'hook',
        scope,
        relativePath: key,
        sha256: sha256(JSON.stringify(entry)),
        details: { event, matcher: typeof entry.matcher === 'string' ? entry.matcher : null, hooks: summaries },
      });
    }
  }
}

function addMcp(collector: Collector, servers: unknown, relativePath: string, scope: InventoryScope): void {
  if (!servers || typeof servers !== 'object') return;
  for (const [name, config] of Object.entries(servers as Record<string, unknown>)) {
    if (!config || typeof config !== 'object') continue;
    collector.items.push({ kind: 'mcp', scope, relativePath: `${relativePath}#${name}`, sha256: sha256(JSON.stringify(config)), details: mcpDetails(config as Record<string, unknown>) });
    if (!(name in collector.configs)) collector.configs[name] = config;
  }
}

async function collectProjectMcp(collector: Collector, file: string, relativePath: string, scope: InventoryScope): Promise<void> {
  const text = await readIf(file);
  if (text === null) return;
  try {
    addMcp(collector, (JSON.parse(text) as Record<string, unknown>).mcpServers, relativePath, scope);
  } catch {
    collector.items.push({ kind: 'mcp', scope, relativePath: `${relativePath}#parse-error`, sha256: sha256(text), details: { error: 'JSON inválido' } });
  }
}

async function collectUserClaudeJson(collector: Collector, file: string, canonicalWorkspace: string): Promise<void> {
  const text = await readIf(file);
  if (text === null) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  addMcp(collector, parsed.mcpServers, 'user:.claude.json', 'user');
  const projects = parsed.projects;
  if (projects && typeof projects === 'object') {
    for (const [projectPath, config] of Object.entries(projects as Record<string, unknown>)) {
      if (!config || typeof config !== 'object') continue;
      if (canonicalizeWorkspace(projectPath) !== canonicalWorkspace) continue;
      addMcp(collector, (config as Record<string, unknown>).mcpServers, 'user:.claude.json#projects', 'user');
    }
  }
}

async function collectDirectory(collector: Collector, dir: string, kind: InventoryKind, scope: InventoryScope, toRelative: (file: string) => string, pattern: RegExp, recursive: boolean): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive && !entry.isSymbolicLink()) await collectDirectory(collector, full, kind, scope, toRelative, pattern, recursive);
      continue;
    }
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const content = await readIf(full);
    if (content === null) continue;
    collector.items.push({ kind, scope, relativePath: toRelative(full), sha256: sha256(content) });
  }
}

async function collectSkills(collector: Collector, dir: string, scope: InventoryScope, toRelative: (file: string) => string): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const skill = path.join(dir, entry.name, 'SKILL.md');
    const content = await readIf(skill);
    if (content === null) continue;
    collector.items.push({ kind: 'skill', scope, relativePath: toRelative(skill), sha256: sha256(content) });
  }
}

async function collectInstructions(collector: Collector, dir: string, scope: InventoryScope, toRelative: (file: string) => string, names: string[]): Promise<void> {
  for (const name of names) {
    const file = path.join(dir, name);
    const content = await readIf(file);
    if (content !== null) collector.items.push({ kind: 'instructions', scope, relativePath: toRelative(file), sha256: sha256(content) });
  }
}

async function collectDotClaudeInstructions(collector: Collector, dir: string, scope: InventoryScope, toRelative: (file: string) => string): Promise<void> {
  await collectInstructions(collector, path.join(dir, '.claude'), scope, toRelative, ['CLAUDE.md']);
  await collectDirectory(collector, path.join(dir, '.claude', 'rules'), 'rules', scope, toRelative, /\.md$/i, true);
}

async function collectChildren(collector: Collector, workspace: string, workspaceCanonical: string, dir: string, depth: number, maxDepth: number): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (SKIP_DIRS.has(entry.name) || entry.name === '.claude') continue;
    let isDir = entry.isDirectory();
    const isLink = entry.isSymbolicLink();
    if (isLink || (process.platform === 'win32' && !isDir && !entry.isFile())) {
      try {
        isDir = (await fs.stat(full)).isDirectory();
      } catch {
        continue;
      }
    }
    if (!isDir) continue;
    let real: string;
    try {
      real = realpathNative(full);
    } catch {
      collector.skipped.push({ path: rel(workspace, full), reason: 'UNRESOLVABLE' });
      collector.incomplete = true;
      continue;
    }
    const realCanonical = canonicalizeWorkspace(real);
    if (realCanonical !== workspaceCanonical && !realCanonical.startsWith(`${workspaceCanonical}/`)) {
      collector.skipped.push({ path: rel(workspace, full), reason: 'REPARSE_OUTSIDE_WORKSPACE' });
      continue;
    }
    if (depth > maxDepth) {
      collector.skipped.push({ path: rel(workspace, full), reason: 'DEPTH_LIMIT' });
      collector.incomplete = true;
      continue;
    }
    const toRelative = (file: string) => rel(workspace, file);
    await collectInstructions(collector, full, 'child', toRelative, ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']);
    await collectDotClaudeInstructions(collector, full, 'child', toRelative);
    await collectChildren(collector, workspace, workspaceCanonical, full, depth + 1, maxDepth);
  }
}

export async function inventoryCustomizations(workspace: string, options: InventoryOptions = {}): Promise<Inventory> {
  const resolved = path.resolve(workspace);
  const canonicalWorkspace = canonicalizeWorkspace(resolved);
  const collector: Collector = { items: [], skipped: [], incomplete: false, configs: {} };
  const toRel = (file: string) => rel(resolved, file);

  // Ancestors: CLAUDE.md files and rules above the workspace are loaded by the
  // CLI. An explicit boundary stops the walk so fixtures never read above
  // their own root.
  const boundary = options.ancestorBoundary ? canonicalizeWorkspace(options.ancestorBoundary) : null;
  let parent = path.dirname(resolved);
  const ancestorDirs: string[] = [];
  while (parent && parent !== path.dirname(parent)) {
    ancestorDirs.push(parent);
    if (boundary && canonicalizeWorkspace(parent) === boundary) break;
    parent = path.dirname(parent);
  }
  if (boundary === canonicalWorkspace) ancestorDirs.length = 0;
  else if (boundary && !ancestorDirs.some((dir) => canonicalizeWorkspace(dir) === boundary)) {
    collector.skipped.push({ path: options.ancestorBoundary ?? '', reason: 'ANCESTOR_BOUNDARY_NOT_AN_ANCESTOR' });
  }
  for (const dir of ancestorDirs.reverse()) {
    await collectInstructions(collector, dir, 'ancestor', toRel, ['CLAUDE.md', 'CLAUDE.local.md']);
    await collectDotClaudeInstructions(collector, dir, 'ancestor', toRel);
  }

  // Project scope.
  await collectInstructions(collector, resolved, 'project', toRel, ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']);
  await collectDotClaudeInstructions(collector, resolved, 'project', toRel);
  await collectSettings(collector, path.join(resolved, '.claude', 'settings.json'), '.claude/settings.json', 'project', resolved, toRel, resolved);
  await collectSettings(collector, path.join(resolved, '.claude', 'settings.local.json'), '.claude/settings.local.json', 'project', resolved, toRel, resolved);
  await collectDirectory(collector, path.join(resolved, '.claude', 'agents'), 'agent', 'project', toRel, /\.md$/i, false);
  await collectSkills(collector, path.join(resolved, '.claude', 'skills'), 'project', toRel);
  await collectProjectMcp(collector, path.join(resolved, '.mcp.json'), '.mcp.json', 'project');

  // Children.
  await collectChildren(collector, resolved, canonicalWorkspace, resolved, 1, options.maxChildDepth ?? 12);

  // User scope.
  const userDir = options.userConfigDir === undefined ? path.join(os.homedir(), '.claude') : options.userConfigDir;
  if (userDir) {
    const userRel = (file: string) => `user:${rel(userDir, file)}`;
    await collectInstructions(collector, userDir, 'user', userRel, ['CLAUDE.md']);
    await collectDirectory(collector, path.join(userDir, 'rules'), 'rules', 'user', userRel, /\.md$/i, true);
    await collectSettings(collector, path.join(userDir, 'settings.json'), 'user:settings.json', 'user', userDir, userRel, resolved);
    await collectDirectory(collector, path.join(userDir, 'agents'), 'agent', 'user', userRel, /\.md$/i, false);
    await collectSkills(collector, path.join(userDir, 'skills'), 'user', userRel);
  }
  const userClaudeJson = options.userClaudeJsonPath === undefined ? path.join(os.homedir(), '.claude.json') : options.userClaudeJsonPath;
  if (userClaudeJson && (await exists(userClaudeJson))) await collectUserClaudeJson(collector, userClaudeJson, canonicalWorkspace);

  // Managed settings are reported, never approved or fingerprinted.
  const managedCandidates = options.managedSettingsPaths === undefined ? defaultManagedSettingsPaths() : options.managedSettingsPaths;
  let managedPresent: boolean | null = null;
  if (managedCandidates) {
    managedPresent = false;
    for (const candidate of managedCandidates) if (await exists(candidate)) managedPresent = true;
  }
  const managedSettings: ManagedSettingsReport = { candidates: managedCandidates ?? [], present: managedPresent, note: MANAGED_SETTINGS_NOTE };

  const items = collector.items.sort((a, b) => `${a.kind}:${a.scope}:${a.relativePath}`.localeCompare(`${b.kind}:${b.scope}:${b.relativePath}`));
  const fingerprint = sha256(items.map((item) => `${item.kind}|${item.scope}|${item.relativePath}|${item.sha256}`).join('\n'));
  const snapshot: InventorySnapshot = {
    workspace: resolved,
    canonicalWorkspace,
    items,
    fingerprint,
    skipped: collector.skipped,
    incomplete: collector.incomplete,
    managedSettings,
    collectedAt: new Date().toISOString(),
  };
  return {
    ...snapshot,
    mcpServerConfigs: collector.configs,
    diff(other: InventorySnapshot): InventoryDiff {
      const mine = new Map(items.map((item) => [item.relativePath, item.sha256]));
      const theirs = new Map(other.items.map((item) => [item.relativePath, item.sha256]));
      const added = [...mine.keys()].filter((key) => !theirs.has(key)).sort();
      const removed = [...theirs.keys()].filter((key) => !mine.has(key)).sort();
      const changed = [...mine.entries()].filter(([key, hash]) => theirs.has(key) && theirs.get(key) !== hash).map(([key]) => key).sort();
      return { added, removed, changed };
    },
    toJSON(): InventorySnapshot {
      return snapshot;
    },
  };
}
