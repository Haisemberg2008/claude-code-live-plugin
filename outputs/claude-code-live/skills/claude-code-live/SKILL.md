---
name: claude-code-live
description: Use when coordinating authorized Claude Code CLI work that needs explicit responsibility assignment, an approved plan, visible progress, scoped tools, controlled permissions, resumption, interruption, or background-session management.
---

# CodeOrquestra

CodeOrquestra e a marca visivel desta integracao local independente para o Codex coordenar Opus e Fable; nao e produto oficial nem representa parceria entre OpenAI e Anthropic. Identificador tecnico: `codeorquestra`; o nome da skill permanece `claude-code-live` como alias documentado, preservando instalacoes, caminhos de estado e automacoes existentes.

Use o CLI instalado e a autenticacao existente: nada do Claude Code e empacotado nem substituido aqui, e nenhum SDK de fornecedor e importado em tempo de execucao. A skill coordena sessoes locais (pelo runtime desta skill) e sessoes na nuvem (pelo proprio CLI); escolha o destino por tarefa, nao por preferencia fixa. Nao transforme isso em automacao recorrente. O Codex coordena, orienta, decide e revisa; o encerramento do processo nunca prova que a tarefa foi aprovada.

Este documento e o contrato principal. Os detalhes do runtime (comandos, ferramentas MCP, estados, travas, worktrees, pareamento, orcamento) estao em `references/runtime-v2.md`; dados, confianca em personalizacoes, autenticacao e superficie HTTP em `references/security.md`; sessoes na nuvem em `references/cloud.md`. O runner PowerShell (v1) foi aposentado: um job no formato antigo (sem `contractVersion`, com `mode`, `allowedCommands` ou `timeoutPolicy`) e recusado com a orientacao de migracao, nunca reinterpretado.

## Escolher o destino

| Destino | Melhor quando | Fluxo |
|---|---|---|
| Local | O trabalho depende do checkout, arquivos locais e testes da maquina atual | Ferramentas `codeorquestra_*` desta skill, com painel ou acompanhamento narrado |
| Nuvem | O trabalho pode ocorrer em sessao remota e se beneficia de recursos de nuvem do Claude Code | Sessao de nuvem do CLI, criada ou retomada e acompanhada pelo proprio CLI |

Antes de escolher nuvem, confirme que o repositorio e os dados necessarios estao no ambiente remoto autorizado; nao envie segredos, arquivos de ambiente, dados pessoais ou perfis reais para criar essa conveniencia. Antes de escolher local, verifique checkout, branch e alteracoes existentes. Se ambos servirem, prefira local para trabalho que requer validacao no computador atual.

## Planejar e atribuir antes de executar

Antes de iniciar implementacao ou qualquer mutacao, inspecione em modo somente leitura o necessario para propor um plano realista. Em uma unica tabela, apresente estas oito responsabilidades e atribua exatamente um ator a cada uma: `planning`, `inspection`, `implementation`, `testing`, `review`, `commit`, `push` e `deploy`. Os atores aceitos sao `codex`, `claude`, `user` e `not_applicable`. `deploy` inclui publicacao e qualquer mutacao externa.

Explique o plano, a matriz e o que o job concedera, e aguarde aprovacao explicita do usuario. Silencio, envio do plano ou autorizacao anterior para uma tarefa diferente nao significam aprovacao. Antes da aprovacao final, uma execucao pode participar do planejamento somente com `phase: planning` (ou `profile: read`), que nao concede edicao nem comandos.

Claude nunca recebe `commit`, `push` ou `deploy`. Essas responsabilidades pertencem ao Codex, ao usuario ou ficam como `not_applicable`; o contrato recusa a atribuicao. Depois da aprovacao, execute apenas as etapas atribuidas ao Claude. O Codex nao assume automaticamente as demais: segue a matriz e solicita nova decisao quando surgir uma acao que nao estava prevista. Qualquer mudanca de plano, escopo ou responsavel exige nova aprovacao e `approvalRevision` maior.

## Contrato da tarefa

O job e um objeto JSON `contractVersion: 2`, passado a `codeorquestra_start`. Inclua no prompt objetivo, pasta autorizada, criterios de aceite e as regras do projeto que se aplicam; o contexto de coordenacao entra como acrescimo ao prompt nativo do CLI. As personalizacoes do projeto (`CLAUDE.md`, `AGENTS.md`, hooks, skills, MCPs) so sao carregadas depois que o usuario as aprova pelo inventario de confianca (`codeorquestra_inventory` e `codeorquestra_trust`); enquanto algo estiver pendente, nenhuma fonte de configuracao entra.

Campos do job:

- `contractVersion`: `2`, obrigatorio.
- `workspace`: caminho absoluto da pasta de trabalho autorizada.
- `prompt` ou `promptFile`: texto ou caminho absoluto, sem segredos ou PII.
- `profile`: `development` (ferramentas nativas completas dentro do escopo aprovado) ou `read` (somente leitura).
- `model`: `{ "requested": "claude-fable-5-1" | "claude-opus-5", "reason": "<motivo>" }`; o identificador exato e obrigatorio e o motivo fica registrado. O runtime registra separadamente o modelo solicitado e o observado; divergencia encerra a execucao de forma visivel.
- `effort`: `xhigh`, o unico autorizado; um rebaixamento relatado pelo CLI para a execucao em vez de trabalhar em silencio com menos.
- `coordination`: `phase`, `scopeId`, `approvalRevision`, `planSummary`, `planApproved` e `responsibilities` para as oito etapas.
- `scope`: `summary` e `paths` (ou `wholeWorkspace: true`), obrigatorio na execucao; escrita fora do escopo escala ao coordenador.
- `execution`: opcional; `{ "mode": "worktree" }` pede uma arvore isolada para trabalho em paralelo (o usuario habilita o repositorio uma vez; ver a referencia).
- `limits`: opcional; `maxTokens`, `maxTurns`, `maxRuntimeSeconds` fixam um orcamento para esta execucao.
- `auth.allowApiBilling`: opcional; somente quando o usuario autorizar explicitamente um caminho que pode gerar cobranca por API. Sem isso, credenciais de API presentes no ambiente fazem a execucao falhar fechada.
- `codexThreadId`: fallback opcional fora do Codex; nunca autoriza nada — a autorizacao e o `taskHandle`.

As capacidades derivam do contrato, nao de uma allowlist: `phase: planning` ou `profile: read` nao concedem edicao nem comandos; `implementation: claude` concede edicao; `testing: claude` concede testes. O classificador de acoes decide sobre o caminho resolvido e bloqueia arquivos sensiveis, escrita fora do escopo e operacoes reservadas ao Codex (commit, push, PR, deploy, publicacao, instalacao global, configuracao instalada, `git worktree` administrativo). O que ele nao decide sozinho vira um pedido de permissao visivel, que o coordenador responde; nada fica esperando uma aprovacao invisivel.

Nao entregar credenciais, perfil real do owner, arquivos de ambiente, provider real, deploy ou banco externo ao Claude. Esta skill nao amplia a autorizacao da tarefa. No YOU Telecom CRM, o coordenador principal conserva o deploy e as mutacoes externas. Para mudancas locais, verificar a branch/worktree e preservar trabalho existente antes da delegacao.

## Executar e acompanhar

Ordem obrigatoria, verificada pelo broker:

1. **Identidade.** `codeorquestra task register` no terminal, ou `codeorquestra_pair` com o codigo curto que o painel mostra, devolve o `taskHandle` desta tarefa Codex. Ele e a capacidade que autoriza todas as outras ferramentas; guarde-o na tarefa e nao o compartilhe. Um novo registro ou pareamento rotaciona o handle anterior.
2. **Confianca.** `codeorquestra_inventory` lista o que o CLI carregaria; o usuario aprova por `codeorquestra_trust`. Mudanca material invalida a aprovacao.
3. **Canal de acompanhamento.** Com `observation.mode: "painel"` (padrao), gere o link com `codeorquestra_dashboard_url`, abra ou reutilize **uma unica aba** e so entao inicie; sem assinante do fluxo daquela tarefa, o inicio e recusado com `OBSERVATION_REQUIRED`. Sem tela, declare `observation.mode: "voz"` e assuma o acompanhamento narrado; a escolha fica registrada em `run_started`. Nao combine mecanismos de abertura em paralelo nem duplique abas. A contagem prova que um canal esta anexado, nao que alguem esta olhando.
4. **Inicio.** `codeorquestra_start` com o job. Execucoes da mesma tarefa serializam; uma trava de escrita por checkout atravessa tarefas; perfis somente leitura coexistem com um escritor.

Durante o trabalho, a sessao e duravel e multiturno:

- `codeorquestra_wait` faz long-poll dos eventos a partir de um cursor e registra a presenca do coordenador; sem ela o painel mostra "aguardando coordenador". Voce pode ficar em silencio por muito tempo, mas precisa voltar para decidir e para entregar.
- `codeorquestra_message` enfileira orientacao para o **proximo** turno; `codeorquestra_annotate` anota um arquivo alterado e vira orientacao na fila. Nada e entregue no meio de um turno.
- `codeorquestra_answer` responde permissao ou pergunta do Claude com `requestId` e `runId` exatos. Esperar uma decisao nao e inatividade, mas depois de dois minutos o alerta `decision_pending` repete ate alguem responder.
- `codeorquestra_interrupt` aborta **o turno**; a sessao continua aberta. `codeorquestra_end` encerra a sessao e reconcilia o worker e a arvore de processos ainda atribuivel. So a interrupcao explicita aborta um turno. Com `codeorquestra_end { afterTurn: true }` o encerramento espera o turno terminar sozinho e a execucao fecha `COMPLETED` em vez de `CANCELLED`; e o que usar quando a decisao e "pode terminar o que esta fazendo e parar".
- `codeorquestra_set_policy { escalate, reason }` restringe o que a execucao faz sem perguntar, valendo ja na proxima chamada de ferramenta (inclusive no meio do turno). Use ao ver o alerta `thrashing`, que traz a ferramenta, a chamada e a contagem: restringir mantem o trabalho vivo, ao contrario de encerrar. Ela so acrescenta decisoes — nunca concede o que o contrato negou. `none` remove a restricao.
- `codeorquestra_set_model` troca o modelo entre turnos, com motivo; no meio de um turno e recusado.
- `codeorquestra_list` devolve o historico da tarefa com o custo de cada execucao encerrada: desfecho, turnos, tokens observados (com a qualidade da contagem), duracao, chamadas e erros de ferramenta e se o orcamento esgotou. E a resposta para "quanto isso custou ate agora" sem reler o log.
- `codeorquestra_usage_refresh` atualiza o bloco **Consumo por fonte**, somente leitura. Ele separa tokens Claude reportados, estimativa da tarefa Codex, limites e atividade Codex; nunca some provedores nem trate estimativa como medicao. Uma falha nele nao autoriza reduzir esforco, trocar modelo ou interromper Claude. Percentuais sao limites de uso da assinatura, nao saldo em dinheiro.

A supervisao so alerta: 20 minutos sem atividade e 2 horas decorridas geram `inactivity_20m` e `elapsed_2h`, e nada e encerrado sozinho. Um orcamento (`limits`) avisa em 80% e, ao esgotar, o broker recusa o proximo turno (`BUDGET_EXHAUSTED`) sem abortar o atual. Na mesma tarefa, a sessao Claude anterior so e retomada quando workspace, perfil, modelo, esforco, plano, revisao, responsaveis, escopo, destino e autenticacao continuam compativeis; mudanca material cria uma sessao nova. Retomar nao desfaz edicoes nem repete ferramentas — reinspecione o estado e diga no prompt seguinte o que falta.

Um fim de sessao que ninguem pediu nunca vira `COMPLETED`: o worker desaparecer ou o broker reiniciar com trabalho em andamento deixa a execucao `UNCERTAIN`, exige revisao explicita (`codeorquestra task review` ou `acknowledgeReview`) antes de outra execucao, e mensagens que estavam na fila nao sao reentregues. Um checkout cuja arvore de processos nao pode ser provada limpa fica em quarentena; revisar o diff nao libera a trava, e a liberacao administrativa e uma acao do usuario.

Nao mostrar eventos JSON brutos, argumentos/resultados de ferramentas, stderr ou raciocinio interno. O texto publico e armazenado; portanto somente delegar dados autorizados e sanitizados. Nao alegar redacao automatica de qualquer segredo. Fechar o painel nao encerra nada: ele e uma visualizacao.

## Trabalho em equipe Codex-Claude

Para tarefas de engenharia, trabalhe em ciclos verificaveis:

1. O Codex delimita o objetivo, o workspace, as regras do projeto e os criterios de aceite.
2. O Claude executa somente as etapas que a matriz lhe atribuiu, nos caminhos do escopo e com as ferramentas que o contrato deriva.
3. O Codex revisa o diff e as evidencias independentemente. Quando houver lacuna, risco ou alternativa melhor, envia uma correcao objetiva pela fila (`codeorquestra_message` ou `codeorquestra_annotate`) na mesma sessao.
4. O Claude revisa a proposta corrigida ou o novo diff. O Codex decide pela aceitacao com base nos artefatos e testes, nao por concordancia entre modelos.

Os modelos colaboram por propostas, diffs, resultados de testes e respostas publicas; nao alegue acesso ao raciocinio interno de nenhum deles. Divergencias sao resolvidas por evidencia reproduzivel. O Codex permanece responsavel por autorizacao, revisao final, mutacoes externas e deploy.

## Sessoes na nuvem

Para uma tarefa na nuvem, aplique primeiro o mesmo plano, matriz e aprovacao explicita. Crie uma nova sessao descrevendo somente as etapas atribuidas ao Claude ou conecte-se a uma sessao ja existente pelo identificador ou link que o usuario forneceu. O runtime local nao controla o backend de nuvem; portanto o Codex deve preservar a matriz no prompt e bloquear manualmente qualquer ampliacao. Use um ambiente remoto especifico somente quando ele tiver sido indicado. Acompanhe marcos reais e pare diante de bloqueio, desvio de escopo ou necessidade de nova autorizacao. O uso de recursos em nuvem, agentes hospedados, revisao remota, plugins ou navegador precisa estar no pedido do usuario e manter os mesmos limites de dados e autorizacao.

Nao trate limite de uso da assinatura como autorizacao para ampliar escopo ou iniciar varias sessoes. Em fluxos por API, use um teto de gasto apenas quando o usuario o tiver autorizado; em fluxos por assinatura, acompanhe somente a janela de uso exibida pelo produto e comunique indisponibilidade sem tentar contornar limites.

## Aceitacao

`COMPLETED` significa que o transporte terminou, nunca que o trabalho foi aprovado; `FAIL`, `CANCELLED` e `UNCERTAIN` nunca sao sucesso. Cada execucao preserva o log de eventos append-only e os arquivos derivados `acompanhamento.txt`, `status.json` e `resultado.json` na sua pasta; logs nunca sao sobrescritos. O painel separa "arquivos alterados observados" (pelo git do workspace) de "autoria do Claude comprovada" (registrada pelas ferramentas), e nunca mostra porcentagem de progresso inventada.

Verifique os arquivos e execute os testes relevantes independentemente do relato do Claude. Registre a distincao entre transporte concluido, ferramentas executadas e comportamento aprovado. Use o fluxo normal do projeto para revisao, commit e eventual deploy; a skill nao os executa automaticamente. Para diagnostico da instalacao, use `codeorquestra doctor`, que so faz sondagens somente leitura. Os adaptadores e parametros de teste sao exclusivos do harness local confiavel, nunca do job delegado.
