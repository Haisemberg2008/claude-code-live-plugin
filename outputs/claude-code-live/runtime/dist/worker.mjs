import { createRequire as __codeorquestraCreateRequire } from 'node:module';
const require = __codeorquestraCreateRequire(import.meta.url);

// src/worker/main.ts
import { readFileSync as readFileSync2 } from "node:fs";

// src/worker/engine-adapter.ts
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";

// src/shared/env.ts
var ENV_PREFIX = "CODEORQUESTRA_";
function readEnv(name, env = process.env) {
  return env[`${ENV_PREFIX}${name}`];
}
function envName(name) {
  return `${ENV_PREFIX}${name}`;
}
function isHarness(env = process.env) {
  return readEnv("TEST_HARNESS", env) === "1";
}

// src/engine/transport.ts
import { spawn } from "node:child_process";
var spawnInstalledClaudeProcess = (plan) => {
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  return child;
};
var MAX_FRAME_BYTES = 32 * 1024 * 1024;
var FramingError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "FramingError";
    this.code = code;
  }
};
async function* readFrames(stream, onProblem) {
  let buffer = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
      onProblem({ code: "FRAME_TOO_LARGE", detail: `linha acima de ${MAX_FRAME_BYTES} bytes descartada` });
      buffer = "";
      continue;
    }
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          yield JSON.parse(line);
        } catch {
          onProblem({ code: "FRAME_NOT_JSON", detail: `${line.length} caracteres ignorados` });
        }
      }
      index = buffer.indexOf("\n");
    }
  }
  const tail = buffer.trim();
  if (tail) {
    try {
      yield JSON.parse(tail);
    } catch {
      onProblem({ code: "FRAME_NOT_JSON", detail: "linha final incompleta ignorada" });
    }
  }
}
function writeFrame(stream, frame) {
  if (!stream.writable) throw new FramingError("STDIN_CLOSED", "A entrada do processo Claude Code j\xE1 foi fechada.");
  stream.write(`${JSON.stringify(frame)}
`);
}

// src/worker/engine-adapter.ts
var AdapterError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
  }
};
async function loadEngineAdapter(env = process.env, override) {
  const harness = isHarness(env);
  const adapterPath = override ?? readEnv("TEST_ADAPTER", env);
  if (adapterPath) {
    if (!harness) throw new AdapterError("ADAPTER_NOT_ALLOWED", `Um adaptador de teste s\xF3 \xE9 aceito sob o harness de testes (${envName("TEST_HARNESS")}=1).`);
    try {
      await fs.access(adapterPath);
    } catch {
      throw new AdapterError("ADAPTER_LOAD_FAILED", "O adaptador de teste configurado n\xE3o existe; a execu\xE7\xE3o falha fechada sem iniciar o Claude Code instalado.");
    }
    let loaded;
    try {
      loaded = await import(pathToFileURL(adapterPath).href);
    } catch (error) {
      throw new AdapterError("ADAPTER_LOAD_FAILED", `O adaptador de teste n\xE3o p\xF4de ser carregado (${error.name}); a execu\xE7\xE3o falha fechada sem iniciar o Claude Code instalado.`);
    }
    if (typeof loaded.spawnClaudeProcess !== "function") throw new AdapterError("ADAPTER_INVALID", "O adaptador de teste n\xE3o exporta spawnClaudeProcess().");
    return { spawn: loaded.spawnClaudeProcess, simulated: true, source: adapterPath };
  }
  if (harness) throw new AdapterError("ADAPTER_REQUIRED_IN_HARNESS", "Sob o harness de testes \xE9 obrigat\xF3rio um adaptador simulado; o Claude Code instalado nunca \xE9 iniciado.");
  return { spawn: spawnInstalledClaudeProcess, simulated: false, source: "processo Claude Code instalado" };
}

// src/worker/session.ts
import { randomUUID } from "node:crypto";

// src/policy/action-classifier.ts
import fs2 from "node:fs";
import path from "node:path";
var FILE_WRITE_TOOLS = /* @__PURE__ */ new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
var FILE_READ_TOOLS = /* @__PURE__ */ new Set(["Read", "Glob", "Grep", "LS"]);
var HARMLESS_TOOLS = /* @__PURE__ */ new Set(["TodoWrite", "TodoRead", "AskUserQuestion", "ExitPlanMode", "EnterPlanMode", "ToolSearch"]);
var DELEGATION_TOOLS = /* @__PURE__ */ new Set(["Task", "Agent"]);
var REQUIRED_DELEGATION_EFFORT = "xhigh";
var NETWORK_TOOLS = /* @__PURE__ */ new Set(["WebFetch", "WebSearch"]);
var SHELL_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell", "BashOutput", "KillShell"]);
var SENSITIVE_PATH_PATTERNS = [
  /(^|[\\/])\.env(\.[^\\/]*)?$/i,
  /(^|[\\/])\.envrc$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|pfx|p12|jks|keystore)$/i,
  /(^|[\\/])(credentials|secrets?)(\.[^\\/]*)?\.(json|ya?ml|toml|ini|txt)$/i,
  /(^|[\\/])service-account[^\\/]*\.json$/i,
  /(^|[\\/])\.git[\\/](config|credentials)$/i,
  /(^|[\\/])\.(npmrc|netrc|pypirc|yarnrc(\.yml)?|git-credentials)$/i,
  /(^|[\\/])\.aws[\\/]/i,
  /(^|[\\/])\.ssh[\\/]/i,
  /(^|[\\/])\.gnupg[\\/]/i,
  /(^|[\\/])\.claude[\\/]\.credentials\.json$/i,
  /(^|[\\/])\.claude\.json$/i,
  /(^|[\\/])secrets?[\\/]/i,
  /(^|[\\/])\.docker[\\/]config\.json$/i,
  /(^|[\\/])\.kube[\\/]config$/i,
  /(^|[\\/])\.codex[\\/](auth\.json|config\.toml)$/i
];
var RESERVED_RULES = [
  { pattern: /^git\b.*\bpush\b/i, reason: "RESERVED_OPERATION_PUSH" },
  { pattern: /^gh\s+pr\s+(create|merge|close|ready|edit|reopen)\b/i, reason: "RESERVED_OPERATION_PUSH" },
  { pattern: /^git\b.*\b(commit|merge|cherry-pick|revert)\b/i, reason: "RESERVED_OPERATION_COMMIT" },
  // Provisioning a worktree is the broker's job, never the agent's: a checkout
  // created behind our back carries no writer lock, no trust record and no
  // entry in the orphan sweep. `git worktree list` is inspection and is left to
  // INSPECTION_RULES below.
  { pattern: /^git\s+worktree\s+(add|remove|move|prune|lock|unlock|repair)\b/i, reason: "RESERVED_OPERATION_WORKTREE" },
  { pattern: /^(npm|pnpm|yarn|bun)\s+(publish|deprecate|dist-tag|unpublish)\b/i, reason: "RESERVED_OPERATION_DEPLOY" },
  { pattern: /^(docker\s+push|kubectl\s+(apply|delete|rollout|scale)|terraform\s+(apply|destroy)|pulumi\s+(up|destroy)|firebase\s+deploy|vercel\b|netlify\s+deploy|gh\s+release\b|helm\s+(install|upgrade|uninstall)|twine\s+upload|cargo\s+publish|dotnet\s+nuget\s+push|az\s+\S+.*\bdeploy\b|aws\s+\S+.*\bdeploy\b|gcloud\s+\S+.*\bdeploy\b|fly\s+deploy|heroku\s+)/i, reason: "RESERVED_OPERATION_DEPLOY" },
  { pattern: /^(npm|pnpm|yarn|bun)\s+(i|install|add|uninstall|remove|update|link|rm|un)\b.*(\s|^)(-g|--global)\b/i, reason: "RESERVED_OPERATION_INSTALL" },
  { pattern: /^(npm|pnpm|yarn|bun)\s+(-g|--global)\b/i, reason: "RESERVED_OPERATION_INSTALL" },
  { pattern: /^npx\s+(-g|--global)\b/i, reason: "RESERVED_OPERATION_INSTALL" },
  { pattern: /^codex\s+(plugin|mcp|config)\b/i, reason: "RESERVED_OPERATION_INSTALL" },
  { pattern: /^claude\s+(plugin|mcp|install|update|migrate-installer|doctor\s+--fix)\b/i, reason: "RESERVED_OPERATION_INSTALL" },
  { pattern: /^(winget|choco|scoop|brew|apt|apt-get|yum|dnf|pacman|snap)\s+(install|remove|uninstall|upgrade|update)\b/i, reason: "RESERVED_OPERATION_INSTALL" },
  { pattern: /^(Install-Module|Install-Package|Uninstall-Module)\b/i, reason: "RESERVED_OPERATION_INSTALL" },
  { pattern: /^claude\s+(config|auth|login|logout|setup-token)\b/i, reason: "RESERVED_OPERATION_CONFIG" },
  { pattern: /^codex\s+(login|logout)\b/i, reason: "RESERVED_OPERATION_CONFIG" },
  { pattern: /^git\s+config\s+(--global|--system)\b/i, reason: "RESERVED_OPERATION_CONFIG" },
  { pattern: /^npm\s+(config\s+set|login|adduser|logout|token)\b/i, reason: "RESERVED_OPERATION_CONFIG" },
  { pattern: /^gh\s+auth\b/i, reason: "RESERVED_OPERATION_CONFIG" },
  { pattern: /^(setx|reg\s+add|reg\s+delete|Set-ItemProperty\s+.*HK(LM|CU)|New-ItemProperty\s+.*HK(LM|CU))\b/i, reason: "RESERVED_OPERATION_CONFIG" }
];
var DESTRUCTIVE_RULES = [
  /^rm\s+(?=.*\s-[a-z]*r)/i,
  /^rm\s+-[a-z]*f/i,
  /^rmdir\b.*\s\/s\b/i,
  /^rd\b.*\s\/s\b/i,
  /^del\b.*\s\/[sq]\b/i,
  /^(Remove-Item|ri|rm|erase)\b.*-(Recurse|Force)/i,
  /^git\s+(checkout\s+--|checkout\s+\.|restore\b|reset\s+--hard|clean\b|stash\b|branch\s+-[dD]\b|tag\s+-d\b|rebase\b|filter-branch\b|reflog\s+expire|gc\s+--prune)/i,
  /^(format|mkfs|dd\s+if=|diskpart|fsutil)\b/i,
  /^(truncate|Clear-Content|Remove-Item|Clear-RecycleBin)\b/i,
  /^find\b.*\s-delete\b/i
];
var INTERPRETER_EVAL_RULES = [
  /^(node|bun|deno)\s+(-e|--eval|-p|--print|--input-type)\b/i,
  /^(python|python3|py)\s+-c\b/i,
  /^(pwsh|powershell)\b.*\s-(c|command|encodedcommand|ec|e)\b/i,
  /^(bash|sh|zsh|dash|ksh)\s+-c\b/i,
  /^cmd(\.exe)?\s+\/[ck]\b/i,
  /^(eval|exec|source)\s/i,
  /^\.\s/,
  /^(Invoke-Expression|iex|Invoke-Command|icm)\b/i,
  /^find\b.*\s-(exec|execdir|ok|okdir)\b/i,
  /^xargs\b/i,
  /^(perl|ruby|php)\s+-e\b/i
];
var NETWORK_RULES = [
  /^(curl|wget|ssh|scp|sftp|ftp|telnet|nc|ncat|nmap|ping|tracert|traceroute|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|Start-BitsTransfer|Test-NetConnection|tnc)\b/i,
  /^git\s+(fetch|pull|clone|ls-remote|remote\s+add|submodule\s+update)\b/i,
  /^(npm|pnpm|yarn)\s+(view|search|info|show|whoami|ping|audit)\b/i,
  /^gh\b/i,
  /^(pip|pip3)\s+(download|search)\b/i
];
var DEPENDENCY_RULES = [
  /^(npm|pnpm|yarn|bun)\s+(i|install|ci|add|update|upgrade|uninstall|remove|link|dedupe|prune|rebuild|un|rm)\b/i,
  /^npx\b/i,
  /^(pip|pip3)\s+(install|uninstall)\b/i,
  /^(pipx|poetry\s+(add|install|remove|update)|uv\s+(add|pip|sync|tool))\b/i,
  /^cargo\s+(add|install|update)\b/i,
  /^go\s+(get|install|mod\s+(download|tidy))\b/i,
  /^dotnet\s+(add|restore|tool)\b/i,
  /^composer\s+(require|install|update|remove)\b/i,
  /^(gem\s+install|bundle\s+(install|add|update))\b/i
];
var PROCESS_KILL_BROAD = /^(taskkill\b.*\/im\b|Stop-Process\b.*-Name\b|pkill\b|killall\b|Get-Process\b.*\|\s*Stop-Process)/i;
var PROCESS_KILL = /^(taskkill|Stop-Process|kill|spps)\b/i;
var GIT_STATE_RULES = /^git\s+(add|rm|mv|switch|checkout\s+(?![-.])|init|tag|notes|update-index|submodule|lfs)\b/i;
var ENV_DISCLOSURE = /^(env|printenv|set|Get-ChildItem\s+env:|gci\s+env:|ls\s+env:|dir\s+env:|\[Environment\]::GetEnvironmentVariables)\b/i;
var INSPECTION_RULES = [
  /^git\s+(status|diff|log|show|blame|rev-parse|ls-files|describe|shortlog|cat-file|grep|reflog|stash\s+list|worktree\s+list|config\s+(--get|--list|-l)\b|branch(\s+(-a|-r|--list|-v|-vv|--show-current|--contains))*\s*$|remote(\s+-v)?\s*$)/i,
  /^(ls|dir|pwd|cat|type|more|less|head|tail|wc|echo|printf|tree|find|findstr|grep|rg|egrep|fgrep|sort|uniq|cut|tr|diff|cmp|file|stat|du|df|which|where|whoami|hostname|date|nl|basename|dirname|realpath|readlink|jq|yq|xxd|od|strings)\b/i,
  /^sed\s+-n\b/i,
  /^(Get-ChildItem|gci|Get-Content|gc|Get-Item|gi|Get-Location|gl|Select-String|sls|Test-Path|Resolve-Path|rvpa|Get-Command|gcm|Get-Process|gps|Measure-Object|Write-Output|Write-Host|Get-Date|Get-FileHash|Compare-Object|Format-List|Format-Table|Select-Object|ConvertFrom-Json|Get-Help|Split-Path|Join-Path)\b/i,
  /^node\s+(-v|--version)\s*$/i,
  /^(npm|pnpm|yarn)\s+(-v|--version|ls|list|outdated|explain|why|run\s*$|help)\b/i,
  /^npx\s+--version\b/i,
  /^(tsc|python|python3|pwsh|dotnet|go|cargo|rustc|java|javac|ruby|php|deno|bun)\s+(-v|-V|--version|--info|version)\s*$/i,
  /^(sleep|timeout|Start-Sleep)\b/i
];
var TESTING_RULES = [
  /^(npm|pnpm|yarn|bun)\s+(test|t|run(-script)?\s+\S+|exec\s+\S+)\b/i,
  /^node\s+/i,
  /^(pytest|vitest|jest|mocha|ava|tap|karma|cypress\s+run|playwright\s+test|go\s+(test|build|vet)|cargo\s+(test|check|clippy|build)|dotnet\s+(test|build)|python\s+-m\s+(pytest|unittest)|python3\s+-m\s+(pytest|unittest)|pwsh\s+.*-File\s+\S+|tsc\b|eslint\b|prettier\b|vite\s+build|esbuild\b|make\b|gradlew?\s+(test|build|check)|mvn\s+(test|verify|package|compile)|phpunit|rspec|mix\s+test|dotnet\s+run|python\s+\S+\.py|python3\s+\S+\.py|ruby\s+\S+\.rb|php\s+\S+\.php)\b/i
];
var IMPLEMENTATION_RULES = [
  /^(mkdir|md|New-Item|ni|touch|cp|copy|Copy-Item|cpi|mv|move|Move-Item|mi|ren|rename|Rename-Item|rni|Set-Content|sc|Add-Content|ac|Out-File|tee|patch|chmod|attrib|icacls)\b/i,
  /^sed\s+-i\b/i,
  /^git\s+apply\b/i
];
var MESSAGES = {
  RESERVED_OPERATION_PUSH: "Opera\xE7\xE3o reservada: push, abertura ou merge de PR pertencem ao Codex ou ao usu\xE1rio; o Claude n\xE3o pode execut\xE1-los.",
  RESERVED_OPERATION_COMMIT: "Opera\xE7\xE3o reservada: commit, merge e reescrita de hist\xF3rico pertencem ao Codex ou ao usu\xE1rio.",
  RESERVED_OPERATION_DEPLOY: "Opera\xE7\xE3o reservada: publica\xE7\xE3o e deploy s\xE3o muta\xE7\xF5es externas fora do escopo do Claude.",
  RESERVED_OPERATION_WORKTREE: "Opera\xE7\xE3o reservada: criar, remover ou mover worktrees altera o reposit\xF3rio de forma persistente e \xE9 feito pelo broker, n\xE3o pelo Claude. Listar worktrees \xE9 permitido.",
  GIT_ADMIN_AREA: "Escrita negada: o diret\xF3rio administrativo .git cont\xE9m hooks e refer\xEAncias que passam a valer no pr\xF3ximo commit, que n\xE3o pertence ao Claude.",
  RESERVED_OPERATION_INSTALL: "Opera\xE7\xE3o reservada: instala\xE7\xE3o global, de plugins ou de gerenciadores de pacotes altera a m\xE1quina e exige a\xE7\xE3o do Codex ou do usu\xE1rio.",
  RESERVED_OPERATION_CONFIG: "Opera\xE7\xE3o reservada: configura\xE7\xE3o instalada, autentica\xE7\xE3o e registro do sistema n\xE3o podem ser alterados pelo Claude.",
  SENSITIVE_FILE: "Arquivo sens\xEDvel bloqueado: credenciais, chaves, vari\xE1veis de ambiente ou configura\xE7\xE3o de autentica\xE7\xE3o n\xE3o s\xE3o lidos nem escritos.",
  SENSITIVE_TARGET: "O caminho aponta (via link ou jun\xE7\xE3o) para um arquivo sens\xEDvel; bloqueado pelo destino resolvido.",
  OUTSIDE_WORKSPACE: "Caminho fora do workspace aprovado; escritas s\xF3 s\xE3o permitidas dentro do workspace.",
  OUTSIDE_WORKSPACE_READ: "Leitura fora do workspace aprovado; requer decis\xE3o do coordenador.",
  OUTSIDE_SCOPE_PATH: "Caminho dentro do workspace, mas fora dos diret\xF3rios do escopo aprovado; requer decis\xE3o do coordenador.",
  IN_SCOPE_IMPLEMENTATION: "Edi\xE7\xE3o dentro do escopo aprovado e atribu\xEDda ao Claude.",
  IN_WORKSPACE_READ: "Leitura dentro do workspace aprovado.",
  INSPECTION_COMMAND: "Comando de inspe\xE7\xE3o conhecido dentro do workspace.",
  TESTING_COMMAND: "Comando de teste ou verifica\xE7\xE3o atribu\xEDdo ao Claude. Guardrail textual: o script do projeto n\xE3o \xE9 inspecionado.",
  IMPLEMENTATION_COMMAND: "Comando que grava dentro do escopo aprovado, atribu\xEDdo ao Claude.",
  EXTERNAL_NETWORK: "A\xE7\xE3o de rede externa; requer decis\xE3o do coordenador antes de executar.",
  DESTRUCTIVE: "Comando potencialmente destrutivo (remo\xE7\xE3o recursiva, descarte de altera\xE7\xF5es, reescrita); requer decis\xE3o do coordenador.",
  INTERPRETER_EVAL: "Avalia\xE7\xE3o de c\xF3digo arbitr\xE1rio por interpretador ou execu\xE7\xE3o encadeada; a classifica\xE7\xE3o textual n\xE3o consegue prever o efeito, requer decis\xE3o do coordenador.",
  DEPENDENCY_CHANGE: "Altera\xE7\xE3o de depend\xEAncias ou execu\xE7\xE3o de pacote remoto; requer decis\xE3o do coordenador.",
  PROCESS_KILL_BROAD: "Encerramento de processos por nome afetaria outros processos do usu\xE1rio; requer decis\xE3o do coordenador.",
  PROCESS_KILL: "Encerramento de processo; requer decis\xE3o do coordenador.",
  GIT_STATE_CHANGE: "Altera\xE7\xE3o de estado do git (\xEDndice, branch, worktree); requer decis\xE3o do coordenador porque o Codex controla o hist\xF3rico.",
  ENV_DISCLOSURE: "Listagem do ambiente pode expor credenciais no transcript; requer decis\xE3o do coordenador.",
  SHELL_SUBSTITUTION: "Substitui\xE7\xE3o de comando ou processo impede classificar o que ser\xE1 executado; requer decis\xE3o do coordenador.",
  UNCLASSIFIED_COMMAND: "Comando n\xE3o reconhecido como parte do escopo aprovado; requer decis\xE3o do coordenador.",
  UNCLASSIFIED_TOOL: "Ferramenta n\xE3o reconhecida; requer decis\xE3o do coordenador.",
  NOT_ASSIGNED_IMPLEMENTATION: "A responsabilidade implementation n\xE3o pertence ao Claude neste plano; escritas (edi\xE7\xF5es, redirecionamentos, movimenta\xE7\xF5es) n\xE3o s\xE3o permitidas.",
  NOT_ASSIGNED_TESTING: "A responsabilidade testing n\xE3o pertence ao Claude neste plano; comandos de teste n\xE3o s\xE3o permitidos.",
  NOT_ASSIGNED_INSPECTION: "Nenhuma responsabilidade de leitura (inspection, implementation ou testing) pertence ao Claude neste plano.",
  CAPABILITY_EDIT_NOT_GRANTED: "Esta execu\xE7\xE3o n\xE3o concede edi\xE7\xE3o de arquivos (fase de planejamento ou perfil somente leitura); nenhuma escrita \xE9 permitida por nenhum caminho.",
  CAPABILITY_COMMANDS_NOT_GRANTED: "Esta execu\xE7\xE3o n\xE3o concede comandos de shell (fase de planejamento ou perfil somente leitura).",
  MCP_APPROVED_READ: "Ferramenta MCP aprovada e declarada somente leitura.",
  MCP_EXTERNAL_MUTATION: "A aprova\xE7\xE3o do servidor MCP n\xE3o autoriza muta\xE7\xF5es externas; esta ferramenta requer decis\xE3o do coordenador.",
  MCP_TOOL_SEMANTICS_UNKNOWN: "A sem\xE2ntica desta ferramenta MCP n\xE3o foi declarada na aprova\xE7\xE3o; requer decis\xE3o do coordenador.",
  MCP_SERVER_NOT_APPROVED: "Servidor MCP n\xE3o aprovado no invent\xE1rio de confian\xE7a do projeto.",
  AGENT_NOT_APPROVED: "Subagente n\xE3o aprovado no invent\xE1rio de confian\xE7a; a delega\xE7\xE3o herda as mesmas permiss\xF5es e exige decis\xE3o do coordenador.",
  SKILL_NOT_APPROVED: "Skill n\xE3o aprovada no invent\xE1rio de confian\xE7a; requer decis\xE3o do coordenador.",
  DELEGATION_MODEL_OVERRIDE: "A delega\xE7\xE3o tentou escolher outro modelo; somente os modelos autorizados do contrato podem ser usados.",
  DELEGATION_EFFORT_OVERRIDE: "A delega\xE7\xE3o tentou usar outro esfor\xE7o; o subagente executa com o mesmo esfor\xE7o aprovado para esta execu\xE7\xE3o (Extra/xhigh).",
  DELEGATION_WITHOUT_CAPABILITY: "A delega\xE7\xE3o pediria capacidades que esta execu\xE7\xE3o n\xE3o concede; o subagente n\xE3o pode exceder o contrato.",
  BUILTIN_SAFE: "Ferramenta interna sem efeito externo.",
  EXACT_ALLOWLIST: "Comando exatamente igual a uma regra aprovada do job legado.",
  NOT_IN_ALLOWLIST: "Comando fora da allowlist exata do job legado.",
  TOOL_NOT_IN_MODE: "Ferramenta indispon\xEDvel no modo legado do job.",
  READ_ONLY_PROFILE: "Perfil somente leitura: ferramentas de escrita e comandos n\xE3o est\xE3o dispon\xEDveis.",
  HARMLESS_COMMAND: "Comando inofensivo."
};
function result(decision, reason, details) {
  return { decision, reason, message: MESSAGES[reason] ?? reason, ...details ? { details } : {} };
}
var SEVERITY = { allow: 1, escalate: 2, deny: 3 };
function worst(results) {
  let chosen = results[0];
  for (const candidate of results) if (SEVERITY[candidate.decision] > SEVERITY[chosen.decision]) chosen = candidate;
  return chosen;
}
function normalizeForCompare(p) {
  const normalized = path.normalize(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function realpathContained(target) {
  let probe = target;
  const trailing = [];
  for (; ; ) {
    try {
      const real = fs2.realpathSync.native(probe);
      return trailing.length ? path.join(real, ...trailing.reverse()) : real;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return target;
      trailing.push(path.basename(probe));
      probe = parent;
    }
  }
}
function isInside(parent, child) {
  const rel = path.relative(normalizeForCompare(parent), normalizeForCompare(child));
  return rel === "" || !rel.startsWith("..") && !path.isAbsolute(rel);
}
function resolveWorkspacePath(workspace, candidate) {
  const absolute = path.resolve(workspace, candidate);
  const workspaceReal = realpathContained(workspace);
  const resolved = realpathContained(absolute);
  return {
    absolute,
    resolved,
    inside: isInside(workspaceReal, resolved),
    redirected: normalizeForCompare(absolute) !== normalizeForCompare(resolved)
  };
}
function isSensitivePath(candidate) {
  const text = candidate.replace(/["']/g, "");
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(text));
}
var GIT_ADMIN_SEGMENT = /(^|[\\/])\.git([\\/]|$)/i;
function targetsGitAdminArea(candidate) {
  return GIT_ADMIN_SEGMENT.test(candidate.replace(/["']/g, ""));
}
function capabilitiesOf(context) {
  if (context.capabilities) return context.capabilities;
  if (context.profile === "read") return { edit: false, test: false, commands: "none" };
  return {
    edit: context.responsibilities.implementation === "claude",
    test: context.responsibilities.testing === "claude",
    commands: context.profile === "development" ? "classified" : "exact-list"
  };
}
function scopeContains(context, resolved) {
  if (context.wholeWorkspace) return true;
  if (context.scopePaths.length === 0) return false;
  const workspaceReal = realpathContained(context.workspace);
  const rel = path.relative(normalizeForCompare(workspaceReal), normalizeForCompare(resolved)).replace(/\\/g, "/");
  if (rel.startsWith("..")) return false;
  for (const scope of context.scopePaths) {
    const clean = scope.replace(/\\/g, "/").replace(/^\.\//, "");
    const lowered = process.platform === "win32" ? clean.toLowerCase() : clean;
    const relCompare = process.platform === "win32" ? rel.toLowerCase() : rel;
    const dir = lowered.endsWith("/") ? lowered : `${lowered}/`;
    if (relCompare === lowered.replace(/\/$/, "") || relCompare.startsWith(dir)) return true;
  }
  return false;
}
function pathFromInput(input) {
  for (const key of ["file_path", "notebook_path", "path", "filePath"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}
function canRead(responsibilities) {
  return responsibilities.inspection === "claude" || responsibilities.implementation === "claude" || responsibilities.testing === "claude";
}
function checkSensitiveTarget(context, candidate) {
  if (isSensitivePath(candidate)) return result("deny", "SENSITIVE_FILE", { token: candidate });
  const resolved = resolveWorkspacePath(context.workspace, candidate);
  if (isSensitivePath(resolved.absolute)) return result("deny", "SENSITIVE_FILE", { token: candidate });
  if (isSensitivePath(resolved.resolved)) {
    return result("deny", resolved.redirected ? "SENSITIVE_TARGET" : "SENSITIVE_FILE", { token: candidate, resolved: resolved.resolved });
  }
  return null;
}
function checkReadTarget(context, candidate, outside) {
  const sensitive = checkSensitiveTarget(context, candidate);
  if (sensitive) return sensitive;
  const resolved = resolveWorkspacePath(context.workspace, candidate);
  if (!resolved.inside) {
    return outside === "deny" ? result("deny", "OUTSIDE_WORKSPACE", { path: candidate, ...resolved.redirected ? { resolved: resolved.resolved } : {} }) : result("escalate", "OUTSIDE_WORKSPACE_READ", { path: candidate, ...resolved.redirected ? { resolved: resolved.resolved } : {} });
  }
  return null;
}
function checkWriteTarget(target, context) {
  const capabilities = capabilitiesOf(context);
  if (!capabilities.edit) {
    return context.responsibilities.implementation === "claude" ? result("deny", "CAPABILITY_EDIT_NOT_GRANTED", { path: target }) : result("deny", "NOT_ASSIGNED_IMPLEMENTATION", { path: target });
  }
  if (isSensitivePath(target)) return result("deny", "SENSITIVE_FILE", { path: target });
  const resolved = resolveWorkspacePath(context.workspace, target);
  if (isSensitivePath(resolved.absolute)) return result("deny", "SENSITIVE_FILE", { path: target });
  if (isSensitivePath(resolved.resolved)) return result("deny", resolved.redirected ? "SENSITIVE_TARGET" : "SENSITIVE_FILE", { path: target, resolved: resolved.resolved });
  if (targetsGitAdminArea(target) || targetsGitAdminArea(resolved.absolute) || targetsGitAdminArea(resolved.resolved)) {
    return result("deny", "GIT_ADMIN_AREA", { path: target, ...resolved.redirected ? { resolved: resolved.resolved } : {} });
  }
  if (!resolved.inside) return result("deny", "OUTSIDE_WORKSPACE", { path: target, ...resolved.redirected ? { resolved: resolved.resolved } : {} });
  if (!scopeContains(context, resolved.resolved)) return result("escalate", "OUTSIDE_SCOPE_PATH", { path: target, ...resolved.redirected ? { resolved: resolved.resolved } : {} });
  return null;
}
function classifyFileAction(tool, input, context) {
  const write = FILE_WRITE_TOOLS.has(tool);
  const raw = pathFromInput(input);
  const candidate = raw ?? context.workspace;
  if (write) {
    const problem = checkWriteTarget(candidate, context);
    return problem ?? result("allow", "IN_SCOPE_IMPLEMENTATION");
  }
  if (isSensitivePath(candidate)) return result("deny", "SENSITIVE_FILE", { path: raw });
  const resolved = resolveWorkspacePath(context.workspace, candidate);
  if (isSensitivePath(resolved.absolute)) return result("deny", "SENSITIVE_FILE", { path: raw });
  if (isSensitivePath(resolved.resolved)) return result("deny", resolved.redirected ? "SENSITIVE_TARGET" : "SENSITIVE_FILE", { path: raw, resolved: resolved.resolved });
  if (!resolved.inside) return result("escalate", "OUTSIDE_WORKSPACE_READ", { path: raw, ...resolved.redirected ? { resolved: resolved.resolved } : {} });
  if (!canRead(context.responsibilities)) return result("deny", "NOT_ASSIGNED_INSPECTION");
  return result("allow", "IN_WORKSPACE_READ");
}
function splitSegments(command) {
  return command.split(/\r?\n|&&|\|\||;|\|/).map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}
function stripEnvAssignments(segment) {
  return segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
}
function tokens(segment) {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^["']|["']$/g, "")) ?? [];
}
function looksLikePath(token) {
  if (/^[A-Za-z]:[\\/]/.test(token) || token.startsWith("\\\\") || token.includes("..")) return true;
  if (token.startsWith("/")) return /^\/[^/]+\/.+/.test(token);
  return false;
}
function looksLikeFileReference(token) {
  if (!token || token.startsWith("-")) return false;
  if (looksLikePath(token)) return true;
  if (token.startsWith("/")) return false;
  return /[\\/]/.test(token) || /^\.[^\\/]+$/.test(token) || /\.[A-Za-z0-9]{1,8}$/.test(token);
}
var NPM_VALUE_OPTIONS = /* @__PURE__ */ new Set(["--prefix", "-C", "--workspace", "-w", "--loglevel", "--cache", "--userconfig", "--registry", "--script-shell"]);
var NPM_FLAG_OPTIONS = /^(-s|-q|-d|-dd|-ddd|--silent|--quiet|--verbose|--no-audit|--no-fund|--ignore-scripts|--workspaces|--if-present|--json|--offline|--prefer-offline|--legacy-peer-deps|--no-save|--save-exact|--yes|-y|--no-progress|--foreground-scripts)$/i;
var GIT_VALUE_OPTIONS = /* @__PURE__ */ new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
var GIT_FLAG_OPTIONS = /^(--no-pager|-P|--no-optional-locks|--paginate|-p|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-replace-objects|--bare)$/i;
function normalizeCommandTokens(segmentTokens) {
  const declaredPaths = [];
  const first = (segmentTokens[0] ?? "").toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
  let rest = segmentTokens.slice(1);
  const isNpm = ["npm", "pnpm", "yarn", "bun"].includes(first);
  const isGit = first === "git";
  if (isNpm || isGit) {
    const valueOptions = isNpm ? NPM_VALUE_OPTIONS : GIT_VALUE_OPTIONS;
    const flagOptions = isNpm ? NPM_FLAG_OPTIONS : GIT_FLAG_OPTIONS;
    while (rest.length) {
      const token = rest[0];
      const eq = /^(--?[A-Za-z-]+)=(.*)$/.exec(token);
      if (eq && valueOptions.has(eq[1])) {
        if (["--prefix", "-C", "--git-dir", "--work-tree", "--cwd", "--workspace", "-w"].includes(eq[1])) declaredPaths.push(eq[2]);
        rest = rest.slice(1);
        continue;
      }
      if (valueOptions.has(token)) {
        if (["--prefix", "-C", "--git-dir", "--work-tree", "--workspace", "-w"].includes(token) && rest[1]) declaredPaths.push(rest[1]);
        rest = rest.slice(2);
        continue;
      }
      if (flagOptions.test(token)) {
        rest = rest.slice(1);
        continue;
      }
      break;
    }
  }
  return { normalized: [segmentTokens[0] ?? "", ...rest].join(" "), declaredPaths };
}
function pathArguments(segmentTokens) {
  const found = [];
  for (let index = 1; index < segmentTokens.length; index += 1) {
    const token = segmentTokens[index];
    if ((token === "--cwd" || token === "-cwd" || token === "--dir" || token === "--WorkingDirectory") && index + 1 < segmentTokens.length) found.push(segmentTokens[index + 1]);
    const eq = /^(--cwd|--dir)=(.+)$/.exec(token);
    if (eq) found.push(eq[2]);
    if (looksLikePath(token) && !token.startsWith("-")) found.push(token);
  }
  return found;
}
function redirections(segment) {
  const outputs = [];
  const inputs = [];
  const outputPattern = /(?:^|[^<>0-9]|\b[0-9])(>{1,2})\s*("[^"]+"|'[^']+'|[^\s|&;<>]+)/g;
  let match;
  while ((match = outputPattern.exec(segment)) !== null) {
    const target = match[2].replace(/^["']|["']$/g, "");
    if (target && !/^&\d$/.test(target) && target !== "/dev/null" && target.toLowerCase() !== "nul") outputs.push(target);
  }
  const inputPattern = /(?:^|[^<>])<(?![<(])\s*("[^"]+"|'[^']+'|[^\s|&;<>]+)/g;
  while ((match = inputPattern.exec(segment)) !== null) inputs.push(match[1].replace(/^["']|["']$/g, ""));
  return { outputs, inputs };
}
function positionals(segmentTokens) {
  return segmentTokens.slice(1).filter((token) => !token.startsWith("-") && !/^\/[^/]*$/.test(token));
}
function optionWriteTargets(segmentTokens) {
  const command = (segmentTokens[0] ?? "").toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
  const targets = [];
  const valueAfter = (flags) => {
    for (let index = 1; index < segmentTokens.length; index += 1) {
      const token = segmentTokens[index];
      if (flags.includes(token) && segmentTokens[index + 1]) targets.push(segmentTokens[index + 1]);
      const eq = /^(--?[A-Za-z-]+)=(.+)$/.exec(token);
      if (eq && flags.includes(eq[1])) targets.push(eq[2]);
    }
  };
  switch (command) {
    case "sort":
      valueAfter(["-o", "--output"]);
      break;
    case "uniq": {
      const args2 = positionals(segmentTokens);
      if (args2.length >= 2) targets.push(args2[1]);
      break;
    }
    case "find":
      valueAfter(["-fprint", "-fprint0", "-fprintf", "-fls"]);
      break;
    case "tee":
      targets.push(...positionals(segmentTokens));
      break;
    case "cp":
    case "copy":
    case "copy-item":
    case "cpi": {
      const args2 = positionals(segmentTokens);
      if (args2.length >= 2) targets.push(args2[args2.length - 1]);
      valueAfter(["-Destination"]);
      break;
    }
    case "mv":
    case "move":
    case "move-item":
    case "mi":
    case "ren":
    case "rename":
    case "rename-item":
    case "rni":
      targets.push(...positionals(segmentTokens));
      valueAfter(["-Destination", "-NewName", "-Path"]);
      break;
    case "out-file":
    case "set-content":
    case "sc":
    case "add-content":
    case "ac": {
      valueAfter(["-Path", "-FilePath", "-LiteralPath"]);
      const args2 = positionals(segmentTokens);
      if (args2.length >= 1 && !targets.length) targets.push(args2[0]);
      break;
    }
    case "sed":
      if (segmentTokens.some((token) => /^-i/.test(token))) targets.push(...positionals(segmentTokens).filter((token) => !token.startsWith("s/")).slice(-1));
      break;
    case "dd":
      valueAfter(["of"]);
      for (const token of segmentTokens) {
        const m = /^of=(.+)$/.exec(token);
        if (m) targets.push(m[1]);
      }
      break;
    default:
      break;
  }
  return targets;
}
function classifyCommandSegment(segment, context, whole) {
  const stripped = stripEnvAssignments(segment);
  const segmentTokens = tokens(stripped);
  if (segmentTokens.length === 0) return result("allow", "HARMLESS_COMMAND");
  for (const token of segmentTokens) if (isSensitivePath(token)) return result("deny", "SENSITIVE_FILE", { token });
  const { normalized, declaredPaths } = normalizeCommandTokens(segmentTokens);
  for (const rule of RESERVED_RULES) if (rule.pattern.test(stripped) || rule.pattern.test(normalized)) return result("deny", rule.reason, { command: stripped });
  for (const candidate of declaredPaths) {
    const problem = checkReadTarget(context, candidate, "deny");
    if (problem) return problem;
  }
  const redirect = redirections(segment);
  for (const input of redirect.inputs) {
    const problem = checkReadTarget(context, input, "escalate");
    if (problem) return problem;
  }
  const writes = [...redirect.outputs, ...optionWriteTargets(segmentTokens)];
  for (const target of writes) {
    const problem = checkWriteTarget(target, context);
    if (problem) return problem;
  }
  for (const candidate of pathArguments(segmentTokens)) {
    const problem = checkReadTarget(context, candidate, "deny");
    if (problem) return problem;
  }
  for (let index = 1; index < segmentTokens.length; index += 1) {
    const token = segmentTokens[index];
    if (!looksLikeFileReference(token)) continue;
    const problem = checkSensitiveTarget(context, token);
    if (problem) return problem;
  }
  const base = normalized;
  if (DESTRUCTIVE_RULES.some((rule) => rule.test(base))) return result("escalate", "DESTRUCTIVE", { command: stripped });
  if (INTERPRETER_EVAL_RULES.some((rule) => rule.test(base))) return result("escalate", "INTERPRETER_EVAL", { command: stripped });
  if (ENV_DISCLOSURE.test(base)) return result("escalate", "ENV_DISCLOSURE");
  if (NETWORK_RULES.some((rule) => rule.test(base))) return result("escalate", "EXTERNAL_NETWORK", { command: stripped });
  if (DEPENDENCY_RULES.some((rule) => rule.test(base))) return result("escalate", "DEPENDENCY_CHANGE", { command: stripped });
  if (PROCESS_KILL_BROAD.test(base)) return result("escalate", "PROCESS_KILL_BROAD");
  if (PROCESS_KILL.test(base)) return result("escalate", "PROCESS_KILL");
  if (GIT_STATE_RULES.test(base)) return result("escalate", "GIT_STATE_CHANGE");
  let category = null;
  if (INSPECTION_RULES.some((rule) => rule.test(base))) {
    if (!canRead(context.responsibilities)) return result("deny", "NOT_ASSIGNED_INSPECTION");
    category = result("allow", "INSPECTION_COMMAND");
  } else if (TESTING_RULES.some((rule) => rule.test(base))) {
    if (context.responsibilities.testing !== "claude") return result("deny", "NOT_ASSIGNED_TESTING");
    if (!capabilitiesOf(context).test) return result("deny", "CAPABILITY_COMMANDS_NOT_GRANTED");
    category = result("allow", "TESTING_COMMAND");
  } else if (IMPLEMENTATION_RULES.some((rule) => rule.test(base))) {
    const problem = checkWriteTarget(context.workspace, context);
    if (problem && problem.reason !== "OUTSIDE_SCOPE_PATH") return problem;
    category = result("allow", "IMPLEMENTATION_COMMAND");
  }
  if (!category) return result("escalate", "UNCLASSIFIED_COMMAND", { command: stripped.slice(0, 200), whole: whole.length > 200 ? `${whole.slice(0, 200)}\u2026` : whole });
  if (writes.length) {
    return { ...result("allow", category.reason === "INSPECTION_COMMAND" ? "IMPLEMENTATION_COMMAND" : category.reason), details: { writes } };
  }
  return category;
}
function classifyCommand(command, context) {
  if (capabilitiesOf(context).commands === "none") return result("deny", "CAPABILITY_COMMANDS_NOT_GRANTED", { command: command.slice(0, 120) });
  const segments = splitSegments(command);
  if (segments.length === 0) return result("escalate", "UNCLASSIFIED_COMMAND");
  const results = segments.map((segment) => classifyCommandSegment(segment, context, command));
  const substitution = /\$\(|`|<\(|>\(|\$\{[^}]*\(/.test(command);
  if (substitution) {
    const inner = command.match(/\$\(([^)]*)\)|`([^`]*)`/g) ?? [];
    for (const piece of inner) {
      const innerCommand = piece.replace(/^\$\(|^`|\)$|`$/g, "");
      results.push(...splitSegments(innerCommand).map((segment) => classifyCommandSegment(segment, context, command)));
    }
    results.push(result("escalate", "SHELL_SUBSTITUTION"));
  }
  return worst(results);
}
function classifyMcp(tool, context) {
  const match = /^mcp__(.+?)__(.+)$/.exec(tool);
  const server = match ? match[1] : "";
  if (!server || !context.approvedMcpServers?.includes(server)) return result("deny", "MCP_SERVER_NOT_APPROVED", { server });
  const declared = context.approvedMcpTools?.[tool];
  if (!declared) return result("escalate", "MCP_TOOL_SEMANTICS_UNKNOWN", { server, tool });
  if (declared.readOnly) return result("allow", "MCP_APPROVED_READ", { server });
  return result("escalate", "MCP_EXTERNAL_MUTATION", { server, tool });
}
function classifyDelegation(tool, input, context) {
  const capabilities = capabilitiesOf(context);
  const model = typeof input.model === "string" ? input.model : null;
  if (model && (!context.authorizedModels || !context.authorizedModels.includes(model))) {
    return result("deny", "DELEGATION_MODEL_OVERRIDE", { tool, model });
  }
  const effort = typeof input.effort === "string" ? input.effort : null;
  if (effort && effort !== (context.requiredEffort ?? REQUIRED_DELEGATION_EFFORT)) {
    return result("deny", "DELEGATION_EFFORT_OVERRIDE", { tool, effort });
  }
  if (tool === "Skill") {
    const name = String(input.skill ?? input.name ?? input.command ?? "");
    if (!name || !(context.approvedSkills ?? []).includes(name)) return result("escalate", "SKILL_NOT_APPROVED", { skill: name || null });
    return result("allow", "BUILTIN_SAFE", { skill: name });
  }
  const agent = String(input.subagent_type ?? input.agent ?? input.agent_type ?? "");
  if (!agent || !(context.approvedAgents ?? []).includes(agent)) return result("escalate", "AGENT_NOT_APPROVED", { agent: agent || null });
  if (!capabilities.edit && !capabilities.test && capabilities.commands === "none") {
    return result("escalate", "DELEGATION_WITHOUT_CAPABILITY", { agent });
  }
  return result("allow", "BUILTIN_SAFE", { agent });
}
function classifyLegacy(action, context) {
  const mode = context.legacyMode ?? "read";
  const toolsByMode = {
    chat: /* @__PURE__ */ new Set(),
    read: /* @__PURE__ */ new Set(["Read", "Glob", "Grep"]),
    verify: /* @__PURE__ */ new Set(["Read", "Glob", "Grep", "Bash"]),
    local: /* @__PURE__ */ new Set(["Read", "Glob", "Grep", "Bash", "Write", "Edit"])
  };
  const allowedTools = toolsByMode[mode] ?? /* @__PURE__ */ new Set();
  if (!allowedTools.has(action.tool)) return result("deny", "TOOL_NOT_IN_MODE", { tool: action.tool, mode });
  if (action.tool === "Bash") {
    const command = typeof action.input.command === "string" ? action.input.command : "";
    for (const token of tokens(command)) if (isSensitivePath(token)) return result("deny", "SENSITIVE_FILE");
    const rule = `Bash(${command})`;
    return (context.legacyAllowedCommands ?? []).includes(rule) ? result("allow", "EXACT_ALLOWLIST") : result("deny", "NOT_IN_ALLOWLIST", { command });
  }
  return classifyFileAction(action.tool, action.input, { ...context, wholeWorkspace: true, capabilities: { edit: mode === "local", test: true, commands: "exact-list" } });
}
function classifyToolAction(action, context) {
  const { tool, input } = action;
  if (context.profile === "restricted" || context.profile === "diagnostic") return classifyLegacy(action, context);
  if (tool.startsWith("mcp__")) return classifyMcp(tool, context);
  if (DELEGATION_TOOLS.has(tool) || tool === "Skill") return classifyDelegation(tool, input, context);
  if (context.profile === "read") {
    if (FILE_READ_TOOLS.has(tool)) return classifyFileAction(tool, input, context);
    if (HARMLESS_TOOLS.has(tool)) return result("allow", "BUILTIN_SAFE");
    return result("deny", "READ_ONLY_PROFILE", { tool });
  }
  if (FILE_WRITE_TOOLS.has(tool) || FILE_READ_TOOLS.has(tool)) return classifyFileAction(tool, input, context);
  if (NETWORK_TOOLS.has(tool)) return result("escalate", "EXTERNAL_NETWORK", { tool });
  if (HARMLESS_TOOLS.has(tool)) return result("allow", "BUILTIN_SAFE");
  if (SHELL_TOOLS.has(tool)) {
    const command = typeof input.command === "string" ? input.command : "";
    return classifyCommand(command, context);
  }
  return result("escalate", "UNCLASSIFIED_TOOL", { tool });
}

// src/events/preview.ts
var PREVIEW_MAX_CHARS = 4096;
var BLOB_MAX_CHARS = 512 * 1024;
function cutSafe(text, limit) {
  if (text.length <= limit) return text;
  let end = limit;
  const code = text.charCodeAt(end - 1);
  if (code >= 55296 && code <= 56319) end -= 1;
  return text.slice(0, end);
}
function boundedPreview(text, maxChars = PREVIEW_MAX_CHARS) {
  const totalChars = text.length;
  const preview = cutSafe(text, maxChars);
  return {
    preview,
    truncated: preview.length < totalChars,
    totalChars,
    pages: Math.max(1, Math.ceil(totalChars / maxChars))
  };
}
function boundBlob(text, maxChars = BLOB_MAX_CHARS) {
  const bounded = cutSafe(text, maxChars);
  return { text: bounded, truncated: bounded.length < text.length, totalChars: text.length };
}

// src/events/redaction.ts
var REDACTED = "[REDIGIDO]";
var PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
];
var SECRET_KEYS = "password|passwd|pwd|senha|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token";
var KEY_VALUE = new RegExp(`\\b(${SECRET_KEYS})(\\s*[=:]\\s*)(?!\\[REDIGIDO\\])("[^"]*"|'[^']*'|\\S+)`, "gi");
var URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+(?::[^\s/@]*)?)@/gi;
function redactUrlUserinfo(text) {
  return text.replace(URL_USERINFO, `$1${REDACTED}@`);
}
function redactSensitiveText(text) {
  if (!text) return text;
  let output = text;
  for (const pattern of PATTERNS) output = output.replace(pattern, REDACTED);
  output = output.replace(KEY_VALUE, (_match, key, separator) => `${key}${separator}${REDACTED}`);
  output = redactUrlUserinfo(output);
  return output;
}
function boundaryOutsideSensitiveSpan(text, boundary) {
  let safe = boundary;
  const expressions = [...PATTERNS, KEY_VALUE, URL_USERINFO];
  for (const expression of expressions) {
    const flags = expression.flags.includes("g") ? expression.flags : `${expression.flags}g`;
    const scanner = new RegExp(expression.source, flags);
    for (const match of text.matchAll(scanner)) {
      const start = match.index;
      const end = start + match[0].length;
      if (start < safe && safe < end) safe = start;
    }
  }
  return safe;
}
var OPEN_CANDIDATES = [
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
  new RegExp(`\\b(${SECRET_KEYS})(\\s*[=:]?\\s*("[^"]*|'[^']*|\\S*)?)?$`, "i"),
  // A URL stays open until whitespace ends it: userinfo is only recognisable
  // once the "@" arrives, and closing the candidate at the "@" itself would
  // publish everything before it while the full pattern still needs the tail.
  /\b[a-z][a-z0-9+.-]*:(\/\/\S*)?$/i
];
var MAX_CANDIDATE_SCAN = 4096;
function safePrefixLength(text, scanFrom) {
  let end = text.length;
  const beginIndex = text.lastIndexOf("-----BEGIN ");
  if (beginIndex >= 0) {
    const endMarker = text.indexOf("-----", beginIndex + 11);
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
    if (code >= 55296 && code <= 56319) end -= 1;
  }
  return Math.max(0, end);
}
var HIDDEN_BLOCK_TYPES = /* @__PURE__ */ new Set(["thinking", "redacted_thinking", "thinking_delta", "signature_delta"]);
var HIDDEN_KEYS = /* @__PURE__ */ new Set(["signature", "thinking", "redacted_thinking"]);
var REMOVED = /* @__PURE__ */ Symbol("hidden-removed");
function sanitizeHiddenContent(message) {
  let droppedThinking = 0;
  const visit = (value) => {
    if (Array.isArray(value)) {
      const output = [];
      for (const item of value) {
        const visited2 = visit(item);
        if (visited2 !== REMOVED) output.push(visited2);
      }
      return output;
    }
    if (value && typeof value === "object") {
      const record = value;
      if (typeof record.type === "string" && HIDDEN_BLOCK_TYPES.has(record.type)) {
        droppedThinking += 1;
        return REMOVED;
      }
      const output = {};
      for (const [key, child] of Object.entries(record)) {
        if (HIDDEN_KEYS.has(key)) {
          droppedThinking += 1;
          continue;
        }
        const visited2 = visit(child);
        if (visited2 !== REMOVED) output[key] = visited2;
      }
      return output;
    }
    return value;
  };
  const visited = visit(message);
  return { sanitized: visited === REMOVED ? {} : visited, droppedThinking };
}
var STREAM_HOLDBACK = 24;
var MAX_OPEN_CANDIDATE = 8192;
var PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;
var PEM_CARRY = 64;
var TextRedactionStream = class {
  buffer = "";
  safeEnd = 0;
  /** Absolute index where the currently open candidate began, if any. */
  candidateStart = null;
  /** Last index proven free of unresolved candidates; the scan floor. */
  lastBoundary = 0;
  /** Set while an over-long candidate is being consumed instead of buffered. */
  suppress = null;
  push(chunk) {
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
  consumeSuppressed(chunk) {
    const state = this.suppress;
    if (state.kind === "token") {
      const match = /\s/.exec(chunk);
      if (!match) return "";
      this.suppress = null;
      return chunk.slice(match.index);
    }
    const combined = state.carry + chunk;
    const end = PEM_END.exec(combined);
    if (!end) {
      state.carry = combined.slice(-PEM_CARRY);
      return "";
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
  trackCandidate() {
    const scanFrom = Math.min(this.candidateStart ?? this.lastBoundary, this.lastBoundary);
    const boundary = safePrefixLength(this.buffer, scanFrom);
    this.lastBoundary = boundary;
    this.candidateStart = boundary < this.buffer.length ? boundary : null;
    if (this.candidateStart === null) return;
    if (this.buffer.length - this.candidateStart <= MAX_OPEN_CANDIDATE) return;
    const open = this.buffer.slice(this.candidateStart);
    this.suppress = { kind: open.startsWith("-----BEGIN ") ? "pem" : "token", carry: open.slice(-PEM_CARRY) };
    this.buffer = `${this.buffer.slice(0, this.candidateStart)}${REDACTED}`;
    this.candidateStart = null;
    this.lastBoundary = this.buffer.length;
  }
  /** Redacted text that is safe to show before the block completes. */
  visible() {
    const limit = this.candidateStart ?? this.buffer.length;
    let boundary = Math.min(limit, Math.max(0, this.buffer.length - STREAM_HOLDBACK));
    boundary = boundaryOutsideSensitiveSpan(this.buffer, boundary);
    if (boundary > 0) {
      const code = this.buffer.charCodeAt(boundary - 1);
      if (code >= 55296 && code <= 56319) boundary -= 1;
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
  flush() {
    this.candidateStart = null;
    this.suppress = null;
    this.lastBoundary = this.buffer.length;
    this.safeEnd = this.buffer.length;
    return redactSensitiveText(this.buffer);
  }
  get length() {
    return this.buffer.length;
  }
};

// src/engine/protocol.ts
var CONTROL_SUBTYPES = {
  initialize: "initialize",
  interrupt: "interrupt",
  setModel: "set_model",
  canUseTool: "can_use_tool",
  hookCallback: "hook_callback"
};
function buildCliArgs(input) {
  const args2 = ["--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-partial-messages"];
  args2.push("--model", input.model);
  args2.push("--effort", input.effort);
  if (input.tools === null) args2.push("--tools", "default");
  else if (input.tools.length === 0) args2.push("--tools", "");
  else args2.push("--tools", input.tools.join(","));
  args2.push("--permission-mode", input.permissionMode);
  args2.push("--permission-prompts", input.permissionPrompts);
  if (input.permissionPromptTool) args2.push("--permission-prompt-tool", "stdio");
  args2.push(`--setting-sources=${input.settingSources.join(",")}`);
  if (input.strictMcpConfig) args2.push("--strict-mcp-config");
  if (Object.keys(input.mcpServers).length > 0) args2.push("--mcp-config", JSON.stringify({ mcpServers: input.mcpServers }));
  if (input.resumeSessionId) args2.push(`--resume=${input.resumeSessionId}`);
  if (input.safeMode) args2.push("--safe-mode");
  if (input.restricted) args2.push("--restricted");
  for (const directory of input.additionalDirectories) args2.push("--add-dir", directory);
  if (input.debugFile) args2.push("--debug-file", input.debugFile);
  return args2;
}
function planLaunch(input, cwd, env) {
  const args2 = buildCliArgs(input);
  return input.runWith === "node" ? { command: process.execPath, args: [input.executablePath, ...args2], cwd, env } : { command: input.executablePath, args: args2, cwd, env };
}

// src/preflight/cli-resolver.ts
var CREDENTIAL_ENV_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN", "ANTHROPIC_AWS_API_KEY"];
var PROVIDER_ENV_VARS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_MANTLE", "ANTHROPIC_BASE_URL"];

// src/broker/process-tree.ts
import { closeSync, openSync, statSync, unlinkSync, utimesSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import path2 from "node:path";

// src/broker/process-identity.ts
import { spawn as spawn2 } from "node:child_process";
import { promises as fs3 } from "node:fs";
var PROBE_TIMEOUT_MS = 1e4;
function runCapture(command, args2, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn2(command, args2, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let stdout = "";
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
      }
      done(null);
    }, PROBE_TIMEOUT_MS);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += chunk;
    });
    child.on("error", () => done(null));
    child.on("exit", (code) => done({ code, stdout: stdout.trim() }));
  });
}
var NOT_FOUND = "CODEORQUESTRA_NOT_FOUND";
var DENIED = "CODEORQUESTRA_DENIED";
async function windowsCreationTime(pid) {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$p = Get-Process -Id ${pid}`,
    `if (-not $p) { Write-Output '${NOT_FOUND}'; exit 0 }`,
    `try { Write-Output $p.StartTime.ToUniversalTime().ToString('o') } catch { Write-Output '${DENIED}' }`,
    "exit 0"
  ].join("; ");
  for (const shell of ["pwsh", "powershell"]) {
    const outcome = await runCapture(shell, ["-NoProfile", "-NonInteractive", "-Command", script]);
    if (outcome === null || outcome.code !== 0) continue;
    if (outcome.stdout === NOT_FOUND) return "";
    if (outcome.stdout === DENIED || outcome.stdout.length === 0) return null;
    return outcome.stdout;
  }
  return null;
}
async function linuxCreationTime(pid) {
  let raw;
  try {
    raw = await fs3.readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    return error.code === "ENOENT" ? "" : null;
  }
  const close = raw.lastIndexOf(")");
  if (close < 0) return null;
  const fields = raw.slice(close + 2).split(" ");
  const starttime = fields[19];
  return starttime && /^\d+$/.test(starttime) ? starttime : null;
}
async function bsdCreationTime(pid) {
  const outcome = await runCapture("ps", ["-o", "lstart=", "-p", String(pid)]);
  if (outcome === null) return null;
  if (outcome.code !== 0) return "";
  return outcome.stdout.length > 0 ? outcome.stdout : "";
}
async function readProcessCreationIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  if (process.platform === "win32") return windowsCreationTime(pid);
  if (process.platform === "linux") return linuxCreationTime(pid);
  return bsdCreationTime(pid);
}
var WINDOWS_TABLE_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().ToString('o') }",
  "exit 0"
].join("; ");

// src/broker/process-tree.ts
function holdFileFor(runDir) {
  return path2.join(runDir, "worker.hold");
}
function identityFileFor(runDir) {
  return path2.join(runDir, "worker-identity.json");
}
var HOLD_HEARTBEAT_MS = 5e3;
function claimWorkerIdentity(runDir, token) {
  mkdirSync(runDir, { recursive: true });
  const identity = { pid: process.pid, startedAt: (/* @__PURE__ */ new Date()).toISOString(), token, createdAt: null };
  writeFileSync(identityFileFor(runDir), JSON.stringify(identity, null, 2), "utf8");
  const hold = holdFileFor(runDir);
  const descriptor2 = openSync(hold, "w");
  const beat = () => {
    try {
      const now = /* @__PURE__ */ new Date();
      utimesSync(hold, now, now);
    } catch {
    }
  };
  beat();
  const timer = setInterval(beat, HOLD_HEARTBEAT_MS);
  timer.unref();
  const ready = readProcessCreationIdentity(process.pid).then((createdAt) => {
    if (createdAt) {
      writeFileSync(identityFileFor(runDir), JSON.stringify({ ...identity, createdAt }, null, 2), "utf8");
    }
  });
  const release = () => {
    clearInterval(timer);
    try {
      closeSync(descriptor2);
    } catch {
    }
    try {
      unlinkSync(hold);
    } catch {
    }
  };
  return { ready, release };
}
function engineFileFor(runDir) {
  return path2.join(runDir, "engine.json");
}
function recordEngineProcess(runDir, pid) {
  if (!pid) return;
  const record = { pid, recordedAt: (/* @__PURE__ */ new Date()).toISOString(), createdAt: null, exitedAt: null };
  try {
    writeFileSync(engineFileFor(runDir), JSON.stringify(record, null, 2), "utf8");
  } catch {
    return;
  }
  void readProcessCreationIdentity(pid).then((createdAt) => {
    if (!createdAt) return;
    const current = readEngineProcess(runDir);
    if (!current || current.pid !== pid || current.exitedAt) return;
    try {
      writeFileSync(engineFileFor(runDir), JSON.stringify({ ...current, createdAt }, null, 2), "utf8");
    } catch {
    }
  });
}
function recordEngineExit(runDir, code, signal) {
  const current = readEngineProcess(runDir);
  if (!current) return;
  try {
    writeFileSync(engineFileFor(runDir), JSON.stringify({ ...current, exitedAt: (/* @__PURE__ */ new Date()).toISOString(), exitCode: code, exitSignal: signal }, null, 2), "utf8");
  } catch {
  }
}
function readEngineProcess(runDir) {
  try {
    const parsed = JSON.parse(readFileSync(engineFileFor(runDir), "utf8"));
    return typeof parsed.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

// src/shared/types.ts
var BRAND = {
  name: "CodeOrquestra",
  tagline: "Codex com Opus e Fable",
  /** Primary technical identifier for new artifacts. */
  technicalId: "codeorquestra",
  /** Documented legacy alias: installed plugin, skill and state paths keep it. */
  legacyTechnicalId: "claude-code-live",
  disclaimer: "Integra\xE7\xE3o local independente que apenas controla o Claude Code j\xE1 instalado pelo usu\xE1rio; n\xE3o \xE9 produto oficial nem parceria entre OpenAI e Anthropic."
};
var RUNTIME_VERSION = "0.1.0";

// src/contract/job-contract.ts
var AUTHORIZED_MODELS = ["claude-fable-5-1", "claude-opus-5"];

// src/worker/async-queue.ts
var AsyncQueue = class {
  items = [];
  waiters = [];
  ended = false;
  push(item) {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }
  end() {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: void 0, done: true });
  }
  get isEnded() {
    return this.ended;
  }
  iterable() {
    const next = () => {
      if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
      if (this.ended) return Promise.resolve({ value: void 0, done: true });
      return new Promise((resolve) => this.waiters.push(resolve));
    };
    return {
      [Symbol.asyncIterator]: () => ({
        next,
        return: async () => {
          this.end();
          return { value: void 0, done: true };
        }
      })
    };
  }
};

// src/engine/session-client.ts
var DRAIN_TIMEOUT_MS = 5e3;
var EngineError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
};
var SessionClient = class {
  proc;
  callbacks;
  hooks;
  appendSystemPrompt;
  requestTimeoutMs;
  outbound = /* @__PURE__ */ new Map();
  inboundAborts = /* @__PURE__ */ new Map();
  messages = new AsyncQueue();
  counter = 0;
  closed = false;
  exited = false;
  exit_ = null;
  drainTimer = null;
  exitPromise;
  constructor(options) {
    this.proc = options.process;
    this.callbacks = options.callbacks;
    this.hooks = options.hooks;
    this.appendSystemPrompt = options.appendSystemPrompt;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 12e4;
    this.exitPromise = new Promise((resolve) => {
      this.proc.on("exit", (code, signal) => {
        this.exited = true;
        this.exit_ = { code, signal };
        this.failAllOutbound(new EngineError("CLI_EXITED", `O processo Claude Code encerrou (c\xF3digo ${String(code)}${signal ? `, sinal ${signal}` : ""}).`));
        this.armDrainDeadline();
        resolve({ code, signal });
      });
    });
    this.proc.on("error", (error) => {
      this.failAllOutbound(new EngineError("CLI_SPAWN_FAILED", `Falha ao executar o Claude Code instalado (${error.name}).`));
      this.messages.end();
    });
    if (this.proc.stderr) {
      this.proc.stderr.setEncoding("utf8");
      this.proc.stderr.on("data", (chunk) => this.callbacks.onStderr(chunk));
    }
    void this.pump();
  }
  get exit() {
    return this.exitPromise;
  }
  /** How the process ended, or null while it is still running. */
  get exitInfo() {
    return this.exit_;
  }
  /**
   * Waits briefly for the exit status so a caller can decide an outcome that
   * depends on it.
   *
   * stdout reaching its end and the process being reaped are separate events,
   * and the stream usually ends first. Without this wait, a caller that acts
   * the moment the conversation closes would see no exit status at all and
   * would have to guess why the session ended. Returns null when the process
   * is still running after the deadline — a fact, not a guess.
   */
  async settleExit(timeoutMs = 2e3) {
    if (this.exit_) return this.exit_;
    await Promise.race([
      this.exitPromise,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      })
    ]);
    return this.exit_;
  }
  get hasExited() {
    return this.exited;
  }
  /** Bounds the post-exit drain so a stream that never ends cannot hang a run. */
  armDrainDeadline() {
    if (this.drainTimer) return;
    this.drainTimer = setTimeout(() => {
      this.callbacks.onProblem({ code: "STDOUT_DRAIN_TIMEOUT", detail: `sa\xEDda n\xE3o terminou em ${DRAIN_TIMEOUT_MS}ms ap\xF3s o encerramento do processo` });
      this.messages.end();
    }, DRAIN_TIMEOUT_MS);
    this.drainTimer.unref();
  }
  /** Conversation frames (system/assistant/user/result/stream_event/...). */
  conversation() {
    return this.messages.iterable();
  }
  failAllOutbound(error) {
    for (const [id, pending] of this.outbound) {
      clearTimeout(pending.timer);
      this.outbound.delete(id);
      pending.reject(error);
    }
    for (const [, controller] of this.inboundAborts) controller.abort();
    this.inboundAborts.clear();
  }
  async pump() {
    try {
      for await (const frame of readFrames(this.proc.stdout, this.callbacks.onProblem)) {
        const type = frame.type;
        if (type === "control_response") {
          this.onControlResponse(frame);
          continue;
        }
        if (type === "control_request") {
          void this.onControlRequest(frame);
          continue;
        }
        if (type === "control_cancel_request") {
          const id = String(frame.request_id ?? "");
          this.inboundAborts.get(id)?.abort();
          continue;
        }
        if (type === "keep_alive") continue;
        this.messages.push(frame);
      }
    } catch (error) {
      this.callbacks.onProblem({ code: "STDOUT_READ_FAILED", detail: error.name });
    } finally {
      if (this.drainTimer) clearTimeout(this.drainTimer);
      this.messages.end();
    }
  }
  onControlResponse(frame) {
    const response = frame.response;
    const pending = this.outbound.get(response.request_id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.outbound.delete(response.request_id);
    if (response.subtype === "error") pending.reject(new EngineError("CONTROL_REQUEST_FAILED", response.error ?? "pedido de controle recusado pelo CLI"));
    else pending.resolve(response.response ?? {});
  }
  async onControlRequest(frame) {
    const requestId = frame.request_id;
    const subtype = frame.request.subtype;
    const controller = new AbortController();
    this.inboundAborts.set(requestId, controller);
    try {
      if (subtype === CONTROL_SUBTYPES.canUseTool) {
        const request = frame.request;
        const answer = await this.callbacks.canUseTool(request.tool_name, request.input ?? {}, {
          toolUseId: request.tool_use_id,
          requestId,
          agentId: request.agent_id ?? null,
          title: request.title ?? null,
          displayName: request.display_name ?? null,
          description: request.description ?? null,
          decisionReason: request.decision_reason ?? null,
          decisionReasonType: request.decision_reason_type ?? null,
          signal: controller.signal
        });
        this.respond(requestId, answer);
        return;
      }
      if (subtype === CONTROL_SUBTYPES.hookCallback) {
        const request = frame.request;
        const event = String(request.input?.hook_event_name ?? "");
        const answer = await this.callbacks.onHook(event, request.input ?? {}, {
          callbackId: request.callback_id,
          toolUseId: request.tool_use_id ?? null,
          signal: controller.signal
        });
        this.respond(requestId, answer);
        return;
      }
      this.respondError(requestId, `pedido de controle n\xE3o suportado: ${subtype}`);
    } catch (error) {
      this.respondError(requestId, `falha ao responder ${subtype} (${error.name})`);
    } finally {
      this.inboundAborts.delete(requestId);
    }
  }
  respond(requestId, payload) {
    if (this.closed || this.exited) return;
    try {
      writeFrame(this.proc.stdin, { type: "control_response", response: { subtype: "success", request_id: requestId, response: payload } });
    } catch (error) {
      this.callbacks.onProblem({ code: "CONTROL_RESPONSE_LOST", detail: error.name });
    }
  }
  respondError(requestId, message) {
    if (this.closed || this.exited) return;
    try {
      writeFrame(this.proc.stdin, { type: "control_response", response: { subtype: "error", request_id: requestId, error: message } });
    } catch {
    }
  }
  request(subtype, extra = {}, timeoutMs = this.requestTimeoutMs) {
    if (this.closed || this.exited) return Promise.reject(new EngineError("CLI_EXITED", "A sess\xE3o Claude Code j\xE1 foi encerrada."));
    this.counter += 1;
    const requestId = `req_${process.pid}_${this.counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.outbound.delete(requestId);
        try {
          writeFrame(this.proc.stdin, { type: "control_response", response: { subtype: "error", request_id: requestId, error: "timeout" } });
        } catch {
        }
        reject(new EngineError("CONTROL_REQUEST_TIMEOUT", `O CLI n\xE3o respondeu ao pedido ${subtype} em ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref();
      this.outbound.set(requestId, { resolve, reject, timer });
      try {
        writeFrame(this.proc.stdin, { type: "control_request", request_id: requestId, request: { ...extra, subtype } });
      } catch (error) {
        clearTimeout(timer);
        this.outbound.delete(requestId);
        reject(error);
      }
    });
  }
  /** Registers hooks and the appended system prompt before the first turn. */
  async initialize() {
    const byEvent = {};
    for (const hook of this.hooks) {
      const list = byEvent[hook.event] ?? (byEvent[hook.event] = []);
      const existing = list.find((entry) => entry.matcher === hook.matcher);
      if (existing) existing.hookCallbackIds.push(hook.callbackId);
      else list.push({ hookCallbackIds: [hook.callbackId], ...hook.matcher !== void 0 ? { matcher: hook.matcher } : {} });
    }
    const payload = { hooks: byEvent, systemPromptSnapshot: true };
    if (this.appendSystemPrompt) payload.appendSystemPrompt = this.appendSystemPrompt;
    const response = await this.request(CONTROL_SUBTYPES.initialize, payload, 6e4);
    return {
      models: Array.isArray(response.models) ? response.models : null,
      account: response.account ?? null,
      hooksApplied: typeof response.hooks_applied === "boolean" ? response.hooks_applied : null,
      raw: response
    };
  }
  async interrupt() {
    const response = await this.request(CONTROL_SUBTYPES.interrupt, {}, 3e4);
    return { stillQueued: Array.isArray(response.still_queued) ? response.still_queued : [] };
  }
  async setModel(model) {
    await this.request(CONTROL_SUBTYPES.setModel, { model }, 3e4);
  }
  send(text, sessionId) {
    if (this.closed || this.exited) throw new EngineError("CLI_EXITED", "A sess\xE3o Claude Code j\xE1 foi encerrada.");
    writeFrame(this.proc.stdin, {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      ...sessionId ? { session_id: sessionId } : {}
    });
  }
  /** Closes stdin so the CLI can shut down gracefully. */
  endInput() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.proc.stdin.end();
    } catch {
    }
  }
  /** Bounded teardown: graceful stdin close, then a scoped kill. */
  async close(graceMs = 4e3) {
    this.endInput();
    if (this.exited) return;
    const timer = setTimeout(() => {
      try {
        this.proc.kill("SIGKILL");
      } catch {
      }
    }, graceMs);
    timer.unref();
    await this.exitPromise;
    clearTimeout(timer);
  }
};

// src/worker/session.ts
var STDERR_LIMIT = 16 * 1024;
var SHUTDOWN_EXIT_GRACE_MS = 3e3;
var PRETOOLUSE_CALLBACK = "codeorquestra-pretooluse";
var INTERACTIVE_TOOLS = /* @__PURE__ */ new Set(["AskUserQuestion"]);
function buildSystemPromptAppendix(descriptor2) {
  const c = descriptor2.contract;
  const owners = Object.entries(c.coordination.responsibilities).map(([key, owner]) => `${key}=${owner}`).join(", ");
  const scope = c.scope.wholeWorkspace ? "todo o workspace aprovado" : c.scope.paths.join(", ");
  const capabilities = [
    c.capabilities.edit ? "edi\xE7\xE3o de arquivos no escopo" : "SEM edi\xE7\xE3o de arquivos",
    c.capabilities.test ? "execu\xE7\xE3o de testes/verifica\xE7\xF5es" : "SEM execu\xE7\xE3o de testes",
    c.capabilities.commands === "none" ? "SEM comandos de shell" : "comandos classificados caso a caso"
  ].join("; ");
  return [
    `Contexto ${BRAND.name} (integra\xE7\xE3o local independente; o Codex coordena e voc\xEA executa somente o que a matriz atribui ao Claude).`,
    `Plano aprovado (escopo ${c.coordination.scopeId}, revis\xE3o ${c.coordination.approvalRevision}): ${c.coordination.planSummary}`,
    `Respons\xE1veis: ${owners}.`,
    `Capacidades desta execu\xE7\xE3o: ${capabilities}.`,
    `Escopo de edi\xE7\xE3o: ${scope}. Resumo: ${c.scope.summary}`,
    "Commit, push, PR, deploy, publica\xE7\xE3o, instala\xE7\xE3o global e altera\xE7\xE3o de configura\xE7\xE3o instalada s\xE3o reservados ao Codex ou ao usu\xE1rio; nunca os execute.",
    "A\xE7\xF5es fora do escopo conhecido geram um pedido de permiss\xE3o vis\xEDvel ao coordenador; aguarde a decis\xE3o em vez de contornar.",
    "N\xE3o inclua segredos, credenciais ou dados pessoais nas respostas; o transcript p\xFAblico \xE9 armazenado."
  ].join("\n");
}
function sanitizedChildEnv(env, allowApiBilling, extra) {
  const output = {};
  for (const [key, value] of Object.entries(env)) {
    if (!allowApiBilling && (CREDENTIAL_ENV_VARS.includes(key) || PROVIDER_ENV_VARS.includes(key))) continue;
    output[key] = value;
  }
  return { ...output, ...extra };
}
function toolsForContract(contract) {
  if (contract.capabilities.edit && contract.capabilities.commands === "classified") return null;
  const tools = ["Read", "Glob", "Grep", "TodoWrite", "AskUserQuestion"];
  if (contract.capabilities.test || contract.capabilities.commands !== "none") tools.push("Bash");
  if (contract.capabilities.edit) tools.push("Write", "Edit", "NotebookEdit");
  return tools;
}
var WorkerSession = class {
  descriptor;
  adapter;
  send;
  client = null;
  phase = "starting";
  turnActive = false;
  interruptPending = false;
  interruptSource = null;
  endRequested = false;
  cancelledByEnd = false;
  sessionId;
  requestedModel;
  observedModel = null;
  pending = /* @__PURE__ */ new Map();
  openTools = /* @__PURE__ */ new Map();
  interactiveTools = /* @__PURE__ */ new Set();
  textStreams = /* @__PURE__ */ new Map();
  stderrTail = "";
  turn = 0;
  runEnded = false;
  failedTurn = false;
  currentDeliveryId = null;
  toolCounter = 0;
  /** Tool uses this runtime already reported as blocked, by tool_use_id. */
  blockedTools = /* @__PURE__ */ new Set();
  /** True once `initialize` succeeded and user frames may be sent. */
  protocolReady = false;
  /** In-flight model switch; no turn may start while it is pending. */
  modelTransition = null;
  /** True once a switch went unconfirmed: the loaded model is unknown. */
  modelUncertain = false;
  /** Deliveries that arrived before the handshake finished; never dropped. */
  heldDeliveries = [];
  constructor(descriptor2, adapter, send2) {
    this.descriptor = descriptor2;
    this.adapter = adapter;
    this.send = send2;
    this.sessionId = descriptor2.resumeSessionId;
    this.requestedModel = descriptor2.contract.model.resolved ?? descriptor2.contract.model.requested;
  }
  emit(type, data, toolUseId) {
    this.send({ t: "event", type, ...toolUseId ? { toolUseId } : {}, data });
  }
  /**
   * A pending interactive request always wins over a generic tool phase, so
   * the panel can never label a question as a permission prompt.
   */
  setPhase(phase) {
    let effective = phase;
    if (phase !== "terminal" && this.pending.size > 0) {
      const kinds = [...this.pending.values()].map((entry) => entry.request.kind);
      effective = kinds.includes("question") ? "waiting_question" : "waiting_permission";
    }
    this.phase = effective;
    const currentTool = this.openTools.size ? [...this.openTools.values()].at(-1) ?? null : null;
    this.send({ t: "phase", phase: effective, currentTool });
  }
  actionContext() {
    const c = this.descriptor.contract;
    return {
      profile: c.profile,
      workspace: c.workspace,
      scopePaths: c.scope.paths,
      wholeWorkspace: c.scope.wholeWorkspace,
      responsibilities: c.coordination.responsibilities,
      capabilities: c.capabilities,
      approvedMcpServers: Object.keys(this.descriptor.launch.mcpServers),
      approvedMcpTools: this.descriptor.approvedMcpTools,
      approvedAgents: this.descriptor.approvedAgents ?? [],
      approvedSkills: this.descriptor.approvedSkills ?? [],
      // A delegated agent runs under this same contract: it may not pick
      // another model, nor a weaker effort than the one this run authorizes.
      authorizedModels: [...AUTHORIZED_MODELS],
      requiredEffort: c.effort,
      ...c.legacy ? { legacyMode: c.legacy.mode, legacyAllowedCommands: c.legacy.allowedCommands.map((command) => command.rule) } : {}
    };
  }
  async start() {
    this.setPhase("starting");
    const d = this.descriptor;
    const c = d.contract;
    const env = sanitizedChildEnv(process.env, c.auth.allowApiBilling, {
      ...d.launch.env,
      CLAUDE_CODE_ENTRYPOINT: "codeorquestra",
      CODEORQUESTRA_VERSION: RUNTIME_VERSION
    });
    const plan = planLaunch({
      executablePath: d.executable.path,
      runWith: d.executable.runWith,
      model: this.requestedModel,
      effort: c.effort,
      tools: toolsForContract(c),
      permissionMode: c.launch.permissionMode,
      permissionPrompts: c.launch.permissionPromptsDisabled ? "none" : "host",
      permissionPromptTool: !c.launch.permissionPromptsDisabled,
      settingSources: d.launch.settingSources,
      strictMcpConfig: true,
      mcpServers: d.launch.mcpServers,
      resumeSessionId: this.sessionId,
      safeMode: c.launch.safeMode,
      restricted: c.launch.restricted,
      additionalDirectories: [],
      debugFile: null
    }, c.workspace, env);
    let proc;
    try {
      proc = this.adapter.spawn(plan);
      recordEngineProcess(d.runDir, proc.pid);
    } catch (error) {
      this.emit("preparation_failed", { stage: "cli-spawn", code: "CLI_SPAWN_FAILED", message: `N\xE3o foi poss\xEDvel iniciar o Claude Code instalado (${error.name}).` });
      this.finish("FAIL", "CLI_SPAWN_FAILED", "N\xE3o foi poss\xEDvel iniciar o Claude Code instalado.", 1);
      return;
    }
    this.client = new SessionClient({
      process: proc,
      hooks: [{ event: "PreToolUse", callbackId: PRETOOLUSE_CALLBACK }],
      appendSystemPrompt: buildSystemPromptAppendix(d),
      callbacks: {
        canUseTool: (tool, input, context) => this.canUseTool(tool, input, context),
        onHook: (event, input, context) => this.onHook(event, input, context),
        onStderr: (text) => {
          this.stderrTail = (this.stderrTail + text).slice(-STDERR_LIMIT);
        },
        onProblem: (problem) => this.emit("transport_problem", { code: problem.code, detail: problem.detail })
      }
    });
    void this.client.exit.then(({ code, signal }) => recordEngineExit(d.runDir, code, signal));
    try {
      const initialized = await this.client.initialize();
      this.emit("cli_initialized", {
        hooksApplied: initialized.hooksApplied,
        modelCatalogSize: initialized.models?.length ?? null,
        modelSupport: describeModelSupport(initialized.models, this.requestedModel)
      });
      if (initialized.hooksApplied !== true) {
        this.abortRun("PRETOOLUSE_HOOK_NOT_APPLIED", `O CLI instalado n\xE3o confirmou a aplica\xE7\xE3o do hook PreToolUse (hooks_applied=${String(initialized.hooksApplied)}); sem esse controle nenhum trabalho \xE9 iniciado.`);
        return;
      }
      if (initialized.models && describeModelSupport(initialized.models, this.requestedModel) === "unsupported") {
        this.abortRun("MODEL_NOT_OFFERED_BY_CLI", `O cat\xE1logo do CLI instalado n\xE3o oferece ${this.requestedModel}; nenhum outro modelo \xE9 iniciado no lugar.`);
        return;
      }
      this.protocolReady = true;
      for (const held of this.heldDeliveries.splice(0)) this.deliver(held.messageId, held.text, held.source);
    } catch (error) {
      const code = error.code ?? "CLI_INITIALIZE_FAILED";
      this.emit("preparation_failed", { stage: "cli-initialize", code, message: `A inicializa\xE7\xE3o do protocolo com o CLI falhou (${code}).` });
      this.finish("FAIL", code, "A inicializa\xE7\xE3o do protocolo com o CLI falhou.", 1);
      return;
    }
    try {
      for await (const message of this.client.conversation()) {
        await this.handle(message);
        if (this.runEnded) break;
      }
      if (!this.runEnded) await this.finishFromShutdown();
    } catch (error) {
      const code = error.code ?? error.name ?? "SESSION_ERROR";
      this.finish("FAIL", String(code), `A sess\xE3o terminou com erro (${String(code)}).`, 1);
    }
  }
  /**
   * Decides the terminal outcome after the conversation stream ended.
   *
   * A closed stream is not success. The outcome needs three facts: whether the
   * protocol completed the work (no turn left running, no failed turn), whether
   * WE asked the CLI to close, and how the process actually exited. A CLI that
   * died on its own — non-zero code or a signal — is a failure even if the last
   * turn had finished, and is never reported as COMPLETED or CANCELLED.
   *
   * stdout ends before the process is reaped, so when nobody asked for the
   * close we wait for the exit status first. Deciding without it would report
   * "the stream ended mid-turn" for a CLI that actually crashed, hiding the
   * exit code and the real cause behind a vaguer reason.
   */
  async finishFromShutdown() {
    if (!this.endRequested) await this.client?.settleExit(SHUTDOWN_EXIT_GRACE_MS);
    if (this.runEnded) return;
    const exit = this.client?.exitInfo ?? null;
    const abnormal = exit !== null && !this.endRequested && (exit.signal !== null || exit.code !== null && exit.code !== 0);
    if (abnormal) {
      const detail = exit.signal ? `sinal ${exit.signal}` : `c\xF3digo ${String(exit.code)}`;
      this.finish("FAIL", "CLI_EXITED_UNEXPECTEDLY", `O Claude Code encerrou sozinho (${detail}) sem que o encerramento fosse solicitado; o resultado n\xE3o pode ser aceito como conclu\xEDdo.`, 1);
      return;
    }
    if (this.failedTurn) {
      this.finish("FAIL", "TURN_FAILED", "A sess\xE3o terminou ap\xF3s um turno com erro; revise as evid\xEAncias antes de aceitar.", 1);
      return;
    }
    if (this.turnActive && !this.endRequested) {
      const detail = exit === null ? "o processo continuou ativo com a sa\xEDda fechada" : `o processo terminou com c\xF3digo ${String(exit.code)}`;
      this.finish("FAIL", "CLI_STREAM_ENDED_MID_TURN", `O fluxo do Claude Code terminou no meio de um turno, sem resultado (${detail}); a execu\xE7\xE3o fica como falha para revis\xE3o.`, 1);
      return;
    }
    if (!this.endRequested && exit === null) {
      this.finish("FAIL", "CLI_EXIT_UNKNOWN", "O fluxo do Claude Code terminou sem que o processo informasse seu encerramento; ele pode continuar ativo. A execu\xE7\xE3o fica como falha para revis\xE3o.", 1);
      return;
    }
    const cancelled = this.turnActive || this.cancelledByEnd;
    const message = this.endRequested ? cancelled ? "Sess\xE3o encerrada pelo coordenador durante um turno." : "Sess\xE3o encerrada pelo coordenador." : null;
    this.finish(cancelled ? "CANCELLED" : "COMPLETED", null, message, 0);
  }
  finish(status, code, message, exitCode) {
    if (this.runEnded) return;
    this.runEnded = true;
    for (const pending of this.pending.values()) pending.resolve({ behavior: "deny", message: "Sess\xE3o encerrada antes da decis\xE3o." });
    this.pending.clear();
    if (this.stderrTail.trim()) this.emit("stderr_tail", { preview: boundedPreview(redactSensitiveText(this.stderrTail), 2048).preview });
    this.setPhase("terminal");
    this.send({ t: "run_ended", status, code, message, exitCode });
    void this.client?.close(4e3);
  }
  handleBrokerMessage(message) {
    switch (message.t) {
      case "deliver":
        this.deliver(message.messageId, message.text, message.source);
        break;
      case "answer":
        this.answer(message);
        break;
      case "interrupt":
        void this.interrupt(message.source);
        break;
      case "end":
        void this.end(message.source);
        break;
      case "set_model":
        void this.setModel(message.model, message.reason, message.source);
        break;
      case "exit":
        void this.client?.close(1e3).then(() => process.exit(0));
        setTimeout(() => process.exit(0), 2e3).unref();
        break;
      default:
        break;
    }
  }
  deliver(messageId, text, source) {
    if (this.runEnded) return;
    if (this.modelUncertain) {
      this.emit("delivery_blocked", { messageId, source, reason: "MODEL_UNCERTAIN", message: "O modelo em vigor n\xE3o foi confirmado pelo CLI; nenhum turno novo \xE9 iniciado at\xE9 revis\xE3o expl\xEDcita." });
      return;
    }
    if (!this.client || !this.protocolReady || this.modelTransition) {
      this.heldDeliveries.push({ messageId, text, source });
      return;
    }
    this.turn += 1;
    this.turnActive = true;
    this.interruptPending = false;
    this.currentDeliveryId = messageId;
    this.emit("turn_started", { turn: this.turn, messageId, source });
    this.setPhase("busy_model");
    try {
      this.client.send(text, this.sessionId);
    } catch (error) {
      this.turnActive = false;
      this.emit("turn_send_failed", { messageId, code: error.code ?? "SEND_FAILED" });
      this.send({ t: "turn_done", interrupted: false });
    }
  }
  answer(message) {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    const { request } = pending;
    const note = message.message ? redactSensitiveText(message.message).slice(0, 2e3) : null;
    if (request.kind === "question") {
      const answers = message.answers ?? {};
      this.emit("question_answered", { requestId: request.requestId, source: message.source, answers: redactAnswers(answers), decision: message.decision });
      if (message.decision === "deny") pending.resolve({ behavior: "deny", message: note ?? "Pergunta recusada pelo coordenador." });
      else pending.resolve({ behavior: "allow", updatedInput: { ...pending.input, answers } });
    } else {
      this.emit("permission_resolved", { requestId: request.requestId, decision: message.decision === "allow" ? "allow" : "deny", source: message.source, message: note, tool: request.tool });
      if (message.decision === "allow") pending.resolve({ behavior: "allow", updatedInput: pending.input });
      else pending.resolve({ behavior: "deny", message: note ?? "Negado pelo coordenador." });
    }
    if (this.runEnded || this.pending.size > 0) return;
    this.setPhase(this.openTools.size ? "busy_tool" : "busy_model");
  }
  async interrupt(source) {
    if (!this.client || !this.turnActive) return;
    this.interruptPending = true;
    this.interruptSource = source;
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      this.emit("permission_resolved", { requestId, decision: "deny", source, message: "Turno interrompido.", tool: pending.request.tool });
      pending.resolve({ behavior: "deny", message: "Turno interrompido pelo coordenador.", interrupt: true });
    }
    try {
      await this.client.interrupt();
    } catch (error) {
      this.emit("interrupt_failed", { code: error.code ?? "INTERRUPT_FAILED" });
    }
  }
  async end(source) {
    if (this.endRequested) return;
    this.endRequested = true;
    this.cancelledByEnd = this.turnActive;
    this.emit("session_end_requested", { source, duringTurn: this.turnActive });
    const fallback = setTimeout(() => {
      if (!this.runEnded) {
        this.finish(this.cancelledByEnd || this.turnActive ? "CANCELLED" : "COMPLETED", null, "Sess\xE3o encerrada pelo coordenador.", 0);
      }
    }, 8e3);
    fallback.unref();
    if (this.turnActive) await this.interrupt(source);
    this.client?.endInput();
  }
  /**
   * Applies a model change between turns.
   *
   * The transition is reserved for its whole duration: a message that arrives
   * while the CLI is still switching is held, not delivered, so a turn can
   * never start on an indeterminate model. Every outcome is reported back, and
   * a refusal leaves the previously active model explicit.
   */
  async setModel(model, reason, source) {
    const refuse = (code) => {
      this.emit("model_change_refused", { model, reason: code, source, activeModel: this.requestedModel });
      this.send({ t: "model_result", ok: false, model, activeModel: this.requestedModel, code });
    };
    if (!this.client || !this.protocolReady) return refuse("SESSION_NOT_READY");
    if (this.modelUncertain) return refuse("MODEL_UNCERTAIN");
    if (this.turnActive) return refuse("TURN_IN_PROGRESS");
    if (this.modelTransition) return refuse("MODEL_CHANGE_IN_PROGRESS");
    const from = this.requestedModel;
    const transition = (async () => {
      try {
        await this.client.setModel(model);
        this.requestedModel = model;
        this.emit("model_changed", { from, to: model, reason: redactSensitiveText(reason).slice(0, 500), source, strategy: "in_session" });
        this.send({ t: "model_result", ok: true, model, activeModel: model, code: null });
      } catch (error) {
        const code = error.code ?? "SET_MODEL_FAILED";
        if (code === "CONTROL_REQUEST_TIMEOUT") {
          this.modelUncertain = true;
          this.emit("model_change_uncertain", { model, previousModel: from, code, note: "O CLI n\xE3o respondeu; o modelo em vigor \xE9 desconhecido." });
          this.send({ t: "model_uncertain", model, previousModel: from, code });
          return;
        }
        this.emit("model_change_failed", { model, code, activeModel: from });
        this.send({ t: "model_result", ok: false, model, activeModel: from, code });
      }
    })();
    this.modelTransition = transition;
    try {
      await transition;
    } finally {
      this.modelTransition = null;
      for (const held of this.heldDeliveries.splice(0)) this.deliver(held.messageId, held.text, held.source);
    }
  }
  // ------------------------------------------------------------ decisions
  decide(tool, input) {
    const result2 = classifyToolAction({ tool, input }, this.actionContext());
    return { decision: result2.decision, reason: result2.reason, message: result2.message };
  }
  async onHook(event, input, _context) {
    if (event !== "PreToolUse") return { continue: true };
    const tool = String(input.tool_name ?? "");
    const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
    const toolUseId = String(input.tool_use_id ?? "");
    if (tool === "AskUserQuestion" || tool === "ExitPlanMode") return { continue: true };
    const decision = this.decide(tool, toolInput);
    if (decision.decision === "deny") {
      if (toolUseId) this.blockedTools.add(toolUseId);
      this.emit("tool_blocked", { tool, reason: decision.reason, message: decision.message, enforcedBy: "PreToolUse", inputPreview: previewInput(toolInput) }, toolUseId || void 0);
      return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.message } };
    }
    if (decision.decision === "allow") {
      return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: decision.message } };
    }
    return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: decision.message } };
  }
  canUseTool(toolName, input, context) {
    const isQuestion = toolName === "AskUserQuestion";
    const decision = isQuestion ? { decision: "escalate", reason: "QUESTION", message: "Pergunta do Claude aguardando resposta." } : this.decide(toolName, input);
    if (decision.decision === "allow") return Promise.resolve({ behavior: "allow", updatedInput: input });
    if (decision.decision === "deny") {
      this.blockedTools.add(context.toolUseId);
      this.emit("tool_blocked", { tool: toolName, reason: decision.reason, message: decision.message, enforcedBy: "canUseTool", inputPreview: previewInput(input) }, context.toolUseId);
      return Promise.resolve({ behavior: "deny", message: decision.message });
    }
    if (context.signal.aborted) {
      this.emit("permission_resolved", { requestId: context.requestId, decision: "deny", source: "system", message: "Pedido j\xE1 cancelado pelo CLI antes da decis\xE3o.", tool: toolName });
      return Promise.resolve({ behavior: "deny", message: "Pedido cancelado antes da decis\xE3o." });
    }
    const request = {
      requestId: `req-${randomUUID()}`,
      runId: this.descriptor.runId,
      kind: isQuestion ? "question" : "permission",
      tool: toolName,
      reason: decision.reason,
      message: decision.message,
      inputPreview: previewInput(input),
      questions: isQuestion ? extractQuestions(input) : [],
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      state: "pending"
    };
    if (isQuestion) {
      this.emit("question_asked", {
        requestId: request.requestId,
        questions: request.questions,
        summary: request.questions.map((q) => q.question).join(" | ").slice(0, 500),
        title: safeText(context.title, 200)
      }, context.toolUseId);
    } else {
      this.emit("permission_requested", {
        requestId: request.requestId,
        tool: toolName,
        reason: decision.reason,
        decision: "escalate",
        message: decision.message,
        inputPreview: request.inputPreview,
        title: safeText(context.title, 200),
        cliReason: safeText(context.decisionReason, 300),
        cliReasonType: safeText(context.decisionReasonType, 60)
      }, context.toolUseId);
    }
    this.send({ t: "request", request });
    this.setPhase(isQuestion ? "waiting_question" : "waiting_permission");
    return new Promise((resolve) => {
      let settled = false;
      const settle2 = (answer) => {
        if (settled) return;
        settled = true;
        resolve(answer);
      };
      this.pending.set(request.requestId, { request, input, resolve: settle2 });
      context.signal.addEventListener("abort", () => {
        if (this.pending.delete(request.requestId)) {
          this.emit("permission_resolved", { requestId: request.requestId, decision: "deny", source: "system", message: "Solicita\xE7\xE3o cancelada pelo CLI.", tool: toolName });
          settle2({ behavior: "deny", message: "Solicita\xE7\xE3o cancelada." });
        }
      }, { once: true });
    });
  }
  // ----------------------------------------------------------- CLI frames
  async handle(raw) {
    const message = sanitizeHiddenContent(raw).sanitized;
    switch (message.type) {
      case "system": {
        const subtype = String(message.subtype ?? "");
        if (subtype === "init") this.onInit(message);
        else if (subtype === "permission_denied") {
          const toolUseId = typeof message.tool_use_id === "string" ? message.tool_use_id : void 0;
          if (!toolUseId || !this.blockedTools.has(toolUseId)) {
            this.emit("tool_blocked", {
              tool: String(message.tool_name ?? "?"),
              reason: "CLI_DENIED",
              message: safeText(message.message, 500) ?? "",
              enforcedBy: "cli"
            }, toolUseId);
          }
        } else {
          this.emit("system_notice", { subtype });
        }
        break;
      }
      case "stream_event":
        this.onStreamEvent(message);
        break;
      case "assistant":
        this.onAssistant(message);
        break;
      case "user":
        this.onUser(message);
        break;
      case "result":
        this.onResult(message);
        break;
      case "auth_status":
        this.emit("auth_status", { isAuthenticating: message.isAuthenticating === true, hasError: Boolean(message.error) });
        break;
      default:
        break;
    }
  }
  onInit(message) {
    const sessionId = typeof message.session_id === "string" ? message.session_id : null;
    const observed = typeof message.model === "string" ? message.model : null;
    this.sessionId = sessionId ?? this.sessionId;
    this.observedModel = observed;
    const effortObserved = typeof message.effort === "string" ? message.effort : null;
    const apiKeySource = typeof message.apiKeySource === "string" ? message.apiKeySource : null;
    this.emit("session_init", {
      sessionId,
      observedModel: observed,
      effortObservedByCli: effortObserved,
      cliVersion: typeof message.claude_code_version === "string" ? message.claude_code_version : null,
      capabilities: Array.isArray(message.capabilities) ? message.capabilities : [],
      apiKeySource,
      permissionMode: typeof message.permissionMode === "string" ? message.permissionMode : null,
      mcpServers: Array.isArray(message.mcp_servers) ? message.mcp_servers.map((server) => ({ name: server.name, status: server.status })) : [],
      resumeMode: this.descriptor.resumeMode
    });
    const c = this.descriptor.contract;
    if (observed && !modelMatches(this.requestedModel, observed)) {
      this.abortRun("MODEL_MISMATCH", `O CLI iniciou a sess\xE3o com ${observed}, diferente do modelo autorizado ${this.requestedModel}; nenhuma substitui\xE7\xE3o silenciosa \xE9 aceita.`);
      return;
    }
    if (effortObserved !== null && effortObserved !== c.effort) {
      this.abortRun("EFFORT_DOWNGRADED_BY_CLI", `O CLI aplicar\xE1 esfor\xE7o ${effortObserved} em vez de ${c.effort} (limite de conta, modelo ou pol\xEDtica); o trabalho n\xE3o continua em sil\xEAncio com esfor\xE7o reduzido.`);
      return;
    }
    if (apiKeySource && ["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key"].includes(apiKeySource) && !c.auth.allowApiBilling) {
      this.abortRun("AUTH_API_BILLING_NOT_AUTHORIZED", `A sess\xE3o usaria credencial de API (${apiKeySource}) sem autoriza\xE7\xE3o expl\xEDcita de cobran\xE7a.`);
      return;
    }
    if (this.phase === "starting") this.setPhase(this.turnActive ? "busy_model" : "idle");
  }
  abortRun(code, message) {
    this.emit("preparation_failed", { stage: "session-init", code, message });
    this.client?.endInput();
    this.finish("FAIL", code, message, 1);
  }
  onStreamEvent(message) {
    const event = message.event;
    if (!event) return;
    const type = String(event.type ?? "");
    const index = String(event.index ?? 0);
    if (type === "content_block_start") {
      const block = event.content_block;
      if (block?.type === "text") this.textStreams.set(index, new TextRedactionStream());
      return;
    }
    if (type === "content_block_delta") {
      const delta = event.delta;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        let stream = this.textStreams.get(index);
        if (!stream) {
          stream = new TextRedactionStream();
          this.textStreams.set(index, stream);
        }
        const visible = stream.push(delta.text);
        this.send({ t: "transient", frame: { kind: "text_progress", taskId: this.descriptor.taskId, runId: this.descriptor.runId, blockId: `${this.turn}:${index}`, text: visible.slice(-8192), ts: (/* @__PURE__ */ new Date()).toISOString() } });
      }
      return;
    }
    if (type === "content_block_stop") this.textStreams.delete(index);
  }
  onAssistant(message) {
    const body = message.message ?? {};
    const model = typeof body.model === "string" ? body.model : null;
    if (model) {
      if (!modelMatches(this.requestedModel, model)) {
        this.abortRun("MODEL_MISMATCH", `Uma mensagem do assistente veio de ${model}, diferente do modelo autorizado ${this.requestedModel}; o trabalho n\xE3o \xE9 aceito.`);
        return;
      }
      this.observedModel = model;
    }
    const error = typeof message.error === "string" ? message.error : null;
    if (error) {
      this.emit("assistant_error", { code: error });
      if (["authentication_failed", "billing_error", "cloud_credential_error", "oauth_org_not_allowed", "account_on_hold"].includes(error)) {
        this.abortRun(`ASSISTANT_${error.toUpperCase()}`, "A sess\xE3o parou por falha de autentica\xE7\xE3o, autoriza\xE7\xE3o ou cobran\xE7a; nenhuma tentativa alternativa \xE9 feita.");
        return;
      }
    }
    const content = Array.isArray(body.content) ? body.content : [];
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        const text = redactSensitiveText(block.text);
        const preview = boundedPreview(text, 64 * 1024);
        this.emit("assistant_text", {
          text: preview.preview,
          truncated: preview.truncated,
          totalChars: preview.totalChars,
          model: this.observedModel,
          messageId: this.currentDeliveryId,
          parentToolUseId: typeof message.parent_tool_use_id === "string" ? message.parent_tool_use_id : null
        });
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        const id = typeof block.id === "string" ? block.id : `toolu_local_${this.toolCounter += 1}`;
        const input = block.input && typeof block.input === "object" ? block.input : {};
        if (INTERACTIVE_TOOLS.has(block.name)) {
          this.interactiveTools.add(id);
          continue;
        }
        this.openTools.set(id, block.name);
        this.emit("tool_start", { name: block.name, inputPreview: previewInput(input), parentToolUseId: typeof message.parent_tool_use_id === "string" ? message.parent_tool_use_id : null }, id);
        this.setPhase("busy_tool");
      }
    }
  }
  onUser(message) {
    const body = message.message ?? {};
    const content = Array.isArray(body.content) ? body.content : [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      if (this.interactiveTools.delete(id)) continue;
      const text = redactSensitiveText(toolResultText(block.content));
      const preview = boundedPreview(text);
      let blobId = null;
      if (preview.truncated) {
        blobId = `blob-${randomUUID()}`;
        const blob = boundBlob(text);
        this.send({ t: "blob", blobId, text: blob.text, truncated: blob.truncated, totalChars: blob.totalChars });
      }
      const name = this.openTools.get(id) ?? null;
      this.openTools.delete(id);
      this.emit("tool_result", { name, isError: block.is_error === true, preview: preview.preview, truncated: preview.truncated, totalChars: preview.totalChars, pages: preview.pages, blobId }, id);
    }
    if (this.turnActive && this.pending.size === 0) this.setPhase(this.openTools.size ? "busy_tool" : "busy_model");
  }
  onResult(message) {
    const interrupted = this.interruptPending;
    this.turnActive = false;
    this.interruptPending = false;
    this.openTools.clear();
    this.textStreams.clear();
    const subtype = String(message.subtype ?? "");
    const isError = message.is_error === true || subtype !== "success";
    const resultText = subtype === "success" && typeof message.result === "string" ? redactSensitiveText(message.result) : "";
    const preview = boundedPreview(resultText, 64 * 1024);
    const usage2 = message.usage;
    const denials = Array.isArray(message.permission_denials) ? message.permission_denials.length : 0;
    const data = {
      turn: this.turn,
      subtype,
      isError,
      resultText: preview.preview,
      truncated: preview.truncated,
      numTurns: typeof message.num_turns === "number" ? message.num_turns : null,
      durationMs: typeof message.duration_ms === "number" ? message.duration_ms : null,
      tokens: usage2 ? { input: usage2.input_tokens ?? null, output: usage2.output_tokens ?? null } : null,
      permissionDenials: denials,
      terminalReason: typeof message.terminal_reason === "string" ? message.terminal_reason : null,
      errors: Array.isArray(message.errors) ? message.errors.map((error) => redactSensitiveText(String(error)).slice(0, 300)) : [],
      model: this.observedModel
    };
    if (interrupted) this.emit("turn_interrupted", { ...data, source: this.interruptSource ?? "system" });
    else if (isError) {
      this.failedTurn = true;
      this.emit("turn_failed", data);
    } else this.emit("turn_completed", data);
    const sessionId = typeof message.session_id === "string" ? message.session_id : null;
    if (sessionId && this.sessionId !== sessionId) {
      this.sessionId = sessionId;
      this.emit("session_init", { sessionId, observedModel: this.observedModel, effortObservedByCli: null, resumeMode: this.descriptor.resumeMode, source: "result" });
    }
    if (isError && !interrupted) {
      this.setPhase("terminal");
      this.send({ t: "turn_done", interrupted: false });
      this.client?.endInput();
      this.finish("FAIL", "TURN_FAILED", `O turno terminou com erro (${subtype}); revise as evid\xEAncias.`, 1);
      return;
    }
    this.setPhase("idle");
    this.send({ t: "turn_done", interrupted });
    if (this.endRequested) this.client?.endInput();
  }
};
function describeModelSupport(models, requested) {
  if (!models || models.length === 0) return "unknown";
  return models.some((model) => model.value === requested || model.resolvedModel === requested) ? "confirmed" : "unsupported";
}
function modelMatches(requested, observed) {
  return observed === requested || observed.startsWith(`${requested}-`);
}
function safeText(value, limit) {
  if (typeof value !== "string" || !value) return null;
  const stripped = value.replace(/\[[0-9;?]*[ -/]*[@-~]/g, "");
  return boundedPreview(redactSensitiveText(stripped), limit).preview;
}
function previewInput(input) {
  return boundedPreview(redactSensitiveText(JSON.stringify(input ?? {}, null, 0)), 2048).preview;
}
function redactAnswers(answers) {
  const output = {};
  for (const [key, value] of Object.entries(answers)) {
    const safeKey = redactSensitiveText(key).slice(0, 300);
    output[safeKey] = Array.isArray(value) ? value.map((item) => redactSensitiveText(item).slice(0, 500)) : redactSensitiveText(value).slice(0, 500);
  }
  return output;
}
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => part && typeof part === "object" && typeof part.text === "string" ? part.text : "").join("\n");
  }
  return "";
}
function extractQuestions(input) {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  return raw.map((entry) => ({
    question: safeText(String(entry.question ?? ""), 1e3) ?? "",
    ...typeof entry.header === "string" ? { header: safeText(entry.header, 120) ?? "" } : {},
    options: Array.isArray(entry.options) ? entry.options.map((option) => ({
      label: safeText(String(option.label ?? ""), 200) ?? "",
      ...typeof option.description === "string" ? { description: safeText(option.description, 500) ?? "" } : {}
    })) : [],
    ...typeof entry.multiSelect === "boolean" ? { multiSelect: entry.multiSelect } : {}
  }));
}

// src/worker/main.ts
function usage() {
  process.stderr.write("codeorquestra worker requer --descriptor <arquivo.json> e um canal IPC do broker.\n");
  process.exit(2);
}
var args = process.argv.slice(2);
var descriptorIndex = args.indexOf("--descriptor");
if (descriptorIndex < 0 || !args[descriptorIndex + 1] || typeof process.send !== "function") usage();
var descriptor = JSON.parse(readFileSync2(args[descriptorIndex + 1], "utf8"));
var identityClaim = claimWorkerIdentity(descriptor.runDir, readEnv("RUN_TOKEN") ?? "");
process.on("exit", () => identityClaim.release());
var send = (message) => {
  try {
    process.send?.(message);
  } catch {
  }
};
process.on("disconnect", () => {
  process.exit(3);
});
var session = null;
var pendingMessages = [];
process.on("message", (message) => {
  if (session) session.handleBrokerMessage(message);
  else if (message.t === "exit") process.exit(0);
  else pendingMessages.push(message);
});
await identityClaim.ready;
if (!process.connected) process.exit(3);
async function main() {
  if (descriptor.harness?.effortCap && readEnv("TEST_HARNESS") === "1") process.env[envName("FAKE_EFFORT_CAP")] = descriptor.harness.effortCap;
  if (descriptor.harness?.modelCatalog && readEnv("TEST_HARNESS") === "1") process.env[envName("FAKE_MODEL_CATALOG")] = descriptor.harness.modelCatalog.join(",");
  if (descriptor.harness?.hooksApplied === false && readEnv("TEST_HARNESS") === "1") process.env[envName("FAKE_HOOKS_APPLIED")] = "false";
  if (descriptor.harness?.setModelDelayMs && readEnv("TEST_HARNESS") === "1") process.env[envName("FAKE_SET_MODEL_DELAY_MS")] = String(descriptor.harness.setModelDelayMs);
  if (descriptor.harness?.failPreparation === "adapter-load") {
    send({ t: "preparation_failed", stage: "adapter-load", code: "ADAPTER_LOAD_FAILED", message: "Falha simulada pelo harness ao carregar o adaptador." });
    await settle();
    process.exit(1);
  }
  let adapter;
  try {
    adapter = await loadEngineAdapter(process.env, descriptor.harness?.adapterPath);
  } catch (error) {
    send({ t: "preparation_failed", stage: "adapter-load", code: error.code ?? "ADAPTER_LOAD_FAILED", message: error.message });
    await settle();
    process.exit(1);
  }
  session = new WorkerSession(descriptor, adapter, send);
  send({ t: "ready", simulated: adapter.simulated, adapter: adapter.simulated ? "simulado" : "cli-instalado" });
  for (const message of pendingMessages.splice(0)) session.handleBrokerMessage(message);
  await session.start();
  await settle();
  process.exit(0);
}
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 3e3).unref());
}
main().catch((error) => {
  send({ t: "run_ended", status: "FAIL", code: "WORKER_CRASH", message: redactSensitiveText(String(error.message ?? error)).slice(0, 300), exitCode: 1 });
  setTimeout(() => process.exit(1), 200);
});
