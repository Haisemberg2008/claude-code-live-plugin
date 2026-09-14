import { createRequire as __codeorquestraCreateRequire } from 'node:module';
const require = __codeorquestraCreateRequire(import.meta.url);
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/engine/protocol.ts
var REQUIRED_CLI_FLAGS;
var init_protocol = __esm({
  "src/engine/protocol.ts"() {
    "use strict";
    REQUIRED_CLI_FLAGS = [
      "--output-format",
      "--input-format",
      "--verbose",
      "--include-partial-messages",
      "--model",
      "--effort",
      "--tools",
      "--permission-mode",
      "--permission-prompts",
      "--permission-prompt-tool",
      "--setting-sources",
      "--strict-mcp-config",
      "--mcp-config",
      "--resume"
    ];
  }
});

// src/preflight/cli-resolver.ts
var cli_resolver_exports = {};
__export(cli_resolver_exports, {
  CREDENTIAL_ENV_VARS: () => CREDENTIAL_ENV_VARS,
  PROVIDER_ENV_VARS: () => PROVIDER_ENV_VARS,
  REQUIRED_CLI_FLAGS: () => REQUIRED_CLI_FLAGS,
  assessAuthPath: () => assessAuthPath,
  diagnoseCliCompatibility: () => diagnoseCliCompatibility,
  resolveClaudeExecutable: () => resolveClaudeExecutable,
  resolvePreflight: () => resolvePreflight
});
import { promises as fs5 } from "node:fs";
import path5 from "node:path";
async function exists(file) {
  try {
    await fs5.access(file);
    return true;
  } catch {
    return false;
  }
}
async function readPackage(packageDir) {
  try {
    const parsed = JSON.parse(await fs5.readFile(path5.join(packageDir, "package.json"), "utf8"));
    const bin = typeof parsed.bin === "string" ? parsed.bin : parsed.bin?.claude ?? null;
    return { version: parsed.version ?? null, bin };
  } catch {
    return { version: null, bin: null };
  }
}
async function resolveFromPackage(launcherPath, packageDir, platform) {
  const { version, bin } = await readPackage(packageDir);
  const nativeCandidates = platform === "win32" ? [path5.join(packageDir, "bin", "claude.exe")] : [path5.join(packageDir, "bin", "claude")];
  for (const candidate of nativeCandidates) {
    if (await exists(candidate)) {
      return { status: "resolved", source: "npm-shim", launcherPath, packageDir, packageVersion: version, executablePath: candidate, kind: "native", runWith: null };
    }
  }
  const script = path5.join(packageDir, bin ?? "cli.js");
  if (await exists(script)) {
    return { status: "resolved", source: "npm-shim", launcherPath, packageDir, packageVersion: version, executablePath: script, kind: "script", runWith: "node" };
  }
  return { status: "not_found", launcherPath, code: "CLI_NOT_FOUND", vendorCliUsed: false };
}
async function resolveClaudeExecutable(input) {
  const platform = input.platform ?? process.platform;
  const launcherPath = input.launcherPath;
  if (!await exists(launcherPath)) return { status: "not_found", launcherPath, code: "CLI_NOT_FOUND", vendorCliUsed: false };
  const lower = launcherPath.toLowerCase();
  if (lower.endsWith(".exe")) {
    return { status: "resolved", source: "direct", launcherPath, packageDir: null, packageVersion: null, executablePath: launcherPath, kind: "native", runWith: null };
  }
  if (/\.(c?js|mjs)$/.test(lower)) {
    const packageDir = path5.dirname(launcherPath);
    const { version } = await readPackage(packageDir);
    return { status: "resolved", source: "direct", launcherPath, packageDir, packageVersion: version, executablePath: launcherPath, kind: "script", runWith: "node" };
  }
  const base = path5.basename(lower);
  if (base === "claude" || base === "claude.cmd" || base === "claude.ps1") {
    const content = await fs5.readFile(launcherPath, "utf8").catch(() => "");
    const match = /node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]/.exec(content);
    const shimDir = path5.dirname(launcherPath);
    const packageDir = path5.join(shimDir, "node_modules", "@anthropic-ai", "claude-code");
    if (match || await exists(packageDir)) return resolveFromPackage(launcherPath, packageDir, platform);
    if (platform !== "win32" && !content.startsWith("#!")) {
      return { status: "resolved", source: "direct", launcherPath, packageDir: null, packageVersion: null, executablePath: launcherPath, kind: "native", runWith: null };
    }
  }
  return { status: "not_found", launcherPath, code: "CLI_NOT_FOUND", vendorCliUsed: false };
}
function diagnoseCliCompatibility(input) {
  const notes = [];
  let modelSupport = "unknown";
  if (input.supportedModels) {
    const matches = input.supportedModels.some((model) => model.value === input.requestedModel || model.resolvedModel === input.requestedModel);
    modelSupport = matches ? "confirmed" : "unconfirmed";
    if (!matches) notes.push(`O cat\xE1logo consultado n\xE3o lista ${input.requestedModel} nem um alias que resolva para ele; a evid\xEAncia final \xE9 o modelo observado no init da sess\xE3o.`);
  } else {
    notes.push("O cat\xE1logo de modelos do CLI n\xE3o foi consultado nesta etapa; o modelo observado no init \xE9 a evid\xEAncia.");
  }
  if (input.advertisedFlags === null) {
    return { status: "unknown", code: "CAPABILITIES_UNKNOWN", action: "report_to_coordinator", vendorCliUsed: false, missingCapabilities: [], modelSupport, notes, message: "N\xE3o foi poss\xEDvel confirmar as capacidades do CLI instalado; a execu\xE7\xE3o n\xE3o inicia sem essa evid\xEAncia." };
  }
  const missing = REQUIRED_CLI_FLAGS.filter((flag) => !input.advertisedFlags.includes(flag));
  if (missing.length) {
    return { status: "incompatible", code: "CLI_MISSING_CAPABILITY", action: "report_to_coordinator", vendorCliUsed: false, missingCapabilities: [...missing], modelSupport, notes, message: `O Claude Code instalado (${input.cliVersion ?? "vers\xE3o desconhecida"}) n\xE3o anuncia ${missing.join(", ")}, exigidos por este runtime. Nenhum CLI alternativo \xE9 usado.` };
  }
  return { status: "compatible", code: null, action: "proceed", vendorCliUsed: false, missingCapabilities: [], modelSupport, notes, message: `O Claude Code instalado (${input.cliVersion ?? "vers\xE3o desconhecida"}) anuncia as capacidades exigidas pelo runtime ${input.runtimeVersion}; modelo ${input.requestedModel} ${modelSupport === "confirmed" ? "confirmado no cat\xE1logo" : modelSupport === "unconfirmed" ? "n\xE3o confirmado no cat\xE1logo (verificar no init)" : "sem cat\xE1logo consultado"}.` };
}
function assessAuthPath(input) {
  const evidence = [];
  for (const name of CREDENTIAL_ENV_VARS) if (input.env[name]) evidence.push(`${name} presente no ambiente`);
  for (const name of PROVIDER_ENV_VARS) if (input.env[name]) evidence.push(`${name} presente no ambiente`);
  const status = input.authStatus;
  if (status) {
    if (status.apiProvider && status.apiProvider !== "firstParty") evidence.push(`apiProvider=${status.apiProvider}`);
    if (status.authMethod && /api|key|console/i.test(status.authMethod)) evidence.push(`authMethod=${status.authMethod}`);
  }
  if (evidence.length && !input.allowApiBilling) {
    return { ok: false, code: "AUTH_API_BILLING_NOT_AUTHORIZED", evidence, message: "Credenciais de API ou provedor de nuvem detectadas; este caminho pode gerar cobran\xE7a por API e exige autoriza\xE7\xE3o separada (auth.allowApiBilling) no job." };
  }
  if (evidence.length) {
    return { ok: true, code: "AUTH_API_BILLING_AUTHORIZED", evidence, message: "Caminho de API autorizado explicitamente pelo job (auth.allowApiBilling)." };
  }
  if (status?.loggedIn === false) return { ok: false, code: "AUTH_NOT_LOGGED_IN", evidence, message: "O Claude Code instalado n\xE3o est\xE1 autenticado; fa\xE7a login pelo fluxo normal do CLI antes de iniciar." };
  const confirmed = status !== null && status.loggedIn === true && status.apiProvider === "firstParty" && typeof status.authMethod === "string" && status.authMethod.length > 0;
  if (!confirmed) {
    return { ok: false, code: "AUTH_STATUS_UNKNOWN", evidence, message: "Estado de autentica\xE7\xE3o n\xE3o confirmado pela sondagem; a execu\xE7\xE3o n\xE3o inicia sem assinatura verificada ou auth.allowApiBilling expl\xEDcito no job." };
  }
  return { ok: true, code: "AUTH_SUBSCRIPTION", evidence, message: "Autentica\xE7\xE3o por assinatura confirmada pelo CLI instalado (sem detalhes de conta retidos)." };
}
function summarize(error) {
  const code = error?.code;
  if (code) return `c\xF3digo ${code}`;
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0].slice(0, 80);
}
async function resolvePreflight(input) {
  const executable = await resolveClaudeExecutable({ launcherPath: input.launcherPath, ...input.platform ? { platform: input.platform } : {} });
  if (executable.status !== "resolved") {
    return { status: "failed", failureStage: "cli-resolution", code: "CLI_NOT_FOUND", message: `Execut\xE1vel do Claude Code n\xE3o encontrado a partir de ${input.launcherPath}; inspecione a instala\xE7\xE3o. Nenhum CLI de terceiros \xE9 usado como substituto.`, launch: null, vendorCliUsed: false };
  }
  let probe;
  try {
    probe = await input.probe(executable);
  } catch (error) {
    return { status: "failed", failureStage: "cli-probe", code: "CLI_PROBE_FAILED", message: `A sondagem do Claude Code instalado falhou (${summarize(error)}); detalhes brutos suprimidos.`, launch: null, vendorCliUsed: false };
  }
  const diagnosis = diagnoseCliCompatibility({
    cliVersion: probe.cliVersion,
    runtimeVersion: input.runtimeVersion,
    advertisedFlags: probe.advertisedFlags,
    supportedModels: probe.supportedModels ?? null,
    requestedModel: input.requestedModel
  });
  if (diagnosis.action !== "proceed") {
    return { status: "failed", failureStage: "cli-compatibility", code: diagnosis.code ?? "CLI_INCOMPATIBLE", message: diagnosis.message, launch: null, vendorCliUsed: false, diagnosis };
  }
  const auth = assessAuthPath({ env: input.env ?? process.env, authStatus: probe.authStatus, allowApiBilling: input.allowApiBilling ?? false });
  if (!auth.ok) {
    return { status: "failed", failureStage: "auth-path", code: auth.code, message: `${auth.message}${auth.evidence.length ? ` Evid\xEAncia: ${auth.evidence.join("; ")}.` : ""}`, launch: null, vendorCliUsed: false, diagnosis };
  }
  return {
    status: "ready",
    executable,
    launch: { executablePath: executable.executablePath, runWith: executable.runWith, model: input.requestedModel, effort: "xhigh", fallbackModel: null },
    observed: { cliVersion: probe.cliVersion, advertisedFlags: probe.advertisedFlags, authStatus: probe.authStatus },
    diagnosis,
    auth,
    vendorCliUsed: false
  };
}
var CREDENTIAL_ENV_VARS, PROVIDER_ENV_VARS;
var init_cli_resolver = __esm({
  "src/preflight/cli-resolver.ts"() {
    "use strict";
    init_protocol();
    CREDENTIAL_ENV_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN", "ANTHROPIC_AWS_API_KEY"];
    PROVIDER_ENV_VARS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_MANTLE", "ANTHROPIC_BASE_URL"];
  }
});

// src/cli/main.ts
import { promises as fs18 } from "node:fs";
import path18 from "node:path";
import { pathToFileURL } from "node:url";

// src/broker/broker.ts
import http from "node:http";
import { promises as fs16 } from "node:fs";
import path16 from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";

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
var RESPONSIBILITY_KEYS = ["planning", "inspection", "implementation", "testing", "review", "commit", "push", "deploy"];

// src/state/atomic-file.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
var StateFileError = class extends Error {
  code;
  path;
  attempts;
  innerCode;
  constructor(code, filePath, attempts, inner) {
    const innerCode = inner && typeof inner === "object" && "code" in inner ? String(inner.code) : null;
    super(`${code}: ${path.basename(filePath)} (${attempts} tentativas${innerCode ? `, erro interno ${innerCode}` : ""})`);
    this.name = "StateFileError";
    this.code = code;
    this.path = filePath;
    this.attempts = attempts;
    this.innerCode = innerCode;
  }
};
var TRANSIENT_CODES = /* @__PURE__ */ new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY", "EEXIST", "ETXTBSY"]);
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function writeFileAtomic(filePath, content, options = {}) {
  const maxWaitMs = options.maxWaitMs ?? 3e3;
  const retryDelayMs = options.retryDelayMs ?? 25;
  if (options.createDirectory !== false) await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temp, content, typeof content === "string" ? { encoding: "utf8" } : void 0);
  const started = Date.now();
  let attempts = 0;
  let lastError;
  for (; ; ) {
    attempts += 1;
    try {
      await fs.rename(temp, filePath);
      return { attempts, waitedMs: Date.now() - started };
    } catch (error) {
      lastError = error;
      const code2 = error.code ?? "";
      const elapsed = Date.now() - started;
      if (!TRANSIENT_CODES.has(code2) || elapsed >= maxWaitMs) break;
      await sleep(Math.min(retryDelayMs, Math.max(1, maxWaitMs - elapsed)));
    }
  }
  await fs.rm(temp, { force: true }).catch(() => void 0);
  const code = lastError.code ?? "";
  throw new StateFileError(TRANSIENT_CODES.has(code) ? "STATE_FILE_BUSY" : "STATE_FILE_WRITE_FAILED", filePath, attempts, lastError);
}
async function readJsonShared(filePath, options = {}) {
  const retryMs = options.retryMs ?? 250;
  const started = Date.now();
  for (; ; ) {
    try {
      const text = await fs.readFile(filePath, "utf8");
      try {
        return { status: "ok", value: JSON.parse(text.charCodeAt(0) === 65279 ? text.slice(1) : text) };
      } catch (error) {
        if (Date.now() - started < retryMs) {
          await sleep(10);
          continue;
        }
        return { status: "invalid", error: error.message };
      }
    } catch (error) {
      const code = error.code ?? "";
      if (code === "ENOENT") {
        if (Date.now() - started < 50) {
          await sleep(5);
          continue;
        }
        return { status: "missing" };
      }
      if (TRANSIENT_CODES.has(code) && Date.now() - started < retryMs) {
        await sleep(10);
        continue;
      }
      return { status: "invalid", error: code || error.message };
    }
  }
}
async function appendTextSafe(filePath, text, options = {}) {
  const maxWaitMs = options.maxWaitMs ?? 2e3;
  const started = Date.now();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  for (; ; ) {
    try {
      await fs.appendFile(filePath, text, "utf8");
      return;
    } catch (error) {
      const code = error.code ?? "";
      if (!TRANSIENT_CODES.has(code) || Date.now() - started >= maxWaitMs) throw new StateFileError("STATE_FILE_BUSY", filePath, 1, error);
      await sleep(20);
    }
  }
}
var StateWriter = class {
  directory;
  failures = [];
  telemetryMaxWaitMs;
  finalMaxWaitMs;
  fallbackFileName;
  createDirectory;
  onTelemetryFailure;
  constructor(options) {
    this.directory = options.directory;
    this.telemetryMaxWaitMs = options.telemetryMaxWaitMs ?? 1500;
    this.finalMaxWaitMs = options.finalMaxWaitMs ?? 15e3;
    this.fallbackFileName = options.fallbackFileName ?? "resultado.fallback.json";
    this.createDirectory = options.createDirectory !== false;
    this.onTelemetryFailure = options.onTelemetryFailure;
  }
  async writeTelemetry(fileName, record2) {
    const target = path.join(this.directory, fileName);
    try {
      await writeFileAtomic(target, JSON.stringify(record2, null, 2), { maxWaitMs: this.telemetryMaxWaitMs, createDirectory: this.createDirectory });
      return { ok: true, file: fileName };
    } catch (error) {
      const code = error instanceof StateFileError ? error.code : "STATE_FILE_WRITE_FAILED";
      const failure = { file: fileName, code, innerCode: error instanceof StateFileError ? error.innerCode : null, at: (/* @__PURE__ */ new Date()).toISOString() };
      this.failures.push(failure);
      this.onTelemetryFailure?.(failure);
      return { ok: false, file: fileName, code };
    }
  }
  writeStatus(record2) {
    return this.writeTelemetry("status.json", record2);
  }
  async writeFinalResult(record2, fileName = "resultado.json") {
    const primary = path.join(this.directory, fileName);
    try {
      const outcome = await writeFileAtomic(primary, JSON.stringify(record2, null, 2), { maxWaitMs: this.finalMaxWaitMs, createDirectory: this.createDirectory });
      return { ok: true, path: primary, fallback: false, attempts: outcome.attempts };
    } catch (primaryError) {
      const primaryCode = primaryError instanceof StateFileError ? primaryError.code : "STATE_FILE_WRITE_FAILED";
      const fallbackPath = path.join(this.directory, this.fallbackFileName);
      const fallbackRecord = {
        ...record2,
        persistence: {
          primaryFile: fileName,
          code: primaryCode,
          innerCode: primaryError instanceof StateFileError ? primaryError.innerCode : null,
          fallbackWrittenAt: (/* @__PURE__ */ new Date()).toISOString(),
          note: "O arquivo prim\xE1rio permaneceu ocupado por outro processo; este fallback \xE9 o resultado final dur\xE1vel."
        }
      };
      try {
        const outcome = await writeFileAtomic(fallbackPath, JSON.stringify(fallbackRecord, null, 2), { maxWaitMs: this.finalMaxWaitMs, createDirectory: this.createDirectory });
        return { ok: true, path: fallbackPath, fallback: true, attempts: outcome.attempts };
      } catch (fallbackError) {
        const error = new StateFileError("FINAL_RESULT_NOT_PERSISTED", primary, primaryError instanceof StateFileError ? primaryError.attempts : 1, fallbackError);
        error.message = `FINAL_RESULT_NOT_PERSISTED: nem ${fileName} nem ${this.fallbackFileName} puderam ser gravados (${primaryCode}; fallback ${fallbackError.code ?? "desconhecido"}).`;
        throw error;
      }
    }
  }
};

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

// src/broker/identity.ts
import { createHash, randomBytes as randomBytes2, timingSafeEqual } from "node:crypto";
import { promises as fs2 } from "node:fs";
import path2 from "node:path";
var BOOTSTRAP_TOKEN_TTL_MS = 10 * 6e4;
function randomToken(bytes = 32) {
  return randomBytes2(bytes).toString("base64url");
}
function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}
function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
var IdentityRegistry = class {
  secret = "";
  secretFile;
  bootstrapTokens = /* @__PURE__ */ new Map();
  sessions = /* @__PURE__ */ new Map();
  constructor(brokerDir) {
    this.secretFile = path2.join(brokerDir, "secret");
  }
  get secretPath() {
    return this.secretFile;
  }
  async load() {
    await fs2.mkdir(path2.dirname(this.secretFile), { recursive: true });
    try {
      const existing = (await fs2.readFile(this.secretFile, "utf8")).trim();
      if (/^[A-Za-z0-9_-]{43,}$/.test(existing)) {
        this.secret = existing;
        return;
      }
    } catch {
    }
    this.secret = randomToken(32);
    await fs2.writeFile(this.secretFile, `${this.secret}
`, { encoding: "utf8", mode: 384 });
  }
  verifySecret(candidate) {
    return this.secret.length > 0 && safeEqual(candidate, this.secret);
  }
  /** Drops expired tokens. `keep` is evaluated by the caller, so its own expiry stays reportable. */
  pruneBootstrapTokens(now = Date.now(), keep) {
    for (const [key, value] of this.bootstrapTokens) {
      if (key !== keep && now - value.createdAt > BOOTSTRAP_TOKEN_TTL_MS) this.bootstrapTokens.delete(key);
    }
  }
  mintBootstrapToken(taskScope) {
    const token2 = randomToken(32);
    this.pruneBootstrapTokens();
    this.bootstrapTokens.set(token2, { taskScope, createdAt: Date.now(), used: false });
    return token2;
  }
  /** Single use AND time limited: an old unused link stops working on its own. */
  redeemBootstrapToken(token2, now = Date.now()) {
    this.pruneBootstrapTokens(now, token2);
    const entry = this.bootstrapTokens.get(token2);
    if (!entry) return { ok: false, code: "BOOTSTRAP_TOKEN_INVALID" };
    if (entry.used) return { ok: false, code: "BOOTSTRAP_TOKEN_USED" };
    if (now - entry.createdAt > BOOTSTRAP_TOKEN_TTL_MS) {
      this.bootstrapTokens.delete(token2);
      return { ok: false, code: "BOOTSTRAP_TOKEN_EXPIRED" };
    }
    entry.used = true;
    const session = { sessionId: `sess-${randomToken(8)}`, cookie: randomToken(32), taskScope: entry.taskScope, createdAt: (/* @__PURE__ */ new Date()).toISOString() };
    this.sessions.set(session.cookie, session);
    return { ok: true, session };
  }
  sessionForCookie(cookie) {
    return this.sessions.get(cookie) ?? null;
  }
};
function mintTaskHandle() {
  const handle = randomToken(32);
  return { handle, hash: sha256(handle) };
}
function verifyTaskHandle(handle, hash) {
  if (!hash || typeof handle !== "string" || !/^[A-Za-z0-9_-]{43,}$/.test(handle)) return false;
  return safeEqual(sha256(handle), hash);
}
var THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
function taskIdForThread(threadId) {
  return `task-${sha256(threadId.toLowerCase()).slice(0, 16)}`;
}

// src/broker/http.ts
import { promises as fs3 } from "node:fs";
import path3 from "node:path";
var CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
var SESSION_COOKIE = "codeorquestra_session";
var CSRF_HEADER = "x-requested-with";
var CSRF_VALUE = "codeorquestra";
var CLIENT_HEADER = "x-codeorquestra-client";
var HttpError = class extends Error {
  status;
  code;
  extra;
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
};
function applySecurityHeaders(res) {
  res.setHeader("content-security-policy", CSP);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("cache-control", "no-store");
}
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(text));
  res.end(text);
}
function sendError(res, error) {
  sendJson(res, error.status, { error: error.code, ...error.extra });
}
function assertHost(req, port) {
  const host = (req.headers.host ?? "").trim().toLowerCase();
  if (host !== `127.0.0.1:${port}`) throw new HttpError(403, "HOST_NOT_ALLOWED");
}
function parseCookies(header) {
  const output = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    output[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return output;
}
function resolveIdentity(req, registry) {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    const token2 = authorization.slice("Bearer ".length).trim();
    if (registry.verifySecret(token2)) {
      const client = String(req.headers[CLIENT_HEADER] ?? "").toLowerCase();
      return { source: client === "mcp" ? "mcp" : "local-secret", taskScope: null, sessionId: null };
    }
    return null;
  }
  const cookies = parseCookies(req.headers.cookie);
  const cookie = cookies[SESSION_COOKIE];
  if (cookie) {
    const session = registry.sessionForCookie(cookie);
    if (session) return { source: "browser", taskScope: session.taskScope, sessionId: session.sessionId };
  }
  return null;
}
function assertActionAllowed(req, identity, baseUrl) {
  if (identity.source !== "browser") return;
  const header = String(req.headers[CSRF_HEADER] ?? "");
  if (header !== CSRF_VALUE) throw new HttpError(403, "CSRF_HEADER_REQUIRED");
  const origin = String(req.headers.origin ?? "");
  if (origin !== baseUrl) throw new HttpError(403, "ORIGIN_NOT_ALLOWED");
}
async function readJsonBody(req, limit = 1e6) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk;
    size += buffer.length;
    if (size > limit) throw new HttpError(413, "BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "BODY_INVALID");
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "BODY_INVALID");
  }
}
var CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8"
};
var StaticAssets = class {
  files = /* @__PURE__ */ new Map();
  dir;
  constructor(dir) {
    this.dir = dir;
  }
  async load() {
    if (!this.dir) return;
    const walk = async (current, prefix) => {
      const entries = await fs3.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path3.join(current, entry.name);
        const url = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) await walk(full, url);
        else if (entry.isFile()) this.files.set(url, full);
      }
    };
    await walk(this.dir, "");
  }
  resolve(urlPath) {
    const key = urlPath === "/" ? "/index.html" : urlPath;
    if (!/^\/[A-Za-z0-9._\-/]+$/.test(key) || key.includes("..") || key.includes("//")) return null;
    return this.files.get(key) ?? null;
  }
  async serve(urlPath, res) {
    const file = this.resolve(urlPath);
    if (!file) return false;
    const content = await fs3.readFile(file);
    res.statusCode = 200;
    res.setHeader("content-type", CONTENT_TYPES[path3.extname(file).toLowerCase()] ?? "application/octet-stream");
    res.setHeader("content-length", content.length);
    res.end(content);
    return true;
  }
};

// src/broker/sse-hub.ts
var MAX_BUFFERED_BYTES = 1024 * 1024;
var MAX_REPLAY_BUFFER_EVENTS = 2e3;
var MAX_REPLAY_BUFFER_BYTES = 4 * 1024 * 1024;
var SseHub = class {
  clients = /* @__PURE__ */ new Set();
  get size() {
    return this.clients.size;
  }
  async attach(res, options) {
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders();
    const client = {
      res,
      taskId: options.taskId,
      taskScope: options.taskScope,
      lastGseq: options.cursor,
      buffered: [],
      bufferedBytes: 0,
      overflowed: false,
      replaying: true,
      heartbeat: setInterval(() => {
        if (!res.writableEnded) res.write(": keep-alive\n\n");
      }, 15e3)
    };
    client.heartbeat.unref();
    this.clients.add(client);
    res.on("close", () => this.detach(client));
    this.write(client, `event: ready
data: ${JSON.stringify({ cursor: options.cursor, epoch: options.epoch })}

`);
    for (const view of options.snapshots()) if (this.visible(client, view.taskId)) this.write(client, `event: task
data: ${JSON.stringify(view)}

`);
    const history = await options.replay(options.cursor, options.taskId, options.taskScope);
    if (history.gapped) {
      this.write(client, `event: reset
data: ${JSON.stringify({ reason: "HISTORY_GAP", from: history.events[0]?.gseq ?? null, epoch: options.epoch })}

`);
      client.lastGseq = Math.max(0, (history.events[0]?.gseq ?? 1) - 1);
    }
    for (const event of history.events) this.deliver(client, event);
    client.replaying = false;
    if (client.overflowed) {
      this.write(client, `event: reset
data: ${JSON.stringify({ reason: "REPLAY_BUFFER_OVERFLOW", from: null, epoch: options.epoch })}

`);
      client.buffered.length = 0;
      client.bufferedBytes = 0;
      res.end();
      this.detach(client);
      return client;
    }
    for (const event of client.buffered.splice(0)) this.deliver(client, event);
    client.bufferedBytes = 0;
    return client;
  }
  /**
   * How many live subscribers would receive this task's events.
   *
   * Attachment is not attention: a background tab, a reconnect still pending, a
   * curl that never closed its connection all count. This proves a channel
   * exists and nothing more, which is the most any broker can actually verify —
   * so the text built on it must say "um canal está anexado", never "alguém
   * está olhando".
   */
  observerCount(taskId) {
    let total = 0;
    for (const client of this.clients) if (this.visible(client, taskId)) total += 1;
    return total;
  }
  visible(client, taskId) {
    if (client.taskScope && client.taskScope !== taskId) return false;
    if (client.taskId && client.taskId !== taskId) return false;
    return true;
  }
  deliver(client, event) {
    const gseq = event.gseq ?? 0;
    if (gseq <= client.lastGseq) return;
    client.lastGseq = gseq;
    this.write(client, `id: ${gseq}
event: event
data: ${JSON.stringify(event)}

`);
  }
  write(client, chunk) {
    const res = client.res;
    if (res.writableEnded || res.destroyed) return;
    const ok = res.write(chunk);
    if (!ok && res.writableLength > MAX_BUFFERED_BYTES) {
      res.end();
      this.detach(client);
    }
  }
  detach(client) {
    clearInterval(client.heartbeat);
    this.clients.delete(client);
  }
  broadcastEvent(event) {
    for (const client of this.clients) {
      if (!this.visible(client, event.taskId)) continue;
      if (!client.replaying) {
        this.deliver(client, event);
        continue;
      }
      if (client.overflowed) continue;
      client.buffered.push(event);
      client.bufferedBytes += Buffer.byteLength(JSON.stringify(event), "utf8");
      if (client.buffered.length > MAX_REPLAY_BUFFER_EVENTS || client.bufferedBytes > MAX_REPLAY_BUFFER_BYTES) {
        client.overflowed = true;
        client.buffered.length = 0;
        client.bufferedBytes = 0;
      }
    }
  }
  broadcastTask(view) {
    for (const client of this.clients) if (this.visible(client, view.taskId)) this.write(client, `event: task
data: ${JSON.stringify(view)}

`);
  }
  broadcastTransient(frame) {
    for (const client of this.clients) if (this.visible(client, frame.taskId) && !client.replaying) this.write(client, `event: transient
data: ${JSON.stringify(frame)}

`);
  }
  closeAll() {
    for (const client of this.clients) {
      clearInterval(client.heartbeat);
      try {
        client.res.end();
      } catch {
      }
    }
    this.clients.clear();
  }
};

// src/broker/task-manager.ts
import { spawn as spawn7 } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs15, realpathSync as realpathSync3 } from "node:fs";
import path14 from "node:path";

// src/contract/job-contract.ts
var CONTRACT_VERSION = 2;
var AUTHORIZED_MODELS = ["claude-fable-5-1", "claude-opus-5"];
var EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
var LEGACY_MODEL_ALIASES = /* @__PURE__ */ new Map([
  ["fable", "claude-fable-5-1"],
  ["opus", "claude-opus-5"],
  ["claude-fable-5-1", "claude-fable-5-1"],
  ["claude-opus-5", "claude-opus-5"]
]);
var OWNERS = ["codex", "claude", "user", "not_applicable"];
var RESERVED_RESPONSIBILITIES = ["commit", "push", "deploy"];
var THREAD_ID_PATTERN2 = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
var LEGACY_RULE_PATTERN = /^Bash\([^*\r\n]+\)$/;
var LEGACY_CRITICAL_PATTERN = /(\bgit\b[^)\r\n]*\b(commit|push)\b|\bgh\s+pr\s+(create|merge)\b|\b(deploy|publish)\b)/i;
var ContractError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "ContractError";
    this.code = code;
  }
};
function isDict(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : void 0;
}
function stringField(value) {
  return typeof value === "string" ? value : null;
}
function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
function resolveCoordination(value) {
  if (!isDict(value)) throw new ContractError("COORDINATION_REQUIRED", "coordination \xE9 obrigat\xF3rio em todo job.");
  const phase = stringField(own(value, "phase"));
  if (phase !== "planning" && phase !== "execution") throw new ContractError("PHASE_INVALID", "coordination.phase deve ser planning ou execution.");
  const scopeId = stringField(own(value, "scopeId"))?.trim() ?? "";
  if (!scopeId) throw new ContractError("SCOPE_ID_REQUIRED", "coordination.scopeId \xE9 obrigat\xF3rio.");
  const revision = own(value, "approvalRevision");
  if (!isPositiveInteger(revision)) throw new ContractError("APPROVAL_REVISION_INVALID", "coordination.approvalRevision deve ser um inteiro positivo.");
  const approved = own(value, "planApproved");
  if (typeof approved !== "boolean") throw new ContractError("PLAN_APPROVED_INVALID", "coordination.planApproved deve ser booleano.");
  const summaryRaw = own(value, "planSummary");
  if (summaryRaw !== void 0 && typeof summaryRaw !== "string") throw new ContractError("PLAN_SUMMARY_INVALID", "coordination.planSummary deve ser texto.");
  const planSummary = (summaryRaw ?? "").trim();
  const responsibilities = resolveResponsibilities(own(value, "responsibilities"));
  if (phase === "execution") {
    if (!approved) throw new ContractError("PLAN_NOT_APPROVED", "A execu\xE7\xE3o exige plano explicitamente aprovado.");
    if (!planSummary) throw new ContractError("PLAN_SUMMARY_REQUIRED", "coordination.planSummary \xE9 obrigat\xF3rio na execu\xE7\xE3o.");
  }
  return { phase, scopeId, approvalRevision: revision, planSummary, planApproved: approved, responsibilities };
}
function resolveResponsibilities(value) {
  if (!isDict(value)) throw new ContractError("RESPONSIBILITY_MISSING", "coordination.responsibilities \xE9 obrigat\xF3rio com as oito responsabilidades.");
  for (const key of Object.keys(value)) {
    if (!RESPONSIBILITY_KEYS.includes(key)) {
      throw new ContractError("RESPONSIBILITY_UNEXPECTED", `coordination.responsibilities cont\xE9m a etapa inesperada ${key}.`);
    }
  }
  const result = {};
  for (const key of RESPONSIBILITY_KEYS) {
    const raw = own(value, key);
    if (typeof raw !== "string" || !raw.trim()) throw new ContractError("RESPONSIBILITY_MISSING", `coordination.responsibilities.${key} \xE9 obrigat\xF3rio.`);
    const actor = raw.trim().toLowerCase();
    if (!OWNERS.includes(actor)) throw new ContractError("RESPONSIBILITY_ACTOR_INVALID", `coordination.responsibilities.${key} tem um ator inv\xE1lido.`);
    if (RESERVED_RESPONSIBILITIES.includes(key) && actor === "claude") {
      throw new ContractError("RESERVED_RESPONSIBILITY", `O Claude n\xE3o pode ser respons\xE1vel por ${key}.`);
    }
    result[key] = actor;
  }
  return result;
}
function resolveEffortV2(value) {
  if (value === void 0 || value === null) return "xhigh";
  if (value !== "xhigh") throw new ContractError("EFFORT_NOT_XHIGH", "Somente o esfor\xE7o xhigh (Extra) \xE9 autorizado em jobs v2; nenhum downgrade \xE9 permitido.");
  return "xhigh";
}
function resolveEffortLegacy(value) {
  if (value === void 0 || value === null) return "high";
  if (typeof value !== "string" || !EFFORT_LEVELS.includes(value)) throw new ContractError("EFFORT_INVALID", "effort legado deve ser low, medium, high, xhigh ou max.");
  return value;
}
function resolveThreadId(value) {
  if (value === void 0 || value === null) return null;
  if (typeof value !== "string" || !THREAD_ID_PATTERN2.test(value)) throw new ContractError("THREAD_ID_INVALID", "codexThreadId deve conter apenas letras, n\xFAmeros, sublinhado ou h\xEDfen, com at\xE9 128 caracteres.");
  return value;
}
function resolveWorkspace(value) {
  const workspace = stringField(value)?.trim() ?? "";
  if (!workspace) throw new ContractError("WORKSPACE_REQUIRED", "workspace \xE9 obrigat\xF3rio.");
  return workspace;
}
function normalizeScopePath(raw) {
  let text = raw.trim().replace(/\\/g, "/");
  while (text.startsWith("./")) text = text.slice(2);
  text = text.replace(/\/{2,}/g, "/");
  return text;
}
function resolveScope(value, phase) {
  if (value === void 0 || value === null) {
    if (phase === "execution") throw new ContractError("SCOPE_REQUIRED", "scope com summary e paths n\xE3o vazios (ou wholeWorkspace: true) \xE9 obrigat\xF3rio na execu\xE7\xE3o.");
    return { summary: "", paths: [], wholeWorkspace: false };
  }
  if (!isDict(value)) throw new ContractError("SCOPE_INVALID", "scope deve ser um objeto com summary, paths e opcionalmente wholeWorkspace.");
  const summaryRaw = own(value, "summary");
  if (summaryRaw !== void 0 && typeof summaryRaw !== "string") throw new ContractError("SCOPE_INVALID", "scope.summary deve ser texto.");
  const summary = (summaryRaw ?? "").trim();
  const wholeRaw = own(value, "wholeWorkspace");
  if (wholeRaw !== void 0 && typeof wholeRaw !== "boolean") throw new ContractError("SCOPE_INVALID", "scope.wholeWorkspace deve ser booleano.");
  const wholeWorkspace = wholeRaw === true;
  const pathsRaw = own(value, "paths");
  if (pathsRaw !== void 0 && !Array.isArray(pathsRaw)) throw new ContractError("SCOPE_INVALID", "scope.paths deve ser uma lista de caminhos relativos.");
  const paths = [];
  for (const entry of pathsRaw ?? []) {
    if (typeof entry !== "string") throw new ContractError("SCOPE_PATH_INVALID", "scope.paths s\xF3 aceita textos.");
    const normalized = normalizeScopePath(entry);
    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..") || /^[A-Za-z]:/.test(normalized) || normalized.startsWith("/")) {
      throw new ContractError("SCOPE_PATH_INVALID", `scope.paths cont\xE9m um caminho inv\xE1lido (${JSON.stringify(entry)}); use caminhos relativos dentro do workspace ou wholeWorkspace: true.`);
    }
    paths.push(normalized);
  }
  if (phase === "execution" && (!summary || paths.length === 0 && !wholeWorkspace)) {
    throw new ContractError("SCOPE_REQUIRED", "scope.summary e scope.paths n\xE3o podem estar vazios na execu\xE7\xE3o, salvo wholeWorkspace: true expl\xEDcito.");
  }
  return { summary, paths, wholeWorkspace };
}
function resolveModelV2(value) {
  let requested = null;
  let reason = null;
  if (typeof value === "string") {
    requested = value;
  } else if (isDict(value)) {
    requested = stringField(own(value, "requested"));
    reason = stringField(own(value, "reason"));
  }
  if (!requested || !AUTHORIZED_MODELS.includes(requested)) {
    throw new ContractError("MODEL_NOT_AUTHORIZED", `Modelo n\xE3o autorizado: somente ${AUTHORIZED_MODELS.join(" e ")} s\xE3o permitidos, com o identificador exato.`);
  }
  if (!reason || !reason.trim()) throw new ContractError("MODEL_REASON_REQUIRED", "model.reason deve explicar a escolha do modelo.");
  return { requested, resolved: requested, reason: reason.trim() };
}
function resolvePrompt(job) {
  const prompt = stringField(own(job, "prompt"));
  const promptFile = stringField(own(job, "promptFile"));
  if ((prompt === null || !prompt.trim()) && (promptFile === null || !promptFile.trim())) {
    throw new ContractError("PROMPT_REQUIRED", "prompt ou promptFile \xE9 obrigat\xF3rio.");
  }
  return { prompt: prompt && prompt.trim() ? prompt : null, promptFile: promptFile && promptFile.trim() ? promptFile : null };
}
function resolveProfileField(job, fallback) {
  const raw = own(job, "profile");
  if (raw === void 0 || raw === null) return fallback;
  if (typeof raw !== "string") throw new ContractError("PROFILE_INVALID", "profile deve ser texto; campos de autoriza\xE7\xE3o malformados s\xE3o rejeitados.");
  return raw;
}
function resolveAuth(job) {
  const raw = own(job, "auth");
  if (raw === void 0 || raw === null) return { allowApiBilling: false };
  if (!isDict(raw)) throw new ContractError("AUTH_INVALID", "auth deve ser um objeto.");
  const allow = own(raw, "allowApiBilling");
  if (allow !== void 0 && typeof allow !== "boolean") throw new ContractError("AUTH_INVALID", "auth.allowApiBilling deve ser booleano.");
  for (const key of Object.keys(raw)) if (key !== "allowApiBilling") throw new ContractError("AUTH_INVALID", `auth cont\xE9m o campo inesperado ${key}.`);
  return { allowApiBilling: allow === true };
}
var REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;
function resolveRefName(value, field) {
  if (value === void 0 || value === null) return null;
  if (typeof value !== "string") throw new ContractError("EXECUTION_BRANCH_INVALID", `execution.worktree.${field} deve ser texto ou null.`);
  const invalid = (why) => {
    throw new ContractError("EXECUTION_BRANCH_INVALID", `execution.worktree.${field} ${why}`);
  };
  if (!REF_NAME.test(value)) invalid("aceita apenas letras, d\xEDgitos, ponto, h\xEDfen, barra e sublinhado, come\xE7ando por letra ou d\xEDgito, com no m\xE1ximo 101 caracteres.");
  if (value.includes("..")) invalid('n\xE3o pode conter "..".');
  if (value.endsWith("/") || value.endsWith(".")) invalid('n\xE3o pode terminar em "/" nem ".".');
  for (const part of value.split("/")) {
    if (part === "") invalid('n\xE3o pode conter componentes vazios ("//").');
    if (part.startsWith(".")) invalid('n\xE3o pode ter componente come\xE7ando com ".".');
    if (part.endsWith(".lock")) invalid('n\xE3o pode ter componente terminando em ".lock".');
  }
  return value;
}
function resolveExecution(job, coordination, profile) {
  const raw = own(job, "execution");
  if (raw === void 0 || raw === null) return { mode: "checkout", worktree: null };
  if (!isDict(raw)) throw new ContractError("EXECUTION_INVALID", "execution deve ser um objeto.");
  for (const key of Object.keys(raw)) {
    if (key !== "mode" && key !== "worktree") throw new ContractError("EXECUTION_INVALID", `execution cont\xE9m o campo inesperado ${key}.`);
  }
  const mode = own(raw, "mode");
  if (mode !== "checkout" && mode !== "worktree") throw new ContractError("EXECUTION_INVALID", "execution.mode deve ser checkout ou worktree.");
  const worktreeRaw = own(raw, "worktree");
  if (mode === "checkout") {
    if (worktreeRaw !== void 0 && worktreeRaw !== null) throw new ContractError("EXECUTION_INVALID", "execution.worktree s\xF3 \xE9 aceito quando execution.mode \xE9 worktree.");
    return { mode: "checkout", worktree: null };
  }
  if (profile === "read") throw new ContractError("WORKTREE_NOT_APPLICABLE", "O perfil read n\xE3o toma trava de escrita e deve inspecionar a mesma \xE1rvore que o usu\xE1rio v\xEA.");
  if (coordination.phase !== "execution") throw new ContractError("WORKTREE_NOT_APPLICABLE", "Um worktree s\xF3 \xE9 provisionado na fase de execu\xE7\xE3o.");
  if (coordination.responsibilities.implementation !== "claude") throw new ContractError("WORKTREE_NOT_APPLICABLE", "Um worktree s\xF3 \xE9 provisionado quando implementation pertence ao Claude.");
  if (worktreeRaw === void 0 || worktreeRaw === null) return { mode: "worktree", worktree: { branch: null, baseRef: null, onExistingWork: "refuse" } };
  if (!isDict(worktreeRaw)) throw new ContractError("EXECUTION_INVALID", "execution.worktree deve ser um objeto ou null.");
  for (const key of Object.keys(worktreeRaw)) {
    if (key !== "branch" && key !== "baseRef" && key !== "onExistingWork") throw new ContractError("EXECUTION_INVALID", `execution.worktree cont\xE9m o campo inesperado ${key}.`);
  }
  const onExistingWork = own(worktreeRaw, "onExistingWork");
  if (onExistingWork !== void 0 && onExistingWork !== "refuse") throw new ContractError("EXECUTION_INVALID", 'execution.worktree.onExistingWork aceita apenas "refuse".');
  return {
    mode: "worktree",
    worktree: {
      branch: resolveRefName(own(worktreeRaw, "branch"), "branch"),
      baseRef: resolveRefName(own(worktreeRaw, "baseRef"), "baseRef"),
      onExistingWork: "refuse"
    }
  };
}
function resolveV2(job) {
  for (const legacyField of ["mode", "allowedCommands", "modelPolicy", "timeoutPolicy", "timeoutSeconds"]) {
    if (Object.prototype.hasOwnProperty.call(job, legacyField)) throw new ContractError("LEGACY_FIELD_IN_V2", `O campo legado ${legacyField} n\xE3o existe no contrato v2.`);
  }
  const workspace = resolveWorkspace(own(job, "workspace"));
  const { prompt, promptFile } = resolvePrompt(job);
  const profileRaw = resolveProfileField(job, "development");
  if (profileRaw === "diagnostic" || profileRaw === "restricted") throw new ContractError("PROFILE_INVALID", "Perfis diagnostic e restricted pertencem ao contrato legado; use development ou read.");
  if (profileRaw !== "development" && profileRaw !== "read") throw new ContractError("PROFILE_INVALID", "profile deve ser development ou read.");
  const coordination = resolveCoordination(own(job, "coordination"));
  const model = resolveModelV2(own(job, "model"));
  const effort = resolveEffortV2(own(job, "effort"));
  const scope = resolveScope(own(job, "scope"), coordination.phase);
  const execution = resolveExecution(job, coordination, profileRaw);
  const codexThreadId = resolveThreadId(own(job, "codexThreadId"));
  const auth = resolveAuth(job);
  const resumeFrom = stringField(own(job, "resumeFrom"));
  const readOnly = profileRaw === "read" || coordination.phase === "planning";
  const capabilities = readOnly ? { edit: false, test: false, commands: "none" } : {
    edit: coordination.responsibilities.implementation === "claude",
    test: coordination.responsibilities.testing === "claude",
    commands: "classified"
  };
  return {
    version: 2,
    profile: profileRaw,
    workspace,
    prompt,
    promptFile,
    model,
    effort,
    coordination,
    scope,
    execution,
    launch: { permissionMode: "default", safeMode: false, permissionPromptsDisabled: false, restricted: false, strictMcpConfig: true },
    capabilities,
    limits: { maxTurns: null, maxTokens: null, maxRuntimeSeconds: null },
    auth,
    resumeFrom,
    codexThreadId,
    legacy: null
  };
}
function resolveLegacyModelPolicy(value) {
  if (value === void 0 || value === null) return null;
  if (!isDict(value)) throw new ContractError("LEGACY_MODEL_POLICY_INVALID", "modelPolicy deve ser um objeto.");
  for (const field of Object.keys(value)) {
    if (!["mode", "primary", "alternate", "switchAtRemainingPercent"].includes(field)) throw new ContractError("LEGACY_MODEL_POLICY_INVALID", `modelPolicy cont\xE9m o campo inesperado ${field}.`);
  }
  if (own(value, "mode") !== "quota-aware" || own(value, "primary") !== "fable" || own(value, "alternate") !== "opus") {
    throw new ContractError("LEGACY_MODEL_POLICY_INVALID", "modelPolicy.mode deve ser quota-aware com primary fable e alternate opus.");
  }
  const threshold = own(value, "switchAtRemainingPercent") ?? 3;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 20) {
    throw new ContractError("LEGACY_MODEL_POLICY_INVALID", "modelPolicy.switchAtRemainingPercent deve ser um inteiro de 1 a 20.");
  }
  return { mode: "quota-aware", primary: "fable", alternate: "opus", switchAtRemainingPercent: threshold };
}
function positiveLegacyInteger(value, field) {
  if (!isPositiveInteger(value) || value > 2147483647) throw new ContractError("LEGACY_TIMEOUT_INVALID", `${field} deve ser um inteiro positivo.`);
  return value;
}
function resolveLegacyTimeoutPolicy(policy, timeoutSeconds) {
  if (policy !== void 0 && policy !== null && timeoutSeconds !== void 0 && timeoutSeconds !== null) {
    throw new ContractError("LEGACY_TIMEOUT_CONFLICT", "Use timeoutSeconds ou timeoutPolicy, nunca ambos.");
  }
  if (timeoutSeconds !== void 0 && timeoutSeconds !== null) {
    return { mode: "fixed", timeoutSeconds: positiveLegacyInteger(timeoutSeconds, "timeoutSeconds") };
  }
  const value = policy === void 0 || policy === null ? { mode: "adaptive" } : policy;
  if (!isDict(value)) throw new ContractError("LEGACY_TIMEOUT_INVALID", "timeoutPolicy deve ser um objeto.");
  for (const field of Object.keys(value)) {
    if (!["mode", "renewEverySeconds", "idleAfterSeconds", "hardStopAfterSeconds"].includes(field)) throw new ContractError("LEGACY_TIMEOUT_INVALID", `timeoutPolicy cont\xE9m o campo inesperado ${field}.`);
  }
  if (own(value, "mode") !== "adaptive") throw new ContractError("LEGACY_TIMEOUT_INVALID", "timeoutPolicy.mode deve ser adaptive.");
  const renew = positiveLegacyInteger(own(value, "renewEverySeconds") ?? 1800, "timeoutPolicy.renewEverySeconds");
  const idle = positiveLegacyInteger(own(value, "idleAfterSeconds") ?? 1200, "timeoutPolicy.idleAfterSeconds");
  const hard = positiveLegacyInteger(own(value, "hardStopAfterSeconds") ?? 7200, "timeoutPolicy.hardStopAfterSeconds");
  if (renew >= hard) throw new ContractError("LEGACY_TIMEOUT_INVALID", "timeoutPolicy.renewEverySeconds deve ser menor que hardStopAfterSeconds.");
  if (idle >= hard) throw new ContractError("LEGACY_TIMEOUT_INVALID", "timeoutPolicy.idleAfterSeconds deve ser menor que hardStopAfterSeconds.");
  return { mode: "adaptive", renewEverySeconds: renew, idleAfterSeconds: idle, hardStopAfterSeconds: hard };
}
function resolveLegacy(job) {
  if (Object.prototype.hasOwnProperty.call(job, "execution")) {
    throw new ContractError("V2_FIELD_IN_LEGACY", "O campo execution pertence ao contrato v2 (contractVersion: 2); o runner legado executa sempre no checkout declarado.");
  }
  const workspace = resolveWorkspace(own(job, "workspace"));
  const { prompt, promptFile } = resolvePrompt(job);
  const coordination = resolveCoordination(own(job, "coordination"));
  const mode = stringField(own(job, "mode"));
  if (mode !== "chat" && mode !== "read" && mode !== "verify" && mode !== "local") throw new ContractError("MODE_INVALID", "mode deve ser chat, read, verify ou local.");
  if (coordination.phase === "planning" && mode !== "chat" && mode !== "read") throw new ContractError("PLANNING_MODE_INVALID", "Um job de planejamento s\xF3 pode usar chat ou read.");
  if (mode === "local" && coordination.responsibilities.implementation !== "claude") throw new ContractError("LOCAL_REQUIRES_IMPLEMENTATION", "O modo local exige que o Claude seja respons\xE1vel por implementation.");
  const profileRaw = resolveProfileField(job, "diagnostic");
  if (profileRaw === "development" || profileRaw === "read") throw new ContractError("PROFILE_REQUIRES_V2", "O perfil development pertence ao contrato v2 (contractVersion: 2).");
  if (profileRaw !== "diagnostic" && profileRaw !== "restricted") throw new ContractError("PROFILE_INVALID", "profile deve ser diagnostic ou restricted.");
  const modelRaw = own(job, "model");
  const policyRaw = own(job, "modelPolicy");
  if (modelRaw !== void 0 && modelRaw !== null && policyRaw !== void 0 && policyRaw !== null) throw new ContractError("LEGACY_MODEL_CONFLICT", "Use model ou modelPolicy, nunca ambos.");
  if (modelRaw !== void 0 && modelRaw !== null && typeof modelRaw !== "string") throw new ContractError("MODEL_NOT_AUTHORIZED", "model legado deve ser texto.");
  const modelPolicy = resolveLegacyModelPolicy(policyRaw);
  const requested = typeof modelRaw === "string" && modelRaw.trim() ? modelRaw.trim() : modelPolicy ? modelPolicy.primary : "fable";
  const resolved = LEGACY_MODEL_ALIASES.get(requested) ?? null;
  const effort = resolveEffortLegacy(own(job, "effort"));
  const timeoutPolicy = resolveLegacyTimeoutPolicy(own(job, "timeoutPolicy"), own(job, "timeoutSeconds"));
  const codexThreadId = resolveThreadId(own(job, "codexThreadId"));
  const commands = [];
  const rawCommands = own(job, "allowedCommands");
  if (rawCommands !== void 0 && rawCommands !== null && !Array.isArray(rawCommands)) throw new ContractError("LEGACY_RULE_INVALID", "allowedCommands deve ser uma lista.");
  for (const raw of (Array.isArray(rawCommands) ? rawCommands : []).filter((c) => c !== null && c !== void 0)) {
    if (mode !== "verify" && mode !== "local") throw new ContractError("LEGACY_COMMANDS_MODE", "allowedCommands s\xF3 existem nos modos verify ou local.");
    if (!isDict(raw)) throw new ContractError("LEGACY_RULE_INVALID", "Cada comando permitido exige rule e responsibility.");
    const rule = stringField(own(raw, "rule")) ?? "";
    const responsibility = (stringField(own(raw, "responsibility")) ?? "").toLowerCase();
    if (!rule.trim() || !responsibility.trim()) throw new ContractError("LEGACY_RULE_INVALID", "Cada comando permitido exige rule e responsibility.");
    if (!LEGACY_RULE_PATTERN.test(rule) || /[:*]/.test(rule)) throw new ContractError("LEGACY_RULE_INVALID", "Somente regras Bash expl\xEDcitas sem curingas s\xE3o permitidas.");
    if (LEGACY_CRITICAL_PATTERN.test(rule)) throw new ContractError("LEGACY_RULE_CRITICAL", "Um comando externo cr\xEDtico n\xE3o pode ser delegado ao Claude.");
    const allowedStages = mode === "verify" ? ["inspection", "testing"] : ["inspection", "implementation", "testing"];
    if (!allowedStages.includes(responsibility)) throw new ContractError("LEGACY_RULE_STAGE", `A responsabilidade ${responsibility} n\xE3o autoriza comandos no modo ${mode}.`);
    if (coordination.responsibilities[responsibility] !== "claude") throw new ContractError("LEGACY_RULE_OWNER", `O Claude precisa ser respons\xE1vel por ${responsibility} para esse comando.`);
    commands.push({ rule, responsibility });
  }
  const capabilities = {
    edit: mode === "local",
    test: (mode === "verify" || mode === "local") && coordination.responsibilities.testing === "claude",
    commands: mode === "verify" || mode === "local" ? "exact-list" : "none"
  };
  return {
    version: 1,
    profile: profileRaw,
    workspace,
    prompt,
    promptFile,
    model: { requested, resolved, reason: "Job legado (contrato v1): configura\xE7\xE3o original preservada para consulta; execu\xE7\xE3o somente pelo runner legado." },
    effort,
    coordination,
    scope: { summary: coordination.planSummary, paths: [], wholeWorkspace: false },
    // The legacy runner has no worktree provisioning; a v1 job always runs in
    // the declared checkout. An `execution` field here is refused above rather
    // than ignored, so it can never look accepted.
    execution: { mode: "checkout", worktree: null },
    launch: { permissionMode: "dontAsk", safeMode: true, permissionPromptsDisabled: true, restricted: profileRaw === "restricted", strictMcpConfig: true },
    capabilities,
    limits: { maxTurns: null, maxTokens: null, maxRuntimeSeconds: null },
    auth: { allowApiBilling: false },
    resumeFrom: stringField(own(job, "resumeFrom")),
    codexThreadId,
    legacy: { mode, allowedCommands: commands, modelPolicy, timeoutPolicy, executor: "legacy-runner" }
  };
}
function resolveJobContract(job) {
  if (!isDict(job)) throw new ContractError("JOB_INVALID", "O job deve ser um objeto JSON.");
  const version = own(job, "contractVersion");
  if (version === void 0 || version === null) return resolveLegacy(job);
  if (version !== CONTRACT_VERSION) throw new ContractError("CONTRACT_VERSION_UNSUPPORTED", `contractVersion ${String(version)} n\xE3o \xE9 suportado; use ${CONTRACT_VERSION}.`);
  return resolveV2(job);
}

// src/events/derive.ts
var SUPERVISED_TIMEOUT_POLICY = { mode: "supervised", inactivityAlertSeconds: 1200, elapsedAlertSeconds: 7200, killTimers: false };
function seconds(from, to) {
  if (!from || !to) return 0;
  const delta = (Date.parse(to) - Date.parse(from)) / 1e3;
  return Number.isFinite(delta) && delta > 0 ? Math.round(delta * 10) / 10 : 0;
}
function deriveCompatibilityFiles(events, options = {}) {
  const now = options.now ?? (/* @__PURE__ */ new Date()).toISOString();
  const status = {
    status: "STARTING",
    codexThreadId: null,
    startedAt: null,
    sessionId: null,
    result: null,
    exitCode: null,
    elapsedSeconds: 0,
    toolCalls: [],
    workspace: null,
    requestedModel: null,
    selectedModel: null,
    model: null,
    effort: null,
    effortConfirmed: null,
    effortObservedByCli: null,
    mode: null,
    profile: null,
    coordination: null,
    usage: null,
    usageCheckedAt: null,
    toolErrors: 0,
    permissionDenials: 0,
    lastActivityAt: null,
    runtimeSeconds: 0,
    resumeMode: "new",
    allowedCommands: [],
    timeoutPolicy: SUPERVISED_TIMEOUT_POLICY,
    timeoutReason: null,
    failureStage: null,
    failureCode: null,
    contractVersion: null,
    runId: null,
    taskId: null,
    currentTool: null,
    requiresReview: false,
    telemetryFailures: 0,
    turns: 0,
    modelReason: null,
    endedAt: null,
    alerts: []
  };
  const lines = [];
  const openTools = /* @__PURE__ */ new Map();
  let terminal = false;
  let runId = null;
  let sessionStartedAt = null;
  for (const event of events) {
    if (runId && event.runId !== runId && event.type === "run_started") {
      break;
    }
    const data = event.data;
    status.lastActivityAt = event.ts;
    switch (event.type) {
      case "run_started": {
        runId = event.runId;
        status.runId = event.runId;
        status.taskId = event.taskId;
        status.codexThreadId = event.threadId ?? null;
        status.startedAt = data.startedAt ?? event.ts;
        status.requestedModel = data.requestedModel ?? null;
        status.selectedModel = status.requestedModel;
        status.modelReason = data.modelReason ?? null;
        status.effort = data.effort ?? null;
        status.workspace = data.workspace ?? null;
        status.profile = data.profile ?? null;
        status.mode = data.mode ?? null;
        status.coordination = data.coordination ?? null;
        status.contractVersion = data.contractVersion ?? null;
        status.resumeMode = data.resumeMode ?? "new";
        status.allowedCommands = Array.isArray(data.allowedCommands) ? data.allowedCommands : [];
        status.status = "STARTING";
        lines.push("CODEORQUESTRA - ACOMPANHAMENTO AO VIVO");
        lines.push(`Tarefa Codex: ${status.codexThreadId ?? "desconhecida"} | Execu\xE7\xE3o: ${event.runId}`);
        lines.push(`Modelo solicitado: ${status.requestedModel ?? "?"} | Esfor\xE7o configurado: ${status.effort ?? "?"} (confirma\xE7\xE3o de servidor: n\xE3o dispon\xEDvel)`);
        break;
      }
      case "session_init": {
        status.sessionId = data.sessionId ?? status.sessionId;
        status.model = data.observedModel ?? null;
        status.effortObservedByCli = data.effortObservedByCli ?? null;
        status.status = "RUNNING";
        sessionStartedAt = event.ts;
        lines.push(`[Conectado] Modelo observado: ${status.model ?? "?"} | Sess\xE3o: ${status.sessionId ?? "?"}`);
        break;
      }
      case "quota_observed": {
        status.usage = data.snapshot ?? null;
        status.usageCheckedAt = data.attemptedAt ?? event.ts;
        lines.push(`[Uso] Consulta: ${status.usageCheckedAt} | ${data.snapshot ? `recomenda\xE7\xE3o ${String(data.recommendation)}` : "INDISPONIVEL"}`);
        break;
      }
      case "turn_started": {
        status.turns += 1;
        break;
      }
      case "assistant_text": {
        lines.push(String(data.text ?? ""));
        break;
      }
      case "tool_start": {
        const name = String(data.name ?? "?");
        status.toolCalls.push(name);
        status.currentTool = name;
        if (event.toolUseId) openTools.set(event.toolUseId, name);
        lines.push(`[Ferramenta] ${name}`);
        break;
      }
      case "tool_result": {
        if (data.isError) {
          status.toolErrors += 1;
          lines.push("[Ferramenta] Falha reportada; conferir resultado antes de aprovar.");
        }
        if (event.toolUseId) openTools.delete(event.toolUseId);
        status.currentTool = openTools.size ? [...openTools.values()].at(-1) ?? null : null;
        break;
      }
      case "tool_blocked": {
        status.permissionDenials += 1;
        lines.push(`[Bloqueado] ${String(data.tool ?? "?")}: ${String(data.reason ?? "")}`);
        break;
      }
      case "permission_requested": {
        lines.push(`[Permiss\xE3o] ${String(data.tool ?? "?")} aguarda decis\xE3o (${String(data.reason ?? "")}).`);
        break;
      }
      case "permission_resolved": {
        if (data.decision === "deny") status.permissionDenials += 1;
        lines.push(`[Permiss\xE3o] ${String(data.decision ?? "?")} por ${String(data.source ?? "?")}.`);
        break;
      }
      case "question_asked": {
        lines.push(`[Pergunta] ${String(data.summary ?? "")}`);
        break;
      }
      case "question_answered": {
        lines.push(`[Pergunta] respondida por ${String(data.source ?? "?")}.`);
        break;
      }
      case "message_queued": {
        lines.push(`[Fila] Orienta\xE7\xE3o ${String(data.messageId ?? "")} recebida de ${String(data.source ?? "?")}.`);
        break;
      }
      case "message_delivered": {
        lines.push(`[Fila] Orienta\xE7\xE3o ${String(data.messageId ?? "")} entregue ao pr\xF3ximo turno.`);
        break;
      }
      case "turn_completed": {
        status.result = data.resultText ?? status.result;
        status.currentTool = null;
        break;
      }
      case "turn_interrupted": {
        lines.push(`[Interrompido] Turno interrompido por ${String(data.source ?? "?")}.`);
        status.currentTool = null;
        break;
      }
      case "alert": {
        const alert = String(data.alert ?? "");
        if (!status.alerts.includes(alert)) status.alerts.push(alert);
        lines.push(`[Alerta] ${alert}: apenas alerta, sem encerramento autom\xE1tico.`);
        break;
      }
      case "telemetry_write_failed": {
        status.telemetryFailures += 1;
        lines.push(`[Telemetria] Falha ao gravar ${String(data.file ?? "?")} (${String(data.code ?? "?")}); a execu\xE7\xE3o continua.`);
        break;
      }
      case "model_changed": {
        status.requestedModel = data.to ?? status.requestedModel;
        status.selectedModel = status.requestedModel;
        status.modelReason = data.reason ?? status.modelReason;
        lines.push(`[Modelo] ${String(data.from ?? "?")} -> ${String(data.to ?? "?")} (${String(data.reason ?? "")})`);
        break;
      }
      case "preparation_failed": {
        status.status = "FAIL";
        status.failureStage = data.stage ?? null;
        status.failureCode = data.code ?? null;
        status.result = data.message ?? "Falha na prepara\xE7\xE3o.";
        status.endedAt = event.ts;
        terminal = true;
        lines.push(`[FAIL] Etapa: ${status.failureStage ?? "?"} (${status.failureCode ?? "?"}). ${status.result}`);
        break;
      }
      case "worker_disconnected": {
        status.status = "UNCERTAIN";
        status.requiresReview = true;
        lines.push("[Incerto] O worker desapareceu sem resultado; revise antes de retomar.");
        break;
      }
      case "run_ended": {
        status.status = data.status ?? "COMPLETED";
        status.exitCode = data.exitCode ?? null;
        status.endedAt = data.endedAt ?? event.ts;
        status.failureCode = data.code ?? status.failureCode;
        if (typeof data.message === "string" && data.message) status.result = status.result ?? data.message;
        terminal = true;
        lines.push(`[Encerrado] ${status.status}`);
        break;
      }
      default:
        break;
    }
  }
  if (!terminal && status.startedAt) {
    if (options.processAlive === false) {
      status.status = "UNCERTAIN";
      status.requiresReview = true;
    }
  }
  const end = status.endedAt ?? now;
  status.elapsedSeconds = seconds(status.startedAt, end);
  status.runtimeSeconds = seconds(sessionStartedAt, end);
  if (terminal || status.status === "UNCERTAIN") {
    lines.push("COMPLETED confirma o fim da execu\xE7\xE3o; a aprova\xE7\xE3o depende da revis\xE3o independente dos artefatos.");
  }
  const result = { ...status };
  return { status, result, acompanhamento: `${lines.join("\n")}
` };
}

// src/events/event-log.ts
import { promises as fs4, createReadStream } from "node:fs";
import path4 from "node:path";
import readline from "node:readline";
var EventLogError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "EventLogError";
    this.code = code;
  }
};
var FORBIDDEN_KEYS = /* @__PURE__ */ new Set(["thinking", "redacted_thinking", "signature", "api_key", "apikey", "authorization", "cookie", "set-cookie", "password", "secret", "private_key", "privatekey"]);
var HIDDEN_BLOCK_TYPES = /* @__PURE__ */ new Set(["thinking", "redacted_thinking", "thinking_delta", "signature_delta"]);
var MAX_RECORD_BYTES = 1024 * 1024;
var CACHE_MAX_RECORDS = 5e3;
var CACHE_MAX_BYTES = 8 * 1024 * 1024;
var RollingWindow = class {
  records = [];
  sizes = [];
  bytes = 0;
  limit;
  byteBudget;
  dropped = false;
  constructor(limit, byteBudget) {
    this.limit = limit;
    this.byteBudget = byteBudget;
  }
  push(event) {
    const size = Buffer.byteLength(JSON.stringify(event), "utf8");
    this.records.push(event);
    this.sizes.push(size);
    this.bytes += size;
    while (this.records.length > this.limit || this.bytes > this.byteBudget && this.records.length > 1) {
      this.records.shift();
      this.bytes -= this.sizes.shift() ?? 0;
      this.dropped = true;
    }
  }
  get events() {
    return this.records;
  }
};
var REPLAY_MAX_BYTES = 8 * 1024 * 1024;
var READ_CHUNK = 64 * 1024;
function scanForbidden(value, trail = []) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = scanForbidden(value[index], [...trail, String(index)]);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const record2 = value;
    if (typeof record2.type === "string" && HIDDEN_BLOCK_TYPES.has(record2.type)) return [...trail, `type=${record2.type}`].join(".");
    for (const [key, child] of Object.entries(record2)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) return [...trail, key].join(".");
      const hit = scanForbidden(child, [...trail, key]);
      if (hit) return hit;
    }
  }
  return null;
}
var EventLog = class _EventLog {
  file;
  recovery = { recovered: 0, droppedPartialLine: false, corruptLines: 0 };
  nextSeq = 1;
  cache = [];
  cacheBytes = 0;
  cacheStartSeq = 1;
  chain = Promise.resolve();
  listeners = /* @__PURE__ */ new Set();
  closed = false;
  needsSeparator = false;
  constructor(file) {
    this.file = file;
  }
  static async open(file) {
    const log = new _EventLog(file);
    await fs4.mkdir(path4.dirname(file), { recursive: true });
    await log.load();
    return log;
  }
  get lastSeq() {
    return this.nextSeq - 1;
  }
  pushCache(record2, bytes) {
    this.cache.push(record2);
    this.cacheBytes += bytes;
    while (this.cache.length > CACHE_MAX_RECORDS || this.cacheBytes > CACHE_MAX_BYTES && this.cache.length > 1) {
      const dropped = this.cache.shift();
      if (!dropped) break;
      this.cacheBytes -= Buffer.byteLength(JSON.stringify(dropped), "utf8");
      this.cacheStartSeq = this.cache[0]?.seq ?? this.nextSeq;
    }
    if (this.cache.length === 1) this.cacheStartSeq = record2.seq;
  }
  async load() {
    let handle;
    try {
      handle = await fs4.open(this.file, "r");
    } catch (error) {
      if (error.code === "ENOENT") {
        await fs4.writeFile(this.file, "", "utf8");
        return;
      }
      throw error;
    }
    let recovered = 0;
    let corrupt = 0;
    let last = null;
    const recent = [];
    let recentBytes = 0;
    let truncateAt = null;
    let needsSeparator = false;
    try {
      const size = (await handle.stat()).size;
      const chunk = Buffer.alloc(READ_CHUNK);
      let position = 0;
      let pending = [];
      let pendingBytes = 0;
      let pendingTooLong = false;
      let lineStart = 0;
      const consume = (bytes) => {
        if (bytes.length === 0) return;
        try {
          const parsed = JSON.parse(bytes.toString("utf8"));
          if (typeof parsed.seq !== "number" || typeof parsed.type !== "string") throw new Error("registro sem seq/type");
          recovered += 1;
          last = parsed;
          recent.push({ record: parsed, bytes: bytes.length });
          recentBytes += bytes.length;
          while (recent.length > CACHE_MAX_RECORDS || recentBytes > CACHE_MAX_BYTES && recent.length > 1) {
            const dropped = recent.shift();
            if (!dropped) break;
            recentBytes -= dropped.bytes;
          }
        } catch {
          corrupt += 1;
        }
      };
      while (position < size) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        const base = position;
        position += bytesRead;
        let start = 0;
        for (let index = 0; index < bytesRead; index += 1) {
          if (chunk[index] !== 10) continue;
          if (pendingTooLong) {
            corrupt += 1;
          } else {
            pending.push(Buffer.from(chunk.subarray(start, index)));
            consume(Buffer.concat(pending));
          }
          pending = [];
          pendingBytes = 0;
          pendingTooLong = false;
          lineStart = base + index + 1;
          start = index + 1;
        }
        if (start < bytesRead) {
          const remainder = bytesRead - start;
          if (pendingTooLong || pendingBytes + remainder > MAX_RECORD_BYTES) {
            pendingTooLong = true;
            pending = [];
            pendingBytes = 0;
          } else {
            pending.push(Buffer.from(chunk.subarray(start, bytesRead)));
            pendingBytes += remainder;
          }
        }
      }
      if (pendingTooLong) {
        truncateAt = lineStart;
      } else if (pendingBytes > 0) {
        const tail = Buffer.concat(pending);
        let valid = false;
        try {
          const parsed = JSON.parse(tail.toString("utf8"));
          if (typeof parsed.seq === "number" && typeof parsed.type === "string") {
            recovered += 1;
            last = parsed;
            recent.push({ record: parsed, bytes: tail.length });
            recentBytes += tail.length;
            while (recent.length > CACHE_MAX_RECORDS || recentBytes > CACHE_MAX_BYTES && recent.length > 1) {
              const dropped = recent.shift();
              if (!dropped) break;
              recentBytes -= dropped.bytes;
            }
            valid = true;
          }
        } catch {
          valid = false;
        }
        if (valid) needsSeparator = true;
        else truncateAt = lineStart;
      }
    } finally {
      await handle.close();
    }
    if (truncateAt !== null) await fs4.truncate(this.file, truncateAt);
    this.recovery = { recovered, droppedPartialLine: truncateAt !== null, corruptLines: corrupt };
    this.needsSeparator = needsSeparator;
    const lastRecord = last;
    this.nextSeq = (lastRecord?.seq ?? 0) + 1;
    this.cache = [];
    this.cacheBytes = 0;
    this.cacheStartSeq = this.nextSeq;
    for (const entry of recent) this.pushCache(entry.record, entry.bytes);
  }
  append(input) {
    const run2 = async () => {
      if (this.closed) throw new EventLogError("EVENT_LOG_CLOSED", "O log de eventos foi fechado.");
      const data = JSON.parse(JSON.stringify(input.data ?? {}));
      const forbidden = scanForbidden(data);
      if (forbidden) throw new EventLogError("EVENT_FORBIDDEN_FIELD", `Conte\xFAdo oculto ou sens\xEDvel em evento: ${forbidden}`);
      const record2 = {
        seq: this.nextSeq,
        ...input.gseq !== void 0 ? { gseq: input.gseq } : {},
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        type: input.type,
        taskId: input.taskId,
        runId: input.runId,
        ...input.threadId !== void 0 ? { threadId: input.threadId } : {},
        ...input.toolUseId !== void 0 ? { toolUseId: input.toolUseId } : {},
        data
      };
      const serialized = JSON.stringify(record2);
      const bytes = Buffer.byteLength(serialized, "utf8");
      if (bytes > MAX_RECORD_BYTES) {
        throw new EventLogError("EVENT_RECORD_TOO_LARGE", `Evento ${input.type} com ${bytes} bytes excede o limite de ${MAX_RECORD_BYTES}; use uma pr\xE9via limitada com armazenamento externo.`);
      }
      await fs4.appendFile(this.file, `${this.needsSeparator ? "\n" : ""}${serialized}
`, "utf8");
      this.needsSeparator = false;
      this.nextSeq += 1;
      this.pushCache(record2, bytes);
      for (const listener of this.listeners) {
        try {
          listener(structuredClone(record2));
        } catch {
        }
      }
      return structuredClone(record2);
    };
    const next = this.chain.then(run2, run2);
    this.chain = next.catch(() => void 0);
    return next;
  }
  /** Convenience reader used by derivation and tests; unbounded by design. */
  async readFrom(cursor, limit = 1e5) {
    return (await this.readPage(cursor, limit, Number.MAX_SAFE_INTEGER)).events;
  }
  /**
   * Reads events after `cursor`. When the page budget cannot cover everything,
   * the NEWEST events are returned and `gapped` is true, so the caller can
   * signal a view reset instead of silently losing history.
   */
  async readPage(cursor, limit = 2e3, byteBudget = REPLAY_MAX_BYTES) {
    await this.chain.catch(() => void 0);
    const window2 = new RollingWindow(limit, byteBudget);
    if (cursor + 1 >= this.cacheStartSeq) {
      for (const event of this.cache) if (event.seq > cursor) window2.push(structuredClone(event));
    } else {
      const reader = readline.createInterface({ input: createReadStream(this.file, { encoding: "utf8" }), crlfDelay: Infinity });
      try {
        for await (const line of reader) {
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.seq > cursor) window2.push(parsed);
          } catch {
          }
        }
      } finally {
        reader.close();
      }
    }
    const page = window2.events;
    return { events: page, gapped: window2.dropped, firstSeq: page[0]?.seq ?? null };
  }
  /**
   * Reads the page immediately BEFORE `seq`, so a client can walk backwards
   * through history it never received instead of being told it is unavailable.
   * `more` reports whether older events still exist beyond this page.
   */
  async readBefore(seq, limit = 200, byteBudget = REPLAY_MAX_BYTES) {
    await this.chain.catch(() => void 0);
    if (seq <= 1) return { events: [], more: false };
    const window2 = new RollingWindow(limit, byteBudget);
    let oldestSeen = null;
    const consider = (event) => {
      if (event.seq >= seq) return;
      if (oldestSeen === null || event.seq < oldestSeen) oldestSeen = event.seq;
      window2.push(event);
    };
    if (this.cacheStartSeq <= 1 || seq > this.cacheStartSeq) {
      for (const event of this.cache) consider(structuredClone(event));
    }
    if (this.cacheStartSeq > 1) {
      const reader = readline.createInterface({ input: createReadStream(this.file, { encoding: "utf8" }), crlfDelay: Infinity });
      const disk = new RollingWindow(limit, byteBudget);
      let diskOldest = null;
      try {
        for await (const line of reader) {
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.seq >= seq) continue;
            if (diskOldest === null || parsed.seq < diskOldest) diskOldest = parsed.seq;
            disk.push(parsed);
          } catch {
          }
        }
      } finally {
        reader.close();
      }
      if (disk.events.length) return { events: disk.events, more: (disk.events[0]?.seq ?? 1) > 1 };
    }
    const events = window2.events;
    return { events, more: (events[0]?.seq ?? 1) > 1 };
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async close() {
    await this.chain.catch(() => void 0);
    this.closed = true;
    this.listeners.clear();
  }
};

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
function previewPage(text, page, maxChars = PREVIEW_MAX_CHARS) {
  const pages = Math.max(1, Math.ceil(text.length / maxChars));
  const index = Math.min(Math.max(1, page), pages);
  const start = (index - 1) * maxChars;
  return { page: index, pages, text: text.slice(start, start + maxChars) };
}

// src/preflight/cli-probe.ts
import { spawn } from "node:child_process";
function run(executable, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const command = executable.runWith === "node" ? process.execPath : executable.executablePath;
    const argv = executable.runWith === "node" ? [executable.executablePath, ...args] : args;
    const child = spawn(command, argv, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 1e6) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 1e5) stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(Object.assign(new Error("timeout"), { code: "PROBE_TIMEOUT" }));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
function parseVersion(text) {
  const match = /(\d+\.\d+\.\d+)/.exec(text);
  return match ? match[1] : null;
}
function parseAdvertisedFlags(helpText) {
  const flags = /* @__PURE__ */ new Set();
  for (const match of helpText.matchAll(/(--[a-z][a-z0-9-]*)/g)) flags.add(match[1]);
  return [...flags].sort();
}
function sanitizeAuthStatus(raw) {
  if (!raw || typeof raw !== "object") return null;
  const value = raw;
  return {
    loggedIn: typeof value.loggedIn === "boolean" ? value.loggedIn : null,
    authMethod: typeof value.authMethod === "string" ? value.authMethod : null,
    apiProvider: typeof value.apiProvider === "string" ? value.apiProvider : null,
    subscriptionType: typeof value.subscriptionType === "string" ? value.subscriptionType : null
  };
}
async function probeCli(executable, options = {}) {
  const timeoutMs = options.timeoutMs ?? 3e4;
  const version = await run(executable, ["--version"], timeoutMs);
  if (version.code !== 0) throw Object.assign(new Error("claude --version falhou"), { code: "VERSION_EXIT_NONZERO" });
  const help = await run(executable, ["--help"], timeoutMs);
  const advertisedFlags = help.code === 0 ? parseAdvertisedFlags(`${help.stdout}
${help.stderr}`) : null;
  let authStatus = null;
  try {
    const auth = await run(executable, ["auth", "status", "--json"], timeoutMs);
    if (auth.code === 0) {
      const start = auth.stdout.indexOf("{");
      authStatus = start >= 0 ? sanitizeAuthStatus(JSON.parse(auth.stdout.slice(start))) : null;
    }
  } catch {
    authStatus = null;
  }
  return { cliVersion: parseVersion(version.stdout), advertisedFlags, authStatus };
}
async function queryUsageText(executable, timeoutMs = 45e3) {
  const outcome = await run(executable, ["--safe-mode", "--tools", "", "--permission-mode", "dontAsk", "--permission-prompts", "none", "--output-format", "json", "-p", "/usage"], timeoutMs);
  if (outcome.code !== 0) throw Object.assign(new Error("consulta /usage falhou"), { code: "USAGE_QUERY_FAILED" });
  const start = outcome.stdout.indexOf("{");
  const payload = JSON.parse(outcome.stdout.slice(start));
  if (typeof payload.result !== "string") throw Object.assign(new Error("resposta /usage sem result"), { code: "USAGE_FORMAT_UNEXPECTED" });
  return payload.result;
}

// src/broker/task-manager.ts
init_cli_resolver();

// src/trust/inventory.ts
import { createHash as createHash2 } from "node:crypto";
import { promises as fs6, realpathSync } from "node:fs";
import os from "node:os";
import path6 from "node:path";
var SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "build", "out", "target", "vendor", ".next", ".venv", "venv", "__pycache__", ".codex", "coverage", ".turbo", ".cache"]);
var SCRIPT_EXTENSIONS = /\.(ps1|js|mjs|cjs|py|sh|bash|cmd|bat|rb|pl|php|exe)$/i;
var MANAGED_SETTINGS_NOTE = "Pol\xEDticas gerenciadas (managed settings) s\xE3o aplicadas pelo CLI independentemente do runtime; n\xE3o s\xE3o aprovadas, alteradas nem desativadas aqui.";
function defaultManagedSettingsPaths() {
  if (process.platform === "win32") {
    const programData = process.env.ProgramData ?? "C:\\ProgramData";
    return [path6.join(programData, "ClaudeCode", "managed-settings.json")];
  }
  if (process.platform === "darwin") return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
  return ["/etc/claude-code/managed-settings.json"];
}
function sha2562(input) {
  return createHash2("sha256").update(input).digest("hex");
}
function realpathNative(target) {
  return realpathSync.native(target);
}
function canonicalizeWorkspace(workspace) {
  let real;
  try {
    real = realpathNative(workspace);
  } catch {
    real = path6.resolve(workspace);
  }
  const normalized = real.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
async function exists2(file) {
  try {
    await fs6.access(file);
    return true;
  } catch {
    return false;
  }
}
async function readIf(file) {
  try {
    return await fs6.readFile(file, "utf8");
  } catch {
    return null;
  }
}
function realpathOrResolve(target) {
  try {
    return realpathNative(target);
  } catch {
    return path6.resolve(target);
  }
}
function rel(root, file) {
  const relative = path6.relative(root, file).replace(/\\/g, "/");
  if (!relative.startsWith("../")) return relative;
  const retried = path6.relative(realpathOrResolve(root), realpathOrResolve(file)).replace(/\\/g, "/");
  return retried.startsWith("../") ? relative : retried;
}
function mcpDetails(config) {
  const url = typeof config.url === "string" ? config.url : null;
  const transport = typeof config.type === "string" ? config.type : url ? "http" : "stdio";
  if (url) {
    try {
      return { transport, host: new URL(url).hostname };
    } catch {
      return { transport, host: null };
    }
  }
  return { transport: "stdio", command: typeof config.command === "string" ? path6.basename(config.command) : null };
}
function commandTokens(command) {
  return command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token2) => token2.replace(/^["']|["']$/g, "")) ?? [];
}
var VARIABLE_PATTERN = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?|%([A-Za-z_][A-Za-z0-9_]*)%/g;
function expandHookVariables(token2, workspace) {
  const unresolved = [];
  const value = token2.replace(VARIABLE_PATTERN, (match, dollar, percent) => {
    const name = dollar ?? percent ?? "";
    if (name === "CLAUDE_PROJECT_DIR") return workspace;
    unresolved.push(name);
    return match;
  });
  return { value, unresolved };
}
async function collectHookScripts(collector, command, root, rootCanonical, scope, toRelative, referencedBy, workspace) {
  const scripts = [];
  for (const rawToken of commandTokens(command)) {
    const expansion = expandHookVariables(rawToken, workspace);
    const token2 = expansion.value;
    const looksLikeScript = SCRIPT_EXTENSIONS.test(token2) || token2.includes("/") || token2.includes("\\");
    if (!looksLikeScript || /^https?:\/\//i.test(token2)) continue;
    if (expansion.unresolved.length > 0) {
      collector.skipped.push({ path: `${referencedBy} -> ${rawToken}`, reason: `UNRESOLVED_HOOK_ENTRYPOINT:${expansion.unresolved.join(",")}` });
      collector.incomplete = true;
      continue;
    }
    const absolute = path6.resolve(root, token2);
    let real;
    try {
      real = realpathNative(absolute);
    } catch {
      continue;
    }
    const canonical = canonicalizeWorkspace(real);
    if (canonical !== rootCanonical && !canonical.startsWith(`${rootCanonical}/`)) {
      collector.skipped.push({ path: token2, reason: "HOOK_SCRIPT_OUTSIDE_ROOT" });
      collector.incomplete = true;
      continue;
    }
    let content;
    try {
      const stat = await fs6.stat(real);
      if (!stat.isFile()) continue;
      content = await fs6.readFile(real);
    } catch {
      continue;
    }
    const relativePath = toRelative(real);
    scripts.push(relativePath);
    if (!collector.items.some((item) => item.kind === "hook" && item.relativePath === relativePath)) {
      collector.items.push({ kind: "hook", scope, relativePath, sha256: sha2562(content), details: { referencedBy } });
    }
  }
  return scripts;
}
async function collectSettings(collector, file, relativePath, scope, root, toRelative, workspace) {
  const text = await readIf(file);
  if (text === null) return;
  collector.items.push({ kind: "settings", scope, relativePath, sha256: sha2562(text) });
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    collector.items.push({ kind: "settings", scope, relativePath: `${relativePath}#parse-error`, sha256: sha2562(text), details: { error: "JSON inv\xE1lido" } });
    return;
  }
  const hooks = parsed.hooks;
  if (!hooks || typeof hooks !== "object") return;
  const rootCanonical = canonicalizeWorkspace(root);
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (let index = 0; index < matchers.length; index += 1) {
      const entry = matchers[index];
      const key = `${relativePath}#hooks.${event}[${index}]`;
      const summaries = [];
      for (const hook of Array.isArray(entry.hooks) ? entry.hooks : []) {
        const type = typeof hook.type === "string" ? hook.type : "unknown";
        const command = typeof hook.command === "string" ? hook.command : null;
        const url = typeof hook.url === "string" ? hook.url : null;
        const summary = { type };
        if (command) {
          const tokens = commandTokens(redactSensitiveText(command));
          summary.command = tokens.length ? path6.basename(expandHookVariables(tokens[0], workspace).value) : null;
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
        kind: "hook",
        scope,
        relativePath: key,
        sha256: sha2562(JSON.stringify(entry)),
        details: { event, matcher: typeof entry.matcher === "string" ? entry.matcher : null, hooks: summaries }
      });
    }
  }
}
function addMcp(collector, servers, relativePath, scope) {
  if (!servers || typeof servers !== "object") return;
  for (const [name, config] of Object.entries(servers)) {
    if (!config || typeof config !== "object") continue;
    collector.items.push({ kind: "mcp", scope, relativePath: `${relativePath}#${name}`, sha256: sha2562(JSON.stringify(config)), details: mcpDetails(config) });
    if (!(name in collector.configs)) collector.configs[name] = config;
  }
}
async function collectProjectMcp(collector, file, relativePath, scope) {
  const text = await readIf(file);
  if (text === null) return;
  try {
    addMcp(collector, JSON.parse(text).mcpServers, relativePath, scope);
  } catch {
    collector.items.push({ kind: "mcp", scope, relativePath: `${relativePath}#parse-error`, sha256: sha2562(text), details: { error: "JSON inv\xE1lido" } });
  }
}
async function collectUserClaudeJson(collector, file, canonicalWorkspace) {
  const text = await readIf(file);
  if (text === null) return;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  addMcp(collector, parsed.mcpServers, "user:.claude.json", "user");
  const projects = parsed.projects;
  if (projects && typeof projects === "object") {
    for (const [projectPath, config] of Object.entries(projects)) {
      if (!config || typeof config !== "object") continue;
      if (canonicalizeWorkspace(projectPath) !== canonicalWorkspace) continue;
      addMcp(collector, config.mcpServers, "user:.claude.json#projects", "user");
    }
  }
}
async function collectDirectory(collector, dir, kind, scope, toRelative, pattern, recursive) {
  let entries;
  try {
    entries = await fs6.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path6.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive && !entry.isSymbolicLink()) await collectDirectory(collector, full, kind, scope, toRelative, pattern, recursive);
      continue;
    }
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const content = await readIf(full);
    if (content === null) continue;
    collector.items.push({ kind, scope, relativePath: toRelative(full), sha256: sha2562(content) });
  }
}
async function collectSkills(collector, dir, scope, toRelative) {
  let entries;
  try {
    entries = await fs6.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const skill = path6.join(dir, entry.name, "SKILL.md");
    const content = await readIf(skill);
    if (content === null) continue;
    collector.items.push({ kind: "skill", scope, relativePath: toRelative(skill), sha256: sha2562(content) });
  }
}
async function collectInstructions(collector, dir, scope, toRelative, names) {
  for (const name of names) {
    const file = path6.join(dir, name);
    const content = await readIf(file);
    if (content !== null) collector.items.push({ kind: "instructions", scope, relativePath: toRelative(file), sha256: sha2562(content) });
  }
}
async function collectDotClaudeInstructions(collector, dir, scope, toRelative) {
  await collectInstructions(collector, path6.join(dir, ".claude"), scope, toRelative, ["CLAUDE.md"]);
  await collectDirectory(collector, path6.join(dir, ".claude", "rules"), "rules", scope, toRelative, /\.md$/i, true);
}
async function collectChildren(collector, workspace, workspaceCanonical, dir, depth, maxDepth) {
  let entries;
  try {
    entries = await fs6.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path6.join(dir, entry.name);
    if (SKIP_DIRS.has(entry.name) || entry.name === ".claude") continue;
    let isDir = entry.isDirectory();
    const isLink = entry.isSymbolicLink();
    if (isLink || process.platform === "win32" && !isDir && !entry.isFile()) {
      try {
        isDir = (await fs6.stat(full)).isDirectory();
      } catch {
        continue;
      }
    }
    if (!isDir) continue;
    let real;
    try {
      real = realpathNative(full);
    } catch {
      collector.skipped.push({ path: rel(workspace, full), reason: "UNRESOLVABLE" });
      collector.incomplete = true;
      continue;
    }
    const realCanonical = canonicalizeWorkspace(real);
    if (realCanonical !== workspaceCanonical && !realCanonical.startsWith(`${workspaceCanonical}/`)) {
      collector.skipped.push({ path: rel(workspace, full), reason: "REPARSE_OUTSIDE_WORKSPACE" });
      continue;
    }
    if (depth > maxDepth) {
      collector.skipped.push({ path: rel(workspace, full), reason: "DEPTH_LIMIT" });
      collector.incomplete = true;
      continue;
    }
    const toRelative = (file) => rel(workspace, file);
    await collectInstructions(collector, full, "child", toRelative, ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"]);
    await collectDotClaudeInstructions(collector, full, "child", toRelative);
    await collectChildren(collector, workspace, workspaceCanonical, full, depth + 1, maxDepth);
  }
}
async function inventoryCustomizations(workspace, options = {}) {
  const resolved = realpathOrResolve(workspace);
  const canonicalWorkspace = canonicalizeWorkspace(resolved);
  const collector = { items: [], skipped: [], incomplete: false, configs: {} };
  const toRel = (file) => rel(resolved, file);
  const boundary = options.ancestorBoundary ? canonicalizeWorkspace(options.ancestorBoundary) : null;
  let parent = path6.dirname(resolved);
  const ancestorDirs = [];
  while (parent && parent !== path6.dirname(parent)) {
    ancestorDirs.push(parent);
    if (boundary && canonicalizeWorkspace(parent) === boundary) break;
    parent = path6.dirname(parent);
  }
  if (boundary === canonicalWorkspace) ancestorDirs.length = 0;
  else if (boundary && !ancestorDirs.some((dir) => canonicalizeWorkspace(dir) === boundary)) {
    collector.skipped.push({ path: options.ancestorBoundary ?? "", reason: "ANCESTOR_BOUNDARY_NOT_AN_ANCESTOR" });
  }
  for (const dir of ancestorDirs.reverse()) {
    await collectInstructions(collector, dir, "ancestor", toRel, ["CLAUDE.md", "CLAUDE.local.md"]);
    await collectDotClaudeInstructions(collector, dir, "ancestor", toRel);
  }
  await collectInstructions(collector, resolved, "project", toRel, ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"]);
  await collectDotClaudeInstructions(collector, resolved, "project", toRel);
  await collectSettings(collector, path6.join(resolved, ".claude", "settings.json"), ".claude/settings.json", "project", resolved, toRel, resolved);
  await collectSettings(collector, path6.join(resolved, ".claude", "settings.local.json"), ".claude/settings.local.json", "project", resolved, toRel, resolved);
  await collectDirectory(collector, path6.join(resolved, ".claude", "agents"), "agent", "project", toRel, /\.md$/i, false);
  await collectSkills(collector, path6.join(resolved, ".claude", "skills"), "project", toRel);
  await collectProjectMcp(collector, path6.join(resolved, ".mcp.json"), ".mcp.json", "project");
  await collectChildren(collector, resolved, canonicalWorkspace, resolved, 1, options.maxChildDepth ?? 12);
  const userDir = options.userConfigDir === void 0 ? path6.join(os.homedir(), ".claude") : options.userConfigDir;
  if (userDir) {
    const userRel = (file) => `user:${rel(userDir, file)}`;
    await collectInstructions(collector, userDir, "user", userRel, ["CLAUDE.md"]);
    await collectDirectory(collector, path6.join(userDir, "rules"), "rules", "user", userRel, /\.md$/i, true);
    await collectSettings(collector, path6.join(userDir, "settings.json"), "user:settings.json", "user", userDir, userRel, resolved);
    await collectDirectory(collector, path6.join(userDir, "agents"), "agent", "user", userRel, /\.md$/i, false);
    await collectSkills(collector, path6.join(userDir, "skills"), "user", userRel);
  }
  const userClaudeJson = options.userClaudeJsonPath === void 0 ? path6.join(os.homedir(), ".claude.json") : options.userClaudeJsonPath;
  if (userClaudeJson && await exists2(userClaudeJson)) await collectUserClaudeJson(collector, userClaudeJson, canonicalWorkspace);
  const managedCandidates = options.managedSettingsPaths === void 0 ? defaultManagedSettingsPaths() : options.managedSettingsPaths;
  let managedPresent = null;
  if (managedCandidates) {
    managedPresent = false;
    for (const candidate of managedCandidates) if (await exists2(candidate)) managedPresent = true;
  }
  const managedSettings = { candidates: managedCandidates ?? [], present: managedPresent, note: MANAGED_SETTINGS_NOTE };
  const items = collector.items.sort((a, b) => `${a.kind}:${a.scope}:${a.relativePath}`.localeCompare(`${b.kind}:${b.scope}:${b.relativePath}`));
  const fingerprint = sha2562(items.map((item) => `${item.kind}|${item.scope}|${item.relativePath}|${item.sha256}`).join("\n"));
  const snapshot = {
    workspace: resolved,
    canonicalWorkspace,
    items,
    fingerprint,
    skipped: collector.skipped,
    incomplete: collector.incomplete,
    managedSettings,
    collectedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  return {
    ...snapshot,
    mcpServerConfigs: collector.configs,
    diff(other) {
      const mine = new Map(items.map((item) => [item.relativePath, item.sha256]));
      const theirs = new Map(other.items.map((item) => [item.relativePath, item.sha256]));
      const added = [...mine.keys()].filter((key) => !theirs.has(key)).sort();
      const removed = [...theirs.keys()].filter((key) => !mine.has(key)).sort();
      const changed = [...mine.entries()].filter(([key, hash]) => theirs.has(key) && theirs.get(key) !== hash).map(([key]) => key).sort();
      return { added, removed, changed };
    },
    toJSON() {
      return snapshot;
    }
  };
}

// src/trust/launch-customizations.ts
function resolveLaunchCustomizations(input) {
  const base = {
    strictMcpConfig: true,
    mcpConfigIsExhaustive: true,
    autoMemoryEnabled: false,
    env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }
  };
  if (!input.trust.trusted) {
    return {
      settingSources: [],
      ...base,
      mcpServers: {},
      loadProjectInstructions: false,
      pendingApproval: [...input.trust.pending, ...input.trust.changed].sort(),
      reason: input.trust.reason
    };
  }
  const items = input.inventory.items;
  const settingSources = [];
  if (items.some((item) => item.scope === "user")) settingSources.push("user");
  if (items.some((item) => item.scope === "project" || item.scope === "ancestor" || item.scope === "child")) settingSources.push("project");
  if (items.some((item) => item.relativePath === ".claude/settings.local.json")) settingSources.push("local");
  const configs = "mcpServerConfigs" in input.inventory ? input.inventory.mcpServerConfigs : {};
  const approvedServers = input.record ? Object.keys(input.record.mcpServers) : items.filter((item) => item.kind === "mcp").map((item) => item.relativePath.split("#").slice(1).join("#"));
  const mcpServers = {};
  for (const name of approvedServers) if (name in configs) mcpServers[name] = configs[name];
  return {
    settingSources,
    ...base,
    mcpServers,
    loadProjectInstructions: settingSources.includes("project"),
    pendingApproval: [],
    reason: input.trust.reason
  };
}

// src/policy/action-classifier.ts
import fs7 from "node:fs";
import path7 from "node:path";
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
function normalizeForCompare(p) {
  const normalized = path7.normalize(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function realpathContained(target) {
  let probe = target;
  const trailing = [];
  for (; ; ) {
    try {
      const real = fs7.realpathSync.native(probe);
      return trailing.length ? path7.join(real, ...trailing.reverse()) : real;
    } catch {
      const parent = path7.dirname(probe);
      if (parent === probe) return target;
      trailing.push(path7.basename(probe));
      probe = parent;
    }
  }
}
function isInside(parent, child) {
  const rel2 = path7.relative(normalizeForCompare(parent), normalizeForCompare(child));
  return rel2 === "" || !rel2.startsWith("..") && !path7.isAbsolute(rel2);
}
function resolveWorkspacePath(workspace, candidate) {
  const absolute = path7.resolve(workspace, candidate);
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

// src/broker/worktree.ts
import { spawn as spawn3 } from "node:child_process";
import { promises as fs9, realpathSync as realpathSync2 } from "node:fs";
import path9 from "node:path";

// src/quota/global-mutex.ts
import { spawn as spawn2 } from "node:child_process";
import { promises as fs8 } from "node:fs";
import os2 from "node:os";
import path8 from "node:path";
var QUOTA_MUTEX_NAME = "Local\\ClaudeLiveQuota";
var QuotaLockError = class extends Error {
  code;
  attemptedAt;
  constructor(code, message, attemptedAt) {
    super(message);
    this.name = "QuotaLockError";
    this.code = code;
    this.attemptedAt = attemptedAt;
  }
};
var HOLDER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$mutex = [Threading.Mutex]::new($false, $env:CODEORQUESTRA_MUTEX_NAME)",
  "try { $held = $mutex.WaitOne([int]$env:CODEORQUESTRA_MUTEX_WAIT_MS) } catch [Threading.AbandonedMutexException] { $held = $true }",
  "if (-not $held) { [Console]::Out.WriteLine('TIMEOUT'); [Console]::Out.Flush(); exit 2 }",
  "[Console]::Out.WriteLine('HELD'); [Console]::Out.Flush()",
  "$null = [Console]::In.ReadLine()",
  "$mutex.ReleaseMutex(); $mutex.Dispose()",
  "[Console]::Out.WriteLine('RELEASED'); [Console]::Out.Flush()"
].join("; ");
var localChains = /* @__PURE__ */ new Map();
function isMissingInterpreter(error) {
  const message = error instanceof Error ? error.message : String(error);
  return error.code === "QUOTA_LOCK_UNAVAILABLE" && /ENOENT/.test(message);
}
var pwshFallbackReported = false;
function reportPwshFallback() {
  if (pwshFallbackReported) return;
  pwshFallbackReported = true;
  process.stderr.write(
    "CodeOrquestra: PowerShell 7 (pwsh) n\xE3o est\xE1 instalado; o mutex de quota passa a usar arquivo de trava. Isso ainda exclui outros brokers v2. A exclus\xE3o m\xFAtua com o runner legado v1 n\xE3o se aplica aqui, porque o v1 tamb\xE9m \xE9 executado por pwsh.\n"
  );
}
function acquireWindows(name, waitMs, attemptedAt) {
  return new Promise((resolve, reject) => {
    const child = spawn2("pwsh", ["-NoProfile", "-NonInteractive", "-Command", HOLDER_SCRIPT], {
      env: { ...process.env, CODEORQUESTRA_MUTEX_NAME: name, CODEORQUESTRA_MUTEX_WAIT_MS: String(waitMs) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = new Promise((done) => child.on("exit", () => done()));
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (child.exitCode === null) child.kill();
      reject(error);
    };
    const timer = setTimeout(() => fail(new QuotaLockError("QUOTA_LOCK_TIMEOUT", "Tempo esgotado aguardando o mutex global de quota.", attemptedAt)), waitMs + 2e4);
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(new QuotaLockError("QUOTA_LOCK_UNAVAILABLE", `pwsh indispon\xEDvel para o mutex global: ${error.message}`, attemptedAt));
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (settled) return;
      if (stdout.includes("HELD")) {
        settled = true;
        clearTimeout(timer);
        resolve({
          async release() {
            if (child.exitCode === null) {
              child.stdin.write("release\n");
              child.stdin.end();
              const killer = setTimeout(() => child.kill(), 5e3);
              await exited;
              clearTimeout(killer);
            }
          }
        });
      } else if (stdout.includes("TIMEOUT")) {
        clearTimeout(timer);
        fail(new QuotaLockError("QUOTA_LOCK_TIMEOUT", "Tempo esgotado aguardando o mutex global de quota (v1 ou outra consulta v2 em andamento).", attemptedAt));
      }
    });
    void exited.then(() => {
      if (!settled) {
        clearTimeout(timer);
        fail(new QuotaLockError("QUOTA_LOCK_UNAVAILABLE", `O processo do mutex encerrou antes de adquirir (${stderr.trim().slice(0, 200)}).`, attemptedAt));
      }
    });
  });
}
async function acquireLockFile(name, waitMs, attemptedAt) {
  const file = path8.join(os2.tmpdir(), `${name.replace(/[^A-Za-z0-9]/g, "_")}.lock`);
  const deadline = Date.now() + waitMs;
  for (; ; ) {
    try {
      const handle = await fs8.open(file, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      return { async release() {
        await fs8.rm(file, { force: true });
      } };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const pid = Number(await fs8.readFile(file, "utf8"));
        if (pid && !isAlive(pid)) {
          await fs8.rm(file, { force: true });
          continue;
        }
      } catch {
      }
      if (Date.now() >= deadline) throw new QuotaLockError("QUOTA_LOCK_TIMEOUT", "Tempo esgotado aguardando o lock global de quota.", attemptedAt);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function withNamedMutex(name, fn, options = {}) {
  const waitMs = options.waitMs ?? 3e4;
  const attemptedAt = (/* @__PURE__ */ new Date()).toISOString();
  const started = Date.now();
  const useKernelMutex = process.platform === "win32" && (options.transport ?? "auto") === "auto";
  const run2 = async () => {
    let holder;
    if (useKernelMutex) {
      try {
        holder = await acquireWindows(name, waitMs, attemptedAt);
      } catch (error) {
        if (!isMissingInterpreter(error)) throw error;
        reportPwshFallback();
        holder = await acquireLockFile(name, waitMs, attemptedAt);
      }
    } else {
      holder = await acquireLockFile(name, waitMs, attemptedAt);
    }
    const waitedMs = Date.now() - started;
    try {
      const value = await fn();
      return { value, waitedMs, attemptedAt };
    } finally {
      await holder.release();
    }
  };
  const previous = localChains.get(name) ?? Promise.resolve();
  const next = previous.then(run2, run2);
  const settled = next.catch(() => void 0).then(() => {
    if (localChains.get(name) === settled) localChains.delete(name);
  });
  localChains.set(name, settled);
  return next;
}
async function withGlobalQuotaMutex(fn, options = {}) {
  return withNamedMutex(options.name ?? QUOTA_MUTEX_NAME, fn, options.waitMs === void 0 ? {} : { waitMs: options.waitMs });
}

// src/broker/worktree.ts
var GIT_TIMEOUT_MS = 2e4;
var GIT_PROVISION_TIMEOUT_MS = 12e4;
var MAX_CHANGED_FILES = 500;
var WorktreeError = class extends Error {
  code;
  detail;
  constructor(code, message, detail) {
    super(message);
    this.name = "WorktreeError";
    this.code = code;
    this.detail = detail;
  }
};
function git(args, cwd, timeoutMs = GIT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn3("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(error), timedOut });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
async function gitStatus(workspace) {
  try {
    await fs9.access(path9.join(workspace, ".git"));
  } catch {
    return [];
  }
  const result = await git(["status", "--porcelain", "--untracked-files=all"], workspace, 5e3);
  if (result.code !== 0) return [];
  return result.stdout.split("\n").map((line) => normalizeStatusPath(line.slice(3).trim())).filter(Boolean).slice(0, MAX_CHANGED_FILES);
}
function normalizeStatusPath(field) {
  let value = field;
  const arrow = value.lastIndexOf(" -> ");
  if (arrow >= 0) value = value.slice(arrow + 4).trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    const body = value.slice(1, -1);
    try {
      const bytes = [];
      for (let index = 0; index < body.length; index += 1) {
        if (body[index] !== "\\") {
          bytes.push(body.charCodeAt(index));
          continue;
        }
        const next = body[index + 1] ?? "";
        if (/[0-7]/.test(next)) {
          bytes.push(parseInt(body.slice(index + 1, index + 4), 8));
          index += 3;
        } else {
          bytes.push({ n: 10, t: 9, r: 13, '"': 34, "\\": 92 }[next] ?? body.charCodeAt(index + 1));
          index += 1;
        }
      }
      value = Buffer.from(bytes).toString("utf8");
    } catch {
      return field;
    }
  }
  return value;
}
function lexical(target) {
  const normalized = target.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function canonicalize(target) {
  try {
    return lexical(realpathSync2.native(target));
  } catch {
    return lexical(target);
  }
}
function canonicalizePlanned(target) {
  const absolute = path9.resolve(target);
  const trailing = [];
  let probe = absolute;
  for (; ; ) {
    try {
      const real = realpathSync2.native(probe);
      return canonicalize(trailing.length ? path9.join(real, ...trailing.reverse()) : real);
    } catch {
      const parent = path9.dirname(probe);
      if (parent === probe) return canonicalize(absolute);
      trailing.push(path9.basename(probe));
      probe = parent;
    }
  }
}
async function resolveRepository(workspace) {
  const result = await git(["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], workspace);
  if (result.code !== 0) {
    throw new WorktreeError("NOT_A_GIT_REPOSITORY", "O workspace declarado n\xE3o pertence a um reposit\xF3rio git; worktrees exigem um.", result.stderr.trim().slice(0, 400));
  }
  const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const commonDir = lines[0];
  const topLevel = lines[1];
  if (!commonDir || !topLevel) {
    throw new WorktreeError("NOT_A_GIT_REPOSITORY", "N\xE3o foi poss\xEDvel identificar o reposit\xF3rio do workspace declarado.");
  }
  return { commonDir: canonicalize(commonDir), topLevel: canonicalize(topLevel), repoKey: sha256(canonicalize(commonDir)).slice(0, 24) };
}
async function withRepositoryMutex(repoKey, fn) {
  const outcome = await withNamedMutex(`CodeOrquestraRepo-${repoKey}`, fn, { waitMs: 6e4, transport: "file" });
  return outcome.value;
}
function worktreePathFor(stateRoot, repoKey, taskId) {
  const root = path9.join(stateRoot, "worktrees", repoKey);
  return { root, path: path9.join(root, taskId.slice(0, 16)) };
}
function assertUsablePathLength(target) {
  if (process.platform === "win32" && target.length > 150) {
    throw new WorktreeError(
      "WORKTREE_PATH_TOO_LONG",
      `O caminho do worktree tem ${target.length} caracteres; ferramentas que n\xE3o habilitaram caminhos longos falhariam dentro dele. Configure um worktreeRoot mais curto na pol\xEDtica do reposit\xF3rio.`
    );
  }
}
async function inspectExisting(target, repository) {
  try {
    await fs9.access(target);
  } catch {
    return null;
  }
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], target);
  if (common.code !== 0 || canonicalize(common.stdout.trim()) !== repository.commonDir) {
    throw new WorktreeError("WORKTREE_PATH_OCCUPIED", "J\xE1 existe um diret\xF3rio nesse caminho que n\xE3o \xE9 um worktree deste reposit\xF3rio. Nada foi removido; resolva manualmente.");
  }
  return { reusable: true, dirty: await gitStatus(target) };
}
async function ensureWorktree(options) {
  const { repository, target, branch, baseRef } = options;
  assertUsablePathLength(target);
  const existing = await inspectExisting(target, repository);
  if (existing) {
    if (existing.dirty.length > 0) {
      throw new WorktreeError(
        "WORKTREE_DIRTY_FROM_PREVIOUS_RUN",
        `O worktree desta tarefa ainda tem ${existing.dirty.length} arquivo(s) com altera\xE7\xF5es n\xE3o commitadas de uma execu\xE7\xE3o anterior. Revise e commite ou descarte antes de iniciar outra.`,
        existing.dirty.slice(0, 20).join(", ")
      );
    }
    return { path: target, branch, baseRef, created: false };
  }
  await fs9.mkdir(path9.dirname(target), { recursive: true });
  const args = ["worktree", "add", "--no-track", "-b", branch, target];
  if (baseRef) args.push(baseRef);
  const result = await git(args, repository.topLevel, GIT_PROVISION_TIMEOUT_MS);
  if (result.code !== 0) {
    await git(["worktree", "prune"], repository.topLevel).catch(() => void 0);
    throw new WorktreeError(
      result.timedOut ? "WORKTREE_ADD_TIMEOUT" : "WORKTREE_ADD_FAILED",
      result.timedOut ? "git worktree add excedeu o tempo limite; nada foi iniciado." : "git worktree add falhou; nada foi iniciado.",
      result.stderr.trim().slice(0, 400)
    );
  }
  return { path: target, branch, baseRef, created: true };
}
async function removeWorktree(repository, target, options = {}) {
  const result = await git(["worktree", "remove", ...options.force ? ["--force"] : [], target], repository.topLevel);
  if (result.code === 0) {
    await git(["worktree", "prune"], repository.topLevel).catch(() => void 0);
    return { removed: true };
  }
  return { removed: false, reason: result.stderr.trim().slice(0, 400) || "git worktree remove recusou a remo\xE7\xE3o." };
}
async function listOrphans(stateRoot, isOwned) {
  const root = path9.join(stateRoot, "worktrees");
  let repoDirs;
  try {
    repoDirs = (await fs9.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  const orphans = [];
  for (const repoKey of repoDirs) {
    let taskDirs;
    try {
      taskDirs = (await fs9.readdir(path9.join(root, repoKey), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const taskPrefix of taskDirs) {
      if (isOwned(repoKey, taskPrefix)) continue;
      const target = path9.join(root, repoKey, taskPrefix);
      orphans.push({ path: target, repoKey, taskId: taskPrefix, dirtyFiles: await gitStatus(target) });
    }
  }
  return orphans;
}

// src/broker/worktree-policy.ts
import { createHash as createHash3 } from "node:crypto";
import { promises as fs10 } from "node:fs";
import path10 from "node:path";
var DEFAULT_MAX_RETAINED = 8;
var DEFAULT_MAX_PARALLEL = 3;
var WorktreePolicyError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "WorktreePolicyError";
    this.code = code;
  }
};
function boundedInteger(value, field, min, max, fallback) {
  if (value === void 0 || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new WorktreePolicyError("WORKTREE_POLICY_INVALID", `${field} deve ser inteiro entre ${min} e ${max}.`);
  }
  return value;
}
var WorktreePolicyStore = class {
  root;
  constructor(root) {
    this.root = root;
  }
  fileFor(repoKey) {
    return path10.join(this.root, "worktree-policy", `${createHash3("sha256").update(repoKey).digest("hex")}.json`);
  }
  /**
   * Records the user's decision to allow worktrees in this repository.
   *
   * A note is mandatory, exactly as releasing a quarantine requires one: an
   * unexplained standing permission to mutate a repository is worth less than
   * no record at all.
   */
  async enrol(input) {
    const note = typeof input.note === "string" ? input.note.trim() : "";
    if (!note) throw new WorktreePolicyError("WORKTREE_POLICY_NOTE_REQUIRED", "Habilitar worktrees exige uma nota dizendo por qu\xEA; a permiss\xE3o fica registrada.");
    let worktreeRoot = null;
    if (input.worktreeRoot !== void 0 && input.worktreeRoot !== null) {
      if (typeof input.worktreeRoot !== "string" || !path10.isAbsolute(input.worktreeRoot)) {
        throw new WorktreePolicyError("WORKTREE_POLICY_INVALID", "worktreeRoot deve ser um caminho absoluto.");
      }
      worktreeRoot = input.worktreeRoot;
    }
    const file = this.fileFor(input.repoKey);
    const record2 = {
      repoKey: input.repoKey,
      canonicalWorkspace: input.canonicalWorkspace,
      enabled: true,
      enabledAt: (/* @__PURE__ */ new Date()).toISOString(),
      enabledBy: input.enabledBy,
      note,
      maxParallelRuns: boundedInteger(input.maxParallelRuns, "maxParallelRuns", 1, 10, DEFAULT_MAX_PARALLEL),
      maxRetainedWorktrees: boundedInteger(input.maxRetainedWorktrees, "maxRetainedWorktrees", 1, 50, DEFAULT_MAX_RETAINED),
      worktreeRoot,
      file
    };
    await fs10.mkdir(path10.dirname(file), { recursive: true });
    await writeFileAtomic(file, JSON.stringify(record2, null, 2));
    return record2;
  }
  async load(repoKey) {
    const read = await readJsonShared(this.fileFor(repoKey));
    return read.status === "ok" && read.value.enabled ? read.value : null;
  }
  /** Fails closed: a repository nobody enrolled cannot be provisioned into. */
  async require(repoKey) {
    const record2 = await this.load(repoKey);
    if (!record2) {
      throw new WorktreePolicyError(
        "WORKTREE_POLICY_REQUIRED",
        'Este reposit\xF3rio ainda n\xE3o foi habilitado para worktrees. Criar um worktree altera o reposit\xF3rio de forma persistente, ent\xE3o exige uma a\xE7\xE3o local do usu\xE1rio: "codeorquestra worktree enable --repo <caminho> --note <motivo>".'
      );
    }
    return record2;
  }
  async revoke(repoKey) {
    await fs10.rm(this.fileFor(repoKey), { force: true });
  }
  async list() {
    const dir = path10.join(this.root, "worktree-policy");
    let names;
    try {
      names = (await fs10.readdir(dir)).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const records = [];
    for (const name of names) {
      const read = await readJsonShared(path10.join(dir, name));
      if (read.status === "ok") records.push(read.value);
    }
    return records.sort((a, b) => a.canonicalWorkspace.localeCompare(b.canonicalWorkspace));
  }
};

// src/trust/trust-store.ts
import { createHash as createHash4 } from "node:crypto";
import { promises as fs11 } from "node:fs";
import path11 from "node:path";
var TrustStoreError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "TrustStoreError";
    this.code = code;
  }
};
var TrustStore = class {
  root;
  constructor(root) {
    this.root = root;
  }
  fileFor(canonicalWorkspace) {
    return path11.join(this.root, "trust", `${createHash4("sha256").update(canonicalWorkspace).digest("hex")}.json`);
  }
  async approve(input) {
    if (input.inventory.incomplete) throw new TrustStoreError("INVENTORY_INCOMPLETE", "O invent\xE1rio est\xE1 incompleto; aprove somente ap\xF3s a descoberta completa.");
    const approvedSet = input.approvedItems === "all" ? null : new Set(input.approvedItems);
    const approvedItems = input.inventory.items.filter((item) => approvedSet === null || approvedSet.has(item.relativePath)).map((item) => ({ relativePath: item.relativePath, sha256: item.sha256, kind: item.kind, scope: item.scope }));
    const mcpServers = {};
    for (const item of approvedItems) {
      if (item.kind !== "mcp") continue;
      const name = item.relativePath.split("#").pop() ?? "";
      if (name && name !== "parse-error") mcpServers[name] = { approved: true, externalMutations: "escalate" };
    }
    const file = this.fileFor(input.inventory.canonicalWorkspace);
    const record2 = {
      canonicalWorkspace: input.inventory.canonicalWorkspace,
      fingerprint: input.inventory.fingerprint,
      identity: input.identity,
      approvalRevision: input.approvalRevision,
      approvedAt: (/* @__PURE__ */ new Date()).toISOString(),
      note: input.approvedRevisionNote ?? null,
      approvedItems,
      mcpServers,
      file
    };
    await fs11.mkdir(path11.dirname(file), { recursive: true });
    await writeFileAtomic(file, JSON.stringify(record2, null, 2));
    return record2;
  }
  async load(canonicalWorkspace) {
    const read = await readJsonShared(this.fileFor(canonicalWorkspace));
    return read.status === "ok" ? read.value : null;
  }
  /**
   * Reuses a parent checkout's approval for a worktree of the same repository.
   *
   * A worktree is a new canonical path, so it has no record of its own and the
   * first parallel run would be refused with WORKSPACE_NOT_TRUSTED — pushing
   * the user to approve without reading anything. Derivation avoids that
   * without weakening the invariant, stated precisely:
   *
   *   no resource executes whose exact content hash the user has not already
   *   approved for this project.
   *
   * So every item in the child must have an identical (relativePath, sha256)
   * among the parent's approved items. One new or changed file and this returns
   * null, falling through to the normal refusal with pending/changed populated.
   * It reuses an approval; it never manufactures one.
   *
   * The child may legitimately be a strict SUBSET — ancestor-scope items the
   * state-root worktree does not have — which is why absence is not a mismatch.
   *
   * Known and deliberate limit: comparison is over bytes, so a repository whose
   * checkout settings rewrite text on checkout (notably `core.autocrlf=true` on
   * Windows, where the worktree gets CRLF while the parent working tree holds
   * LF) produces different hashes for the same instruction file, and derivation
   * refuses. That refusal is correct — the bytes the CLI would load really are
   * different — and the cost is bounded: the worktree path is deterministic per
   * task, so the user approves it once, not once per run. Normalizing line
   * endings before hashing would make trust equality mean something weaker than
   * "these exact bytes", which is not a trade worth making here.
   */
  async deriveFromParent(input) {
    if (input.child.incomplete) return null;
    const parent = await this.load(input.parentCanonicalWorkspace);
    if (!parent) return null;
    const approved = new Map(parent.approvedItems.map((item) => [item.relativePath, item.sha256]));
    for (const item of input.child.items) {
      if (approved.get(item.relativePath) !== item.sha256) return null;
    }
    const file = this.fileFor(input.child.canonicalWorkspace);
    const record2 = {
      canonicalWorkspace: input.child.canonicalWorkspace,
      fingerprint: input.child.fingerprint,
      identity: parent.identity,
      approvalRevision: parent.approvalRevision,
      approvedAt: (/* @__PURE__ */ new Date()).toISOString(),
      note: `Herdado de ${parent.canonicalWorkspace}: todo item bate por hash com uma aprova\xE7\xE3o existente.`,
      approvedItems: input.child.items.map((item) => ({ relativePath: item.relativePath, sha256: item.sha256, kind: item.kind, scope: item.scope })),
      mcpServers: parent.mcpServers,
      file,
      derivedFrom: { canonicalWorkspace: parent.canonicalWorkspace, approvalRevision: parent.approvalRevision, fingerprint: parent.fingerprint }
    };
    await fs11.mkdir(path11.dirname(file), { recursive: true });
    await writeFileAtomic(file, JSON.stringify(record2, null, 2));
    return record2;
  }
  async check(inventory) {
    const all = inventory.items.map((item) => item.relativePath).sort();
    if (inventory.incomplete) return { trusted: false, reason: "INVENTORY_INCOMPLETE", changed: [], pending: all };
    const record2 = await this.load(inventory.canonicalWorkspace);
    if (!record2) {
      if (all.length === 0) return { trusted: true, approvalRevision: null, pending: [], changed: [], reason: "NO_CUSTOMIZATIONS" };
      return { trusted: false, reason: "NOT_APPROVED", changed: [], pending: all };
    }
    if (record2.derivedFrom) {
      const parent = await this.load(record2.derivedFrom.canonicalWorkspace);
      if (!parent || parent.fingerprint !== record2.derivedFrom.fingerprint) {
        return { trusted: false, reason: "NOT_APPROVED", changed: [], pending: all };
      }
    }
    const approved = new Map(record2.approvedItems.map((item) => [item.relativePath, item.sha256]));
    const current = new Map(inventory.items.map((item) => [item.relativePath, item.sha256]));
    const changed = [...current.entries()].filter(([key, hash]) => approved.has(key) && approved.get(key) !== hash).map(([key]) => key);
    for (const key of approved.keys()) if (!current.has(key)) changed.push(key);
    changed.sort();
    const pending = [...current.keys()].filter((key) => !approved.has(key)).sort();
    if (changed.length) return { trusted: false, reason: "FINGERPRINT_CHANGED", changed, pending };
    if (pending.length) return { trusted: false, reason: "PENDING_RESOURCES", changed: [], pending };
    return { trusted: true, approvalRevision: record2.approvalRevision, pending: [], changed: [], reason: "TRUSTED" };
  }
  async revoke(canonicalWorkspace) {
    await fs11.rm(this.fileFor(canonicalWorkspace), { force: true });
  }
};

// src/worker/supervision.ts
var SUPERVISION = {
  inactivityAlertMs: 12e5,
  elapsedAlertMs: 72e5,
  coordinatorAbsentMs: 9e4
};
var COORDINATOR_ABSENT_LABEL = "aguardando coordenador";
function evaluateSupervision(input) {
  const thresholds = input.thresholds ?? SUPERVISION;
  const coordinatorPresence = input.coordinatorLastSeenAt !== null && input.now - input.coordinatorLastSeenAt < thresholds.coordinatorAbsentMs ? "present" : "absent";
  const coordinatorLabel = coordinatorPresence === "absent" ? COORDINATOR_ABSENT_LABEL : null;
  if (input.terminal || input.phase === "terminal") {
    return { state: "terminal", alerts: [], action: "none", coordinatorPresence, coordinatorLabel, requiresReview: false };
  }
  if (input.brokerRestartedDuringRun) {
    return { state: "uncertain", alerts: [], action: "none", coordinatorPresence, coordinatorLabel, requiresReview: true };
  }
  if (!input.processAlive) {
    return { state: "disconnected", alerts: [], action: "none", coordinatorPresence, coordinatorLabel, requiresReview: true };
  }
  const waiting = input.phase === "waiting_permission" || input.phase === "waiting_question" || input.pendingRequests > 0;
  const alerts = [];
  if (!waiting && input.now - input.lastActivityAt >= thresholds.inactivityAlertMs) alerts.push("inactivity_20m");
  if (input.now - input.runStartedAt >= thresholds.elapsedAlertMs) alerts.push("elapsed_2h");
  const state = waiting && input.phase !== "waiting_permission" && input.phase !== "waiting_question" ? "waiting_permission" : input.phase;
  return { state, alerts, action: "none", coordinatorPresence, coordinatorLabel, requiresReview: false };
}

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

// src/usage/claude-usage.ts
function token(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function sanitizeClaudeUsageReport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage2 = value;
  const report = {
    input_tokens: token(usage2.input_tokens ?? usage2.inputTokens ?? usage2.input),
    output_tokens: token(usage2.output_tokens ?? usage2.outputTokens ?? usage2.output),
    cache_read_input_tokens: token(usage2.cache_read_input_tokens ?? usage2.cachedInputTokens ?? usage2.cacheRead),
    cache_creation_input_tokens: token(usage2.cache_creation_input_tokens ?? usage2.cacheWriteInputTokens ?? usage2.cacheWrite)
  };
  return Object.values(report).some((item) => item !== null) ? report : null;
}
function normalizeClaudeUsage(value) {
  const usage2 = sanitizeClaudeUsageReport(value);
  if (!usage2) return null;
  const inputTokens = usage2.input_tokens;
  const outputTokens = usage2.output_tokens;
  const cachedInputTokens = usage2.cache_read_input_tokens;
  const cacheWriteInputTokens = usage2.cache_creation_input_tokens;
  const totalInputTokens = (inputTokens ?? 0) + (cachedInputTokens ?? 0) + (cacheWriteInputTokens ?? 0);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    totalInputTokens,
    totalObservedTokens: totalInputTokens + (outputTokens ?? 0),
    quality: [inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens].every((item) => item !== null) ? "reported" : "partial"
  };
}
function emptyTotal() {
  return { turns: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalInputTokens: 0, totalObservedTokens: 0, partial: false };
}
function add(total, usage2) {
  total.turns += 1;
  total.inputTokens += usage2.inputTokens ?? 0;
  total.outputTokens += usage2.outputTokens ?? 0;
  total.cachedInputTokens += usage2.cachedInputTokens ?? 0;
  total.cacheWriteInputTokens += usage2.cacheWriteInputTokens ?? 0;
  total.totalInputTokens += usage2.totalInputTokens;
  total.totalObservedTokens += usage2.totalObservedTokens;
  total.partial ||= usage2.quality === "partial";
}
var ClaudeUsageAccumulator = class _ClaudeUsageAccumulator {
  seen = /* @__PURE__ */ new Set();
  total = emptyTotal();
  models = /* @__PURE__ */ new Map();
  lastObservedAt = null;
  static fromEvents(events) {
    const accumulator = new _ClaudeUsageAccumulator();
    for (const event of events) accumulator.addEvent(event);
    return accumulator;
  }
  addEvent(event) {
    if (!["turn_completed", "turn_interrupted", "turn_failed"].includes(event.type)) return false;
    const turn = token(event.data.turn);
    if (turn === null) return false;
    const key = `${event.runId}:${turn}`;
    if (this.seen.has(key)) return false;
    const usage2 = normalizeClaudeUsage(event.data.usage ?? event.data.tokens);
    if (!usage2) return false;
    this.seen.add(key);
    const model = typeof event.data.model === "string" && event.data.model.trim() ? event.data.model.trim() : "desconhecido";
    add(this.total, usage2);
    const modelTotal = this.models.get(model) ?? emptyTotal();
    add(modelTotal, usage2);
    this.models.set(model, modelTotal);
    this.lastObservedAt = event.ts;
    return true;
  }
  snapshot(observedAt = this.lastObservedAt) {
    const quality = this.total.turns === 0 ? "unavailable" : this.total.partial ? "partial" : "reported";
    return {
      quality,
      observedAt: this.total.turns === 0 ? null : observedAt,
      turns: this.total.turns,
      inputTokens: this.total.inputTokens,
      outputTokens: this.total.outputTokens,
      cachedInputTokens: this.total.cachedInputTokens,
      cacheWriteInputTokens: this.total.cacheWriteInputTokens,
      totalInputTokens: this.total.totalInputTokens,
      totalObservedTokens: this.total.totalObservedTokens,
      byModel: [...this.models.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([model, total]) => ({
        model,
        turns: total.turns,
        inputTokens: total.inputTokens,
        outputTokens: total.outputTokens,
        cachedInputTokens: total.cachedInputTokens,
        cacheWriteInputTokens: total.cacheWriteInputTokens,
        totalInputTokens: total.totalInputTokens,
        totalObservedTokens: total.totalObservedTokens,
        quality: total.partial ? "partial" : "reported"
      }))
    };
  }
};

// src/usage/codex-usage.ts
import { spawn as spawn4 } from "node:child_process";
import readline2 from "node:readline";
function integer(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function boundedText(value, max = 80) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
}
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function unavailableCodexUsage(code = null, queriedAt = null) {
  return {
    quality: "unavailable",
    queriedAt,
    limits: { quality: "unavailable", buckets: [] },
    activity: { quality: "unavailable", lifetimeTokens: null, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null, daily: [] },
    task: { quality: "unavailable", groups: [] },
    failure: code ? { code } : null
  };
}
function window(value) {
  const item = record(value);
  const used = integer(item?.usedPercent);
  if (used === null) return null;
  const usedPercent = Math.min(100, used);
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowDurationMins: integer(item?.windowDurationMins),
    resetsAt: integer(item?.resetsAt)
  };
}
function limits(value) {
  const response = record(value);
  const multiple = record(response?.rateLimitsByLimitId);
  const candidates = multiple && Object.keys(multiple).length ? Object.entries(multiple).slice(0, 16) : [["codex", response?.rateLimits]];
  const buckets = candidates.flatMap(([fallbackId, raw]) => {
    const item = record(raw);
    if (!item) return [];
    const primary = window(item.primary);
    const secondary = window(item.secondary);
    if (!primary && !secondary) return [];
    return [{
      id: boundedText(item.limitId) ?? fallbackId.slice(0, 80),
      name: boundedText(item.limitName),
      planType: boundedText(item.planType),
      primary,
      secondary
    }];
  });
  return { quality: buckets.length ? "reported" : "unavailable", buckets };
}
function activity(value) {
  const response = record(value);
  const summary = record(response?.summary);
  const daily = Array.isArray(response?.dailyUsageBuckets) ? response.dailyUsageBuckets.slice(0, 400).flatMap((raw) => {
    const item = record(raw);
    const startDate = boundedText(item?.startDate, 20);
    const tokens = integer(item?.tokens);
    return startDate && tokens !== null ? [{ startDate, tokens }] : [];
  }) : [];
  const result = {
    quality: "unavailable",
    lifetimeTokens: integer(summary?.lifetimeTokens),
    peakDailyTokens: integer(summary?.peakDailyTokens),
    longestRunningTurnSec: integer(summary?.longestRunningTurnSec),
    currentStreakDays: integer(summary?.currentStreakDays),
    longestStreakDays: integer(summary?.longestStreakDays),
    daily
  };
  const fields = [result.lifetimeTokens, result.peakDailyTokens, result.longestRunningTurnSec, result.currentStreakDays, result.longestStreakDays];
  if (fields.some((item) => item !== null) || daily.length) result.quality = fields.every((item) => item !== null) ? "reported" : "partial";
  return result;
}
function taskUsage(value) {
  const response = record(value);
  const usage2 = record(response?.threadUsage);
  if (!usage2 || !Array.isArray(usage2.groups)) return { quality: "unavailable", groups: [] };
  const groups = usage2.groups.slice(0, 32).flatMap((raw) => {
    const item = record(raw);
    if (!item) return [];
    return [{
      model: boundedText(item.model),
      reasoningEffort: boundedText(item.reasoningEffort),
      inputTokens: integer(item.inputTokens),
      cachedInputTokens: integer(item.cachedInputTokens),
      netNewInputTokens: integer(item.netNewInputTokens),
      outputTokens: integer(item.outputTokens),
      totalTokens: integer(item.totalTokens)
    }];
  });
  if (!groups.length) return { quality: "unavailable", groups: [] };
  const complete = groups.every((group) => group.inputTokens !== null && group.outputTokens !== null && group.totalTokens !== null);
  return { quality: complete ? "estimated" : "partial", groups };
}
var CodexUsageService = class {
  command;
  args;
  minRefreshMs;
  requestTimeoutMs;
  child = null;
  ready = null;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  cache = /* @__PURE__ */ new Map();
  refreshes = /* @__PURE__ */ new Map();
  constructor(options = {}) {
    this.command = options.command ?? "codex";
    this.args = options.args ?? ["app-server", "--listen", "stdio://"];
    this.minRefreshMs = Math.max(0, options.minRefreshMs ?? 3e4);
    this.requestTimeoutMs = Math.max(100, options.requestTimeoutMs ?? 5e3);
  }
  async refresh(threadId, options = {}) {
    const key = threadId ?? "";
    const cached = this.cache.get(key);
    if (!options.force && cached && Date.now() - cached.at < this.minRefreshMs) return cached.value;
    const active = this.refreshes.get(key);
    if (active) return active;
    const refresh = this.read(threadId).finally(() => this.refreshes.delete(key));
    this.refreshes.set(key, refresh);
    return refresh;
  }
  async read(threadId) {
    try {
      await this.ensureReady();
      const [rateRead, activityRead, taskRead] = await Promise.all([
        this.request("account/rateLimits/read", null).then((value2) => ({ ok: true, value: value2 }), () => ({ ok: false, value: null })),
        this.request("account/usage/read", null).then((value2) => ({ ok: true, value: value2 }), () => ({ ok: false, value: null })),
        threadId ? this.request("account/usage/read", { threadId }).then((value2) => ({ ok: true, value: value2 }), () => ({ ok: false, value: null })) : Promise.resolve({ ok: true, value: null })
      ]);
      const limitView = rateRead.ok ? limits(rateRead.value) : { quality: "unavailable", buckets: [] };
      const activityView = activityRead.ok ? activity(activityRead.value) : unavailableCodexUsage().activity;
      const taskView = threadId && taskRead.ok ? taskUsage(taskRead.value) : { quality: "unavailable", groups: [] };
      const qualities = [limitView.quality, activityView.quality, taskView.quality];
      const quality = qualities.every((item) => item === "reported" || item === "estimated") ? "reported" : qualities.some((item) => item !== "unavailable") ? "partial" : "unavailable";
      const value = {
        quality,
        queriedAt: (/* @__PURE__ */ new Date()).toISOString(),
        limits: limitView,
        activity: activityView,
        task: taskView,
        failure: [rateRead, activityRead, taskRead].some((item) => !item.ok) ? { code: quality === "unavailable" ? "CODEX_USAGE_UNAVAILABLE" : "CODEX_USAGE_PARTIAL" } : null
      };
      this.cache.set(threadId ?? "", { at: Date.now(), value });
      return value;
    } catch (error) {
      const code = error instanceof Error && error.message.startsWith("CODEX_USAGE_") ? error.message.split(":", 1)[0] ?? "CODEX_USAGE_UNAVAILABLE" : "CODEX_USAGE_UNAVAILABLE";
      const value = unavailableCodexUsage(code, (/* @__PURE__ */ new Date()).toISOString());
      this.cache.set(threadId ?? "", { at: Date.now(), value });
      return value;
    }
  }
  ensureReady() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const child = spawn4(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      this.child = child;
      child.stderr.resume();
      const reader = readline2.createInterface({ input: child.stdout, crlfDelay: Infinity });
      reader.on("line", (line) => this.onLine(line));
      const fail = (code) => {
        const error = new Error(code);
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
        this.child = null;
        this.ready = null;
        reject(error);
      };
      child.once("error", () => fail("CODEX_USAGE_START_FAILED"));
      child.once("exit", () => fail("CODEX_USAGE_APP_SERVER_EXITED"));
      this.request("initialize", { clientInfo: { name: "codeorquestra", title: "CodeOrquestra", version: "0.1.0" }, capabilities: null }, child).then(() => resolve(), () => {
        this.breakConnection("CODEX_USAGE_INITIALIZE_FAILED");
        reject(new Error("CODEX_USAGE_INITIALIZE_FAILED"));
      });
    });
    return this.ready;
  }
  request(method, params, child = this.child) {
    if (!child?.stdin.writable) return Promise.reject(new Error("CODEX_USAGE_NOT_CONNECTED"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CODEX_USAGE_REQUEST_TIMEOUT"));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}
`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new Error("CODEX_USAGE_WRITE_FAILED"));
      });
    });
  }
  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.breakConnection("CODEX_USAGE_INVALID_RESPONSE");
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error("CODEX_USAGE_REQUEST_REJECTED"));
    else pending.resolve(message.result);
  }
  breakConnection(code) {
    const error = new Error(code);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }
  async stop() {
    const child = this.child;
    this.child = null;
    this.ready = null;
    this.cache.clear();
    this.breakConnection("CODEX_USAGE_STOPPED");
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2e3);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }
};

// src/broker/runtime-paths.ts
import { promises as fs12, existsSync, readFileSync } from "node:fs";
import os3 from "node:os";
import path12 from "node:path";
import { fileURLToPath } from "node:url";
var here = fileURLToPath(import.meta.url);
var SOURCE_MODE = here.endsWith(".ts");
var RUNTIME_BASE = SOURCE_MODE ? path12.resolve(path12.dirname(here), "..", "..") : path12.dirname(here);
function workerEntry() {
  return readEnv("WORKER_ENTRY") ?? (SOURCE_MODE ? path12.join(RUNTIME_BASE, "src", "worker", "main.ts") : path12.join(RUNTIME_BASE, "worker.mjs"));
}
function cliEntry() {
  return SOURCE_MODE ? path12.join(RUNTIME_BASE, "src", "cli", "main.ts") : path12.join(RUNTIME_BASE, "codeorquestra.mjs");
}
function nodeExecArgv() {
  return SOURCE_MODE ? ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"] : [];
}
function dashboardDir() {
  const candidates = [
    readEnv("DASHBOARD_DIR"),
    SOURCE_MODE ? path12.join(RUNTIME_BASE, "dist", "dashboard") : path12.join(RUNTIME_BASE, "dashboard")
  ].filter((candidate) => Boolean(candidate));
  for (const candidate of candidates) if (existsSync(path12.join(candidate, "index.html"))) return candidate;
  return null;
}
function defaultStateRoot() {
  const base = process.platform === "win32" ? process.env.LOCALAPPDATA ?? path12.join(os3.homedir(), "AppData", "Local") : path12.join(os3.homedir(), ".local", "state");
  return path12.join(base, "CodexClaudeLive", "v2");
}
function engineInfo() {
  return { runtimeVersion: RUNTIME_VERSION, productName: BRAND.name };
}
async function findClaudeLauncher(env = process.env) {
  const override = readEnv("TEST_CLI", env) ?? readEnv("CLAUDE_LAUNCHER", env);
  if (override) return override;
  const names = process.platform === "win32" ? ["claude.ps1", "claude.cmd", "claude.exe", "claude"] : ["claude"];
  for (const dir of (env.PATH ?? "").split(path12.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path12.join(dir, name);
      try {
        await fs12.access(candidate);
        return candidate;
      } catch {
      }
    }
  }
  return null;
}

// src/quota/usage-parser.ts
var UsageError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "UsageError";
    this.code = code;
  }
};
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function readLimit(text, label) {
  const pattern = new RegExp(`^${escapeRegExp(label)}:\\s*(\\d{1,3})% used.*?resets\\s+(.+)$`, "im");
  const match = pattern.exec(text);
  if (!match) throw new UsageError("USAGE_FORMAT_UNEXPECTED", `Campo de uso n\xE3o encontrado: ${label}`);
  const used = Number(match[1]);
  if (!Number.isInteger(used) || used < 0 || used > 100) throw new UsageError("USAGE_FORMAT_UNEXPECTED", `Percentual inv\xE1lido: ${label}`);
  return { usedPercent: used, remainingPercent: 100 - used, resets: match[2].trim() };
}
function parseUsageText(text, observedAt) {
  const session = readLimit(text, "Current session");
  const allModels = readLimit(text, "Current week (all models)");
  const fable = readLimit(text, "Current week (Fable)");
  const minimum = Math.min(session.remainingPercent, allModels.remainingPercent, fable.remainingPercent);
  const alertLevel = minimum <= 5 ? "critical" : minimum <= 20 ? "warning" : "ok";
  return { session, allModels, fable, alertLevel, observedAt };
}
function evaluateQuotaRecommendation(input) {
  const thresholdPercent = input.thresholdPercent ?? 3;
  if (!input.usage) {
    return {
      recommendation: "unknown",
      alternate: null,
      blocking: false,
      thresholdPercent,
      effectiveRemainingPercent: null,
      observedAt: null,
      ...input.failure ? { failure: input.failure } : {}
    };
  }
  const shared = Math.min(input.usage.session.remainingPercent, input.usage.allModels.remainingPercent);
  if (shared <= thresholdPercent) {
    return { recommendation: "shared_limit", alternate: null, blocking: false, thresholdPercent, effectiveRemainingPercent: shared, observedAt: input.usage.observedAt };
  }
  if (input.requestedModel === "claude-fable-5-1") {
    const effective = Math.min(shared, input.usage.fable.remainingPercent);
    if (effective <= thresholdPercent) {
      return { recommendation: "consider_alternate", alternate: "claude-opus-5", blocking: false, thresholdPercent, effectiveRemainingPercent: effective, observedAt: input.usage.observedAt };
    }
    return { recommendation: "ok", alternate: null, blocking: false, thresholdPercent, effectiveRemainingPercent: effective, observedAt: input.usage.observedAt };
  }
  return { recommendation: "ok", alternate: null, blocking: false, thresholdPercent, effectiveRemainingPercent: shared, observedAt: input.usage.observedAt };
}

// src/broker/quota-service.ts
var QuotaService = class {
  last = null;
  inFlight = null;
  waitMs;
  constructor(options = {}) {
    this.waitMs = options.waitMs ?? 3e4;
  }
  get lastObservation() {
    return this.last;
  }
  async observe(executable) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const attemptedAt = (/* @__PURE__ */ new Date()).toISOString();
      if (!executable) {
        const observation = { attemptedAt, observedAt: null, snapshot: null, failure: { code: "CLI_NOT_RESOLVED", attemptedAt } };
        this.last = observation;
        return observation;
      }
      try {
        const outcome = await withGlobalQuotaMutex(() => queryUsageText(executable), { waitMs: this.waitMs });
        const observedAt = (/* @__PURE__ */ new Date()).toISOString();
        const snapshot = parseUsageText(outcome.value, observedAt);
        const observation = { attemptedAt: outcome.attemptedAt, observedAt, snapshot, failure: null };
        this.last = observation;
        return observation;
      } catch (error) {
        const code = error.code ?? "USAGE_QUERY_FAILED";
        const observation = { attemptedAt, observedAt: null, snapshot: null, failure: { code, attemptedAt } };
        this.last = observation;
        return observation;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }
  view(requestedModel, observation = this.last) {
    if (!observation) return { observedAt: null, attemptedAt: null, recommendation: "unknown", alternate: null, snapshot: null, failure: null };
    const recommendation = evaluateQuotaRecommendation({ usage: observation.snapshot, requestedModel, ...observation.failure ? { failure: observation.failure } : {} });
    return {
      observedAt: observation.observedAt,
      attemptedAt: observation.attemptedAt,
      recommendation: recommendation.recommendation,
      alternate: recommendation.alternate,
      snapshot: observation.snapshot ? { session: observation.snapshot.session, allModels: observation.snapshot.allModels, fable: observation.snapshot.fable, alertLevel: observation.snapshot.alertLevel } : null,
      failure: observation.failure
    };
  }
};

// src/broker/process-tree.ts
import { spawn as spawn6 } from "node:child_process";
import { closeSync, openSync, statSync, unlinkSync, utimesSync, writeFileSync, readFileSync as readFileSync2, mkdirSync } from "node:fs";
import { promises as fs14 } from "node:fs";
import path13 from "node:path";

// src/broker/process-identity.ts
import { spawn as spawn5 } from "node:child_process";
import { promises as fs13 } from "node:fs";
var PROBE_TIMEOUT_MS = 1e4;
function runCapture(command, args, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn5(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
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
    raw = await fs13.readFile(`/proc/${pid}/stat`, "utf8");
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
function parsePipeTable(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const [pid, ppid, createdAt] = line.trim().split("|");
    const parsedPid = Number(pid);
    const parsedPpid = Number(ppid);
    if (!Number.isInteger(parsedPid) || !Number.isInteger(parsedPpid)) continue;
    rows.push({ pid: parsedPid, ppid: parsedPpid, createdAt: createdAt && createdAt.length > 0 ? createdAt : null });
  }
  return rows;
}
async function linuxProcessTable() {
  let names;
  try {
    names = await fs13.readdir("/proc");
  } catch {
    return null;
  }
  const rows = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const raw = await fs13.readFile(`/proc/${name}/stat`, "utf8");
      const close = raw.lastIndexOf(")");
      if (close < 0) continue;
      const fields = raw.slice(close + 2).split(" ");
      const ppid = Number(fields[1]);
      const starttime = fields[19];
      if (!Number.isInteger(ppid)) continue;
      rows.push({ pid: Number(name), ppid, createdAt: starttime && /^\d+$/.test(starttime) ? starttime : null });
    } catch {
    }
  }
  return rows;
}
async function listProcessTable() {
  if (process.platform === "win32") {
    for (const shell of ["pwsh", "powershell"]) {
      const outcome2 = await runCapture(shell, ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_TABLE_SCRIPT], 3e4);
      if (outcome2 === null || outcome2.code !== 0 || outcome2.stdout.length === 0) continue;
      return parsePipeTable(outcome2.stdout);
    }
    return null;
  }
  if (process.platform === "linux") return linuxProcessTable();
  const outcome = await runCapture("ps", ["-eo", "pid=,ppid=,lstart="]);
  if (outcome === null || outcome.code !== 0) return null;
  const rows = [];
  for (const line of outcome.stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), createdAt: match[3].trim() || null });
  }
  return rows;
}
function collectDescendants(table, rootPid, rootCreatedAt) {
  const byParent = /* @__PURE__ */ new Map();
  for (const entry of table) {
    if (entry.pid === entry.ppid) continue;
    const list = byParent.get(entry.ppid);
    if (list) list.push(entry);
    else byParent.set(entry.ppid, [entry]);
  }
  const found = [];
  const seen = /* @__PURE__ */ new Set([rootPid]);
  const queue = [{ pid: rootPid, createdAt: rootCreatedAt }];
  while (queue.length) {
    const current = queue.shift();
    for (const child of byParent.get(current.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      if (current.createdAt && child.createdAt && child.createdAt < current.createdAt) continue;
      seen.add(child.pid);
      found.push(child);
      queue.push({ pid: child.pid, createdAt: child.createdAt });
    }
  }
  return found;
}
async function verifyProcessIdentity(pid, recorded) {
  const observed = await readProcessCreationIdentity(pid);
  if (observed === "") return "gone";
  if (observed === null) return "unknown";
  if (!recorded) return "unknown";
  return observed === recorded ? "same" : "recycled";
}

// src/broker/process-tree.ts
function holdFileFor(runDir) {
  return path13.join(runDir, "worker.hold");
}
function identityFileFor(runDir) {
  return path13.join(runDir, "worker-identity.json");
}
function readWorkerIdentity(runDir) {
  try {
    const parsed = JSON.parse(readFileSync2(identityFileFor(runDir), "utf8"));
    return typeof parsed.pid === "number" && typeof parsed.token === "string" ? parsed : null;
  } catch {
    return null;
  }
}
function isAlive2(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
async function verifyWorkerLiveness(runDir, expected) {
  let holdExists = true;
  try {
    statSync(holdFileFor(runDir));
  } catch (error) {
    if (error.code !== "ENOENT") return expected ? "unknown" : "gone";
    holdExists = false;
  }
  if (!holdExists) return "gone";
  if (!expected) return "unknown";
  const verdict = await verifyProcessIdentity(expected.pid, expected.createdAt);
  if (verdict === "same") return "alive";
  if (verdict === "unknown") return "unknown";
  return "gone";
}
function terminateTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      const killer = spawn6("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      const timer = setTimeout(() => {
        killer.kill();
        resolve();
      }, 1e4);
      killer.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      killer.on("error", () => {
        clearTimeout(timer);
        resolve();
      });
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
      }
    }
    resolve();
  });
}
function waitForExit(pid, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (!isAlive2(pid)) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}
function engineFileFor(runDir) {
  return path13.join(runDir, "engine.json");
}
function readEngineProcess(runDir) {
  try {
    const parsed = JSON.parse(readFileSync2(engineFileFor(runDir), "utf8"));
    return typeof parsed.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}
var PROVEN = /* @__PURE__ */ new Set(["absent-clean", "terminated"]);
async function liveDescendants(pid, createdAt) {
  const table = await listProcessTable();
  if (table === null) return null;
  return collectDescendants(table, pid, createdAt).map((entry) => entry.pid);
}
async function clearDescendants(pid, createdAt) {
  const first = await liveDescendants(pid, createdAt);
  if (first === null) return { remaining: [], proven: false, observed: 0 };
  if (first.length === 0) return { remaining: [], proven: true, observed: 0 };
  for (const descendant of first) {
    await terminateTree(descendant);
    await waitForExit(descendant, 5e3);
  }
  const second = await liveDescendants(pid, createdAt);
  if (second === null) return { remaining: [], proven: false, observed: first.length };
  return { remaining: second, proven: true, observed: first.length };
}
async function settleTarget(name, pid, recordedCreatedAt) {
  const identity = await verifyProcessIdentity(pid, recordedCreatedAt);
  if (identity === "gone" || identity === "recycled") {
    return { name, pid, outcome: "absent-unproven", identity };
  }
  if (identity === "unknown") return { name, pid, outcome: "unverified", identity };
  await terminateTree(pid);
  const exited = await waitForExit(pid, 5e3);
  if (!exited) return { name, pid, outcome: "surviving", identity };
  const tree = await clearDescendants(pid, recordedCreatedAt);
  if (!tree.proven) return { name, pid, outcome: "unverified", identity, descendants: [] };
  if (tree.remaining.length) return { name, pid, outcome: "surviving", identity, descendants: tree.remaining };
  return { name, pid, outcome: "terminated", identity };
}
async function settleExitedTarget(name, pid, createdAt, abnormal = false) {
  const identity = await verifyProcessIdentity(pid, createdAt);
  if (identity === "unknown" || identity === "same") {
    return { name, pid, outcome: "unverified", identity };
  }
  if (identity === "recycled") {
    return { name, pid, outcome: "absent-unproven", identity };
  }
  if (process.platform !== "win32") {
    return { name, pid, outcome: "absent-unproven", identity };
  }
  const tree = await clearDescendants(pid, createdAt);
  if (!tree.proven) {
    return { name, pid, outcome: "unverified", identity, descendants: [] };
  }
  if (tree.remaining.length) return { name, pid, outcome: "surviving", identity, descendants: tree.remaining };
  if (abnormal && tree.observed === 0) {
    return { name, pid, outcome: "absent-unproven", identity };
  }
  return { name, pid, outcome: "absent-clean", identity };
}
async function reconcileRunProcesses(runDir, workerPid, strictRecovery = false) {
  const targets = [];
  const holdReleased = await fs14.access(holdFileFor(runDir)).then(() => false, () => true);
  const workerCreatedAt = readWorkerIdentity(runDir)?.createdAt;
  if (workerPid !== null) {
    if (holdReleased) targets.push(await settleExitedTarget("worker", workerPid, workerCreatedAt));
    else targets.push(await settleTarget("worker", workerPid, workerCreatedAt));
  }
  const engine = readEngineProcess(runDir);
  if (engine) {
    if (engine.exitedAt) targets.push(await settleExitedTarget("engine", engine.pid, engine.createdAt, engine.exitSignal !== null || engine.exitCode === null || engine.exitCode !== 0));
    else targets.push(await settleTarget("engine", engine.pid, engine.createdAt));
  }
  if (strictRecovery && process.platform === "win32") {
    for (const target of targets) {
      if (PROVEN.has(target.outcome)) target.outcome = "absent-unproven";
    }
  }
  const survivingPids = targets.filter((target) => target.outcome === "surviving").map((target) => target.pid);
  const unverifiedPids = targets.filter((target) => target.outcome === "unverified").map((target) => target.pid);
  const unproven = targets.filter((target) => target.outcome === "absent-unproven");
  const clean = targets.every((target) => PROVEN.has(target.outcome));
  if (clean) return { clean, survivingPids, unverifiedPids, targets, note: "A sess\xE3o terminou cooperativamente e nenhum sobrevivente continua vis\xEDvel na \xE1rvore ainda atribu\xEDvel." };
  const reasons = [];
  const remainingDescendants = targets.flatMap((target) => target.descendants ?? []);
  if (survivingPids.length) reasons.push(`processos ainda ativos (${survivingPids.join(", ")})`);
  if (remainingDescendants.length) reasons.push(`descendentes que sobreviveram ao encerramento (${remainingDescendants.join(", ")})`);
  if (unverifiedPids.length) reasons.push(`processos ativos sem identidade comprovada, n\xE3o encerrados (${unverifiedPids.join(", ")})`);
  if (unproven.length) reasons.push(`${unproven.map((target) => `${target.name}/${target.pid}`).join(", ")} desapareceu sem registrar t\xE9rmino, ent\xE3o descendentes \xF3rf\xE3os n\xE3o podem ser descartados`);
  return {
    clean,
    survivingPids,
    unverifiedPids,
    targets,
    note: `A trava do checkout permanece em quarentena: ${reasons.join("; ")}.`
  };
}
async function survivorCheck(runDir, workerPid) {
  const live = /* @__PURE__ */ new Set();
  const engine = readEngineProcess(runDir);
  const candidates = [];
  if (workerPid !== null) candidates.push({ pid: workerPid, createdAt: readWorkerIdentity(runDir)?.createdAt });
  if (engine) candidates.push({ pid: engine.pid, createdAt: engine.createdAt });
  let unproven = false;
  for (const candidate of candidates) {
    const identity = await verifyProcessIdentity(candidate.pid, candidate.createdAt);
    if (identity === "unknown") {
      live.add(candidate.pid);
      continue;
    }
    if (identity === "recycled") {
      unproven = true;
      continue;
    }
    if (identity === "gone" && process.platform !== "win32") {
      unproven = true;
      continue;
    }
    if (identity === "same") live.add(candidate.pid);
    const descendants = await liveDescendants(candidate.pid, candidate.createdAt);
    if (descendants === null) unproven = true;
    else for (const pid of descendants) live.add(pid);
  }
  const livePids = [...live];
  if (livePids.length === 0 && !unproven) {
    return { releasable: true, livePids: [], note: "Nenhum sobrevivente est\xE1 vis\xEDvel entre os processos registrados e a \xE1rvore ainda atribu\xEDvel; a ancestralidade hist\xF3rica pode ser inconclusiva." };
  }
  if (livePids.length === 0) {
    return { releasable: false, livePids: [], note: "N\xE3o foi poss\xEDvel enumerar os processos desta m\xE1quina para descartar descendentes \xF3rf\xE3os; a posse do checkout n\xE3o \xE9 liberada sem essa prova." };
  }
  return { releasable: false, livePids, note: `Ainda h\xE1 processos desta execu\xE7\xE3o em atividade (${livePids.join(", ")}); a posse do checkout n\xE3o \xE9 liberada enquanto um sobrevivente for poss\xEDvel.` };
}

// src/broker/task-manager.ts
var WORKER_END_GRACE_MS = 15e3;
var MODEL_CHANGE_TIMEOUT_MS = isHarness() ? 1e3 : 3e4;
var PREPARATION_DRAIN_MS = 2e4;
var TaskManager = class {
  stateRoot;
  tasks = /* @__PURE__ */ new Map();
  trustStore;
  worktreePolicy;
  quota;
  codexUsage;
  locks = /* @__PURE__ */ new Map();
  options;
  globalSeq = 0;
  appendChain = Promise.resolve();
  supervisionTimer = null;
  derivedTimer = null;
  launcherPath = null;
  probeCache = null;
  stopping = false;
  /** Preparations in flight; shutdown awaits them before sweeping workers. */
  preparations = /* @__PURE__ */ new Set();
  /** True once shutdown began: no further run may be admitted. */
  get isStopping() {
    return this.stopping;
  }
  constructor(options) {
    this.options = options;
    this.stateRoot = options.stateRoot;
    this.trustStore = new TrustStore(options.stateRoot);
    this.worktreePolicy = new WorktreePolicyStore(options.stateRoot);
    this.quota = new QuotaService({ waitMs: options.quotaWaitMs ?? 3e4 });
    this.codexUsage = options.codexUsage ?? (options.harness ? {
      refresh: async () => unavailableCodexUsage("CODEX_USAGE_DISABLED_IN_HARNESS", (/* @__PURE__ */ new Date()).toISOString()),
      stop: async () => void 0
    } : new CodexUsageService());
  }
  get thresholds() {
    return this.options.supervision ?? SUPERVISION;
  }
  tasksDir() {
    return path14.join(this.stateRoot, "tasks");
  }
  locksDir() {
    return path14.join(this.stateRoot, "locks");
  }
  async start() {
    await fs15.mkdir(this.tasksDir(), { recursive: true });
    this.assertOperational();
    await fs15.mkdir(this.locksDir(), { recursive: true });
    this.assertOperational();
    this.launcherPath = await findClaudeLauncher();
    this.assertOperational();
    await this.recover();
    this.assertOperational();
    this.supervisionTimer = setInterval(() => this.superviseAll(), 1e3);
    this.supervisionTimer.unref();
    this.derivedTimer = setInterval(() => void this.flushDerived(), 1e3);
    this.derivedTimer.unref();
  }
  /**
   * Stops workers without pretending their runs finished: in-flight runs stay
   * RUNNING on disk so the next broker start reconciles them as uncertain and
   * requires review before anything is resumed or replayed.
   */
  /**
   * Stops accepting new work and settles everything already in flight.
   *
   * The order matters. `stopping` is set first so no further run is admitted,
   * then the preparations already running are awaited: each one is about to
   * spawn a worker, and sweeping workers before they finish would leave a
   * process created after the sweep, owning a checkout nobody is watching.
   * Only then are workers terminated and the logs closed.
   */
  async stop() {
    this.stopping = true;
    if (this.supervisionTimer) clearInterval(this.supervisionTimer);
    if (this.derivedTimer) clearInterval(this.derivedTimer);
    await this.codexUsage.stop();
    await Promise.allSettled([...this.tasks.values()].flatMap((task) => task.usageRefresh ? [task.usageRefresh] : []));
    await this.settlePreparations();
    for (const task of this.tasks.values()) {
      if (task.run && !task.run.finalized) {
        await this.append(task, task.run.runId, "broker_stopping", { note: "O broker est\xE1 encerrando com trabalho em andamento; a execu\xE7\xE3o ser\xE1 revisada como incerta no pr\xF3ximo in\xEDcio." }).catch(() => void 0);
      }
      if (task.worker?.pid) await terminateTree(task.worker.pid);
      await task.log.close();
    }
  }
  /** Awaits every in-flight preparation, bounded so a hung stage cannot wedge shutdown. */
  async settlePreparations() {
    const deadline = Date.now() + PREPARATION_DRAIN_MS;
    while (this.preparations.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...this.preparations]),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 250);
          timer.unref();
        })
      ]);
    }
    if (this.preparations.size > 0) {
      this.options.log(`broker encerrando com ${this.preparations.size} prepara\xE7\xE3o(\xF5es) ainda ativa(s); os workers criados ser\xE3o reconciliados no pr\xF3ximo in\xEDcio.`);
    }
  }
  // ---------------------------------------------------------------- recovery
  assertOperational() {
    if (this.stopping) throw new Error("BROKER_STOPPED_DURING_RECOVERY");
  }
  async recover() {
    this.assertOperational();
    let entries = [];
    try {
      entries = await fs15.readdir(this.tasksDir());
      this.assertOperational();
    } catch {
      entries = [];
    }
    const opened = [];
    for (const taskId of entries) {
      this.assertOperational();
      const dir = path14.join(this.tasksDir(), taskId);
      const record2 = await readJsonShared(path14.join(dir, "task.json"));
      this.assertOperational();
      if (record2.status !== "ok") continue;
      opened.push(await this.openTask(normalizeRecord(record2.value), dir));
      this.assertOperational();
    }
    for (const task of opened) {
      this.assertOperational();
      const tail = await task.log.readPage(Math.max(0, task.log.lastSeq - 1), 5);
      this.assertOperational();
      for (const event of tail.events) if ((event.gseq ?? 0) > this.globalSeq) this.globalSeq = event.gseq ?? 0;
    }
    if (this.options.harness && this.options.recoveryCheckpoint) {
      await this.options.recoveryCheckpoint();
      this.assertOperational();
    }
    for (const task of opened) {
      this.assertOperational();
      const current = await readJsonShared(path14.join(task.dir, "current-run.json"));
      this.assertOperational();
      if (current.status !== "ok") continue;
      if (current.value.status !== "RUNNING" && current.value.status !== "STARTING") continue;
      const runDir = current.value.runDir || path14.join(task.dir, "runs", current.value.runId);
      const identity = readWorkerIdentity(runDir);
      const verdict = await verifyWorkerLiveness(runDir, identity);
      this.assertOperational();
      const ownWorker = verdict === "alive" && identity && identity.token === current.value.runToken;
      const reconciliation = await reconcileRunProcesses(runDir, ownWorker ? identity.pid : null, true);
      this.assertOperational();
      const terminated = reconciliation.clean;
      let quarantineNote = reconciliation.clean ? null : reconciliation.note;
      if (verdict === "unknown") {
        quarantineNote = `A identidade do worker anterior n\xE3o p\xF4de ser comprovada; nenhum processo foi encerrado por suposi\xE7\xE3o. ${reconciliation.note}`;
      }
      task.uncertain = true;
      task.record.requiresReview = true;
      task.record.reviewReason = "A execu\xE7\xE3o anterior ficou incerta ap\xF3s rein\xEDcio do broker.";
      await this.persistRecord(task);
      this.assertOperational();
      for (const entry of task.queue) if (entry.state === "queued") entry.state = "requires_review";
      await this.persistQueue(task);
      this.assertOperational();
      await this.append(task, current.value.runId, "broker_recovered", {
        uncertainRuns: 1,
        previousWorkerPid: identity?.pid ?? current.value.workerPid,
        workerLiveness: verdict,
        terminated,
        reconciledTargets: reconciliation.targets.map((target) => ({ name: target.name, outcome: target.outcome, identity: target.identity })),
        quarantineNote,
        note: "O broker reiniciou com trabalho em andamento; revise antes de retomar. Mensagens na fila n\xE3o s\xE3o reenviadas automaticamente."
      });
      this.assertOperational();
      if (current.value.writerLockKey && quarantineNote) {
        const lock = {
          workspaceKey: current.value.writerLockKey,
          workspace: current.value.workspace,
          holderTaskId: task.record.taskId,
          holderRunId: current.value.runId,
          holderPid: identity?.pid ?? null,
          acquiredAt: current.value.startedAt,
          quarantined: true,
          quarantineNote
        };
        this.locks.set(lock.workspaceKey, lock);
        await writeFileAtomic(path14.join(this.locksDir(), `${lock.workspaceKey}.json`), JSON.stringify(lock, null, 2));
        this.assertOperational();
      }
      await this.writeCurrentRunBestEffort(task, { ...current.value, status: "UNCERTAIN", workerPid: null });
      this.assertOperational();
      await this.writeDerivedNow(task, current.value.runId, false);
      this.assertOperational();
    }
    let lockFiles = [];
    try {
      lockFiles = await fs15.readdir(this.locksDir());
      this.assertOperational();
    } catch {
      lockFiles = [];
    }
    for (const file of lockFiles) {
      this.assertOperational();
      const key = file.replace(/\.json$/, "");
      if (this.locks.has(key)) continue;
      const read = await readJsonShared(path14.join(this.locksDir(), file));
      this.assertOperational();
      if (read.status !== "ok") {
        await fs15.rm(path14.join(this.locksDir(), file), { force: true });
        this.assertOperational();
        continue;
      }
      if (read.value.quarantined) {
        this.locks.set(key, read.value);
        continue;
      }
      await fs15.rm(path14.join(this.locksDir(), file), { force: true });
      this.assertOperational();
    }
    await this.sweepOrphanWorktrees();
  }
  /**
   * Removes worktrees no live task owns, and reports the ones it will not touch.
   *
   * Deliberately the LAST pass: quarantined locks are re-seeded just above, and
   * a quarantined worktree must never be swept — a process of the previous run
   * may still be able to write there.
   *
   * This is not optional once provisioning exists. `git worktree add` can
   * outlast PREPARATION_DRAIN_MS on a large repository; shutdown logs and
   * proceeds, leaving a registered worktree with no task. Without this sweep
   * that leaks, one directory per interrupted start.
   *
   * Removal is narrow by design: only a tree with no uncommitted work, and only
   * through git, which refuses a dirty tree on its own. Anything dirty or
   * unattributable is listed and left alone.
   */
  async sweepOrphanWorktrees() {
    const owned = /* @__PURE__ */ new Set();
    for (const task of this.tasks.values()) owned.add(task.record.taskId.slice(0, 16));
    for (const lock of this.locks.values()) if (lock.quarantined) owned.add(lock.holderTaskId.slice(0, 16));
    let orphans;
    try {
      orphans = await listOrphans(this.stateRoot, (_repoKey, prefix) => owned.has(prefix));
    } catch {
      return;
    }
    for (const orphan of orphans) {
      this.assertOperational();
      if (orphan.dirtyFiles.length > 0) {
        this.options.log(`worktree \xF3rf\xE3o preservado (${orphan.dirtyFiles.length} arquivo(s) n\xE3o commitado(s)): ${orphan.path}`);
        continue;
      }
      let repository;
      try {
        repository = await resolveRepository(orphan.path);
      } catch {
        this.options.log(`worktree \xF3rf\xE3o n\xE3o atribu\xEDvel, preservado: ${orphan.path}`);
        continue;
      }
      const removal = await withRepositoryMutex(repository.repoKey, () => removeWorktree(repository, orphan.path));
      this.options.log(removal.removed ? `worktree \xF3rf\xE3o limpo removido: ${orphan.path}` : `worktree \xF3rf\xE3o preservado (git recusou a remo\xE7\xE3o): ${orphan.path} \u2014 ${removal.reason ?? "sem motivo informado"}`);
    }
  }
  async openTask(record2, dir) {
    const existing = this.tasks.get(record2.taskId);
    if (existing) return existing;
    const log = await EventLog.open(path14.join(dir, "events.jsonl"));
    const history = await log.readFrom(0);
    const queue = await this.loadQueue(dir);
    const pointer = await readJsonShared(path14.join(dir, "session.json"));
    const task = {
      record: record2,
      dir,
      log,
      run: null,
      worker: null,
      workerReady: false,
      modelTransition: null,
      phase: "terminal",
      currentTool: null,
      lastActivityAt: Date.now(),
      coordinatorLastSeenAt: null,
      queue,
      pending: /* @__PURE__ */ new Map(),
      resolvedRequests: /* @__PURE__ */ new Set(),
      alertsRaised: /* @__PURE__ */ new Set(),
      uncertain: record2.requiresReview,
      disconnected: false,
      previousSessionId: pointer.status === "ok" && typeof pointer.value.sessionId === "string" ? pointer.value.sessionId : null,
      quota: null,
      claudeUsage: ClaudeUsageAccumulator.fromEvents(history),
      codexUsage: unavailableCodexUsage(),
      usageRefresh: null,
      writer: null,
      derivedDirty: false,
      lastTelemetryEventAt: 0,
      changedFilesCache: null,
      endTimer: null,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      chain: Promise.resolve()
    };
    this.tasks.set(record2.taskId, task);
    return task;
  }
  async persistRecord(task) {
    await writeFileAtomic(path14.join(task.dir, "task.json"), JSON.stringify(task.record, null, 2));
  }
  // ------------------------------------------------------------- registration
  async register(threadId, source) {
    if (typeof threadId !== "string" || !THREAD_ID_PATTERN.test(threadId)) throw new HttpError(400, "THREAD_ID_INVALID");
    const taskId = taskIdForThread(threadId);
    const dir = path14.join(this.tasksDir(), taskId);
    await fs15.mkdir(dir, { recursive: true });
    const existing = this.tasks.get(taskId) ?? null;
    const { handle, hash } = mintTaskHandle();
    const record2 = existing ? { ...existing.record, handleHash: hash, handleRotatedAt: (/* @__PURE__ */ new Date()).toISOString() } : { taskId, threadId, createdAt: (/* @__PURE__ */ new Date()).toISOString(), handleHash: hash, handleRotatedAt: (/* @__PURE__ */ new Date()).toISOString(), workspace: null, requiresReview: false, reviewReason: null };
    const task = await this.openTask(record2, dir);
    task.record = record2;
    await this.persistRecord(task);
    await this.append(task, task.run?.runId ?? "none", "task_registered", { source, rotated: Boolean(existing) });
    this.options.log(`task ${taskId} registered (${source})`);
    this.changed(task);
    if (!this.options.harness) void this.refreshUsage(task);
    return { taskId, taskHandle: handle, created: !existing, requiresReview: record2.requiresReview };
  }
  resolveHandle(handle) {
    if (typeof handle !== "string" || !handle) throw new HttpError(403, "TASK_HANDLE_REQUIRED");
    for (const task of this.tasks.values()) if (verifyTaskHandle(handle, task.record.handleHash)) return task;
    throw new HttpError(403, "TASK_HANDLE_INVALID");
  }
  getTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND");
    return task;
  }
  touchCoordinator(task) {
    task.coordinatorLastSeenAt = Date.now();
    this.changed(task);
  }
  /**
   * Confirms that the ARTIFACTS of an uncertain run were reviewed.
   *
   * This never releases ownership of a checkout. A quarantined writer lock
   * means a process of that run may still be alive, and reviewing a diff says
   * nothing about that; releasing it is a separate, explicit decision that
   * re-checks for survivors first (see `releaseQuarantinedLock`).
   */
  async acknowledgeReview(task, note, source) {
    if (!task.record.requiresReview && !task.uncertain) return;
    task.record.requiresReview = false;
    task.record.reviewReason = null;
    task.uncertain = false;
    task.disconnected = false;
    await this.persistRecord(task);
    const quarantined = [...this.locks.values()].filter((lock) => lock.quarantined && lock.holderTaskId === task.record.taskId);
    await this.append(task, task.run?.runId ?? "none", "review_acknowledged", {
      source,
      note: note ? redactSensitiveText(note).slice(0, 500) : null,
      quarantinedLocks: quarantined.map((lock) => lock.workspaceKey),
      ownershipReleased: false,
      ...quarantined.length ? { ownershipNote: "A revis\xE3o de artefatos n\xE3o libera a posse do checkout; use a libera\xE7\xE3o expl\xEDcita da trava em quarentena." } : {}
    });
    this.changed(task);
  }
  /**
   * Explicit, administrative release of a quarantined checkout lock.
   *
   * Refuses while any recorded process of the holding run is running or cannot
   * be proven gone: a writer is never restored while a survivor is possible.
   * The decision and its reason are recorded in the task log.
   */
  /**
   * What worktrees exist under this state root and which are unaccounted for.
   *
   * Ownership is decided here, not in the git module, because only the task
   * manager knows which tasks are live and which locks are quarantined. A
   * quarantined worktree is never reported as an orphan: a process of the
   * previous run may still be able to write there, and the audited release
   * path — not a sweep — is what ends that.
   */
  async worktreeInventory() {
    const ownedPrefixes = /* @__PURE__ */ new Set();
    for (const task of this.tasks.values()) ownedPrefixes.add(task.record.taskId.slice(0, 16));
    for (const lock of this.locks.values()) if (lock.quarantined) ownedPrefixes.add(lock.holderTaskId.slice(0, 16));
    const orphans = await listOrphans(this.stateRoot, (_repoKey, taskPrefix) => ownedPrefixes.has(taskPrefix));
    return { policies: await this.worktreePolicy.list(), orphans };
  }
  /**
   * Removes a retained worktree, on the operator's explicit instruction.
   *
   * Retention exists because uncommitted work is the normal end state of a run,
   * so discarding it has to be stated, not defaulted: a dirty tree is only
   * removed with confirmDiscardUncommitted, and the files being discarded are
   * named back in the answer. A tree whose lock is still quarantined is never
   * removed here — releasing ownership is the other, survivor-checking action.
   */
  async releaseWorktree(target, request, source) {
    const note = (request.note ?? "").trim();
    if (!note) throw new HttpError(400, "NOTE_REQUIRED", { message: "Remover um worktree exige uma nota; a remo\xE7\xE3o fica registrada." });
    const canonical = canonicalize(target);
    for (const lock of this.locks.values()) {
      if (canonicalize(lock.workspace) !== canonical) continue;
      if (lock.quarantined) {
        throw new HttpError(409, "WORKSPACE_LOCK_QUARANTINED", {
          holderTaskId: lock.holderTaskId,
          note: lock.quarantineNote,
          remediation: "Um processo da execu\xE7\xE3o anterior pode continuar escrevendo aqui. Libere a posse pela rota de travas, que reverifica sobreviventes, antes de remover o diret\xF3rio."
        });
      }
      throw new HttpError(409, "WORKSPACE_WRITER_LOCKED", { holderTaskId: lock.holderTaskId, holderRunId: lock.holderRunId, message: "Este worktree ainda pertence a uma execu\xE7\xE3o ativa." });
    }
    let repository;
    try {
      repository = await resolveRepository(target);
    } catch (error) {
      throw new HttpError(400, error.code ?? "NOT_A_GIT_REPOSITORY", { message: error.message });
    }
    const dirty = await gitStatus(target);
    if (dirty.length > 0 && !request.confirmDiscardUncommitted) {
      throw new HttpError(409, "WORKTREE_HAS_UNCOMMITTED_WORK", {
        files: dirty.slice(0, 50),
        message: `Este worktree tem ${dirty.length} arquivo(s) com altera\xE7\xF5es n\xE3o commitadas. Commite a partir dele, ou repita com confirmDiscardUncommitted para descartar.`
      });
    }
    const removal = await withRepositoryMutex(repository.repoKey, () => removeWorktree(repository, target, { force: dirty.length > 0 }));
    if (!removal.removed) throw new HttpError(409, "WORKTREE_REMOVE_REFUSED", { message: removal.reason ?? "git recusou a remo\xE7\xE3o." });
    this.options.log(`worktree removido por a\xE7\xE3o administrativa (${source}): ${target} \u2014 ${note}`);
    return { removed: true, path: target, discarded: dirty.slice(0, 50), note };
  }
  async releaseQuarantinedLock(workspaceKey, request, source) {
    const lock = this.locks.get(workspaceKey);
    if (!lock) throw new HttpError(404, "LOCK_NOT_FOUND");
    if (!lock.quarantined) throw new HttpError(409, "LOCK_NOT_QUARANTINED", { note: "Uma trava ativa pertence a uma execu\xE7\xE3o em andamento; encerre a execu\xE7\xE3o." });
    if (lock.releaseInProgress) throw new HttpError(409, "LOCK_RELEASE_IN_PROGRESS");
    if (!request.note?.trim() || !request.confirmHistoricalRisk || request.expectedTaskId !== lock.holderTaskId || request.expectedRunId !== lock.holderRunId) {
      throw new HttpError(409, "LOCK_RELEASE_CONFIRMATION_REQUIRED", {
        holderTaskId: lock.holderTaskId,
        holderRunId: lock.holderRunId,
        note: "A libera\xE7\xE3o excepcional exige nota, reconhecimento expl\xEDcito do risco hist\xF3rico e a identidade exata da posse atual."
      });
    }
    lock.releaseInProgress = true;
    const task = this.tasks.get(lock.holderTaskId) ?? null;
    let check = { releasable: false, livePids: [], note: "Auditoria ainda n\xE3o executada." };
    const historicalAncestryConclusive = false;
    try {
      if (this.options.harness) await new Promise((resolve) => setTimeout(resolve, 50));
      const runDir = task ? path14.join(task.dir, "runs", lock.holderRunId) : null;
      check = runDir ? await survivorCheck(runDir, lock.holderPid) : { releasable: false, livePids: [], note: "A execu\xE7\xE3o que det\xE9m a trava n\xE3o p\xF4de ser localizada no estado; a posse n\xE3o \xE9 liberada \xE0s cegas." };
      if (!check.releasable) {
        if (task) await this.append(task, lock.holderRunId, "lock_release_refused", { workspaceKey, source, livePids: check.livePids, note: check.note });
        throw new HttpError(409, "LOCK_SURVIVOR_POSSIBLE", { livePids: check.livePids, note: check.note });
      }
      if (task) {
        await this.append(task, lock.holderRunId, "lock_release_authorized", {
          workspaceKey,
          source,
          note: redactSensitiveText(request.note).slice(0, 500),
          evidence: check.note,
          historicalAncestryConclusive,
          riskAcknowledged: true,
          visibleProcesses: check.livePids,
          ownership: { taskId: lock.holderTaskId, runId: lock.holderRunId }
        });
      }
      const persisted = await readJsonShared(path14.join(this.locksDir(), `${workspaceKey}.json`));
      const current = this.locks.get(workspaceKey);
      if (current !== lock || persisted.status !== "ok" || persisted.value.holderTaskId !== lock.holderTaskId || persisted.value.holderRunId !== lock.holderRunId || !persisted.value.quarantined) {
        throw new HttpError(409, "LOCK_OWNERSHIP_CHANGED", { note: "A posse mudou durante a auditoria; nada foi liberado." });
      }
      await fs15.rm(path14.join(this.locksDir(), `${workspaceKey}.json`));
      this.locks.delete(workspaceKey);
      if (task) await this.append(task, lock.holderRunId, "lock_released", {
        workspaceKey,
        source,
        ownership: { taskId: lock.holderTaskId, runId: lock.holderRunId }
      });
      if (task) this.changed(task);
    } catch (error) {
      if (this.locks.get(workspaceKey) === lock) lock.releaseInProgress = false;
      throw error;
    }
    return { released: true, workspaceKey, livePids: [], note: check.note, historicalAncestryConclusive };
  }
  // --------------------------------------------------------------- events
  /**
   * Appends to the task log and broadcasts, globally serialized: the sequence
   * number, the durable write and the broadcast happen in one order for every
   * task, so no subscriber can observe a later sequence before an earlier one.
   */
  append(task, runId, type, data, toolUseId) {
    const run2 = async () => {
      this.globalSeq += 1;
      const gseq = this.globalSeq;
      const record2 = await task.log.append({ type, taskId: task.record.taskId, runId, threadId: task.record.threadId, ...toolUseId ? { toolUseId } : {}, data, gseq });
      task.lastActivityAt = Date.now();
      task.derivedDirty = true;
      task.updatedAt = record2.ts;
      this.options.onEvent(record2);
      return record2;
    };
    const next = this.appendChain.then(run2, run2);
    this.appendChain = next.catch(() => void 0);
    return next;
  }
  changed(task) {
    task.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.options.onTaskChanged(this.view(task));
  }
  // ---------------------------------------------------------------- queue
  async loadQueue(dir) {
    const file = path14.join(dir, "queue.jsonl");
    let text;
    try {
      text = await fs15.readFile(file, "utf8");
    } catch {
      return [];
    }
    const entries = /* @__PURE__ */ new Map();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        entries.set(parsed.messageId, { ...entries.get(parsed.messageId) ?? parsed, ...parsed });
      } catch {
      }
    }
    return [...entries.values()];
  }
  async persistQueue(task) {
    const lines = task.queue.map((entry) => JSON.stringify(entry)).join("\n");
    await writeFileAtomic(path14.join(task.dir, "queue.jsonl"), lines ? `${lines}
` : "");
  }
  queueView(entry) {
    return { messageId: entry.messageId, source: entry.source, textPreview: entry.textPreview, receivedAt: entry.receivedAt, deliveredAt: entry.deliveredAt, state: entry.state };
  }
  /**
   * Accepts guidance for the next turn. A 202 means the message is durably
   * queued: it survives a not-yet-ready worker and is flushed in order.
   */
  async enqueueMessage(task, text, source) {
    if (!task.run || task.run.finalized || task.run.finalizing || !task.worker) throw new HttpError(409, "NO_ACTIVE_RUN");
    if (task.uncertain) throw new HttpError(409, "REQUIRES_REVIEW", { message: "A execu\xE7\xE3o est\xE1 incerta; confirme a revis\xE3o antes de enviar novas orienta\xE7\xF5es." });
    const redacted = redactSensitiveText(text);
    const entry = { messageId: `msg-${randomUUID()}`, source, text: redacted, textPreview: boundedPreview(redacted, 300).preview, receivedAt: (/* @__PURE__ */ new Date()).toISOString(), deliveredAt: null, state: "queued" };
    task.queue.push(entry);
    await this.persistQueue(task);
    await this.append(task, task.run.runId, "message_queued", { messageId: entry.messageId, source, textPreview: entry.textPreview });
    if (source !== "browser") this.touchCoordinator(task);
    await this.deliverNext(task);
    this.changed(task);
    return this.queueView(entry);
  }
  /**
   * A review note on a changed file becomes guidance for the next turn.
   *
   * Three steps, in order: validate the target, record the annotation in the
   * durable log, and hand the rendered text to the EXISTING enqueueMessage.
   * There is no new delivery path, no second queue and no new worker message,
   * so every guarantee comes along unchanged — refused with NO_ACTIVE_RUN,
   * refused while the run REQUIRES_REVIEW, delivered only between turns, never
   * mid-turn, persisted in queue.jsonl, redacted on the way in.
   *
   * The target must be a file the broker already observed as changed. An
   * annotation can therefore never name an arbitrary path, which is what keeps
   * this from becoming a way to make Claude read somewhere it was not sent.
   */
  async annotate(task, input, source) {
    const file = typeof input.file === "string" ? input.file.trim() : "";
    const comment = typeof input.comment === "string" ? input.comment.trim() : "";
    if (!file) throw new HttpError(400, "FILE_REQUIRED", { message: 'Informe o arquivo anotado em "file".' });
    if (!comment) throw new HttpError(400, "COMMENT_REQUIRED", { message: "Uma anota\xE7\xE3o sem texto n\xE3o orienta nada." });
    const workspace = task.record.workspace;
    if (!workspace) throw new HttpError(409, "NO_ACTIVE_RUN");
    const observed = await this.observedFiles(task);
    if (!observed.includes(file)) {
      throw new HttpError(400, "FILE_NOT_OBSERVED", {
        message: "S\xF3 \xE9 poss\xEDvel anotar um arquivo que o broker observou como alterado nesta execu\xE7\xE3o.",
        observed: observed.slice(0, 50)
      });
    }
    if (isSensitivePath(file)) throw new HttpError(403, "SENSITIVE_FILE", { message: "Arquivos sens\xEDveis n\xE3o s\xE3o anotados nem exibidos." });
    const resolved = resolveWorkspacePath(workspace, file);
    if (!resolved.inside) throw new HttpError(403, "OUTSIDE_WORKSPACE", { message: "O caminho anotado sai da \xE1rvore de trabalho." });
    const hunk = typeof input.hunk === "string" && input.hunk.trim() ? input.hunk.trim().slice(0, 120) : null;
    const rendered = `Anota\xE7\xE3o de revis\xE3o em ${file}${hunk ? ` (${hunk})` : ""}: ${comment}`;
    await this.append(task, task.run?.runId ?? "none", "diff_annotated", {
      file,
      hunk,
      commentPreview: boundedPreview(redactSensitiveText(comment), 300).preview,
      source,
      note: "A anota\xE7\xE3o entra na fila como orienta\xE7\xE3o e \xE9 entregue entre turnos, como qualquer outra."
    });
    return this.enqueueMessage(task, rendered, source);
  }
  /** The changed-file list the annotation and diff routes validate against. */
  async observedFiles(task) {
    const fresh = await this.changedFiles(task);
    return fresh.observed;
  }
  /**
   * The diff of one observed file, for review.
   *
   * Diff output is file content the panel has never previewed, so it goes
   * through the same redaction as everything else public, and through the same
   * target validation as an annotation.
   */
  async fileDiff(task, file) {
    const workspace = task.record.workspace;
    if (!workspace) throw new HttpError(409, "NO_ACTIVE_RUN");
    const observed = await this.observedFiles(task);
    if (!observed.includes(file)) throw new HttpError(400, "FILE_NOT_OBSERVED", { observed: observed.slice(0, 50) });
    if (isSensitivePath(file)) throw new HttpError(403, "SENSITIVE_FILE");
    const resolved = resolveWorkspacePath(workspace, file);
    if (!resolved.inside) throw new HttpError(403, "OUTSIDE_WORKSPACE");
    const result = await git(["diff", "--unified=3", "--", file], workspace);
    const raw = result.code === 0 ? result.stdout : "";
    const redacted = redactSensitiveText(raw);
    const limit = 64e3;
    return { file, diff: redacted.slice(0, limit), truncated: redacted.length > limit };
  }
  async deliverNext(task) {
    const run2 = task.run;
    if (!run2 || !task.worker || !task.workerReady || task.uncertain || run2.finalized || run2.finalizing) return;
    if (task.phase !== "idle") return;
    if (task.modelTransition) return;
    const next = task.queue.find((entry) => entry.state === "queued");
    if (!next) return;
    next.state = "delivered";
    next.deliveredAt = (/* @__PURE__ */ new Date()).toISOString();
    task.phase = "busy_model";
    await this.persistQueue(task);
    this.sendToWorker(task, { t: "deliver", messageId: next.messageId, text: next.text, source: next.source });
    await this.append(task, run2.runId, "message_delivered", { messageId: next.messageId, source: next.source });
  }
  // -------------------------------------------------------------- requests
  async answer(task, body, source) {
    const requestId = String(body.requestId ?? "");
    if (task.resolvedRequests.has(requestId)) throw new HttpError(409, "REQUEST_ALREADY_RESOLVED");
    const pending = task.pending.get(requestId);
    if (!pending) throw new HttpError(404, "REQUEST_NOT_FOUND");
    if (body.runId !== pending.runId) throw new HttpError(409, "REQUEST_WRONG_RUN");
    const decision = body.decision === "allow" || body.decision === "deny" || body.decision === "answer" ? body.decision : null;
    if (!decision) throw new HttpError(400, "DECISION_INVALID");
    const answers = body.answers && typeof body.answers === "object" ? body.answers : void 0;
    task.pending.delete(requestId);
    task.resolvedRequests.add(requestId);
    this.sendToWorker(task, { t: "answer", requestId, decision, ...typeof body.message === "string" ? { message: body.message.slice(0, 2e3) } : {}, ...answers ? { answers } : {}, source });
    if (source !== "browser") this.touchCoordinator(task);
    this.changed(task);
  }
  // ------------------------------------------------------------- lifecycle
  sendToWorker(task, message) {
    try {
      task.worker?.send(message);
    } catch (error) {
      this.options.log(`task ${task.record.taskId}: envio ao worker falhou (${error.name})`);
    }
  }
  async interrupt(task, source) {
    if (!task.run || !task.worker || task.run.finalized) throw new HttpError(409, "NO_ACTIVE_RUN");
    this.sendToWorker(task, { t: "interrupt", source });
    if (source !== "browser") this.touchCoordinator(task);
  }
  async end(task, source) {
    if (!task.run || !task.worker || task.run.finalized) throw new HttpError(409, "NO_ACTIVE_RUN");
    this.sendToWorker(task, { t: "end", source });
    if (source !== "browser") this.touchCoordinator(task);
    const run2 = task.run;
    task.endTimer = setTimeout(() => {
      if (task.run === run2 && !run2.finalized) void this.finalize(task, run2, "CANCELLED", "END_TIMEOUT", "O worker n\xE3o encerrou no prazo; a \xE1rvore de processos foi terminada.", 1, null);
    }, WORKER_END_GRACE_MS);
    task.endTimer.unref();
  }
  /**
   * Switches the model between turns.
   *
   * The transition is reserved before the request leaves and released only
   * after the worker confirms, so a queued message cannot start a turn on an
   * indeterminate model. Until the CLI confirms, the recorded model is still
   * the old one; a refusal reports the model that stayed active.
   */
  async setModel(task, model, reason, source) {
    if (typeof model !== "string" || !AUTHORIZED_MODELS.includes(model)) throw new HttpError(400, "MODEL_NOT_AUTHORIZED");
    if (typeof reason !== "string" || !reason.trim()) throw new HttpError(400, "MODEL_REASON_REQUIRED");
    if (!task.run || !task.worker || task.run.finalized) throw new HttpError(409, "NO_ACTIVE_RUN");
    if (task.phase !== "idle") throw new HttpError(409, "TURN_IN_PROGRESS", { activeModel: task.run.requestedModel });
    if (task.modelTransition) throw new HttpError(409, "MODEL_CHANGE_IN_PROGRESS", { activeModel: task.run.requestedModel, pendingModel: task.modelTransition.model });
    const run2 = task.run;
    let uncertain = false;
    let settle = () => void 0;
    const confirmed = new Promise((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => settle({ ok: false, activeModel: null, code: "MODEL_CHANGE_TIMEOUT" }), MODEL_CHANGE_TIMEOUT_MS);
    timer.unref();
    task.modelTransition = { model, settle };
    this.changed(task);
    try {
      this.sendToWorker(task, { t: "set_model", model, reason: reason.trim(), source });
      const outcome = await confirmed;
      if (outcome.code === "MODEL_CHANGE_TIMEOUT") {
        uncertain = true;
        task.uncertain = true;
        task.record.requiresReview = true;
        task.record.reviewReason = "A troca de modelo n\xE3o foi confirmada pelo CLI; o modelo em vigor \xE9 desconhecido.";
        await this.persistRecord(task);
        await this.append(task, run2.runId, "model_change_uncertain", {
          requestedModel: model,
          previousModel: run2.requestedModel,
          source,
          note: "O CLI n\xE3o confirmou a troca no prazo. Ele pode t\xEA-la aplicado. O modelo em vigor n\xE3o \xE9 afirmado e nenhum turno novo \xE9 liberado at\xE9 revis\xE3o expl\xEDcita."
        });
        throw new HttpError(409, "MODEL_CHANGE_UNCERTAIN", {
          activeModel: null,
          requestedModel: model,
          note: "A troca n\xE3o foi confirmada; o modelo em vigor \xE9 desconhecido e a execu\xE7\xE3o exige revis\xE3o antes de continuar."
        });
      }
      if (!outcome.ok) {
        throw new HttpError(409, outcome.code ?? "MODEL_CHANGE_REFUSED", { activeModel: outcome.activeModel, note: "O modelo em vigor n\xE3o mudou." });
      }
      run2.requestedModel = model;
      run2.modelReason = reason.trim();
      if (source !== "browser") this.touchCoordinator(task);
      return { applied: "next_turn", strategy: "in_session", model };
    } finally {
      clearTimeout(timer);
      task.modelTransition = null;
      this.changed(task);
      if (!uncertain) await this.deliverNext(task);
    }
  }
  async inventoryFor(workspace) {
    const inventory = await inventoryCustomizations(workspace, this.options.harness ? { userConfigDir: null, userClaudeJsonPath: null, managedSettingsPaths: null, ancestorBoundary: workspace } : {});
    const trust = await this.trustStore.check(inventory);
    return { inventory, trust };
  }
  async approveTrust(task, workspace, approvalRevision, approvedItems, note, source) {
    const { inventory } = await this.inventoryFor(workspace);
    await this.trustStore.approve({ inventory, identity: { threadId: task.record.threadId, source: source === "mcp" ? "mcp" : source === "browser" ? "browser" : "local-secret" }, approvalRevision, approvedItems, ...note ? { approvedRevisionNote: note } : {} });
    const trust = await this.trustStore.check(inventory);
    await this.append(task, task.run?.runId ?? "none", "trust_approved", { workspace: inventory.canonicalWorkspace, approvalRevision, items: approvedItems === "all" ? inventory.items.length : approvedItems.length, trusted: trust.trusted, source });
    return trust;
  }
  /**
   * Reserves the task slot and the checkout writer lock synchronously, before
   * any awaited preparation, so two concurrent starts can never both proceed.
   */
  async startRun(task, job, harness, source, acknowledgeReview, observation) {
    let contract;
    try {
      contract = resolveJobContract(job);
    } catch (error) {
      if (error instanceof ContractError) throw new HttpError(400, "CONTRACT_INVALID", { code: error.code, message: error.message });
      throw error;
    }
    if (contract.version !== 2) throw new HttpError(409, "LEGACY_CONTRACT_USE_LEGACY_RUNNER", { message: "Jobs v1 executam somente pelo runner legado (start-live.ps1); o runtime v2 aceita contractVersion 2." });
    this.assertObserved(task, observation);
    if (this.stopping) throw new HttpError(503, "BROKER_SHUTTING_DOWN", { message: "O broker est\xE1 encerrando; nenhuma execu\xE7\xE3o nova \xE9 aceita." });
    if ((task.record.requiresReview || task.uncertain) && !acknowledgeReview) {
      throw new HttpError(409, "REQUIRES_REVIEW", { message: "A \xFAltima execu\xE7\xE3o ficou incerta ou desconectada; confirme a revis\xE3o (acknowledgeReview: true) antes de iniciar outra.", reason: task.record.reviewReason });
    }
    let workspace;
    let canonicalWorkspace;
    try {
      workspace = realpathSync3.native(contract.workspace);
      canonicalWorkspace = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
      if (process.platform === "win32") canonicalWorkspace = canonicalWorkspace.toLowerCase();
    } catch {
      throw new HttpError(400, "WORKSPACE_NOT_FOUND");
    }
    let worktreePlan = null;
    let workspaceKey = sha256(canonicalWorkspace).slice(0, 24);
    if (contract.execution.mode === "worktree") {
      worktreePlan = await this.planWorktree(task, contract, workspace);
      workspaceKey = sha256(canonicalizePlanned(worktreePlan.path)).slice(0, 24);
    }
    if (task.run && !task.run.finalized) throw new HttpError(409, "RUN_IN_PROGRESS", { runId: task.run.runId });
    const holder = this.locks.get(workspaceKey);
    if (contract.capabilities.edit && holder && holder.holderTaskId !== task.record.taskId) {
      throw new HttpError(409, holder.quarantined ? "WORKSPACE_LOCK_QUARANTINED" : "WORKSPACE_WRITER_LOCKED", { holderTaskId: holder.holderTaskId, holderRunId: holder.holderRunId, acquiredAt: holder.acquiredAt, ...holder.quarantined ? { note: holder.quarantineNote } : {} });
    }
    if (holder?.quarantined && holder.holderTaskId === task.record.taskId) {
      throw new HttpError(409, "WORKSPACE_LOCK_QUARANTINED", {
        holderRunId: holder.holderRunId,
        note: holder.quarantineNote,
        remediation: "Libere explicitamente a trava em quarentena depois de confirmar que nenhum processo da execu\xE7\xE3o anterior sobreviveu; a revis\xE3o de artefatos n\xE3o libera a posse."
      });
    }
    const runId = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const runToken = randomUUID();
    const runDir = path14.join(task.dir, "runs", runId);
    const run2 = {
      runId,
      runToken,
      status: "STARTING",
      startedAt: (/* @__PURE__ */ new Date()).toISOString(),
      endedAt: null,
      contract,
      prompt: "",
      sessionConfirmed: false,
      requestedModel: contract.model.resolved ?? contract.model.requested,
      modelReason: contract.model.reason,
      observedModel: null,
      effortObservedByCli: null,
      sessionId: task.previousSessionId,
      workerPid: null,
      workerStartedAt: null,
      failureStage: null,
      failureCode: null,
      telemetryFailures: 0,
      turns: 0,
      resumeMode: task.previousSessionId ? "automatic" : "new",
      simulated: false,
      declaredWorkspace: worktreePlan ? workspace : null,
      worktree: worktreePlan,
      writerLockKey: contract.capabilities.edit ? workspaceKey : null,
      finalized: false,
      finalizing: false,
      initialPromptDelivered: false,
      ownershipRecorded: false,
      claudeAuthored: /* @__PURE__ */ new Set(),
      harnessFinalizationFailure: this.options.harness && typeof harness?.finalizationFailure === "string" ? harness.finalizationFailure : null
    };
    task.run = run2;
    if (contract.capabilities.edit) {
      this.locks.set(workspaceKey, { workspaceKey, workspace: worktreePlan ? canonicalizePlanned(worktreePlan.path) : canonicalWorkspace, holderTaskId: task.record.taskId, holderRunId: runId, holderPid: null, acquiredAt: run2.startedAt, quarantined: false });
    }
    task.uncertain = false;
    task.disconnected = false;
    task.phase = "starting";
    task.currentTool = null;
    task.alertsRaised.clear();
    task.pending.clear();
    task.workerReady = false;
    task.record.workspace = workspace;
    try {
      await fs15.mkdir(runDir, { recursive: true });
      run2.prompt = contract.prompt ?? (contract.promptFile ? await fs15.readFile(contract.promptFile, "utf8") : "");
      if (this.stopping) throw new HttpError(503, "BROKER_SHUTTING_DOWN", { message: "O broker come\xE7ou a encerrar durante a prepara\xE7\xE3o; nenhum worker ser\xE1 criado." });
      let effectiveWorkspace = workspace;
      if (worktreePlan) {
        effectiveWorkspace = await this.provisionWorktree(task, run2, worktreePlan);
        if (this.stopping || task.run !== run2) throw new HttpError(503, "BROKER_SHUTTING_DOWN", { message: "O broker come\xE7ou a encerrar durante o provisionamento; nenhum worker ser\xE1 criado." });
      }
      const { inventory, trust: initialTrust } = await this.inventoryFor(effectiveWorkspace);
      let trust = initialTrust;
      if (this.stopping) throw new HttpError(503, "BROKER_SHUTTING_DOWN", { message: "O broker come\xE7ou a encerrar durante a prepara\xE7\xE3o; nenhum worker ser\xE1 criado." });
      if (!trust.trusted && worktreePlan) {
        const derived = await this.trustStore.deriveFromParent({ child: inventory, parentCanonicalWorkspace: canonicalizeWorkspace(workspace) });
        if (derived) {
          trust = await this.trustStore.check(inventory);
          await this.append(task, runId, "trust_derived", {
            workspace: inventory.canonicalWorkspace,
            from: canonicalWorkspace,
            approvalRevision: derived.approvalRevision,
            items: derived.approvedItems.length,
            note: "Aprova\xE7\xE3o herdada do checkout de origem: todo item bate por hash. Nenhum recurso novo foi autorizado."
          });
        }
      }
      if (!trust.trusted) {
        throw new HttpError(409, "WORKSPACE_NOT_TRUSTED", { reason: trust.reason, pending: trust.pending, changed: trust.changed, fingerprint: inventory.fingerprint, incomplete: inventory.incomplete });
      }
      const record2 = await this.trustStore.load(inventory.canonicalWorkspace);
      const launch = resolveLaunchCustomizations({ inventory, trust, record: record2 });
      task.writer = new StateWriter({ directory: runDir, telemetryMaxWaitMs: 1500, finalMaxWaitMs: 15e3, onTelemetryFailure: (failure) => {
        run2.telemetryFailures += 1;
        void this.reportTelemetryFailure(task, run2, failure.file, failure.code);
      } });
      await this.persistRecord(task);
      if (run2.writerLockKey) {
        const lock = this.locks.get(run2.writerLockKey);
        await writeFileAtomic(path14.join(this.locksDir(), `${run2.writerLockKey}.json`), JSON.stringify(lock, null, 2));
      }
      try {
        await this.writeCurrentRun(task, { runId, runToken, status: "STARTING", workerPid: null, workerStartedAt: null, startedAt: run2.startedAt, workspace: effectiveWorkspace, writerLockKey: run2.writerLockKey, runDir });
      } catch (error) {
        throw new HttpError(503, "OWNERSHIP_RECORD_FAILED", {
          code: error.code ?? "WRITE_FAILED",
          message: "O estado autoritativo da execu\xE7\xE3o n\xE3o p\xF4de ser gravado; nenhum trabalho \xE9 iniciado sem esse registro."
        });
      }
      await this.append(task, runId, "run_started", {
        startedAt: run2.startedAt,
        requestedModel: run2.requestedModel,
        modelReason: run2.modelReason,
        effort: contract.effort,
        workspace: effectiveWorkspace,
        // Recorded so an audit of status.json can see a run that started with
        // no panel attached, and which channel was declared instead.
        observation: { mode: isRecord(observation) && observation.mode === "voz" ? "voz" : "painel", observers: this.options.observers?.(task.record.taskId) ?? 0 },
        ...worktreePlan ? { declaredWorkspace: workspace, worktree: { path: worktreePlan.path, branch: worktreePlan.branch, baseRef: worktreePlan.baseRef, repoKey: worktreePlan.repository.repoKey, provisionedBy: "broker", policyEnabledAt: worktreePlan.policy.enabledAt } } : {},
        profile: contract.profile,
        contractVersion: contract.version,
        coordination: contract.coordination,
        scope: contract.scope,
        capabilities: contract.capabilities,
        resumeMode: run2.resumeMode,
        resumeSessionId: run2.sessionId,
        source,
        trust: { reason: trust.reason, approvalRevision: trust.trusted ? trust.approvalRevision : null, items: inventory.items.length, managedSettingsPresent: inventory.managedSettings.present }
      });
      if (source !== "browser") this.touchCoordinator(task);
      this.changed(task);
      const approvedAgents = inventory.items.filter((item) => item.kind === "agent").map((item) => path14.basename(item.relativePath, ".md"));
      const approvedSkills = inventory.items.filter((item) => item.kind === "skill").map((item) => path14.basename(path14.dirname(item.relativePath)));
      const preparation = this.prepareAndSpawn(task, run2, launch, approvedAgents, approvedSkills, harness).catch((error) => {
        this.options.log(`task ${task.record.taskId}: prepara\xE7\xE3o falhou inesperadamente (${error.name})`);
        void this.finalize(task, run2, "FAIL", "PREPARATION_CRASH", redactSensitiveText(String(error.message ?? error)).slice(0, 300), 1, "preparation");
      }).finally(() => this.preparations.delete(preparation));
      this.preparations.add(preparation);
      return { runId, status: "STARTING" };
    } catch (error) {
      await this.releaseReservation(task, run2);
      throw error;
    }
  }
  /**
   * A run never starts without a declared channel for watching it.
   *
   * Commit 0988ebb added this requirement, but only to the v1 runner, where
   * `Wait-ClaudeLivePanelReady` really blocks. In v2 it existed solely as prose
   * in SKILL.md and two READMEs telling the coordinator to confirm the panel —
   * an instruction to a model, not an invariant, and therefore the only place
   * in this codebase where the documentation promised more than the code did.
   *
   * The property worth keeping is not "a tab is on screen", which no broker can
   * verify. It is that the mode of observation is DECIDED before work starts
   * and recorded durably. `painel` is now actually checked against live SSE
   * subscribers; `voz` is an explicit, attributable choice for a coordinator
   * with no screen. What can no longer happen is a run starting with neither.
   *
   * Deliberately understated: a subscriber count proves a channel is attached,
   * not that a human is watching.
   */
  assertObserved(task, observation) {
    const mode = isRecord(observation) && observation.mode === "voz" ? "voz" : "painel";
    if (mode === "voz") return;
    const observers = this.options.observers?.(task.record.taskId) ?? 0;
    if (observers > 0) return;
    throw new HttpError(409, "OBSERVATION_REQUIRED", {
      message: 'Nenhum painel est\xE1 acompanhando esta tarefa. Abra o link do painel e aguarde ele carregar, ou declare observa\xE7\xE3o por voz (observation.mode: "voz") para assumir o acompanhamento narrado.',
      note: "A contagem prova que um canal est\xE1 anexado, n\xE3o que algu\xE9m est\xE1 olhando."
    });
  }
  /**
   * Decides where a worktree run will live, and whether it may start at all.
   *
   * Everything here is a lookup or a policy check: no directory is created, so
   * a refusal leaves nothing behind. Runs before the critical section, because
   * the section cannot await.
   */
  async planWorktree(task, contract, declaredWorkspace) {
    let repository;
    let policy;
    try {
      repository = await resolveRepository(declaredWorkspace);
      policy = await this.worktreePolicy.require(repository.repoKey);
    } catch (error) {
      const code = error.code ?? "WORKTREE_UNAVAILABLE";
      throw new HttpError(code === "WORKTREE_POLICY_REQUIRED" ? 403 : 400, code, { message: error.message });
    }
    const active = [...this.tasks.values()].filter((other) => other.record.taskId !== task.record.taskId && other.run && !other.run.finalized && other.run.worktree?.repository.repoKey === repository.repoKey);
    if (active.length >= policy.maxParallelRuns) {
      throw new HttpError(429, "FLEET_CAPACITY_REACHED", {
        limit: policy.maxParallelRuns,
        holders: active.map((other) => ({ taskId: other.record.taskId, threadId: other.record.threadId, runId: other.run?.runId ?? null })),
        message: `J\xE1 existem ${active.length} execu\xE7\xE3o(\xF5es) em worktree neste reposit\xF3rio, o limite aprovado. Aguarde uma terminar ou ajuste maxParallelRuns na pol\xEDtica.`
      });
    }
    const root = policy.worktreeRoot ?? this.stateRoot;
    const location = worktreePathFor(root, repository.repoKey, task.record.taskId);
    try {
      assertUsablePathLength(location.path);
    } catch (error) {
      throw new HttpError(400, error.code ?? "WORKTREE_PATH_TOO_LONG", { message: error.message });
    }
    const retained = await listOrphans(root, () => false);
    const mine = retained.filter((entry) => entry.repoKey === repository.repoKey && canonicalize(entry.path) !== canonicalizePlanned(location.path));
    if (mine.length >= policy.maxRetainedWorktrees) {
      throw new HttpError(409, "WORKTREE_RETENTION_LIMIT", {
        limit: policy.maxRetainedWorktrees,
        retained: mine.map((entry) => ({ path: entry.path, dirtyFiles: entry.dirtyFiles.length })),
        message: `H\xE1 ${mine.length} worktree(s) retido(s) deste reposit\xF3rio, o limite aprovado. Revise e remova os conclu\xEDdos com "codeorquestra worktree list".`
      });
    }
    return {
      repository,
      policy,
      path: location.path,
      branch: contract.execution.worktree?.branch ?? `codeorquestra/${task.record.taskId.slice(0, 16)}`,
      baseRef: contract.execution.worktree?.baseRef ?? null
    };
  }
  /**
   * Creates the run's worktree and makes it the effective workspace.
   *
   * The single substitution of `contract.workspace` is what carries the change
   * everywhere else: the spawn cwd, the worker descriptor, the action context's
   * containment checks, the inventory and the changed-file list all read it.
   */
  async provisionWorktree(task, run2, plan) {
    let outcome;
    try {
      outcome = await withRepositoryMutex(plan.repository.repoKey, () => ensureWorktree({
        repository: plan.repository,
        target: plan.path,
        branch: plan.branch,
        baseRef: plan.baseRef
      }));
    } catch (error) {
      const code = error.code ?? "WORKTREE_ADD_FAILED";
      throw new HttpError(code === "WORKTREE_DIRTY_FROM_PREVIOUS_RUN" ? 409 : 500, code, {
        message: error.message,
        ...error.detail ? { detail: error.detail } : {}
      });
    }
    run2.contract = { ...run2.contract, workspace: outcome.path };
    task.record.workspace = outcome.path;
    await this.append(task, run2.runId, "worktree_provisioned", {
      path: outcome.path,
      branch: outcome.branch,
      baseRef: outcome.baseRef,
      created: outcome.created,
      repoKey: plan.repository.repoKey,
      declaredWorkspace: run2.declaredWorkspace,
      provisionedBy: "broker",
      note: "O Claude nunca cria worktrees; a pol\xEDtica do reposit\xF3rio foi aprovada pelo usu\xE1rio e o broker executou."
    });
    return outcome.path;
  }
  async releaseReservation(task, run2) {
    if (run2.writerLockKey) {
      const lock = this.locks.get(run2.writerLockKey);
      if (lock && lock.holderRunId === run2.runId && !lock.quarantined) {
        this.locks.delete(run2.writerLockKey);
        await fs15.rm(path14.join(this.locksDir(), `${run2.writerLockKey}.json`), { force: true });
      }
      run2.writerLockKey = null;
    }
    run2.finalized = true;
    if (task.run === run2) {
      task.run = null;
      task.phase = "terminal";
    }
  }
  async prepareAndSpawn(task, run2, launch, approvedAgents, approvedSkills, harness) {
    const preparationDelayMs = typeof harness?.preparationDelayMs === "number" ? Math.max(0, Math.min(5e3, harness.preparationDelayMs)) : 0;
    if (preparationDelayMs) await new Promise((resolve) => setTimeout(resolve, preparationDelayMs));
    if (this.stopping || task.run !== run2 || run2.finalized) return;
    const failPreparation = typeof harness?.failPreparation === "string" ? harness.failPreparation : null;
    const stage = async (name, fn) => {
      if (failPreparation === name) {
        await this.append(task, run2.runId, "preparation_failed", { stage: name, code: "HARNESS_SIMULATED_FAILURE", message: `Falha simulada pelo harness na etapa ${name}.` });
        await this.finalize(task, run2, "FAIL", "HARNESS_SIMULATED_FAILURE", `Falha simulada na etapa ${name}.`, 1, name);
        return false;
      }
      try {
        await fn();
        return true;
      } catch (error) {
        const code = error.code ?? "PREPARATION_FAILED";
        const failedStage = error.stage ?? name;
        const message = redactSensitiveText(String(error.message ?? error)).slice(0, 300);
        await this.append(task, run2.runId, "preparation_failed", { stage: failedStage, code, message });
        await this.finalize(task, run2, "FAIL", code, message, 1, failedStage);
        return false;
      }
    };
    let executable = null;
    let cliVersion = null;
    const preflightOk = await stage("cli-resolution", async () => {
      if (!this.launcherPath) throw Object.assign(new Error("Claude Code CLI n\xE3o encontrado no PATH; nenhum CLI empacotado \xE9 usado como substituto."), { code: "CLI_NOT_FOUND" });
      if (failPreparation === "cli-probe") throw Object.assign(new Error("Falha simulada pelo harness na sondagem do CLI."), { code: "CLI_PROBE_FAILED", stage: "cli-probe" });
      const preflight = await resolvePreflight({
        launcherPath: this.launcherPath,
        requestedModel: run2.requestedModel,
        runtimeVersion: engineInfo().runtimeVersion,
        allowApiBilling: run2.contract.auth.allowApiBilling,
        env: process.env,
        probe: async (resolved) => {
          if (!this.probeCache) this.probeCache = await probeCli(resolved);
          return this.probeCache;
        }
      });
      if (preflight.status !== "ready") throw Object.assign(new Error(preflight.message), { code: preflight.code, stage: preflight.failureStage });
      executable = preflight.executable;
      cliVersion = preflight.observed.cliVersion;
      await this.append(task, run2.runId, "preflight_ready", {
        cliVersion,
        executableKind: preflight.executable.kind,
        compatibility: preflight.diagnosis.status,
        modelSupport: preflight.diagnosis.modelSupport,
        notes: preflight.diagnosis.notes,
        auth: preflight.auth.code,
        authEvidence: preflight.auth.evidence,
        vendorCliUsed: false
      });
    });
    if (!preflightOk) return;
    if (this.stopping || task.run !== run2 || run2.finalized) return;
    const observation = await this.quota.observe(executable);
    if (this.stopping || task.run !== run2 || run2.finalized) return;
    task.quota = this.quota.view(run2.requestedModel, observation);
    await this.append(task, run2.runId, "quota_observed", { attemptedAt: observation.attemptedAt, observedAt: observation.observedAt, snapshot: task.quota.snapshot, recommendation: task.quota.recommendation, alternate: task.quota.alternate, failure: observation.failure });
    const spawned = await stage("worker-spawn", async () => {
      const descriptor = {
        taskId: task.record.taskId,
        runId: run2.runId,
        threadId: task.record.threadId,
        stateRoot: this.stateRoot,
        taskDir: task.dir,
        runDir: path14.join(task.dir, "runs", run2.runId),
        contract: run2.contract,
        prompt: run2.prompt,
        resumeSessionId: run2.sessionId,
        resumeMode: run2.resumeMode,
        launch,
        approvedMcpTools: {},
        approvedAgents,
        approvedSkills,
        executable: { path: executable.executablePath, runWith: executable.runWith, cliVersion },
        harness: harness ? {
          ...typeof harness.adapterPath === "string" ? { adapterPath: harness.adapterPath } : {},
          ...failPreparation ? { failPreparation } : {},
          ...typeof harness.effortCap === "string" ? { effortCap: harness.effortCap } : {},
          ...Array.isArray(harness.modelCatalog) ? { modelCatalog: harness.modelCatalog } : {},
          ...harness.hooksApplied === false ? { hooksApplied: false } : {},
          ...typeof harness.setModelDelayMs === "number" ? { setModelDelayMs: harness.setModelDelayMs } : {}
        } : null
      };
      const descriptorFile = path14.join(descriptor.runDir, "worker-descriptor.json");
      await writeFileAtomic(descriptorFile, JSON.stringify(descriptor, null, 2));
      if (this.stopping || task.run !== run2 || run2.finalized) return;
      const child = spawn7(process.execPath, [...nodeExecArgv(), workerEntry(), "--descriptor", descriptorFile], {
        cwd: run2.contract.workspace,
        env: { ...process.env, [envName("TASK_ID")]: task.record.taskId, [envName("RUN_ID")]: run2.runId, [envName("RUN_TOKEN")]: run2.runToken },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        serialization: "json",
        windowsHide: true,
        detached: process.platform !== "win32"
      });
      task.worker = child;
      run2.workerPid = child.pid ?? null;
      run2.workerStartedAt = (/* @__PURE__ */ new Date()).toISOString();
      const lock = run2.writerLockKey ? this.locks.get(run2.writerLockKey) : null;
      if (lock) {
        lock.holderPid = run2.workerPid;
        await writeFileAtomic(path14.join(this.locksDir(), `${run2.writerLockKey}.json`), JSON.stringify(lock, null, 2));
      }
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => this.options.log(`worker ${run2.workerPid} stderr: ${redactSensitiveText(chunk).trim().slice(0, 500)}`));
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", () => void 0);
      child.on("message", (message) => this.enqueueTaskWork(task, () => this.onWorkerMessage(task, run2, message)));
      child.on("exit", (code, signal) => this.enqueueTaskWork(task, () => this.onWorkerExit(task, run2, code, signal)));
      await this.writeCurrentRun(task, { runId: run2.runId, runToken: run2.runToken, status: "RUNNING", workerPid: run2.workerPid, workerStartedAt: run2.workerStartedAt, startedAt: run2.startedAt, workspace: run2.contract.workspace, writerLockKey: run2.writerLockKey, runDir: descriptor.runDir });
      run2.ownershipRecorded = true;
      await this.append(task, run2.runId, "worker_spawned", { workerPid: run2.workerPid });
    });
    if (!spawned) return;
    if (this.stopping || task.run !== run2 || run2.finalized) return;
    await this.releaseInitialPrompt(task, run2);
    this.changed(task);
  }
  /**
   * Hands the job prompt to the worker exactly once, and only after BOTH the
   * worker announced itself and the authoritative ownership record was written.
   * Whichever happens last triggers it, so no work is ever released against a
   * state a restarted broker could not recognise.
   */
  async releaseInitialPrompt(task, run2) {
    if (this.stopping || task.run !== run2 || run2.finalized || run2.initialPromptDelivered) return;
    if (!task.workerReady || !run2.ownershipRecorded) return;
    run2.initialPromptDelivered = true;
    task.phase = "busy_model";
    this.sendToWorker(task, { t: "deliver", messageId: `msg-initial-${run2.runId}`, text: run2.prompt, source: "system" });
    await this.append(task, run2.runId, "message_delivered", { messageId: `msg-initial-${run2.runId}`, source: "system", initial: true });
  }
  /** Serializes per-task transitions so stale callbacks cannot race a new run. */
  enqueueTaskWork(task, work) {
    const next = task.chain.then(work, work);
    task.chain = next.catch(() => void 0);
  }
  async onWorkerMessage(task, run2, message) {
    if (task.run !== run2 || run2.finalized) return;
    switch (message.t) {
      case "ready": {
        task.workerReady = true;
        run2.simulated = message.simulated;
        run2.status = "RUNNING";
        await this.releaseInitialPrompt(task, run2);
        this.changed(task);
        break;
      }
      case "event": {
        const event = await this.append(task, run2.runId, message.type, message.data, message.toolUseId);
        task.claudeUsage.addEvent(event);
        this.applyEvent(task, run2, message.type, message.data, message.toolUseId);
        if (message.type === "permission_requested" || message.type === "question_asked") this.changed(task);
        break;
      }
      case "phase": {
        if (message.phase === "terminal") break;
        task.phase = message.phase;
        task.currentTool = message.currentTool;
        task.lastActivityAt = Date.now();
        this.changed(task);
        break;
      }
      case "transient":
        this.options.onTransient(message.frame);
        break;
      case "request":
        task.pending.set(message.request.requestId, message.request);
        this.changed(task);
        break;
      case "blob":
        await fs15.mkdir(path14.join(task.dir, "blobs"), { recursive: true });
        await writeFileAtomic(path14.join(task.dir, "blobs", `${message.blobId}.json`), JSON.stringify({ blobId: message.blobId, truncated: message.truncated, totalChars: message.totalChars, text: message.text }));
        break;
      case "model_result": {
        task.modelTransition?.settle({ ok: message.ok, activeModel: message.activeModel, code: message.code });
        break;
      }
      case "model_uncertain": {
        task.uncertain = true;
        task.record.requiresReview = true;
        task.record.reviewReason = "O worker n\xE3o confirmou qual modelo est\xE1 em vigor no CLI.";
        await this.persistRecord(task);
        this.changed(task);
        break;
      }
      case "turn_done": {
        run2.turns += 1;
        task.phase = "idle";
        task.currentTool = null;
        await this.observeBetweenTurns(task, run2);
        await this.deliverNext(task);
        this.changed(task);
        void this.refreshUsage(task);
        break;
      }
      case "preparation_failed": {
        await this.append(task, run2.runId, "preparation_failed", { stage: message.stage, code: message.code, message: message.message });
        await this.finalize(task, run2, "FAIL", message.code, message.message, 1, message.stage);
        break;
      }
      case "run_ended":
        await this.finalize(task, run2, message.status, message.code, message.message, message.exitCode, null);
        break;
      default:
        break;
    }
  }
  applyEvent(task, run2, type, data, toolUseId) {
    switch (type) {
      case "session_init":
        if (typeof data.sessionId === "string") {
          run2.sessionId = data.sessionId;
          run2.sessionConfirmed = true;
        }
        if (typeof data.observedModel === "string") run2.observedModel = data.observedModel;
        if (typeof data.effortObservedByCli === "string") run2.effortObservedByCli = data.effortObservedByCli;
        break;
      case "assistant_text":
        if (typeof data.model === "string") run2.observedModel = data.model;
        break;
      case "tool_start":
        if (toolUseId && typeof data.name === "string" && ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(data.name) && typeof data.inputPreview === "string") {
          const match = /"(?:file_path|notebook_path)":"((?:[^"\\]|\\.)*)"/.exec(data.inputPreview);
          if (match) run2.claudeAuthored.add(match[1].replace(/\\\\/g, "\\"));
        }
        break;
      case "turn_completed":
      case "turn_interrupted":
      case "turn_failed":
        if (typeof data.model === "string") run2.observedModel = data.model;
        break;
      case "model_changed":
        if (typeof data.to === "string") run2.requestedModel = data.to;
        if (typeof data.reason === "string") run2.modelReason = data.reason;
        break;
      case "permission_resolved":
      case "question_answered":
        if (typeof data.requestId === "string") {
          task.pending.delete(data.requestId);
          task.resolvedRequests.add(data.requestId);
        }
        break;
      default:
        break;
    }
  }
  async observeBetweenTurns(task, run2) {
    const last = this.quota.lastObservation;
    const stale = !last || Date.now() - Date.parse(last.attemptedAt) > 5 * 6e4;
    if (!stale) {
      task.quota = this.quota.view(run2.requestedModel);
      return;
    }
    const executable = await this.resolveExecutableForQuota();
    const observation = await this.quota.observe(executable);
    task.quota = this.quota.view(run2.requestedModel, observation);
    if (task.run === run2 && !run2.finalized) {
      await this.append(task, run2.runId, "quota_observed", { attemptedAt: observation.attemptedAt, observedAt: observation.observedAt, snapshot: task.quota.snapshot, recommendation: task.quota.recommendation, alternate: task.quota.alternate, failure: observation.failure, betweenTurns: true });
    }
  }
  async resolveExecutableForQuota() {
    if (!this.launcherPath) return null;
    const { resolveClaudeExecutable: resolveClaudeExecutable2 } = await Promise.resolve().then(() => (init_cli_resolver(), cli_resolver_exports));
    const resolved = await resolveClaudeExecutable2({ launcherPath: this.launcherPath });
    return resolved.status === "resolved" ? resolved : null;
  }
  async onWorkerExit(task, run2, code, signal) {
    if (task.run !== run2 || run2.finalized || run2.finalizing || this.stopping) return;
    task.disconnected = true;
    task.record.requiresReview = true;
    task.record.reviewReason = "O worker desapareceu sem resultado; a execu\xE7\xE3o ficou incerta.";
    task.worker = null;
    run2.status = "UNCERTAIN";
    run2.endedAt = (/* @__PURE__ */ new Date()).toISOString();
    task.phase = "terminal";
    for (const [requestId] of task.pending) task.resolvedRequests.add(requestId);
    task.pending.clear();
    this.changed(task);
    const runDir = path14.join(task.dir, "runs", run2.runId);
    const reconciliation = await reconcileRunProcesses(runDir, run2.workerPid, true);
    await this.append(task, run2.runId, "worker_disconnected", {
      workerPid: run2.workerPid,
      exitCode: code,
      signal,
      reconciledBy: "process-identity",
      descendantsClean: reconciliation.clean,
      survivingPids: reconciliation.survivingPids,
      note: reconciliation.note
    });
    await this.persistRecord(task);
    await this.settleLock(task, run2, reconciliation.clean, reconciliation.note);
    await this.writeCurrentRunBestEffort(task, { runId: run2.runId, runToken: run2.runToken, status: "UNCERTAIN", workerPid: null, workerStartedAt: run2.workerStartedAt, startedAt: run2.startedAt, workspace: run2.contract.workspace, writerLockKey: null, runDir });
    await this.writeDerivedNow(task, run2.runId, true);
    run2.finalized = true;
    this.changed(task);
  }
  /**
   * Settles a run. The terminal state is published only after the worker tree
   * is reconciled, the writer lock released or quarantined, and the session
   * pointer and derived files written.
   */
  async finalize(task, run2, status, code, message, exitCode, failureStage) {
    if (task.run !== run2 || run2.finalized || run2.finalizing) return;
    run2.finalizing = true;
    const endedAt = (/* @__PURE__ */ new Date()).toISOString();
    run2.failureCode = code;
    run2.failureStage = failureStage;
    if (task.endTimer) clearTimeout(task.endTimer);
    task.endTimer = null;
    task.currentTool = null;
    for (const [requestId] of task.pending) task.resolvedRequests.add(requestId);
    task.pending.clear();
    const runDir = path14.join(task.dir, "runs", run2.runId);
    try {
      if (task.worker?.pid) {
        const pid = task.worker.pid;
        try {
          task.worker.send({ t: "exit" });
        } catch {
        }
        await waitForExit(pid, 500);
      }
      const reconciliation = await reconcileRunProcesses(runDir, run2.workerPid, exitCode !== 0);
      task.worker = null;
      task.workerReady = false;
      await this.settleLock(task, run2, reconciliation.clean, reconciliation.note);
      if (!reconciliation.clean) {
        task.record.requiresReview = true;
        task.record.reviewReason = reconciliation.note;
        await this.persistRecord(task);
        await this.append(task, run2.runId, "descendants_not_reconciled", { survivingPids: reconciliation.survivingPids, note: reconciliation.note });
      }
      if (run2.sessionId && run2.sessionConfirmed) {
        task.previousSessionId = run2.sessionId;
        await writeFileAtomic(path14.join(task.dir, "session.json"), JSON.stringify({ sessionId: run2.sessionId, runId: run2.runId, updatedAt: endedAt, resultFile: path14.join(runDir, "resultado.json") }, null, 2));
      }
      await this.writeCurrentRunBestEffort(task, { runId: run2.runId, runToken: run2.runToken, status, workerPid: null, workerStartedAt: run2.workerStartedAt, startedAt: run2.startedAt, workspace: run2.contract.workspace, writerLockKey: null, runDir });
      await this.writeDerivedNow(task, run2.runId, true, { status, code, message, exitCode, endedAt, failureStage });
      if (run2.harnessFinalizationFailure === "before-public-event") throw Object.assign(new Error("Falha simulada antes do evento terminal p\xFAblico."), { code: "HARNESS_FINALIZATION_FAILURE" });
      await this.append(task, run2.runId, "run_ended", { status, code, message, exitCode, endedAt, failureStage });
      run2.status = status;
      run2.endedAt = endedAt;
      run2.finalized = true;
      task.phase = "terminal";
      this.changed(task);
      this.options.log(`task ${task.record.taskId} run ${run2.runId} ended ${status}${code ? ` (${code})` : ""}`);
    } catch (error) {
      const detail = redactSensitiveText(String(error.message ?? error)).slice(0, 300);
      task.record.requiresReview = true;
      task.record.reviewReason = `A finaliza\xE7\xE3o falhou e exige revis\xE3o: ${detail}`;
      await this.persistRecord(task).catch(() => void 0);
      try {
        if (task.worker?.pid) await terminateTree(task.worker.pid);
        const reconciliation = await reconcileRunProcesses(runDir, run2.workerPid, true);
        await this.settleLock(task, run2, false, `A finaliza\xE7\xE3o falhou; ${reconciliation.note}`);
      } catch {
      }
      task.worker = null;
      task.workerReady = false;
      run2.status = "UNCERTAIN";
      run2.endedAt = (/* @__PURE__ */ new Date()).toISOString();
      run2.finalized = true;
      task.uncertain = true;
      task.phase = "terminal";
      await this.append(task, run2.runId, "finalization_failed", { code: error.code ?? "FINALIZATION_FAILED", message: detail }).catch(() => void 0);
      await this.writeCurrentRunBestEffort(task, { runId: run2.runId, runToken: run2.runToken, status: "UNCERTAIN", workerPid: null, workerStartedAt: run2.workerStartedAt, startedAt: run2.startedAt, workspace: run2.contract.workspace, writerLockKey: run2.writerLockKey, runDir });
      await this.writeDerivedNow(task, run2.runId, true, {
        status: "UNCERTAIN",
        code: error.code ?? "FINALIZATION_FAILED",
        message: detail,
        exitCode: 1,
        endedAt: run2.endedAt,
        failureStage: "finalization"
      }).catch(() => void 0);
      this.changed(task);
      this.options.log(`task ${task.record.taskId} run ${run2.runId}: finaliza\xE7\xE3o falhou (${detail})`);
    }
    run2.finalizing = false;
  }
  async settleLock(task, run2, clean, note) {
    if (!run2.writerLockKey) return;
    const key = run2.writerLockKey;
    const holder = this.locks.get(key);
    if (!holder || holder.holderRunId !== run2.runId) {
      run2.writerLockKey = null;
      return;
    }
    if (clean) {
      this.locks.delete(key);
      await fs15.rm(path14.join(this.locksDir(), `${key}.json`), { force: true });
      if (run2.worktree) await this.settleWorktree(task, run2, run2.worktree);
    } else {
      holder.quarantined = true;
      holder.quarantineNote = note;
      await writeFileAtomic(path14.join(this.locksDir(), `${key}.json`), JSON.stringify(holder, null, 2));
      if (run2.worktree) {
        await this.append(task, run2.runId, "worktree_retained", {
          path: run2.worktree.path,
          reason: "quarantine",
          note: "A trava do worktree ficou em quarentena; o diret\xF3rio \xE9 preservado e n\xE3o ser\xE1 reutilizado at\xE9 a libera\xE7\xE3o expl\xEDcita."
        });
      }
    }
    run2.writerLockKey = null;
  }
  /**
   * Decides what happens to a worktree once its run released the lock cleanly.
   *
   * Uncommitted work is NEVER deleted. `commit` can never belong to Claude, so
   * the normal end state of a successful run is exactly that: work sitting in
   * the tree, waiting for the coordinator. Deleting it would destroy the
   * deliverable, so a dirty tree is retained and reported, and only a tree git
   * itself agrees is clean is removed.
   */
  async settleWorktree(task, run2, plan) {
    const dirty = await gitStatus(plan.path);
    if (dirty.length > 0) {
      await this.append(task, run2.runId, "worktree_retained", {
        path: plan.path,
        branch: plan.branch,
        reason: "uncommitted_work",
        files: dirty.slice(0, 50),
        note: "Trabalho n\xE3o commitado preservado: commit nunca pertence ao Claude, ent\xE3o este \xE9 o estado normal de uma execu\xE7\xE3o bem-sucedida. Commite a partir deste caminho ou remova o worktree explicitamente."
      });
      return;
    }
    const removal = await withRepositoryMutex(plan.repository.repoKey, () => removeWorktree(plan.repository, plan.path));
    await this.append(task, run2.runId, removal.removed ? "worktree_removed" : "worktree_retained", {
      path: plan.path,
      branch: plan.branch,
      ...removal.removed ? {} : { reason: "git_refused", detail: removal.reason ?? null }
    });
  }
  /**
   * Writes the authoritative ownership record of the task.
   *
   * This file is not observability: it is what a restarted broker reads to
   * learn that a run was in flight, which PID owned it and which checkout it
   * held. If it cannot be written, a crash would leave the run invisible and
   * the checkout apparently free, so the caller must fail the launch rather
   * than release work against an unrecorded state.
   */
  async writeCurrentRun(task, value) {
    await writeFileAtomic(path14.join(task.dir, "current-run.json"), JSON.stringify(value, null, 2), { maxWaitMs: 3e3 });
  }
  /** Same record, on paths that are already finishing and cannot abort. */
  async writeCurrentRunBestEffort(task, value) {
    try {
      await this.writeCurrentRun(task, value);
    } catch (error) {
      const code = error.code ?? "ERRO";
      this.options.log(`task ${task.record.taskId}: current-run.json n\xE3o gravado (${code})`);
      await this.append(task, value.runId, "ownership_record_failed", {
        file: "current-run.json",
        code,
        note: "O estado autoritativo desta execu\xE7\xE3o n\xE3o p\xF4de ser gravado; ap\xF3s um rein\xEDcio do broker ela pode n\xE3o ser reconhecida. Revise antes de retomar."
      }).catch(() => void 0);
      task.record.requiresReview = true;
      task.record.reviewReason = "O registro autoritativo da execu\xE7\xE3o falhou; o estado no disco pode estar incompleto.";
      await this.persistRecord(task).catch(() => void 0);
    }
  }
  // --------------------------------------------------------- derived files
  async reportTelemetryFailure(task, run2, file, code) {
    const now = Date.now();
    if (now - task.lastTelemetryEventAt < 1e4) return;
    task.lastTelemetryEventAt = now;
    await this.append(task, run2.runId, "telemetry_write_failed", { file, code, note: "Falha de observabilidade; a execu\xE7\xE3o continua." });
  }
  async flushDerived() {
    for (const task of this.tasks.values()) {
      if (!task.derivedDirty || !task.run || !task.writer) continue;
      task.derivedDirty = false;
      await this.writeDerivedNow(task, task.run.runId, false);
    }
  }
  async writeDerivedNow(task, runId, final, terminal) {
    const runDir = path14.join(task.dir, "runs", runId);
    const writer = task.writer && task.writer.directory === runDir ? task.writer : new StateWriter({ directory: runDir, telemetryMaxWaitMs: 1500, finalMaxWaitMs: 15e3, onTelemetryFailure: (failure) => {
      if (task.run) {
        task.run.telemetryFailures += 1;
        void this.reportTelemetryFailure(task, task.run, failure.file, failure.code);
      }
    } });
    const events = (await task.log.readFrom(0)).filter((event) => event.runId === runId);
    if (terminal) events.push({ seq: (events.at(-1)?.seq ?? 0) + 1, ts: terminal.endedAt, type: "run_ended", taskId: task.record.taskId, runId, threadId: task.record.threadId, data: terminal });
    const derived = deriveCompatibilityFiles(events, { processAlive: Boolean(task.worker) });
    const llmUsage = this.usageView(task);
    const status = { ...derived.status, llmUsage, telemetryFailures: task.run?.telemetryFailures ?? derived.status.telemetryFailures, requiresReview: derived.status.requiresReview || task.record.requiresReview };
    await writer.writeStatus(status);
    try {
      await writeFileAtomic(path14.join(runDir, "acompanhamento.txt"), derived.acompanhamento, { maxWaitMs: 1500 });
    } catch {
    }
    if (final) {
      try {
        const outcome = await writer.writeFinalResult({ ...derived.result, llmUsage, telemetryFailures: status.telemetryFailures });
        if (outcome.fallback) await this.append(task, runId, "final_result_fallback", { path: outcome.path });
      } catch (error) {
        await this.append(task, runId, "final_result_not_persisted", { code: error.code ?? "FINAL_RESULT_NOT_PERSISTED", message: redactSensitiveText(error.message).slice(0, 300) }).catch(() => void 0);
        this.options.log(`task ${task.record.taskId}: resultado final N\xC3O persistido (${error.code ?? "erro"})`);
        throw error;
      }
    }
  }
  // ------------------------------------------------------------ supervision
  superviseAll() {
    for (const task of this.tasks.values()) {
      const run2 = task.run;
      if (!run2 || run2.finalized) continue;
      const evaluation = evaluateSupervision({
        now: Date.now(),
        runStartedAt: Date.parse(run2.startedAt),
        lastActivityAt: task.lastActivityAt,
        phase: task.phase,
        processAlive: Boolean(task.worker && task.worker.pid && isAlive2(task.worker.pid)),
        coordinatorLastSeenAt: task.coordinatorLastSeenAt,
        pendingRequests: task.pending.size,
        brokerRestartedDuringRun: task.uncertain,
        terminal: run2.finalized,
        thresholds: this.thresholds
      });
      for (const alert of evaluation.alerts) {
        if (task.alertsRaised.has(alert)) continue;
        task.alertsRaised.add(alert);
        void this.append(task, run2.runId, "alert", { alert, action: "none", note: "Alerta de supervis\xE3o; nenhum encerramento autom\xE1tico." }).then(() => this.changed(task));
      }
    }
  }
  // ------------------------------------------------------------------ views
  usageView(task) {
    return { claude: task.claudeUsage.snapshot(), codex: task.codexUsage };
  }
  async refreshUsage(task, force = false) {
    if (task.usageRefresh) return task.usageRefresh;
    if (this.stopping) return task.codexUsage;
    const pending = (async () => {
      const snapshot = await this.codexUsage.refresh(task.record.threadId, { force });
      if (this.stopping) return snapshot;
      task.codexUsage = snapshot;
      await this.append(task, task.run?.runId ?? "none", "codex_usage_observed", { snapshot });
      this.changed(task);
      if (task.run) await this.writeDerivedNow(task, task.run.runId, task.run.finalized);
      return snapshot;
    })().finally(() => {
      task.usageRefresh = null;
    });
    task.usageRefresh = pending;
    return pending;
  }
  refreshAllUsage() {
    for (const task of this.tasks.values()) void this.refreshUsage(task);
  }
  async changedFiles(task) {
    const workspace = task.record.workspace;
    if (!workspace) return { observed: [], claudeAuthored: [], observedAt: null };
    const cached = task.changedFilesCache;
    let observed = cached?.observed ?? [];
    if (!cached || Date.now() - cached.at > 5e3) {
      observed = await gitStatus(workspace);
      task.changedFilesCache = { at: Date.now(), observed };
    }
    const authored = task.run ? [...task.run.claudeAuthored].map((file) => path14.relative(workspace, file).replace(/\\/g, "/")) : [];
    return { observed, claudeAuthored: authored, observedAt: new Date(task.changedFilesCache?.at ?? Date.now()).toISOString() };
  }
  view(task) {
    const run2 = task.run;
    const now = Date.now();
    const evaluation = evaluateSupervision({
      now,
      runStartedAt: run2 ? Date.parse(run2.startedAt) : now,
      lastActivityAt: task.lastActivityAt,
      phase: run2 && run2.finalizing && !run2.finalized ? "busy_model" : task.phase,
      processAlive: Boolean(task.worker && task.worker.pid && isAlive2(task.worker.pid)) || Boolean(run2 && run2.finalizing && !run2.finalized),
      coordinatorLastSeenAt: task.coordinatorLastSeenAt,
      pendingRequests: task.pending.size,
      brokerRestartedDuringRun: task.uncertain,
      terminal: !run2 || run2.finalized,
      thresholds: this.thresholds
    });
    const state = task.uncertain ? "uncertain" : task.disconnected ? "disconnected" : evaluation.state;
    const runStatus = run2 ? (state === "disconnected" || state === "uncertain") && (run2.status === "RUNNING" || run2.status === "STARTING") ? "UNCERTAIN" : run2.status : null;
    return {
      taskId: task.record.taskId,
      threadId: task.record.threadId,
      workspace: task.record.workspace,
      state,
      simulated: run2?.simulated ?? this.options.harness,
      alerts: [...task.alertsRaised],
      coordinatorPresence: evaluation.coordinatorPresence,
      coordinatorLastSeenAt: task.coordinatorLastSeenAt ? new Date(task.coordinatorLastSeenAt).toISOString() : null,
      coordinatorLabel: evaluation.coordinatorLabel,
      // Supervision can see the worker is gone before the exit callback runs;
      // its verdict counts immediately so the panel never shows a disconnected
      // task that claims no review is needed. onWorkerExit persists it.
      requiresReview: task.record.requiresReview || task.uncertain || task.disconnected || evaluation.requiresReview,
      currentRun: run2 ? {
        runId: run2.runId,
        status: runStatus ?? run2.status,
        sessionId: run2.sessionId,
        requestedModel: run2.requestedModel,
        modelReason: run2.modelReason,
        observedModel: run2.observedModel,
        effortConfigured: run2.contract.effort,
        effortObservedByCli: run2.effortObservedByCli,
        effortConfirmed: null,
        currentTool: task.currentTool,
        workerPid: run2.workerPid,
        failureStage: run2.failureStage,
        failureCode: run2.failureCode,
        telemetryFailures: run2.telemetryFailures,
        startedAt: run2.startedAt,
        endedAt: run2.endedAt,
        lastActivityAt: new Date(task.lastActivityAt).toISOString(),
        elapsedSeconds: Math.max(0, Math.round(((run2.endedAt ? Date.parse(run2.endedAt) : now) - Date.parse(run2.startedAt)) / 1e3)),
        turns: run2.turns,
        profile: run2.contract.profile,
        contractVersion: run2.contract.version,
        resumeMode: run2.resumeMode
      } : null,
      previousSessionId: task.previousSessionId,
      pendingRequests: [...task.pending.values()],
      queue: task.queue.map((entry) => this.queueView(entry)),
      quota: task.quota ?? this.quota.view(run2?.requestedModel ?? "claude-fable-5-1"),
      usage: this.usageView(task),
      // Relative, like changedFiles() already returns. They disagreed before —
      // view() emitted absolute paths and only the single-task GET overwrote
      // them — which a fleet of worktrees would have made unreadable: two
      // absolute paths from two checkouts look nearly identical.
      changedFiles: {
        observed: task.changedFilesCache?.observed ?? [],
        claudeAuthored: run2 && task.record.workspace ? [...run2.claudeAuthored].map((file) => path14.relative(task.record.workspace, file).replace(/\\/g, "/")).filter((file) => file && !file.startsWith("..")) : [],
        observedAt: task.changedFilesCache ? new Date(task.changedFilesCache.at).toISOString() : null
      },
      worktree: run2?.worktree ? { path: run2.worktree.path, branch: run2.worktree.branch, baseRef: run2.worktree.baseRef, repoKey: run2.worktree.repository.repoKey, declaredWorkspace: run2.declaredWorkspace } : null,
      reviewPending: true,
      createdAt: task.record.createdAt,
      updatedAt: task.updatedAt,
      lastEventSeq: task.log.lastSeq
    };
  }
  views(scope) {
    return [...this.tasks.values()].filter((task) => !scope || task.record.taskId === scope).map((task) => this.view(task));
  }
  async runsOf(task) {
    const dir = path14.join(task.dir, "runs");
    let entries = [];
    try {
      entries = await fs15.readdir(dir);
    } catch {
      return [];
    }
    const runs = [];
    for (const runId of entries.sort()) {
      const status = await readJsonShared(path14.join(dir, runId, "status.json"));
      runs.push({ runId, status: status.status === "ok" ? status.value.status ?? "UNKNOWN" : "UNKNOWN", startedAt: status.status === "ok" ? status.value.startedAt ?? null : null, endedAt: status.status === "ok" ? status.value.endedAt ?? null : null });
    }
    return runs;
  }
  async blobPage(task, blobId, page) {
    if (!/^blob-[a-f0-9-]{36}$/.test(blobId)) return null;
    const read = await readJsonShared(path14.join(task.dir, "blobs", `${blobId}.json`));
    if (read.status !== "ok") return null;
    const paged = previewPage(read.value.text, page);
    return { ...paged, truncated: read.value.truncated, totalChars: read.value.totalChars };
  }
  /**
   * Global replay for a reconnecting subscriber. `gapped` is true when older
   * events could not fit the page, so the client resets rather than assuming
   * continuity.
   */
  async replay(cursor, taskId, scope, limit = 2e3) {
    const collected = [];
    let gapped = false;
    for (const task of this.tasks.values()) {
      if (taskId && task.record.taskId !== taskId) continue;
      if (scope && task.record.taskId !== scope) continue;
      const page = await task.log.readPage(0, limit);
      const oldestAvailable = page.events[0]?.gseq ?? null;
      if (page.gapped && (oldestAvailable === null || oldestAvailable > cursor + 1)) gapped = true;
      for (const event of page.events) if ((event.gseq ?? 0) > cursor) collected.push(event);
    }
    collected.sort((a, b) => (a.gseq ?? 0) - (b.gseq ?? 0));
    if (collected.length > limit) {
      gapped = true;
      return { events: collected.slice(collected.length - limit), gapped };
    }
    return { events: collected, gapped };
  }
};
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeRecord(record2) {
  return {
    ...record2,
    requiresReview: record2.requiresReview === true,
    reviewReason: typeof record2.reviewReason === "string" ? record2.reviewReason : null
  };
}

// src/broker/singleton.ts
import { closeSync as closeSync2, openSync as openSync2, readFileSync as readFileSync3, renameSync, statSync as statSync2, writeFileSync as writeFileSync2, unlinkSync as unlinkSync2, mkdirSync as mkdirSync2 } from "node:fs";
import { spawn as spawn8 } from "node:child_process";
import { createHash as createHash5 } from "node:crypto";
import path15 from "node:path";
function readOwner(file) {
  try {
    const parsed = JSON.parse(readFileSync3(file, "utf8"));
    return typeof parsed.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}
function errorCode(error) {
  return error?.code;
}
function reclaimed(file, expected) {
  if (process.platform !== "win32") return false;
  const claim = `${file}.reclaim-${process.pid}-${Date.now().toString(36)}`;
  try {
    renameSync(file, claim);
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
  const taken = readOwner(claim);
  const sameOwner = expected === null ? taken === null : taken !== null && taken.pid === expected.pid && taken.startedAt === expected.startedAt;
  if (!sameOwner) {
    try {
      renameSync(claim, file);
    } catch {
      try {
        unlinkSync2(claim);
      } catch {
      }
    }
    return false;
  }
  try {
    unlinkSync2(claim);
  } catch {
  }
  return true;
}
var OWNER_WRITE_GRACE_MS = 1e4;
function heldByLiveProcess(file, now = Date.now()) {
  let createdAt;
  try {
    createdAt = statSync2(file).mtimeMs;
  } catch (error) {
    return errorCode(error) !== "ENOENT";
  }
  const owner = readOwner(file);
  if (!owner) {
    if (now - createdAt < OWNER_WRITE_GRACE_MS) return true;
    return !reclaimed(file, null);
  }
  let alive;
  try {
    process.kill(owner.pid, 0);
    alive = true;
  } catch (error) {
    alive = errorCode(error) === "EPERM";
  }
  if (!alive) return !reclaimed(file, owner);
  return true;
}
var SingletonBusyError = class extends Error {
  code = "BROKER_ALREADY_RUNNING";
  owner;
  constructor(owner) {
    super(owner ? `Outro broker j\xE1 est\xE1 ativo para este state root (pid ${owner.pid}).` : "Outro broker j\xE1 est\xE1 ativo para este state root.");
    this.name = "SingletonBusyError";
    this.owner = owner;
  }
};
function acquireFileSingleton(stateRoot) {
  const dir = path15.join(stateRoot, "broker");
  mkdirSync2(dir, { recursive: true });
  const file = path15.join(dir, "broker.lock");
  if (heldByLiveProcess(file)) throw new SingletonBusyError(readOwner(file));
  let descriptor;
  try {
    descriptor = openSync2(file, "wx");
  } catch (error) {
    if (error.code === "EEXIST") throw new SingletonBusyError(readOwner(file));
    throw error;
  }
  writeFileSync2(descriptor, JSON.stringify({ pid: process.pid, startedAt: (/* @__PURE__ */ new Date()).toISOString() }));
  let released = false;
  return {
    file,
    lost: new Promise(() => void 0),
    async release() {
      if (released) return;
      released = true;
      try {
        closeSync2(descriptor);
      } catch {
      }
      try {
        unlinkSync2(file);
      } catch {
      }
    }
  };
}
async function acquireWindowsMutex(stateRoot) {
  const dir = path15.join(stateRoot, "broker");
  mkdirSync2(dir, { recursive: true });
  const file = path15.join(dir, "broker.lock");
  const key = createHash5("sha256").update(path15.resolve(stateRoot).toLowerCase()).digest("hex").slice(0, 32);
  const mutexName = `Local\\CodeOrquestra-${key}`;
  const script = [
    `$m=[Threading.Mutex]::new($false,'${mutexName}')`,
    "if(-not $m.WaitOne(0)){[Console]::Out.WriteLine('BUSY');exit 4}",
    "[Console]::Out.WriteLine('ACQUIRED')",
    "$null=[Console]::In.ReadLine()",
    "try{$m.ReleaseMutex()}catch{}",
    "$m.Dispose()"
  ].join(";");
  const child = spawn8("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true
  });
  let released = false;
  let lostResolve;
  const lost = new Promise((resolve) => {
    lostResolve = resolve;
  });
  const closed = new Promise((resolve) => child.once("close", () => {
    resolve();
    if (!released) lostResolve();
  }));
  let outcome;
  try {
    outcome = await new Promise((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(new Error("BROKER_MUTEX_TIMEOUT")), 1e4);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        text += chunk;
        const line = text.split(/\r?\n/, 1)[0]?.trim();
        if (line === "ACQUIRED" || line === "BUSY") {
          clearTimeout(timer);
          resolve(line);
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        if (!text.includes("ACQUIRED") && !text.includes("BUSY")) {
          clearTimeout(timer);
          reject(new Error(`BROKER_MUTEX_HELPER_EXIT_${String(code)}`));
        }
      });
    });
  } catch (error) {
    try {
      child.kill();
    } catch {
    }
    await closed;
    throw error;
  }
  if (outcome === "BUSY") {
    child.stdin?.end();
    throw new SingletonBusyError(readOwner(file));
  }
  const owner = { pid: process.pid, startedAt: (/* @__PURE__ */ new Date()).toISOString() };
  try {
    writeFileSync2(file, JSON.stringify(owner), "utf8");
  } catch (error) {
    released = true;
    try {
      child.kill();
    } catch {
    }
    await closed;
    throw error;
  }
  return {
    file,
    ...child.pid !== void 0 ? { monitorPid: child.pid } : {},
    lost,
    async release() {
      if (released) return;
      released = true;
      try {
        child.stdin?.end("\n");
      } catch {
      }
      const graceful = await Promise.race([closed.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 2e3))]);
      if (!graceful) {
        try {
          child.kill();
        } catch {
        }
        await closed;
      }
      const current = readOwner(file);
      if (current?.pid === owner.pid && current.startedAt === owner.startedAt) {
        try {
          unlinkSync2(file);
        } catch {
        }
      }
    }
  };
}
async function acquireBrokerSingleton(stateRoot) {
  if (process.platform !== "win32") return acquireFileSingleton(stateRoot);
  try {
    return await acquireWindowsMutex(stateRoot);
  } catch (error) {
    if (!isMissingInterpreter2(error)) throw error;
    process.stderr.write(
      "CodeOrquestra: PowerShell 7 (pwsh) n\xE3o est\xE1 instalado; o singleton do broker passa a usar arquivo de trava exclusivo, o mesmo mecanismo j\xE1 usado fora do Windows. Continua valendo um broker por state root.\n"
    );
    return acquireFileSingleton(stateRoot);
  }
}
function isMissingInterpreter2(error) {
  return /ENOENT/.test(error instanceof Error ? error.message : String(error));
}

// src/broker/broker.ts
var Broker = class {
  options;
  identity;
  hub = new SseHub();
  tasks;
  /** Changes on every broker start; clients reset their cursor when it moves. */
  cursorEpoch = randomUUID2();
  server = null;
  port = 0;
  baseUrl = "";
  startedAt = (/* @__PURE__ */ new Date()).toISOString();
  brokerDir;
  logFile;
  assets;
  shuttingDown = false;
  singleton = null;
  constructor(options) {
    this.options = options;
    this.brokerDir = path16.join(options.stateRoot, "broker");
    this.logFile = path16.join(this.brokerDir, "broker.log");
    this.identity = new IdentityRegistry(this.brokerDir);
    this.assets = new StaticAssets(dashboardDir());
    this.tasks = new TaskManager({
      stateRoot: options.stateRoot,
      log: (line) => this.log(line),
      onEvent: (event) => this.hub.broadcastEvent(event),
      observers: (taskId) => this.hub.observerCount(taskId),
      onTaskChanged: (view) => this.hub.broadcastTask(view),
      onTransient: (frame) => this.hub.broadcastTransient(frame),
      harness: options.harness,
      ...options.supervision ? { supervision: options.supervision } : {},
      ...options.harness ? { quotaWaitMs: 5e3 } : {}
    });
  }
  log(line) {
    const text = `${(/* @__PURE__ */ new Date()).toISOString()} ${redactSensitiveText(line)}
`;
    void appendTextSafe(this.logFile, text).catch(() => void 0);
  }
  async start() {
    await fs16.mkdir(this.brokerDir, { recursive: true });
    this.singleton = await acquireBrokerSingleton(this.options.stateRoot);
    void this.singleton.lost.then(async () => {
      this.log("broker singleton ownership was lost; shutting down to prevent a second owner");
      await this.stop();
    }).catch((error) => this.log(`singleton loss shutdown failed: ${error.message}`));
    try {
      await this.identity.load();
      if (this.shuttingDown) throw new Error("BROKER_SINGLETON_LOST_DURING_STARTUP");
      await this.assets.load();
      if (this.shuttingDown) throw new Error("BROKER_SINGLETON_LOST_DURING_STARTUP");
      await this.tasks.start();
      if (this.shuttingDown) throw new Error("BROKER_SINGLETON_LOST_DURING_STARTUP");
      this.server = http.createServer((req, res) => void this.handle(req, res));
      this.server.keepAliveTimeout = 65e3;
      await new Promise((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(this.options.port, "127.0.0.1", () => resolve());
      });
    } catch (error) {
      await this.singleton?.release();
      this.singleton = null;
      throw error;
    }
    const address = this.server.address();
    this.port = typeof address === "object" && address ? address.port : this.options.port;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    const bootstrapUrl = `${this.baseUrl}/bootstrap?token=${this.identity.mintBootstrapToken(null)}`;
    const announcement = { event: "broker_listening", address: "127.0.0.1", port: this.port, baseUrl: this.baseUrl, bootstrapUrl, secretFile: this.identity.secretPath, stateRoot: this.options.stateRoot, pid: process.pid, cursorEpoch: this.cursorEpoch };
    await writeFileAtomic(path16.join(this.brokerDir, "broker.json"), JSON.stringify({ pid: process.pid, port: this.port, baseUrl: this.baseUrl, startedAt: this.startedAt, secretFile: this.identity.secretPath, version: RUNTIME_VERSION, product: BRAND.name }, null, 2));
    this.log(`broker listening on ${this.baseUrl} (pid ${process.pid}, painel ${this.assets.dir ? "compilado" : "n\xE3o compilado"})`);
    return announcement;
  }
  async stop() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log("broker shutting down");
    this.hub.closeAll();
    await this.tasks.stop();
    if (this.server) await new Promise((resolve) => this.server.close(() => resolve()));
    try {
      await fs16.rm(path16.join(this.brokerDir, "broker.json"), { force: true });
    } catch {
    }
    await this.singleton?.release();
    this.singleton = null;
  }
  async handle(req, res) {
    applySecurityHeaders(res);
    try {
      assertHost(req, this.port);
      const url = new URL(req.url ?? "/", this.baseUrl);
      if (req.method === "OPTIONS") throw new HttpError(405, "METHOD_NOT_ALLOWED");
      if (url.pathname === "/bootstrap") return this.bootstrap(url, res);
      if (url.pathname.startsWith("/api/")) return await this.api(req, res, url);
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "METHOD_NOT_ALLOWED");
      if (!this.assets.dir) {
        if (url.pathname === "/") {
          res.statusCode = 503;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>${BRAND.name}</title><body><h1>Painel n\xE3o compilado</h1><p>Execute o build do runtime para gerar dist/dashboard.</p></body></html>`);
          return;
        }
        throw new HttpError(404, "NOT_FOUND");
      }
      const served = await this.assets.serve(url.pathname, res);
      if (!served) throw new HttpError(404, "NOT_FOUND");
    } catch (error) {
      if (error instanceof HttpError) {
        sendError(res, error);
        return;
      }
      this.log(`erro interno: ${error.name}`);
      sendError(res, new HttpError(500, "INTERNAL_ERROR"));
    }
  }
  bootstrap(url, res) {
    const token2 = url.searchParams.get("token") ?? "";
    const outcome = this.identity.redeemBootstrapToken(token2);
    if (!outcome.ok) throw new HttpError(403, outcome.code);
    res.statusCode = 303;
    res.setHeader("set-cookie", `${SESSION_COOKIE}=${outcome.session.cookie}; HttpOnly; SameSite=Strict; Path=/`);
    res.setHeader("location", "/");
    res.end();
  }
  requireIdentity(req) {
    const identity = resolveIdentity(req, this.identity);
    if (!identity) throw new HttpError(401, "UNAUTHORIZED");
    return identity;
  }
  /**
   * Privileged lifecycle and bootstrap routes require the local administrative
   * secret. Any local process that can read the secret file is administratively
   * equivalent to the coordinator; the MCP label is refused as defence in
   * depth, not as isolation from a same-user process.
   */
  requireAdministrative(identity) {
    if (identity.source !== "local-secret") throw new HttpError(403, "LOCAL_ADMIN_REQUIRED");
  }
  scopedTask(identity, taskId) {
    if (identity.taskScope && identity.taskScope !== taskId) throw new HttpError(404, "TASK_NOT_FOUND");
    return this.tasks.getTask(taskId);
  }
  /** MCP callers must present the task handle for every task-scoped action. */
  bindHandle(identity, task, body, url) {
    const handle = typeof body.taskHandle === "string" ? body.taskHandle : url.searchParams.get("taskHandle");
    if (identity.source === "mcp" || handle) {
      const resolved = this.tasks.resolveHandle(handle);
      if (resolved !== task) throw new HttpError(403, "TASK_HANDLE_MISMATCH");
    }
  }
  async api(req, res, url) {
    const method = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean);
    const identity = this.requireIdentity(req);
    if (method === "POST") assertActionAllowed(req, identity, this.baseUrl);
    if (method === "POST" && this.shuttingDown && !(parts[1] === "broker" && parts[2] === "shutdown")) {
      throw new HttpError(503, "BROKER_SHUTTING_DOWN", { message: "O broker est\xE1 encerrando; a\xE7\xF5es de altera\xE7\xE3o n\xE3o s\xE3o mais aceitas." });
    }
    const body = method === "POST" ? await readJsonBody(req) : {};
    if (parts[1] === "health" && method === "GET") return sendJson(res, 200, { pid: process.pid, product: BRAND.name, version: RUNTIME_VERSION, startedAt: this.startedAt, tasks: this.tasks.tasks.size, cursorEpoch: this.cursorEpoch });
    if (parts[1] === "status" && method === "GET") {
      if (identity.source === "browser") this.tasks.refreshAllUsage();
      return sendJson(res, 200, {
        broker: { version: RUNTIME_VERSION, tagline: BRAND.tagline, startedAt: this.startedAt, pid: process.pid, simulatedAdapter: this.options.harness },
        identity: { source: identity.source, taskScope: identity.taskScope },
        tasks: identity.source === "mcp" ? [] : this.tasks.views(identity.taskScope),
        cursorEpoch: this.cursorEpoch
      });
    }
    if (parts[1] === "broker" && parts[2] === "shutdown" && method === "POST") {
      this.requireAdministrative(identity);
      sendJson(res, 202, { shuttingDown: true });
      setTimeout(() => void this.stop().then(() => process.exit(0)), 50);
      return;
    }
    if (parts[1] === "dashboard-url" && method === "POST") {
      if (identity.source === "browser") throw new HttpError(403, "LOCAL_ADMIN_REQUIRED");
      let scope = null;
      if (typeof body.taskHandle === "string") scope = this.tasks.resolveHandle(body.taskHandle).record.taskId;
      else if (identity.source === "mcp") throw new HttpError(403, "TASK_HANDLE_REQUIRED");
      else this.requireAdministrative(identity);
      const token2 = this.identity.mintBootstrapToken(scope);
      return sendJson(res, 200, { url: `${this.baseUrl}/bootstrap?token=${token2}`, scope, note: "Link de uso \xFAnico; abra no navegador desta m\xE1quina." });
    }
    if (parts[1] === "locks" && parts[2] && parts[3] === "release" && method === "POST") {
      this.requireAdministrative(identity);
      return sendJson(res, 200, await this.tasks.releaseQuarantinedLock(parts[2], {
        note: typeof body.note === "string" ? body.note : null,
        confirmHistoricalRisk: body.confirmHistoricalRisk === true,
        expectedTaskId: typeof body.expectedTaskId === "string" ? body.expectedTaskId : null,
        expectedRunId: typeof body.expectedRunId === "string" ? body.expectedRunId : null
      }, identity.source));
    }
    if (parts[1] === "locks" && method === "GET") {
      this.requireAdministrative(identity);
      return sendJson(res, 200, [...this.tasks.locks.values()].map((lock) => ({ workspaceKey: lock.workspaceKey, workspace: lock.workspace, holderTaskId: lock.holderTaskId, holderRunId: lock.holderRunId, holderPid: lock.holderPid, acquiredAt: lock.acquiredAt, quarantined: lock.quarantined, ...lock.quarantineNote ? { note: lock.quarantineNote } : {} })));
    }
    if (parts[1] === "repos" && parts[2] === "worktree-policy" && method === "POST") {
      this.requireAdministrative(identity);
      const workspace = typeof body.repo === "string" ? body.repo : typeof body.workspace === "string" ? body.workspace : "";
      if (!workspace) throw new HttpError(400, "WORKSPACE_REQUIRED", { message: 'Informe o caminho do reposit\xF3rio em "repo".' });
      const repository = await resolveRepository(workspace);
      const record2 = await this.tasks.worktreePolicy.enrol({
        repoKey: repository.repoKey,
        canonicalWorkspace: repository.topLevel,
        enabledBy: "local-secret",
        note: typeof body.note === "string" ? body.note : "",
        maxParallelRuns: body.maxParallelRuns,
        maxRetainedWorktrees: body.maxRetainedWorktrees,
        worktreeRoot: body.worktreeRoot
      });
      this.log(`worktrees habilitados para ${repository.topLevel} (repoKey ${repository.repoKey})`);
      return sendJson(res, 200, record2);
    }
    if (parts[1] === "worktrees" && method === "GET") {
      this.requireAdministrative(identity);
      return sendJson(res, 200, await this.tasks.worktreeInventory());
    }
    if (parts[1] === "worktrees" && parts[2] === "release" && method === "POST") {
      this.requireAdministrative(identity);
      const target = typeof body.path === "string" ? body.path : "";
      if (!target) throw new HttpError(400, "PATH_REQUIRED", { message: 'Informe o caminho do worktree em "path".' });
      return sendJson(res, 200, await this.tasks.releaseWorktree(target, {
        note: typeof body.note === "string" ? body.note : null,
        confirmDiscardUncommitted: body.confirmDiscardUncommitted === true
      }, identity.source));
    }
    if (parts[1] === "quota" && method === "GET") {
      return sendJson(res, 200, this.tasks.quota.view("claude-fable-5-1"));
    }
    if (parts[1] === "events" && method === "GET") return await this.sse(req, res, url, identity);
    if (parts[1] === "tasks") {
      if (parts.length === 2 && method === "GET") {
        if (identity.source === "mcp") throw new HttpError(403, "TASK_HANDLE_REQUIRED");
        return sendJson(res, 200, this.tasks.views(identity.taskScope));
      }
      if (parts[2] === "register" && method === "POST") {
        this.requireAdministrative(identity);
        const source2 = typeof body.source === "string" ? body.source : "unknown";
        const result = await this.tasks.register(body.codexThreadId, source2);
        return sendJson(res, 201, result);
      }
      if (parts[2] === "by-handle" && method === "POST") {
        const task2 = this.tasks.resolveHandle(body.taskHandle);
        return sendJson(res, 200, { taskId: task2.record.taskId, threadId: task2.record.threadId, requiresReview: task2.record.requiresReview });
      }
      const taskId = parts[2] ?? "";
      const action = parts[3] ?? null;
      const task = this.scopedTask(identity, taskId);
      if (!action && method === "GET") {
        if (identity.source === "mcp") this.bindHandle(identity, task, body, url);
        if (identity.source === "browser") void this.tasks.refreshUsage(task);
        const view = this.tasks.view(task);
        view.changedFiles = await this.tasks.changedFiles(task);
        return sendJson(res, 200, view);
      }
      if (action === "runs" && method === "GET") {
        this.bindHandle(identity, task, body, url);
        return sendJson(res, 200, await this.tasks.runsOf(task));
      }
      if (action === "runs" && method === "POST") {
        if (identity.source === "browser") throw new HttpError(403, "LOCAL_ADMIN_REQUIRED");
        const resolved = this.tasks.resolveHandle(body.taskHandle);
        if (resolved !== task) throw new HttpError(403, "TASK_HANDLE_MISMATCH");
        const harness = this.options.harness && body.harness && typeof body.harness === "object" ? body.harness : null;
        const result = await this.tasks.startRun(task, body.job, harness, identity.source, body.acknowledgeReview === true, body.observation);
        return sendJson(res, 202, result);
      }
      if (action === "events" && method === "GET") {
        this.bindHandle(identity, task, body, url);
        const cursor = Number(url.searchParams.get("cursor") ?? "0") || 0;
        const waitMs = Math.min(3e4, Math.max(0, Number(url.searchParams.get("waitMs") ?? "0") || 0));
        const limit = Math.min(2e3, Math.max(1, Number(url.searchParams.get("limit") ?? "500") || 500));
        if (identity.source !== "browser") this.tasks.touchCoordinator(task);
        const before = Number(url.searchParams.get("before") ?? "0") || 0;
        if (before > 0) {
          const older = await task.log.readBefore(before, limit);
          return sendJson(res, 200, { events: older.events, cursor, gapped: false, more: older.more, cursorEpoch: this.cursorEpoch, task: this.tasks.view(task) });
        }
        let page = await task.log.readPage(cursor, limit);
        if (page.events.length === 0 && waitMs > 0) {
          await new Promise((resolve) => {
            const timer = setTimeout(() => {
              unsubscribe();
              resolve();
            }, waitMs);
            const unsubscribe = task.log.subscribe(() => {
              clearTimeout(timer);
              unsubscribe();
              resolve();
            });
            req.on("close", () => {
              clearTimeout(timer);
              unsubscribe();
              resolve();
            });
          });
          page = await task.log.readPage(cursor, limit);
        }
        const last = page.events.at(-1);
        return sendJson(res, 200, { events: page.events, cursor: last ? last.seq : cursor, gapped: page.gapped, cursorEpoch: this.cursorEpoch, task: this.tasks.view(task) });
      }
      if (action === "blobs" && parts[4] && method === "GET") {
        this.bindHandle(identity, task, body, url);
        const page = Number(url.searchParams.get("page") ?? "1") || 1;
        const blob = await this.tasks.blobPage(task, parts[4], page);
        if (!blob) throw new HttpError(404, "BLOB_NOT_FOUND");
        return sendJson(res, 200, blob);
      }
      if (action === "inventory" && method === "GET") {
        this.bindHandle(identity, task, body, url);
        const workspace = url.searchParams.get("workspace") ?? task.record.workspace;
        if (!workspace) throw new HttpError(400, "WORKSPACE_REQUIRED");
        const { inventory, trust } = await this.tasks.inventoryFor(workspace);
        return sendJson(res, 200, { inventory: inventory.toJSON(), trust });
      }
      if (action === "diff" && method === "GET") {
        const file = url.searchParams.get("file");
        if (!file) throw new HttpError(400, "FILE_REQUIRED");
        return sendJson(res, 200, await this.tasks.fileDiff(task, file));
      }
      if (method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
      this.bindHandle(identity, task, body, url);
      const source = identity.source;
      switch (action) {
        case "message": {
          if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "TEXT_REQUIRED");
          const entry = await this.tasks.enqueueMessage(task, body.text, source);
          return sendJson(res, 202, entry);
        }
        case "annotations": {
          const entry = await this.tasks.annotate(task, { file: body.file, comment: body.comment, hunk: body.hunk }, source);
          return sendJson(res, 202, entry);
        }
        case "answer":
          await this.tasks.answer(task, body, source);
          return sendJson(res, 200, { resolved: true });
        case "interrupt":
          await this.tasks.interrupt(task, source);
          return sendJson(res, 202, { interrupted: true });
        case "end":
          await this.tasks.end(task, source);
          return sendJson(res, 202, { ending: true });
        case "model":
          return sendJson(res, 200, await this.tasks.setModel(task, body.model, body.reason, source));
        case "heartbeat":
          if (identity.source === "browser") throw new HttpError(403, "LOCAL_ADMIN_REQUIRED");
          this.tasks.touchCoordinator(task);
          return sendJson(res, 200, { present: true });
        case "usage-refresh":
          return sendJson(res, 200, { usage: await this.tasks.refreshUsage(task, true) });
        case "acknowledge-review":
          if (identity.source === "browser") throw new HttpError(403, "LOCAL_ADMIN_REQUIRED");
          await this.tasks.acknowledgeReview(task, typeof body.note === "string" ? body.note : null, source);
          return sendJson(res, 200, { requiresReview: task.record.requiresReview });
        case "trust": {
          if (identity.source === "browser") throw new HttpError(403, "LOCAL_ADMIN_REQUIRED");
          const workspace = typeof body.workspace === "string" ? body.workspace : task.record.workspace;
          if (!workspace) throw new HttpError(400, "WORKSPACE_REQUIRED");
          const revision = Number(body.approvalRevision);
          if (!Number.isInteger(revision) || revision < 1) throw new HttpError(400, "APPROVAL_REVISION_INVALID");
          const approved = body.approvedItems === "all" ? "all" : Array.isArray(body.approvedItems) ? body.approvedItems.filter((item) => typeof item === "string") : null;
          if (!approved) throw new HttpError(400, "APPROVED_ITEMS_REQUIRED");
          const trust = await this.tasks.approveTrust(task, workspace, revision, approved, typeof body.note === "string" ? body.note : void 0, source);
          return sendJson(res, 200, { trust });
        }
        default:
          throw new HttpError(404, "NOT_FOUND");
      }
    }
    throw new HttpError(404, "NOT_FOUND");
  }
  async sse(req, res, url, identity) {
    const taskId = url.searchParams.get("taskId");
    if (identity.source === "mcp") throw new HttpError(403, "TASK_HANDLE_REQUIRED");
    if (taskId) this.scopedTask(identity, taskId);
    const requestedEpoch = url.searchParams.get("epoch");
    const cursor = requestedEpoch && requestedEpoch !== this.cursorEpoch ? 0 : Number(url.searchParams.get("cursor") ?? "0") || 0;
    await this.hub.attach(res, {
      taskId,
      taskScope: identity.taskScope,
      cursor,
      epoch: this.cursorEpoch,
      replay: (from, id, scope) => this.tasks.replay(from, id, scope),
      snapshots: () => this.tasks.views(identity.taskScope)
    });
    req.on("close", () => void 0);
  }
};

// src/broker/client.ts
import { spawn as spawn9 } from "node:child_process";
import { promises as fs17 } from "node:fs";
import path17 from "node:path";
async function readBrokerInfo(stateRoot) {
  const read = await readJsonShared(path17.join(stateRoot, "broker", "broker.json"));
  if (read.status !== "ok") return null;
  try {
    const secret = (await fs17.readFile(read.value.secretFile, "utf8")).trim();
    const response = await fetch(`${read.value.baseUrl}/api/health`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(3e3) });
    if (!response.ok) return null;
    const health = await response.json();
    if (health.pid !== read.value.pid) return null;
    return read.value;
  } catch {
    return null;
  }
}
async function ensureBroker(stateRoot) {
  const existing = await readBrokerInfo(stateRoot);
  if (existing) return { baseUrl: existing.baseUrl, secret: (await fs17.readFile(existing.secretFile, "utf8")).trim(), pid: existing.pid, started: false };
  const child = spawn9(process.execPath, [...nodeExecArgv(), cliEntry(), "broker", "start", "--state-root", stateRoot, "--port", "0"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env
  });
  child.unref();
  const deadline = Date.now() + 2e4;
  while (Date.now() < deadline) {
    const info = await readBrokerInfo(stateRoot);
    if (info) return { baseUrl: info.baseUrl, secret: (await fs17.readFile(info.secretFile, "utf8")).trim(), pid: info.pid, started: true };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("O broker n\xE3o iniciou a tempo.");
}
async function brokerApi(stateRoot, method, pathname, body, client = "cli") {
  const broker = await ensureBroker(stateRoot);
  const response = await fetch(`${broker.baseUrl}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${broker.secret}`, "content-type": "application/json", ...client === "mcp" ? { [CLIENT_HEADER]: "mcp" } : {} },
    ...body !== void 0 ? { body: JSON.stringify(body) } : {}
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

// src/cli/main.ts
init_cli_resolver();
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
        flags[arg.slice(2)] = argv[index + 1];
        index += 1;
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}
function usage() {
  return [
    `${BRAND.name} ${RUNTIME_VERSION} \u2014 ${BRAND.tagline}`,
    BRAND.disclaimer,
    `Identificador t\xE9cnico: ${BRAND.technicalId} (alias legado: ${BRAND.legacyTechnicalId}).`,
    "",
    "Comandos:",
    "  broker start [--state-root <dir>] [--port <n>] [--announce-json]   inicia o broker local (127.0.0.1)",
    "  broker status [--state-root <dir>]                                  mostra se o broker est\xE1 ativo",
    "  broker stop [--state-root <dir>]                                    encerra o broker e seus workers",
    "  task register [--state-root <dir>] [--thread-id <id>]               registra a tarefa Codex atual e imprime o handle",
    "  task review [--task-handle <h>] [--note <texto>]                    confirma a revis\xE3o de uma execu\xE7\xE3o incerta",
    "  dashboard [--state-root <dir>] [--task-handle <h>]                  imprime um link de uso \xFAnico para o painel",
    "  worktree enable --repo <dir> --note <motivo>                        habilita worktrees paralelos neste reposit\xF3rio",
    "  worktree list                                                       lista reposit\xF3rios habilitados e worktrees \xF3rf\xE3os",
    "  start --job <job.json> --task-handle <h> [--state-root <dir>]       inicia uma execu\xE7\xE3o v2 na tarefa",
    "  doctor [--json]                                                     verifica o Claude Code instalado sem autenticar",
    "  --version"
  ].join("\n");
}
var api = brokerApi;
function parseSupervision() {
  const raw = readEnv("TEST_SUPERVISION_MS");
  if (!raw || !isHarness()) return void 0;
  try {
    const parsed = JSON.parse(raw);
    return { inactivityAlertMs: parsed.inactivityAlertMs ?? 12e5, elapsedAlertMs: parsed.elapsedAlertMs ?? 72e5, coordinatorAbsentMs: parsed.coordinatorAbsentMs ?? 9e4 };
  } catch {
    return void 0;
  }
}
async function doctor(json) {
  const launcher = await findClaudeLauncher();
  const report = {
    product: engineInfo().productName,
    technicalId: BRAND.technicalId,
    legacyTechnicalId: BRAND.legacyTechnicalId,
    version: RUNTIME_VERSION,
    node: process.version,
    runtimeMode: SOURCE_MODE ? "source" : "bundle",
    runtimeBase: RUNTIME_BASE,
    engine: "cli-instalado-do-usuario",
    vendorSdkBundled: false,
    requiredCliFlags: REQUIRED_CLI_FLAGS.length,
    cli: { status: "not_found", launcher, executablePath: null, kind: null, version: null, advertisedFlags: null, missingFlags: null, vendorCliUsed: false },
    authenticated: null,
    note: "doctor executa somente --version, --help e auth status --json do Claude Code instalado; nunca autentica nem gera."
  };
  if (launcher) {
    const resolved = await resolveClaudeExecutable({ launcherPath: launcher });
    if (resolved.status === "resolved") {
      report.cli = { status: "resolved", launcher, executablePath: resolved.executablePath, kind: resolved.kind, version: resolved.packageVersion, advertisedFlags: null, missingFlags: null, vendorCliUsed: false };
      try {
        const probe = await probeCli(resolved, { timeoutMs: 2e4 });
        const cli = report.cli;
        cli.version = probe.cliVersion;
        cli.advertisedFlags = probe.advertisedFlags?.length ?? null;
        cli.missingFlags = probe.advertisedFlags ? REQUIRED_CLI_FLAGS.filter((flag) => !probe.advertisedFlags.includes(flag)) : null;
      } catch (error) {
        report.cli.probeError = error.code ?? "PROBE_FAILED";
      }
    }
  }
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}
` : `${usage()}

${JSON.stringify(report, null, 2)}
`);
  return 0;
}
async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  if (flags.version || positional[0] === "--version") {
    process.stdout.write(`codeorquestra ${RUNTIME_VERSION} (${BRAND.legacyTechnicalId})
`);
    return 0;
  }
  const stateRoot = typeof flags["state-root"] === "string" ? path18.resolve(flags["state-root"]) : defaultStateRoot();
  const [command, sub] = positional;
  if (command === "broker" && sub === "start") {
    const supervision = parseSupervision();
    const broker = new Broker({
      stateRoot,
      port: typeof flags.port === "string" ? Number(flags.port) : 0,
      announceJson: flags["announce-json"] === true,
      harness: isHarness(),
      ...supervision ? { supervision } : {}
    });
    let announcement;
    try {
      announcement = await broker.start();
    } catch (error) {
      if (error instanceof SingletonBusyError) {
        process.stderr.write(`${error.message}
`);
        return 4;
      }
      throw error;
    }
    process.stdout.write(flags["announce-json"] === true ? `${JSON.stringify(announcement)}
` : `Broker ativo em ${announcement.baseUrl}
Painel (link de uso \xFAnico): ${announcement.bootstrapUrl}
`);
    const shutdown = () => void broker.stop().then(() => process.exit(0));
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await new Promise(() => void 0);
    return 0;
  }
  if (command === "broker" && sub === "status") {
    const info = await readBrokerInfo(stateRoot);
    process.stdout.write(`${JSON.stringify(info ? { active: true, pid: info.pid, port: info.port, baseUrl: info.baseUrl } : { active: false }, null, 2)}
`);
    return 0;
  }
  if (command === "broker" && sub === "stop") {
    const info = await readBrokerInfo(stateRoot);
    if (!info) {
      process.stdout.write("Nenhum broker ativo.\n");
      return 0;
    }
    const result = await api(stateRoot, "POST", "/api/broker/shutdown", {});
    process.stdout.write(`${JSON.stringify(result.body)}
`);
    return 0;
  }
  if (command === "task" && sub === "register") {
    const threadId = process.env.CODEX_THREAD_ID ?? (typeof flags["thread-id"] === "string" ? flags["thread-id"] : null);
    const source = process.env.CODEX_THREAD_ID ? "codex-thread" : typeof flags["thread-id"] === "string" ? "job" : null;
    if (!threadId || !source) {
      process.stderr.write("CODEX_THREAD_ID ausente. Execute este comando no terminal da tarefa Codex atual (ou informe --thread-id explicitamente fora do Codex).\n");
      return 2;
    }
    const result = await api(stateRoot, "POST", "/api/tasks/register", { codexThreadId: threadId, source });
    process.stdout.write(`${JSON.stringify({ ...result.body, source, note: "Guarde o taskHandle nesta tarefa; ele \xE9 a capacidade que autoriza as ferramentas MCP e n\xE3o deve ser compartilhado." }, null, 2)}
`);
    return result.status === 201 ? 0 : 1;
  }
  if (command === "task" && sub === "review") {
    if (typeof flags["task-handle"] !== "string") {
      process.stderr.write("Use: task review --task-handle <handle> [--note <texto>]\n");
      return 2;
    }
    const bound = await api(stateRoot, "POST", "/api/tasks/by-handle", { taskHandle: flags["task-handle"] });
    if (bound.status !== 200) {
      process.stdout.write(`${JSON.stringify(bound.body)}
`);
      return 1;
    }
    const { taskId } = bound.body;
    const result = await api(stateRoot, "POST", `/api/tasks/${taskId}/acknowledge-review`, { taskHandle: flags["task-handle"], note: typeof flags.note === "string" ? flags.note : null });
    process.stdout.write(`${JSON.stringify(result.body, null, 2)}
`);
    return result.status === 200 ? 0 : 1;
  }
  if (command === "worktree" && sub === "enable") {
    const repo = typeof flags.repo === "string" ? flags.repo : process.cwd();
    if (typeof flags.note !== "string" || !flags.note.trim()) {
      process.stderr.write("Use: worktree enable --repo <caminho> --note <motivo>\nA nota fica registrada junto com a permiss\xE3o; permiss\xE3o sem motivo vale menos que nenhum registro.\n");
      return 2;
    }
    const payload = { repo, note: flags.note };
    if (typeof flags["max-parallel"] === "string") payload.maxParallelRuns = Number(flags["max-parallel"]);
    if (typeof flags["max-retained"] === "string") payload.maxRetainedWorktrees = Number(flags["max-retained"]);
    if (typeof flags["worktree-root"] === "string") payload.worktreeRoot = flags["worktree-root"];
    const result = await api(stateRoot, "POST", "/api/repos/worktree-policy", payload);
    process.stdout.write(`${JSON.stringify(result.body, null, 2)}
`);
    return result.status === 200 ? 0 : 1;
  }
  if (command === "worktree" && sub === "list") {
    const result = await api(stateRoot, "GET", "/api/worktrees");
    process.stdout.write(`${JSON.stringify(result.body, null, 2)}
`);
    return result.status === 200 ? 0 : 1;
  }
  if (command === "dashboard") {
    const result = await api(stateRoot, "POST", "/api/dashboard-url", typeof flags["task-handle"] === "string" ? { taskHandle: flags["task-handle"] } : {});
    process.stdout.write(`${JSON.stringify(result.body, null, 2)}
`);
    return result.status === 200 ? 0 : 1;
  }
  if (command === "start") {
    if (typeof flags.job !== "string" || typeof flags["task-handle"] !== "string") {
      process.stderr.write("Use: start --job <job.json> --task-handle <handle>\n");
      return 2;
    }
    const job = JSON.parse(await fs18.readFile(flags.job, "utf8"));
    const bound = await api(stateRoot, "POST", "/api/tasks/by-handle", { taskHandle: flags["task-handle"] });
    if (bound.status !== 200) {
      process.stdout.write(`${JSON.stringify(bound.body)}
`);
      return 1;
    }
    const { taskId } = bound.body;
    const result = await api(stateRoot, "POST", `/api/tasks/${taskId}/runs`, { taskHandle: flags["task-handle"], job, ...flags["acknowledge-review"] === true ? { acknowledgeReview: true } : {} });
    process.stdout.write(`${JSON.stringify(result.body, null, 2)}
`);
    return result.status === 202 ? 0 : 1;
  }
  if (command === "doctor") return doctor(flags.json === true);
  process.stdout.write(`${usage()}
`);
  return command ? 2 : 0;
}
var isEntry = process.argv[1] ? pathToFileURL(path18.resolve(process.argv[1])).href === import.meta.url : false;
if (isEntry) {
  main().then((code) => {
    if (code !== 0) process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error.message}
`);
    process.exitCode = 1;
  });
}
export {
  main
};
