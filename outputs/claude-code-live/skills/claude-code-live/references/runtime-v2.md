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
| `codeorquestra_wait` | long-poll de eventos a partir de um cursor; atualiza a presenca do coordenador |
| `codeorquestra_list` | execucao ativa e historico da tarefa |
| `codeorquestra_message` | enfileira orientacao para o proximo turno |
| `codeorquestra_answer` | responde permissao ou pergunta (`requestId` + `runId` exatos) |
| `codeorquestra_interrupt` | aborta o turno atual; a sessao continua aberta |
| `codeorquestra_end` | solicita o encerramento da sessao e reconcilia o worker e a arvore ainda atribuivel daquela tarefa |
| `codeorquestra_set_model` | troca o modelo entre turnos, com motivo |
| `codeorquestra_inventory` | inventaria personalizacoes do projeto e mostra o estado de confianca |
| `codeorquestra_trust` | registra a aprovacao do usuario para as personalizacoes inventariadas |
| `codeorquestra_dashboard_url` | link de uso unico do painel, limitado aquela tarefa |

A presenca do coordenador vem de `codeorquestra_wait` e do heartbeat reais. Sem isso, o painel mostra "aguardando coordenador" em vez de fingir um Codex sempre ativo.

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
