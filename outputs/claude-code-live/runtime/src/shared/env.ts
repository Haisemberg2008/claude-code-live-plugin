// Environment variable names for the CodeOrquestra runtime.
//
// There is exactly one prefix. The retired working name was never part of a
// released runtime, so no legacy alias is kept here: a stale variable must be
// ignored rather than quietly changing behaviour. The documented legacy alias
// `claude-code-live` applies to skill, state directories and derived files,
// not to this environment contract.
export const ENV_PREFIX = 'CODEORQUESTRA_';

export function readEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`${ENV_PREFIX}${name}`];
}

export function envName(name: string): string {
  return `${ENV_PREFIX}${name}`;
}

export function isHarness(env: NodeJS.ProcessEnv = process.env): boolean {
  return readEnv('TEST_HARNESS', env) === '1';
}
