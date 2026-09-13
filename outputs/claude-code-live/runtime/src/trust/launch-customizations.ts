// Translates the trust check into the CLI launch surface: which setting
// sources may load and which MCP servers exist for the session. Unapproved
// resources stay disabled. `--strict-mcp-config` makes the explicit
// `--mcp-config` the only source of servers, so connectors the user did not
// approve here never load; auto-memory is off via the CLI's own env switch.
import type { Inventory, InventorySnapshot } from './inventory.ts';
import type { TrustCheck, TrustRecord } from './trust-store.ts';

export interface LaunchCustomizations {
  settingSources: Array<'user' | 'project' | 'local'>;
  strictMcpConfig: true;
  /** With strict MCP config, the servers below are the complete set for the run. */
  mcpConfigIsExhaustive: true;
  autoMemoryEnabled: false;
  env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  mcpServers: Record<string, unknown>;
  loadProjectInstructions: boolean;
  pendingApproval: string[];
  reason: string;
}

export function resolveLaunchCustomizations(input: { inventory: InventorySnapshot | Inventory; trust: TrustCheck; record?: TrustRecord | null }): LaunchCustomizations {
  const base = {
    strictMcpConfig: true as const,
    mcpConfigIsExhaustive: true as const,
    autoMemoryEnabled: false as const,
    env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' as const },
  };
  if (!input.trust.trusted) {
    return {
      settingSources: [],
      ...base,
      mcpServers: {},
      loadProjectInstructions: false,
      pendingApproval: [...input.trust.pending, ...input.trust.changed].sort(),
      reason: input.trust.reason,
    };
  }
  const items = input.inventory.items;
  const settingSources: Array<'user' | 'project' | 'local'> = [];
  if (items.some((item) => item.scope === 'user')) settingSources.push('user');
  if (items.some((item) => item.scope === 'project' || item.scope === 'ancestor' || item.scope === 'child')) settingSources.push('project');
  if (items.some((item) => item.relativePath === '.claude/settings.local.json')) settingSources.push('local');
  const configs = 'mcpServerConfigs' in input.inventory ? input.inventory.mcpServerConfigs : {};
  const approvedServers = input.record ? Object.keys(input.record.mcpServers) : items.filter((item) => item.kind === 'mcp').map((item) => item.relativePath.split('#').slice(1).join('#'));
  const mcpServers: Record<string, unknown> = {};
  for (const name of approvedServers) if (name in configs) mcpServers[name] = configs[name];
  return {
    settingSources,
    ...base,
    mcpServers,
    loadProjectInstructions: settingSources.includes('project'),
    pendingApproval: [],
    reason: input.trust.reason,
  };
}
