# Runtime CodeOrquestra v2

**Codex com Opus e Fable.** Runtime local independente (Node 22+, TypeScript) que coordena sessões do Claude Code a partir do Codex: broker HTTP em loopback, um worker por tarefa Codex, adaptador MCP stdio, CLI e painel web. Não é produto oficial nem parceria entre OpenAI e Anthropic; é uma integração local que apenas controla o Claude Code que **você já instalou**. Identificador técnico: `codeorquestra`; alias legado documentado: `claude-code-live` (nomes de diretórios de estado, skill e arquivos derivados permanecem no alias para não quebrar instalações existentes).

## Como o Claude Code é acionado

O runtime **não empacota e não importa o Agent SDK**. Ele resolve o executável do Claude Code que já está instalado na máquina (pelo shim `claude` no PATH, com o caminho final sempre passado explicitamente) e conversa com esse processo pelo protocolo `stream-json` documentado do próprio CLI:

* entrada e saída em NDJSON (`--input-format stream-json --output-format stream-json --verbose --include-partial-messages`);
* `control_request` / `control_response` / `control_cancel_request` para `initialize`, `can_use_tool`, `hook_callback`, `interrupt` e `set_model`;
* prompts de permissão roteados para este runtime com `--permission-prompts host --permission-prompt-tool stdio`;
* personalizações do projeto liberadas só depois da aprovação, via `--setting-sources=…`, `--strict-mcp-config` e `--mcp-config`.

O preflight exige que a build instalada **anuncie** cada flag de que o runtime depende (`src/engine/protocol.ts`, `REQUIRED_CLI_FLAGS`); quando alguma falta, a execução não inicia e o motivo é reportado. Nenhum CLI alternativo é usado como substituto e nenhum caminho de cobrança por API é ativado automaticamente: credenciais de API/provedor herdadas do ambiente são removidas do processo filho a menos que o job autorize `auth.allowApiBilling` explicitamente.

## Comandos

Todos os comandos rodam a partir da raiz do repositório com `npm --prefix outputs/claude-code-live/runtime run <script>`.

| Script | O que faz |
|---|---|
| `typecheck` | `tsc` para backend/testes e para o painel |
| `test` | `node --test` em `test/*.test.ts` (processos reais de broker, worker, MCP e HTTP; só o processo do Claude Code é simulado) |
| `test:browser` | testes funcionais do painel com `playwright-core` no Edge ou Chrome instalados (sem download) |
| `build:backend` | bundle ESM reproduzível em `dist/*.mjs` via esbuild |
| `build:dashboard` | bundle estático do painel em `dist/dashboard` via Vite |
| `verify` | typecheck, build, testes e testes de navegador |

Instalação de dependências: sempre com `--ignore-scripts`, versões exatas e lockfile. Observação verificada nesta máquina: no Windows com npm 10.9.7, `npm --prefix <dir> install` sem argumentos faz os prefixos local e global coincidirem e o npm tenta instalar o diretório atual como pacote global. Execute o `install` com o diretório de trabalho em `outputs/claude-code-live/runtime`:

```powershell
Set-Location outputs/claude-code-live/runtime
npm install --ignore-scripts --no-audit --no-fund
```

Essa política agora vive em `runtime/.npmrc` (`ignore-scripts=true`, `save-exact=true`, `save-prefix=`, `package-lock=true`, `global=false`), e não depende mais de quem digita o comando lembrar das flags. O arquivo precisa ser criado pelo Codex ou pelo usuário: `.npmrc` está em `SENSITIVE_PATH_PATTERNS` porque pode conter `_authToken`, então uma sessão Claude sob este contrato é impedida de escrevê-lo — o que é o comportamento correto, não uma limitação a contornar.

O plugin registra `dist/mcp-stdio.mjs` por meio do `.mcp.json` da raiz. Ao ser carregado numa tarefa nova do Codex, o adaptador inicia ou reutiliza o broker local. O registro inicial da tarefa continua explícito porque o `taskHandle` é a capacidade que impede uma tarefa de consultar, orientar ou cancelar outra:

```powershell
node runtime/dist/codeorquestra.mjs task register --thread-id '<id-da-tarefa-codex>'
node runtime/dist/codeorquestra.mjs dashboard --task-handle '<handle-retornado>'
```

O primeiro comando não inicia o Claude. Uma execução só começa depois que o job v2 aprovado é enviado por `codeorquestra_start` ou pelo comando `start`. Se o inventário encontrar instruções, configurações, hooks, agentes, skills ou MCPs, o início falha fechado até o conjunto ser aprovado para aquele projeto.

## Execucao paralela em worktrees

Um job v2 pode pedir uma arvore isolada com `execution.mode: "worktree"`; sem o
campo, tudo roda no checkout declarado exatamente como antes. Habilitar o
repositorio e uma acao local do usuario, porque criar um worktree altera o
repositorio de forma persistente:

```powershell
node runtime/dist/codeorquestra.mjs worktree enable --repo '<caminho>' --note '<motivo>'
node runtime/dist/codeorquestra.mjs worktree list
```

A trava de escrita nao some: ela passa a ser sobre a **arvore de trabalho**, e
as mutacoes do `.git` compartilhado serializam sob um mutex por repositorio. Os
worktrees vivem sob o state root, fora do repositorio, em caminho deterministico
por `(repositorio, tarefa)` — dentro dele, o inventario de confianca veria a
copia do `CLAUDE.md` de cada worktree e recusaria toda execucao no checkout
principal. Trabalho nao commitado nunca e apagado; `commit` nunca pertence ao
Claude, entao esse e o estado normal de uma execucao bem-sucedida.

## Layout

```
runtime/
  package.json            manifesto e scripts
  tsconfig.json           backend + testes (Node type stripping: import com extensão .ts, sintaxe apagável)
  tsconfig.dashboard.json painel React
  esbuild.config.mjs      bundle backend: codeorquestra.mjs, worker.mjs, mcp-stdio.mjs, build-info.json
  vite.config.mts         bundle do painel (root dashboard/, saída dist/dashboard)
  src/contract/           contrato de job v2 (o formato v1 e recusado com orientacao de migracao)
  src/engine/             protocolo stream-json, transporte de processo e cliente de sessão do CLI instalado
  src/policy/             classificação de ações (capacidades, escopo, alvos resolvidos, delegação)
  src/trust/              inventário de personalizações, armazenamento de confiança e opções de lançamento
  src/preflight/          resolução do executável instalado, sondagem read-only e política de autenticação
  src/quota/              leitura sanitizada de /usage sob o mutex global
  src/usage/              acumulador Claude e adaptador somente leitura do Codex App Server
  src/events/             log append-only sequenciado, redação e arquivos derivados de compatibilidade
  src/worker/             um processo por execução: sessão, supervisão e adaptador de processo
  src/broker/             estado autoritativo, HTTP em loopback, SSE, travas e identidade de processo
  src/mcp/ src/cli/       adaptador MCP stdio e CLI
  dashboard/              painel React + Vite (bundle estático, sem recursos de rede)
  test/                   testes de comportamento (node:test)
  test/helpers/           fixtures literais, processos reais, PowerShell para modos de compartilhamento, cliente do broker
  test/browser/           testes funcionais do painel
```

## Fronteira simulada

A única fronteira substituída é o **processo do Claude Code**. O harness aponta `CODEORQUESTRA_TEST_ADAPTER` para `test/helpers/fake-claude-process.ts`, um módulo confiável do harness que fala o mesmo protocolo `stream-json` em pipes de memória; ele nunca é um campo do job. Broker, worker, HTTP, MCP e persistência são exercitados de verdade.

O adaptador falha fechado: sob o harness um adaptador simulado é **obrigatório** (`ADAPTER_REQUIRED_IN_HARNESS`), um adaptador ausente ou quebrado resulta em `ADAPTER_LOAD_FAILED` e um adaptador fora do harness é recusado com `ADAPTER_NOT_ALLOWED` — em nenhum desses casos o Claude Code instalado é iniciado. Um segundo executável falso (`test/helpers/fake-claude.mjs`) atende apenas `--version`, `--help`, `auth status --json` e `-p /usage`, registra cada invocação e sai com código 99 em qualquer chamada que iniciaria um turno de modelo.

O medidor Codex tem uma fronteira falsa própria no harness: um processo `stdio` responde apenas a `initialize`, `account/rateLimits/read` e `account/usage/read`. Os testes provam que nenhuma operação de turno, autenticação, reset ou consumo de crédito é emitida.

O comportamento de cada turno é roteirizado por diretivas no texto da mensagem (`say:`, `thinking:`, `tool:`, `ask:`, `sleep:`, `spawn:`, `big:`, `stderr:`, `fail:`; ver `test/helpers/scenario.ts`). Strings como `curl https://…` ou `git push` nessas diretivas são **dados** para o simulador: nada é executado. O adaptador grava um rastro por processo em `CODEORQUESTRA_FAKE_TRACE_DIR` para que os testes verifiquem os argumentos reais de lançamento (modelo exato, `xhigh`, executável instalado, `--permission-prompts host`, sem `dontAsk`).

Testes que dependem de semântica de compartilhamento de arquivos do Windows usam `pwsh` para segurar um handle sem `FileShare.Delete` (o mesmo cenário que derrubou o runner legado). Sem Windows/pwsh esses testes são pulados explicitamente.

## Segurança do broker (contrato testado)

Loopback 127.0.0.1 apenas; segredo por usuário em arquivo (modo 0600) e nunca impresso no anúncio; link de bootstrap de uso único **e com validade** (10 min) que grava o cookie `codeorquestra_session` com `HttpOnly; SameSite=Strict; Path=/`; ações do navegador exigem `X-Requested-With: codeorquestra`, `Origin` correspondente e `Host` de loopback; sem CORS curinga; CSP estrita; só ativos estáticos de uma lista fixa; **todas** as APIs, inclusive de leitura, exigem autenticação; SSE autenticado com replay por cursor, época de cursor por inicialização do broker e sinalização explícita de lacuna (`HISTORY_GAP`) quando a continuidade não pode ser prometida.

Rotas administrativas (`/api/broker/shutdown`, `/api/tasks/register`, `/api/locks`, link de painel sem escopo) exigem o segredo local; a sessão do navegador é recusada com `LOCAL_ADMIN_REQUIRED`. Qualquer processo do mesmo usuário do SO consegue ler o arquivo de segredo: isso é uma fronteira de roteamento da aplicação, **não** isolamento de processos.

Redação de segredos é melhor esforço, não garantia. Filtros de texto não são sandbox de sistema operacional: o que impede escrita fora do escopo é a classificação de ação com o caminho **resolvido** (symlink/junction) mais o hook `PreToolUse`, e ainda assim a decisão final de risco é do coordenador humano.

## Invariantes que os testes cobrem

* uma identidade de sessão durável por tarefa Codex real; execuções da mesma tarefa serializam e a trava de escrita do checkout atravessa tarefas (inclusive pelo mesmo checkout alcançado por outra grafia de caminho);
* mensagens ficam na fila para o próximo turno, com id/origem/estado persistidos; só a interrupção explícita aborta um turno;
* pedidos de permissão e perguntas têm ciclo de vida único por `requestId` + `runId`; respostas duplicadas, obsoletas ou de outra execução são recusadas;
* 20 min sem atividade e 2 h decorridas **alertam**, nunca encerram;
* incerteza sobrevive a reinício do broker e exige revisão explícita; mensagens enfileiradas nunca são reenviadas automaticamente;
* retomada automática exige compatibilidade do contrato anterior; mudança de workspace, perfil, modelo, esforço, plano, revisão, responsáveis, escopo, destino ou autenticação inicia uma sessão nova;
* terminação cooperativa é escopada ao processo registrado e à árvore ainda atribuível — nunca por nome. Identidade de criação e batimento reduzem enganos de PID, mas não são isolamento do SO: no Windows, um intermediário já encerrado pode ocultar um descendente órfão da visão por PPID;
* reinício, desaparecimento do worker, saída anormal/desconhecida do CLI e falha de finalização usam reconciliação estrita e mantêm a trava em quarentena quando a árvore histórica não pode ser provada. `COMPLETED` confirma o término correlacionado da sessão supervisionada, não a ausência matemática de todo processo em segundo plano;
* liberar uma quarentena é uma exceção exclusiva do administrador local: requer nota, reconhecimento explícito do risco e a identidade exata da posse, relida antes da remoção. A auditoria não retoma a sessão, não reenvia fila e não aprova artefatos;
* modelo e esforço não são rebaixados em silêncio; o esforço é reportado como “configurado”, com confirmação de servidor indisponível;
* pensamento interno e assinaturas nunca são persistidos nem exibidos.
* uso Claude é acumulado uma vez por `runId + turno`, com subtotais por modelo e ausência de campos marcada como parcial; reconexão ou retomada não duplica tokens;
* uso Codex vem de uma única conexão local `stdio` com o App Server, somente leitura. Limites e atividade são reportados; o recorte por tarefa é sempre estimado e pode estar indisponível. Respostas brutas, credenciais e valores financeiros não são persistidos;
* o painel nunca soma Claude e Codex como custo nem inventa economia; mostra duração, turnos, cache e cada fonte separadamente.

## Medidor híbrido de uso

O broker consulta o Codex App Server ao carregar o painel, depois de um turno Claude e pelo botão **Atualizar consumo** ou pela ferramenta MCP `codeorquestra_usage_refresh`. Leituras automáticas respeitam um intervalo mínimo. A falha ou incompatibilidade da telemetria produz `indisponível` e nunca bloqueia o worker, reduz o esforço ou troca o modelo.

O `status.json` e o `resultado.json` recebem apenas a projeção sanitizada `llmUsage`: números de tokens, modelo/esforço quando informados, qualidade e horário da consulta. O runtime não acessa arquivos de autenticação do Codex. Nesta versão não exibe saldo, créditos estimados, dólares nem qualquer total financeiro combinado.
