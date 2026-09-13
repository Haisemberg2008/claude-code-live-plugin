// Chooses the process factory for a run. Under the test harness a fake
// factory is mandatory: a missing or broken fake fails closed and the real
// installed CLI is never started.
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isHarness, readEnv, envName } from '../shared/env.ts';
import { spawnInstalledClaudeProcess, type SpawnClaudeProcess } from '../engine/transport.ts';

export interface EngineAdapter {
  spawn: SpawnClaudeProcess;
  simulated: boolean;
  source: string;
}

export class AdapterError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
  }
}

export async function loadEngineAdapter(env: NodeJS.ProcessEnv = process.env, override?: string): Promise<EngineAdapter> {
  const harness = isHarness(env);
  const adapterPath = override ?? readEnv('TEST_ADAPTER', env);
  if (adapterPath) {
    if (!harness) throw new AdapterError('ADAPTER_NOT_ALLOWED', `Um adaptador de teste só é aceito sob o harness de testes (${envName('TEST_HARNESS')}=1).`);
    try {
      await fs.access(adapterPath);
    } catch {
      throw new AdapterError('ADAPTER_LOAD_FAILED', 'O adaptador de teste configurado não existe; a execução falha fechada sem iniciar o Claude Code instalado.');
    }
    let loaded: Record<string, unknown>;
    try {
      loaded = (await import(pathToFileURL(adapterPath).href)) as Record<string, unknown>;
    } catch (error) {
      throw new AdapterError('ADAPTER_LOAD_FAILED', `O adaptador de teste não pôde ser carregado (${(error as Error).name}); a execução falha fechada sem iniciar o Claude Code instalado.`);
    }
    if (typeof loaded.spawnClaudeProcess !== 'function') throw new AdapterError('ADAPTER_INVALID', 'O adaptador de teste não exporta spawnClaudeProcess().');
    return { spawn: loaded.spawnClaudeProcess as SpawnClaudeProcess, simulated: true, source: adapterPath };
  }
  if (harness) throw new AdapterError('ADAPTER_REQUIRED_IN_HARNESS', 'Sob o harness de testes é obrigatório um adaptador simulado; o Claude Code instalado nunca é iniciado.');
  return { spawn: spawnInstalledClaudeProcess, simulated: false, source: 'processo Claude Code instalado' };
}
