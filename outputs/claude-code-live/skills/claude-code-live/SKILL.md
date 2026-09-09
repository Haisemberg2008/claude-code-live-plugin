---
name: claude-code-live
description: Use when coordinating authorized Claude Code CLI work that needs explicit responsibility assignment, an approved plan, visible progress, scoped tools, controlled permissions, resumption, interruption, or background-session management.
---

# OpenAInthropic

OpenAInthropic e a marca visivel desta integracao local independente para o Codex coordenar Opus e Fable; nao e produto oficial nem representa parceria entre OpenAI e Anthropic. O identificador tecnico da skill permanece `claude-code-live`.

Use o CLI instalado e a autenticacao existente. A skill coordena tanto sessoes locais quanto sessoes na nuvem; escolha o destino por tarefa, nao por preferencia fixa. Nao transforme isso em automacao recorrente. O usuario acompanha uma janela de terminal; o Codex coordena, le os resultados e verifica os artefatos. O encerramento do processo nunca prova que a tarefa foi aprovada.

## Escolher o destino

| Destino | Melhor quando | Fluxo |
|---|---|---|
| Local | O trabalho depende do checkout, arquivos locais, testes ou uma allowlist precisa | Use o job desta skill, painel ao vivo e perfis `diagnostic` ou `restricted` |
| Nuvem | O trabalho pode ocorrer em sessao remota e se beneficia de recursos de nuvem do Claude Code | Use a sessao de nuvem do CLI, ou retome uma existente, e acompanhe-a pelo proprio CLI |

Antes de escolher nuvem, confirme que o repositorio e os dados necessarios estao no ambiente remoto autorizado. Nao envie segredos, arquivos de ambiente, dados pessoais ou perfis reais para criar essa conveniencia. Antes de escolher local, verifique checkout, branch e alteracoes existentes. Se ambos servirem, prefira local para trabalho que requer validacao no computador atual; prefira nuvem para uma sessao remota independente ou revisao hospedada.

## Planejar e atribuir antes de executar

Antes de iniciar implementacao ou qualquer mutacao, inspecione em modo somente leitura o necessario para propor um plano realista. Em uma unica tabela, apresente estas oito responsabilidades e atribua exatamente um ator a cada uma: `planning`, `inspection`, `implementation`, `testing`, `review`, `commit`, `push` e `deploy`. Os atores aceitos sao `codex`, `claude`, `user` e `not_applicable`. `deploy` inclui publicacao e qualquer mutacao externa.

Explique o plano, a matriz e as permissoes que o job concedera, e aguarde aprovacao explicita do usuario. Silencio, envio do plano ou autorizacao anterior para uma tarefa diferente nao significam aprovacao. Antes da aprovacao final, uma sessao Claude pode participar do planejamento somente em `chat` ou `read`; nenhuma ferramenta de escrita ou comando e permitido.

Claude nunca recebe `commit`, `push` ou `deploy`. Essas responsabilidades pertencem ao Codex, ao usuario ou ficam como `not_applicable`. Depois da aprovacao, execute apenas as etapas atribuidas ao Claude. O Codex nao assume automaticamente as demais: segue a matriz e solicita nova decisao quando surgir uma acao que nao estava prevista.

## Contrato da tarefa

Crie um arquivo de prompt completo e um job JSON fora do checkout ou dentro de uma pasta de trabalho autorizada. Use `apply_patch` para cria-los. Inclua no prompt objetivo, pasta autorizada, arquivos permitidos, criterios de aceite e regras relevantes do projeto. O executor usa safe mode: nao pressupor que CLAUDE.md, AGENTS.md, hooks ou skills do projeto serao carregados automaticamente. Leia-os e transmita as regras aplicaveis.

Campos do job:

- `workspace`: caminho absoluto da pasta de trabalho.
- `promptFile`: caminho absoluto do prompt, sem segredos ou PII.
- `mode`: `chat`, `read`, `verify` ou `local`.
- `profile`: `diagnostic` ou `restricted`; omitir equivale a `diagnostic` para compatibilidade.
- `model`: opcional; omitir usa `fable`, atualmente apresentado ao usuario como Fable 5.1. Nao combinar com `modelPolicy`.
- `modelPolicy`: opcional e opt-in. Em `quota-aware`, usa Fable como primario, Opus como alternativo e um limite configuravel de restante.
- `effort`: opcional; omitir usa `high`. Valores aceitos: low, medium, high, xhigh ou max.
- `coordination`: contrato obrigatorio com `phase`, `scopeId`, `approvalRevision`, `planSummary`, `planApproved` e `responsibilities` para as oito etapas.
- `allowedCommands`: array opcional de objetos com `rule` e `responsibility`, por exemplo `{ "rule": "Bash(node check.cjs)", "responsibility": "testing" }`. Somente `verify` ou `local`. Inspecionar os scripts chamados antes de permitir a execucao. Nao usar Bash irrestrito nem regras genericas de interpretador.
- `resumeFrom`: opcional; caminho para resultado.json de uma execucao anterior no mesmo workspace.
- `codexThreadId`: fallback opcional para chamadas fora do Codex. Dentro do Codex, use automaticamente `CODEX_THREAD_ID`; nunca invente ou copie o id de outra tarefa.
- `timeoutSeconds`: opcional, padrao 1800.

`chat` nao oferece ferramentas; `read` oferece Read/Glob/Grep; `verify` acrescenta Bash somente para comandos exatos atribuidos a `inspection` ou `testing`; `local` acrescenta Write/Edit e pode executar comandos exatos de `inspection`, `implementation` ou `testing`. Cada comando exige que Claude seja o responsavel pela etapa indicada. Todos usam `dontAsk`, uma allowlist e `--permission-prompts none`: uma acao nao autorizada e negada, registrada como BLOCKED e nunca fica esperando uma aprovacao invisivel.

Use `phase: planning` antes da aprovacao, somente com `chat` ou `read`; a matriz ja deve ter sido escolhida, mas `planApproved` pode ser falso e `planSummary` pode estar vazio. Use `phase: execution` somente com resumo nao vazio e `planApproved: true`. O executor recusa jobs antigos sem `coordination`, matrizes incompletas, atores invalidos, edicao quando `implementation` nao pertence ao Claude e comandos ligados a etapas de outro ator.

Para implementacao atribuida ao Claude e autorizada, use por padrao `mode: local`, `profile: restricted`, modelo Fable e esforco high. Para testes atribuidos ao Claude quando outro ator implementa, use `verify`, que nao concede Write/Edit. O painel deve mostrar o modelo efetivo no inicio. Se o alias `fable` deixar de corresponder ao Fable 5.1 solicitado, pare a execucao antes de aceitar o trabalho e comunique a divergencia; nao troque silenciosamente de modelo. Para diagnostico sem comandos, continue usando `read`.

| Perfil | Quando usar | Contencao |
|---|---|---|
| `diagnostic` | Diagnostico ou ambiente limpo sem personalizacoes do projeto | `--safe-mode`; ferramentas limitadas pelo job |
| `restricted` | Analise ou alteracao local com a menor superficie pratica | `--restricted`, `--safe-mode` e MCP estrito; acesso limitado ao diretorio de trabalho |

`restricted` e preferivel quando a tarefa nao depende de personalizacoes confiaveis do projeto. `diagnostic` nao e um sandbox de sistema operacional: ferramentas de arquivo e comandos aprovados ainda exigem um escopo confiavel e revisao; nao prometer isolamento de rede ou de filesystem.

Nao entregar credenciais, perfil real do owner, arquivos de ambiente, provider real, deploy ou banco externo ao Claude. Esta skill nao amplia a autorizacao da tarefa. No YOU Telecom CRM, o coordenador principal conserva o deploy e as mutacoes externas. Para mudancas locais, verificar a branch/worktree e preservar trabalho existente antes da delegacao.

## Executar e acompanhar

Execute `scripts/start-live.ps1 -JobFile <job.json> -RunDirectory <pasta-nova>` com PowerShell 7 pelo terminal do Codex. O executor usa `CODEX_THREAD_ID` para abrir ou reutilizar um painel, mutex e estado exclusivos da tarefa Codex atual. Jobs da mesma tarefa sao serializados; tarefas Codex diferentes podem executar simultaneamente e recebem sessoes Claude independentes. A consulta `/usage` continua serializada globalmente porque a quota pertence a conta. Comandos longos retornam uma sessao observavel; acompanhe com write_stdin. O usuario ja autorizou essa janela; nao pedir novamente.

Antes de cada execucao local, o executor consulta `/usage` sem ferramentas e mostra no painel o restante da sessao, da semana geral e da semana do Fable, com os respectivos horarios de renovacao. A consulta tambem fica registrada de forma sanitizada em `status.json` e `resultado.json`; nao persistir a resposta bruta, identificadores de MCP ou diagnosticos detalhados. Restante de 20% ou menos gera alerta; 5% ou menos gera alerta critico. A consulta nao autoriza compra de creditos, troca de modelo ou reducao de effort. Se ela falhar, mostrar `INDISPONIVEL` e deixar claro que o limite nao foi confirmado.

Quando o usuario aprovar selecao automatica por quota, omita `model` e use `modelPolicy: { "mode": "quota-aware", "primary": "fable", "alternate": "opus", "switchAtRemainingPercent": 3 }`. O limite e opcional, padrao 3, e aceita inteiro de 1 a 20. Antes de iniciar ou retomar, calcule a capacidade compartilhada como o menor restante entre sessao e semana geral; o restante efetivo do Fable e o menor entre capacidade compartilhada e limite Fable. Use Fable acima do limite, Opus quando apenas Fable estiver no limite ou abaixo, e bloqueie quando a capacidade compartilhada estiver no limite ou abaixo. Se `/usage` falhar ou mudar de formato, bloqueie somente o job quota-aware; jobs de modelo fixo preservam o comportamento anterior. Reavalie em cada inicio/retomada para voltar ao Fable depois da renovacao. Nao use `--fallback-model` para isso. Registre politica, percentuais sanitizados, solicitado, efetivo e motivo no painel e nos JSONs. Mudanca da politica em retomada requer aprovacao nova e `approvalRevision` maior.

Esses percentuais representam limites de uso da assinatura, nao saldo monetario de creditos pre-pagos. Para saldo financeiro, encaminhar o usuario ao painel Usage da conta; nunca inferir um valor em dinheiro a partir dos percentuais do CLI.

Quando nao for necessario painel ao vivo, use o gerenciamento nativo do CLI para iniciar em segundo plano, listar tarefas, ler logs, anexar, interromper ou remover. Antes de iniciar, confirme que a tarefa pode continuar sem acompanhamento visivel. Segundo plano nao amplia permissoes: mantenha o mesmo perfil e a mesma allowlist.

## Trabalho em equipe Codex-Claude

Para tarefas de engenharia, trabalhe em ciclos verificaveis:

1. O Codex delimita o objetivo, o workspace, as regras do projeto e os criterios de aceite.
2. O Claude executa somente as etapas que a matriz lhe atribuiu, nos arquivos autorizados e com os testes/comandos permitidos.
3. O Codex revisa o diff e as evidencias independentemente. Quando houver lacuna, risco ou alternativa melhor, envia uma correcao objetiva retomando a mesma sessao.
4. O Claude revisa a proposta corrigida ou o novo diff. O Codex decide pela aceitacao com base nos artefatos e testes, nao por concordancia entre modelos.

Na mesma tarefa Codex, o executor retoma automaticamente a ultima sessao Claude apenas quando thread, workspace, modo, perfil, effort, modelo/politica, plano, revisao e matriz forem identicos. Qualquer diferenca inicia sessao nova. Use `resumeFrom` para retomada explicita quando o objetivo e o workspace continuarem compativeis; resultados vinculados a outra tarefa Codex sao rejeitados. Resultados legados sem identidade de tarefa seguem as verificacoes anteriores. Qualquer mudanca aprovada exige `approvalRevision` maior. Mantenha no prompt seguinte um resumo curto das decisoes, evidencias e pendencias; deixe o Claude reler o codigo necessario com as ferramentas autorizadas, em vez de copiar o repositorio inteiro para o prompt.

Os modelos colaboram por propostas, diffs, resultados de testes e respostas publicas; nao alegue acesso ao raciocinio interno de nenhum deles. Divergencias sao resolvidas por evidencia reproduzivel. O Codex permanece responsavel por autorizacao, revisao final, mutacoes externas e deploy.

## Sessoes na nuvem

Para uma tarefa na nuvem, aplique primeiro o mesmo plano, matriz e aprovacao explicita. Crie uma nova sessao descrevendo somente as etapas atribuidas ao Claude ou conecte-se a uma sessao ja existente pelo identificador ou link que o usuario forneceu. O runner local nao controla o backend de nuvem; portanto o Codex deve preservar a matriz no prompt e bloquear manualmente qualquer ampliacao. Use um ambiente remoto especifico somente quando ele tiver sido indicado. Para trabalho longo, o CLI oferece execucao em segundo plano, listagem, logs, conexao ao terminal e interrupcao; acompanhe marcos reais e pare diante de bloqueio, desvio de escopo ou necessidade de nova autorizacao. O uso de recursos em nuvem, agentes hospedados, revisao remota, plugins ou navegador precisa estar no pedido do usuario e manter os mesmos limites de dados e autorizacao.

Nao trate limite de uso da assinatura como autorizacao para ampliar escopo ou iniciar varias sessoes. Em fluxos por API, use um teto de gasto apenas quando o usuario o tiver autorizado; em fluxos por assinatura, acompanhe somente a janela de uso exibida pelo produto e comunique indisponibilidade sem tentar contornar limites.

Leia `acompanhamento.txt` e `status.json` na pasta da execucao em intervalos razoaveis enquanto o terminal mostra os eventos ao vivo. O modelo efetivo aparece no inicio. Nao repetir atualizacoes sem mudanca; comunicar resultado, bloqueio ou mudanca concreta. Nao mostrar eventos JSON brutos, argumentos/resultados de ferramentas, stderr ou raciocinio interno. O texto publico e armazenado; portanto somente delegar dados autorizados e sanitizados. Nao alegar redacao automatica de qualquer segredo.

O usuario pode apertar Q no painel da tarefa ou pedir parada aqui. Para parar por aqui, crie `stop.request` na pasta exata da execucao com `apply_patch`; o executor encerra o processo filho e seus descendentes. Ctrl+C no terminal executor tambem aciona a limpeza no finally. X ou fechar o painel encerra somente a visualizacao, nao o trabalho; o painel daquela tarefa reabre na proxima chamada. Fechamento forcado do executor ou queda do sistema nao foram garantidos: verificar processos antes de retomar.

`resultado.json` contem status, sessionId, workspace, modelo, perfil, contrato de coordenacao sanitizado, nomes das ferramentas, quantidade de falhas de ferramenta, negativas de permissao e resposta final. O painel mostra fase, escopo, revisao aprovada, resumo e responsaveis. `COMPLETED` significa que o CLI terminou, nao que a tarefa foi aprovada. `FAIL`, `BLOCKED`, `CANCELLED` e `TIMEOUT` nunca sao sucesso. Logs ficam preservados; nao sobrescrever uma pasta de execucao anterior.

Para continuar na mesma tarefa Codex, crie outro job compatível em outra pasta de execucao; o executor usa o ponteiro duravel `session.json` e retoma automaticamente. Use `resumeFrom` para escolher explicitamente um resultado compativel. A retomada conserva o contexto salvo, nao desfaz edicoes nem repete ferramentas automaticamente. Reinspecione artefatos depois de interrupcao e explique o que falta no prompt seguinte. Nunca reexecutar cegamente uma mutacao. Use sessao em nuvem, plugins, diretorios adicionais, Chrome e agentes somente quando o usuario os pedir explicitamente; eles aumentam o escopo de acesso e nao fazem parte do caminho padrao.

## Aceitacao

A compatibilidade de retomada inclui `allowedCommands`, normalizados e ordenados com suas responsabilidades. Resultados antigos sem esse campo nao retomam automaticamente; para retomada explicita exigem `approvalRevision` maior, assim como mudancas nos comandos. Falhas de preparacao geram estado terminal sanitizado e preservam o ponteiro da ultima sessao confirmada. `startedAt` alimenta o tempo decorrido do painel e `usageCheckedAt` data a tentativa de consulta inicial. Nao apresentar esses limites como monitoramento continuo nem prometer troca durante uma execucao. O painel identifica a tarefa no titulo e le novos bytes do log incrementalmente. Os adaptadores e parametros de teste sao exclusivos do harness local confiavel, nunca do job delegado.

Verifique os arquivos e execute os testes relevantes independentemente do relato do Claude. Registre a distincao entre transporte concluido, ferramentas executadas e comportamento aprovado. Use o fluxo normal do projeto para revisao, commit e eventual deploy; a skill nao os executa automaticamente. Para diagnostico da instalacao, use a verificacao de saude do CLI antes de alterar configuracoes; para limite de custo em chamadas por API, defina um teto somente quando o usuario o tiver autorizado.
