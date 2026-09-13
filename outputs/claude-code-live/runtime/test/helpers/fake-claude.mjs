// Harness-only fake `claude` launcher used by preflight, quota and doctor.
//
// It never generates anything: it serves --version, --help, `auth status
// --json` and `-p /usage`, records every invocation to a launcher trace, and
// exits 99 on anything that would start a model turn.
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const traceDir = process.env.CODEORQUESTRA_FAKE_TRACE_DIR;

function trace(outcome) {
  if (!traceDir) return;
  mkdirSync(traceDir, { recursive: true });
  appendFileSync(path.join(traceDir, 'launcher.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), args, outcome })}\n`, 'utf8');
}

const REQUIRED_FLAGS = [
  '--output-format', '--input-format', '--verbose', '--include-partial-messages', '--model', '--effort',
  '--tools', '--permission-mode', '--permission-prompts', '--permission-prompt-tool', '--setting-sources',
  '--strict-mcp-config', '--mcp-config', '--resume', '--allowedTools', '--cloud', '--background', '--safe-mode',
  '--restricted', '--add-dir', '--debug-file',
];

const USAGE_SAMPLE = [
  'Current session: 10% used · resets Sep 6, 9:19pm (America/Sao_Paulo)',
  'Current week (all models): 23% used · resets Sep 10, 8:59pm (America/Sao_Paulo)',
  'Current week (Fable): 44% used · resets Sep 10, 8:59pm (America/Sao_Paulo)',
].join('\n');

const env = (name) => process.env[`CODEORQUESTRA_${name}`];

if (args[0] === '--version') {
  trace('served');
  process.stdout.write(`${env('FAKE_CLI_VERSION') ?? '2.1.263'} (Claude Code)\n`);
  process.exit(0);
}
if (args[0] === '--help') {
  trace('served');
  const omitted = (env('FAKE_OMIT_FLAGS') ?? '').split(',').filter(Boolean);
  const lines = REQUIRED_FLAGS.filter((flag) => !omitted.includes(flag)).map((flag) => `  ${flag} <value>   descrição simulada`);
  process.stdout.write(`Usage: claude [options] [command] [prompt]\n\nOptions:\n${lines.join('\n')}\n`);
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  trace('served');
  process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: env('FAKE_AUTH_METHOD') ?? 'claude.ai', apiProvider: env('FAKE_API_PROVIDER') ?? 'firstParty', subscriptionType: 'max' })}\n`);
  process.exit(0);
}
const promptIndex = args.indexOf('-p');
if (promptIndex >= 0 && args[promptIndex + 1] === '/usage') {
  trace('served');
  if (env('FAKE_USAGE') === 'unavailable') {
    process.stderr.write('usage unavailable (simulated)\n');
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ type: 'result', result: USAGE_SAMPLE })}\n`);
  process.exit(0);
}
trace('FORBIDDEN_GENERATION');
process.stderr.write('fake-claude: invocation would start a model turn; refused by the harness\n');
process.exit(99);
