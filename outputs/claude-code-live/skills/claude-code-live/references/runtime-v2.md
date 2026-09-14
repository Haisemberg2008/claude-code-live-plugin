# Runtime v2: sessao duravel, broker local e ferramentas MCP

Esta referencia descreve o runtime v2 do CodeOrquestra (`runtime/` no pacote). O runner legado v1, descrito em `local.md`, continua suportado sem alteracoes. Identificador tecnico: `codeorquestra`; alias legado documentado: `claude-code-live`.

## O que muda em relacao ao v1

| | v1 | v2 |
|---|---|---|
| Unidade de trabalho | uma execucao com prompt fixo | uma **sessao duravel** por tarefa Codex, com varios turnos |
| Orientacao durante o trabalho | nao ha | fila de mensagens entregues no proximo turno |
| Permissoes | `dontAsk` + allowlist; fora do escopo e negado na hora | pedido visivel ao coordenador, que decide; a espera nao e inatividade |
| Perguntas do Claude | nao ha | `AskUserQuestion` chega ao painel e ao MCP como pergunta, com opcoes |
| Interrupcao | encerra a execucao | aborta **o turno**; a sessao continua aberta |
| Acompanhamento | painel de console + `acompanhamento.txt` | painel web + log de eventos append-only (os arquivos v1 continuam sendo derivados) |
| Tempo | 20 min de inatividade e 2 h encerram | 20 min e 2 h **alertam**; nada encerra sozinho |

## Como o Claude Code e acionado

O runtime resolve o executavel do Claude Code ja instalado e conversa com esse processo pelo protocolo `stream-json` documentado do proprio CLI. Nenhum Agent SDK e importado ou redistribuido em tempo de execucao, e nenhum CLI alternativo e usado como substituto.

O preflight exige que a build instalada anuncie todas as flags de que o runtime depende (`--output-format`, `--input-format`, `--verbose`, `--include-partial-messages`, `--model`, `--effort`, `--tools`, `--permission-mode`, `--permission-prompts`, `--permission-prompt-tool`, `--setting-sources`, `--strict-mcp-config`, `--mcp-config`, `--resume`). Faltando qualquer uma, a execucao nao inicia e o motivo e reportado com a lista do que falta.

O prompt de codificacao nativo do CLI e preservado; o contexto de coordenacao entra como **acrescimo** (`appendSystemPrompt`), nunca substituindo o prompt do produto.

## Modelo e esforco

Somente `claude-fable-5-1` e `claude-opus-5` sao autorizados, sempre com esforco `xhigh` (Extra). O runtime registra separadamente o **modelo solicitado** e o **modelo observado** em cada mensagem do assistente; divergencia encerra a execucao de forma visivel em vez de continuar com outro modelo.

O esforco e reportado como "configurado": o CLI ecoa o valor no `init`, mas nao existe confirmacao de servidor, e o painel diz exatamente isso. Um rebaixamento relatado pelo CLI (`EFFORT_DOWNGRADED_BY_CLI`) para a execucao em vez de trabalhar em silencio com menos esforco.

A troca de modelo so acontece **entre turnos**, com motivo registrado; no meio de um turno o pedido e recusado com `TURN_IN_PROGRESS`.

## Quota

A leitura de `/usage` reusa o parser sanitizado do v1 sob o mesmo mutex global `Local\ClaudeLiveQuota`, para que v1 e v2 nunca consultem ao mesmo tempo. O limite de 3% e **recomendacao**, nao bloqueio: uma quota desconhecida continua desconhecida e nao impede um modelo fixo autorizado pelo usuario. Valores monetarios nunca sao inventados.

## Comandos do CLI

```
codeorquestra broker start [--state-root <dir>] [--port <n>] [--announce-json]
codeorquestra broker status | broker stop
codeorquestra task register [--thread-id <id>]      # imprime o taskHandle desta tarefa Codex
codeorquestra task review --task-handle <h> [--note <texto>]
codeorquestra dashboard [--task-handle <h>]         # link de uso unico para o painel
codeorquestra start --job <job.json> --task-handle <h> [--acknowledge-review]
codeorquestra doctor [--json]                        # somente --version, --help e auth status --json
```

`task register` deriva a identidade da tarefa do ambiente real (`CODEX_THREAD_ID`). O `taskHandle` e a capacidade que autoriza as ferramentas MCP daquela tarefa: guarde-o na tarefa e nao o compartilhe. Um registro novo **rotaciona** o handle e invalida o anterior.

`doctor` nunca autentica nem gera: executa apenas sondagens somente leitura e reporta o que observou, inclusive quais flags exigidas estao faltando.

## Ferramentas MCP

O adaptador stdio (`mcp-stdio.mjs`) se conecta ao broker ja em execucao — nunca inicia um worker proprio. Todas as ferramentas de tarefa exigem `taskHandle`; um `codexThreadId` passado como argumento **nunca** autoriza nada.

| Ferramenta | O que faz |
|---|---|
| `codeorquestra_status` | saude do broker, sem dados de tarefas |
| `codeorquestra_start` | inicia uma execucao v2 na tarefa do handle (job `contractVersion: 2`) |
| `codeorquestra_wait` | long-poll de eventos a partir de um cursor; atualiza a presenca do coordenador. O campo `task` vem resumido por padrao (`taskView=full` na rota HTTP devolve a view completa) |
| `codeorquestra_list` | execucao ativa e historico da tarefa |
| `codeorquestra_pair` | pareia com a tarefa do painel usando o codigo curto da tela; devolve o taskHandle |
| `codeorquestra_message` | enfileira orientacao para o proximo turno |
| `codeorquestra_annotate` | anota um arquivo alterado; a anotacao vira orientacao na fila, entregue entre turnos |
| `codeorquestra_answer` | responde permissao ou pergunta (`requestId` + `runId` exatos) |
| `codeorquestra_interrupt` | aborta o turno atual; a sessao continua aberta |
| `codeorquestra_end` | solicita o encerramento da sessao e reconcilia o worker e a arvore ainda atribuivel daquela tarefa |
| `codeorquestra_set_model` | troca o modelo entre turnos, com motivo |
| `codeorquestra_inventory` | inventaria personalizacoes do projeto e mostra o estado de confianca |
| `codeorquestra_trust` | registra a aprovacao do usuario para as personalizacoes inventariadas |
| `codeorquestra_usage_refresh` | atualiza limites, atividade e estimativa da tarefa pelo Codex App Server, somente leitura |
| `codeorquestra_dashboard_url` | link de uso unico do painel, limitado aquela tarefa |

A presenca do coordenador vem de `codeorquestra_wait` e do heartbeat reais. Sem isso, o painel mostra "aguardando coordenador" em vez de fingir um Codex sempre ativo.

## Ordem obrigatoria de abertura

Uma execucao v2 exige um canal de acompanhamento **declarado**, e o broker verifica. Com `observation.mode: "painel"` (padrao), registre a tarefa, gere o link limitado com `codeorquestra_dashboard_url`, abra ou reutilize uma unica aba e so entao chame `codeorquestra_start`: sem assinante do fluxo de eventos daquela tarefa, o inicio e recusado com `OBSERVATION_REQUIRED`. Com `observation.mode: "voz"`, o coordenador assume explicitamente o acompanhamento narrado; a escolha fica registrada em `run_started`. Nao combine mecanismos de abertura em paralelo ou como fallback imediato, pois uma solicitacao ainda pendente pode criar uma aba duplicada. O limite, dito sem exagero: a contagem prova que um canal esta anexado, nao que alguem esta olhando.

## Contrato de job v2

```json
{
  "contractVersion": 2,
  "workspace": "C:\\projeto-autorizado",
  "prompt": "Implemente o recurso aprovado dentro do escopo.",
  "profile": "development",
  "model": { "requested": "claude-fable-5-1", "reason": "Tarefa longa de implementacao." },
  "effort": "xhigh",
  "coordination": {
    "phase": "execution",
    "scopeId": "corrigir-validacao",
    "approvalRevision": 1,
    "planSummary": "Implementar a correcao aprovada e rodar os testes.",
    "planApproved": true,
    "responsibilities": {
      "planning": "codex", "inspection": "claude", "implementation": "claude", "testing": "claude",
      "review": "codex", "commit": "codex", "push": "codex", "deploy": "not_applicable"
    }
  },
  "scope": { "summary": "modulo de validacao", "paths": ["src/validacao/"] }
}
```

- `profile`: `development` (ferramentas nativas completas dentro do escopo aprovado) ou `read` (somente leitura). Os perfis legados `diagnostic` e `restricted` pertencem ao v1 e sao recusados aqui.
- As capacidades **derivam** do contrato: `phase: "planning"` ou `profile: "read"` nao concedem edicao nem comandos; `implementation: "claude"` concede edicao; `testing: "claude"` concede testes.
- `auth.allowApiBilling` e opcional e so deve ser usado quando o usuario autorizar explicitamente um caminho que pode gerar cobranca por API.
- Claude nunca pode receber `commit`, `push` ou `deploy`.

## Estados e o que eles significam

`STARTING` → `RUNNING` (a sessao fica aberta e ociosa entre turnos) → `COMPLETED`, `CANCELLED`, `FAIL` ou `UNCERTAIN`.

`UNCERTAIN` aparece quando o worker desaparece ou o broker reinicia com trabalho em andamento. Nesse caso a tarefa exige revisao explicita (`task review` ou `--acknowledge-review`) antes de qualquer nova execucao, e mensagens que estavam na fila **nao** sao reentregues automaticamente.

`COMPLETED` significa que o transporte terminou, nunca que o trabalho foi aprovado. A revisao independente continua sendo do Codex.

Um fim de sessao que **ninguem pediu** nunca vira `COMPLETED` nem `CANCELLED`. O runtime espera o codigo de saida do processo antes de decidir e distingue duas causas:

| Motivo | O que aconteceu |
|---|---|
| `CLI_EXITED_UNEXPECTEDLY` | O Claude Code terminou sozinho com codigo diferente de zero ou por sinal, sem que o encerramento fosse solicitado. A mensagem registra o codigo ou o sinal observado. |
| `CLI_STREAM_ENDED_MID_TURN` | O fluxo terminou no meio de um turno sem resultado, mas o processo nao morreu de forma anormal: ou saiu com codigo zero sem entregar resultado, ou continua ativo com a saida fechada. |

Em ambos os casos o resultado e `FAIL` e fica para revisao. A saida do processo e drenada antes de fechar a conversa, entao o texto que o CLI chegou a escrever antes de cair continua visivel no log.

## Concorrencia, travas e encerramento

Execucoes da mesma tarefa serializam (`RUN_IN_PROGRESS`). Uma trava de escrita por checkout atravessa tarefas (`WORKSPACE_WRITER_LOCKED`), resolvida pelo caminho canonico — o mesmo checkout alcancado por outra grafia, junction ou symlink e a mesma trava. Perfis somente leitura coexistem com um escritor. A trava sobrevive ao fim da sessao do cliente e e liberada no termino cooperativo correlacionado ou pela excecao administrativa descrita abaixo. Isso coordena escritores; nao e isolamento de processos do sistema operacional.

Encerrar uma tarefa atua somente sobre o processo registrado e a arvore ainda atribuivel — nunca por nome. A identidade combina PID, instante de criacao e batimento. Reinicio, desaparecimento do worker, saida anormal/desconhecida do CLI e falha de finalizacao usam reconciliacao estrita: se a arvore historica nao puder ser provada, a trava fica em **quarentena**. No Windows, PPID nao reconstrui um ramo cujo intermediario ja terminou; por isso o painel e os resultados nao afirmam ausencia garantida de descendentes.

Revisar o diff nao libera a quarentena. A excecao administrativa exige segredo local, nota obrigatoria, reconhecimento explicito do risco e `taskId`/`runId` exatos da posse atual. A identidade da trava e relida antes da remocao; a auditoria registra processos visiveis e a limitacao historica. Essa acao apenas permite outro escritor: nao retoma Claude, nao reenvia mensagens e nao aprova a entrega.

Fechar o navegador nao encerra nada: o painel e uma visualizacao.

## Painel

Portugues, tema grafite/azul escuro com acento violeta, React + Vite em bundle estatico servido pelo proprio broker, sem CDN nem recursos de rede. Mostra a lista de tarefas, o feed publico cronologico, o inspetor e os controles nativos: enfileirar orientacao, responder, **interromper turno** e **encerrar sessao** (acoes separadas, com confirmacao vinculada a tarefa e execucao exatas).

O painel nunca mostra porcentagem de progresso inventada nem raciocinio interno, e separa "arquivos alterados observados" (pelo git do workspace) de "autoria do Claude comprovada" (registrada pelas ferramentas).

### Consumo por fonte

Quatro cartoes permanecem independentes: Claude nesta tarefa, Codex nesta tarefa, limites Codex e atividade Codex. O Claude CLI reporta entrada, saida, leitura e criacao de cache; campos omitidos tornam o total `parcial`, nao zero. Os turnos sao identificados por execucao + numero do turno, portanto replay, reconexao e retomada nao contam o mesmo evento duas vezes. Ha subtotais por modelo.

O broker mantem uma conexao local `stdio` com `codex app-server` e emite somente `account/rateLimits/read` e `account/usage/read` depois do handshake. O recorte por `threadId`, quando aceito, e rotulado `estimado`; limites e atividade sao `reportados`. O adaptador nao le arquivos de autenticacao, nao inicia turno, nao resgata credito e descarta campos financeiros. Falha de autenticacao, versao ou transporte apenas deixa a fonte indisponivel e nunca interfere na sessao Claude.

A coleta acontece ao carregar o painel, depois dos turnos e por atualizacao explicita, com intervalo minimo para leituras automaticas. O painel e os arquivos derivados mostram o horario e a qualidade (`reportado`, `estimado`, `parcial`, `indisponivel`). Claude e Codex nunca sao somados como custo ou apresentados como economia percentual.

## Execucao paralela em worktrees

Por padrao uma execucao roda no checkout declarado, e a trava de escrita por
checkout impede que duas tarefas escrevam no mesmo projeto ao mesmo tempo. Para
trabalhar em paralelo, o job pede uma arvore isolada:

```json
"execution": { "mode": "worktree", "worktree": { "branch": null, "baseRef": "main" } }
```

`execution` ausente resolve para `{ "mode": "checkout" }`, entao todo job
existente continua identico. `branch` nulo deixa o broker derivar
`codeorquestra/<tarefa>`; `baseRef` nulo usa o HEAD atual.

O modo worktree exige que `implementation` pertenca ao Claude, fase de execucao
e perfil diferente de `read`: nos outros casos a arvore isolada ficaria vazia.

**Habilitar o repositorio e uma acao local do usuario.** Criar um worktree
escreve em `.git/worktrees/<n>`, cria uma branch duradoura e materializa um
segundo checkout, entao exige uma decisao explicita e registrada:

```powershell
node runtime/dist/codeorquestra.mjs worktree enable --repo '<caminho>' --note '<motivo>'
node runtime/dist/codeorquestra.mjs worktree list
```

O Codex pede o modo no job, o usuario habilita o repositorio, o broker executa.
O Claude nunca cria worktrees: `git worktree add|remove|move|prune|lock|unlock|repair`
e negado pelo classificador (`RESERVED_OPERATION_WORKTREE`); `git worktree list`
e permitido.

O que o runtime garante e o que ele nao garante:

* a trava de escrita continua existindo, agora sobre a **arvore de trabalho**;
  duas tarefas em worktrees diferentes tem travas diferentes e coexistem, e as
  mutacoes do `.git` compartilhado serializam sob um mutex por repositorio;
* os worktrees ficam **fora do repositorio**, sob o state root, em caminho
  deterministico por `(repositorio, tarefa)`. Dentro do repositorio, o
  inventario de confianca passaria a ver a copia do `CLAUDE.md` de cada worktree
  e recusaria toda execucao no checkout principal;
* a confianca e **derivada** do checkout de origem apenas quando todo item bate
  por hash, e um registro derivado e revalidado contra o pai a cada checagem:
  revogar a confianca do projeto nao deixa worktrees confiaveis. Um repositorio
  com `core.autocrlf=true` produz bytes diferentes no worktree, entao a
  derivacao recusa e o usuario aprova aquele caminho uma vez;
* `maxParallelRuns` (padrao 3) limita execucoes simultaneas por repositorio,
  porque N sessoes dividem uma conta e o consumo nao e serializado como a
  observacao. Acima disso, `FLEET_CAPACITY_REACHED` nomeia quem ocupa os slots;
* **trabalho nao commitado nunca e apagado.** Como `commit` nunca pertence ao
  Claude, o estado normal de uma execucao bem-sucedida e trabalho pendente na
  arvore: ele e retido e reportado. So uma arvore que o proprio git considera
  limpa e removida, e uma trava em quarentena nao remove nada.

## Parear sem o terminal

O `taskHandle` e a capacidade que impede uma tarefa de consultar, orientar ou
cancelar outra. Obte-lo pelo terminal (`codeorquestra task register`) funciona,
mas exige copiar 43 caracteres — o que quebra qualquer fluxo em que o
coordenador nao esta no teclado.

O painel gera um codigo curto para a tarefa aberta. O coordenador o informa:

```
codeorquestra_pair { code: "K7M4QD" }
```

e recebe o `taskHandle` daquela tarefa. Espacos, hifens e caixa sao ignorados; o
alfabeto nao tem 0/O, 1/I/L, 5/S nem 8/B, para o codigo sobreviver a ser lido em
voz alta.

Onde cada propriedade fica:

* **cunhar e acao do painel** — so uma sessao de navegador emite codigo, e essa
  sessao so existe depois que alguem resgatou, nesta maquina, um link de uso
  unico com validade. As identidades de coordenador sao recusadas com
  `BROWSER_PAIRING_ONLY`;
* **resgatar e acao do coordenador** — o navegador que mostrou o codigo nao o
  consome (`LOCAL_ADMIN_REQUIRED`);
* **isolamento entre tarefas** — um painel limitado a tarefa A nao emite codigo
  para B; a rota recusa antes de chegar ao pareamento;
* **uso unico e cinco minutos** — as mesmas propriedades do link de bootstrap;
* **resgatar rotaciona o handle** — quem detinha o anterior deixa de agir na
  tarefa, e a rotacao entra no log duravel como `task_handle_rotated`. Isso e
  deliberado: pareamento e tomada de posse, nao compartilhamento.

`codeorquestra task register` continua existindo e nao mudou; o pareamento e um
segundo caminho para a mesma capacidade, nao um substituto.

## Decisao pendente deixa de ser silenciosa

Uma permissao ou pergunta bloqueia o turno ate alguem responder. Essa espera
continua fora do alerta de inatividade, porque esperar nao e ociosidade — mas
passados dois minutos entra `decision_pending`, que diz a outra coisa
verdadeira: ninguem respondeu e nada avanca. O alerta **repete** enquanto
continuar valendo, e some quando a decisao e respondida. Como todo alerta de
supervisao, ele so avisa: nada e encerrado.

## Custo da frota

`GET /api/worktrees` (administrativa) passou a devolver tambem `fleet`: quais
execucoes estao vivas, em que branch, com quantos turnos e tokens observados,
quantas por repositorio contra o limite aprovado, e o restante da conta em
percentual.

Existe porque o teto de paralelismo diz quando voce e recusado, nao quanto esta
gastando. A leitura de `/usage` e serializada; o **consumo nao**. Aprovar N
execucoes sem ver a conta e aprovar um custo que ninguem mostra.

Somente percentuais, como o painel ja faz: numeros brutos da conta nunca sao
expostos.
