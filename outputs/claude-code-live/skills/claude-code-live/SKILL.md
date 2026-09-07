---
name: claude-code-live
description: Use when coordinating authorized local Claude Code CLI work that needs visible progress, scoped tools, controlled permissions, resumption, interruption, or native background-session management.
---

# Claude Code ao vivo

Use o CLI instalado e a autenticacao existente. A skill coordena tanto sessoes locais quanto sessoes na nuvem; escolha o destino por tarefa, nao por preferencia fixa. Nao transforme isso em automacao recorrente. O usuario acompanha uma janela de terminal; o Codex coordena, le os resultados e verifica os artefatos. O encerramento do processo nunca prova que a tarefa foi aprovada.

## Escolher o destino

| Destino | Melhor quando | Fluxo |
|---|---|---|
| Local | O trabalho depende do checkout, arquivos locais, testes ou uma allowlist precisa | Use o job desta skill, painel ao vivo e perfis `diagnostic` ou `restricted` |
| Nuvem | O trabalho pode ocorrer em sessao remota e se beneficia de recursos de nuvem do Claude Code | Use a sessao de nuvem do CLI, ou retome uma existente, e acompanhe-a pelo proprio CLI |

Antes de escolher nuvem, confirme que o repositorio e os dados necessarios estao no ambiente remoto autorizado. Nao envie segredos, arquivos de ambiente, dados pessoais ou perfis reais para criar essa conveniencia. Antes de escolher local, verifique checkout, branch e alteracoes existentes. Se ambos servirem, prefira local para trabalho que requer validacao no computador atual; prefira nuvem para uma sessao remota independente ou revisao hospedada.

## Contrato da tarefa

Crie um arquivo de prompt completo e um job JSON fora do checkout ou dentro de uma pasta de trabalho autorizada. Use `apply_patch` para cria-los. Inclua no prompt objetivo, pasta autorizada, arquivos permitidos, criterios de aceite e regras relevantes do projeto. O executor usa safe mode: nao pressupor que CLAUDE.md, AGENTS.md, hooks ou skills do projeto serao carregados automaticamente. Leia-os e transmita as regras aplicaveis.

Campos do job:

- `workspace`: caminho absoluto da pasta de trabalho.
- `promptFile`: caminho absoluto do prompt, sem segredos ou PII.
- `mode`: `chat`, `read` ou `local`.
- `profile`: `diagnostic` ou `restricted`; omitir equivale a `diagnostic` para compatibilidade.
- `model`: opcional; omitir usa `fable`, atualmente apresentado ao usuario como Fable 5.1. Uma escolha explicita no job prevalece.
- `effort`: opcional; omitir usa `high`. Valores aceitos: low, medium, high, xhigh ou max.
- `allowedCommands`: array opcional de regras Bash especificas, por exemplo `Bash(node check.cjs)`. Somente modo local. Inspecionar os scripts chamados antes de permitir a execucao. Nao usar Bash irrestrito nem regras genericas de interpretador.
- `resumeFrom`: opcional; caminho para resultado.json de uma execucao anterior no mesmo workspace.
- `timeoutSeconds`: opcional, padrao 1800.

`chat` nao oferece ferramentas; `read` oferece Read/Glob/Grep; `local` acrescenta Write/Edit e, somente com regras de comandos, Bash. Todos usam `dontAsk`, uma allowlist e `--permission-prompts none`: uma acao nao autorizada e negada, registrada como BLOCKED e nunca fica esperando uma aprovacao invisivel.

Para implementacao autorizada, use por padrao `mode: local`, `profile: restricted`, modelo Fable e esforco high. O painel deve mostrar o modelo efetivo no inicio. Se o alias `fable` deixar de corresponder ao Fable 5.1 solicitado, pare a execucao antes de aceitar o trabalho e comunique a divergencia; nao troque silenciosamente de modelo. Para diagnostico sem edicao, continue usando `read`.

| Perfil | Quando usar | Contencao |
|---|---|---|
| `diagnostic` | Diagnostico ou ambiente limpo sem personalizacoes do projeto | `--safe-mode`; ferramentas limitadas pelo job |
| `restricted` | Analise ou alteracao local com a menor superficie pratica | `--restricted`, `--safe-mode` e MCP estrito; acesso limitado ao diretorio de trabalho |

`restricted` e preferivel quando a tarefa nao depende de personalizacoes confiaveis do projeto. `diagnostic` nao e um sandbox de sistema operacional: ferramentas de arquivo e comandos aprovados ainda exigem um escopo confiavel e revisao; nao prometer isolamento de rede ou de filesystem.

Nao entregar credenciais, perfil real do owner, arquivos de ambiente, provider real, deploy ou banco externo ao Claude. Esta skill nao amplia a autorizacao da tarefa. No YOU Telecom CRM, o coordenador principal conserva o deploy e as mutacoes externas. Para mudancas locais, verificar a branch/worktree e preservar trabalho existente antes da delegacao.

## Executar e acompanhar

Execute `scripts/start-live.ps1 -JobFile <job.json> -RunDirectory <pasta-nova>` com PowerShell 7 pelo terminal do Codex. Ele abre ou reutiliza um unico painel visivel da integracao e executa o Claude em primeiro plano no terminal controlado pelo Codex. Comandos longos retornam uma sessao observavel; acompanhe com write_stdin. O usuario ja autorizou essa janela; nao pedir novamente. Um mutex rejeita execucoes concorrentes nesta integracao. Nao abrir um novo PowerShell visivel para cada tarefa.

Antes de cada execucao local, o executor consulta `/usage` sem ferramentas e mostra no painel o restante da sessao, da semana geral e da semana do Fable, com os respectivos horarios de renovacao. A consulta tambem fica registrada de forma sanitizada em `status.json` e `resultado.json`; nao persistir a resposta bruta, identificadores de MCP ou diagnosticos detalhados. Restante de 20% ou menos gera alerta; 5% ou menos gera alerta critico. A consulta nao autoriza compra de creditos, troca de modelo ou reducao de effort. Se ela falhar, mostrar `INDISPONIVEL` e deixar claro que o limite nao foi confirmado.

Esses percentuais representam limites de uso da assinatura, nao saldo monetario de creditos pre-pagos. Para saldo financeiro, encaminhar o usuario ao painel Usage da conta; nunca inferir um valor em dinheiro a partir dos percentuais do CLI.

Quando nao for necessario painel ao vivo, use o gerenciamento nativo do CLI para iniciar em segundo plano, listar tarefas, ler logs, anexar, interromper ou remover. Antes de iniciar, confirme que a tarefa pode continuar sem acompanhamento visivel. Segundo plano nao amplia permissoes: mantenha o mesmo perfil e a mesma allowlist.

## Trabalho em equipe Codex-Claude

Para tarefas de engenharia, trabalhe em ciclos verificaveis:

1. O Codex delimita o objetivo, o workspace, as regras do projeto e os criterios de aceite.
2. O Claude inspeciona os arquivos autorizados, propoe ou aplica a mudanca e executa apenas os testes/comandos permitidos.
3. O Codex revisa o diff e as evidencias independentemente. Quando houver lacuna, risco ou alternativa melhor, envia uma correcao objetiva retomando a mesma sessao.
4. O Claude revisa a proposta corrigida ou o novo diff. O Codex decide pela aceitacao com base nos artefatos e testes, nao por concordancia entre modelos.

Use `resumeFrom` quando o objetivo e o workspace continuarem compativeis, preservando a conversa e a grande janela de contexto. Mantenha no prompt seguinte um resumo curto das decisoes, evidencias e pendencias; deixe o Claude reler o codigo necessario com as ferramentas autorizadas, em vez de copiar o repositorio inteiro para o prompt. Uma nova tarefa, mudanca material de escopo ou contexto contaminado exige uma nova sessao.

Os modelos colaboram por propostas, diffs, resultados de testes e respostas publicas; nao alegue acesso ao raciocinio interno de nenhum deles. Divergencias sao resolvidas por evidencia reproduzivel. O Codex permanece responsavel por autorizacao, revisao final, mutacoes externas e deploy.

## Sessoes na nuvem

Para uma tarefa na nuvem, crie uma nova sessao descrevendo o objetivo ou conecte-se a uma sessao ja existente pelo identificador ou link que o usuario forneceu. Use um ambiente remoto especifico somente quando ele tiver sido indicado. Para trabalho longo, o CLI oferece execucao em segundo plano, listagem, logs, conexao ao terminal e interrupcao; acompanhe marcos reais e pare diante de bloqueio, desvio de escopo ou necessidade de nova autorizacao. O uso de recursos em nuvem, agentes hospedados, revisao remota, plugins ou navegador precisa estar no pedido do usuario e manter os mesmos limites de dados e autorizacao.

Nao trate limite de uso da assinatura como autorizacao para ampliar escopo ou iniciar varias sessoes. Em fluxos por API, use um teto de gasto apenas quando o usuario o tiver autorizado; em fluxos por assinatura, acompanhe somente a janela de uso exibida pelo produto e comunique indisponibilidade sem tentar contornar limites.

Leia `acompanhamento.txt` e `status.json` na pasta da execucao em intervalos razoaveis enquanto o terminal mostra os eventos ao vivo. O modelo efetivo aparece no inicio. Nao repetir atualizacoes sem mudanca; comunicar resultado, bloqueio ou mudanca concreta. Nao mostrar eventos JSON brutos, argumentos/resultados de ferramentas, stderr ou raciocinio interno. O texto publico e armazenado; portanto somente delegar dados autorizados e sanitizados. Nao alegar redacao automatica de qualquer segredo.

O usuario pode apertar Q no painel ou pedir parada aqui. Para parar por aqui, crie `stop.request` na pasta exata da execucao com `apply_patch`; o executor encerra o processo filho e seus descendentes. Ctrl+C no terminal executor tambem aciona a limpeza no finally. X ou fechar o painel encerra somente a visualizacao, nao o trabalho; o painel reabre na proxima chamada. O ultimo resultado permanece visivel e as tarefas seguintes reutilizam a janela. Fechamento forcado do executor ou queda do sistema nao foram garantidos: verificar processos antes de retomar.

`resultado.json` contem status, sessionId, workspace, modelo, perfil, nomes das ferramentas, quantidade de falhas de ferramenta, negativas de permissao e resposta final. `COMPLETED` significa que o CLI terminou, nao que a tarefa foi aprovada. `FAIL`, `BLOCKED`, `CANCELLED` e `TIMEOUT` nunca sao sucesso. Logs ficam preservados; nao sobrescrever uma pasta de execucao anterior.

Para continuar, crie outro job com `resumeFrom` apontando ao resultado anterior e outra pasta de execucao. A retomada conserva o contexto salvo, nao desfaz edicoes nem repete ferramentas automaticamente. Reinspecione artefatos depois de interrupcao e explique o que falta no prompt seguinte. Nunca reexecutar cegamente uma mutacao. Use sessao em nuvem, plugins, diretorios adicionais, Chrome e agentes somente quando o usuario os pedir explicitamente; eles aumentam o escopo de acesso e nao fazem parte do caminho padrao.

## Aceitacao

Verifique os arquivos e execute os testes relevantes independentemente do relato do Claude. Registre a distincao entre transporte concluido, ferramentas executadas e comportamento aprovado. Use o fluxo normal do projeto para revisao, commit e eventual deploy; a skill nao os executa automaticamente. Para diagnostico da instalacao, use a verificacao de saude do CLI antes de alterar configuracoes; para limite de custo em chamadas por API, defina um teto somente quando o usuario o tiver autorizado.
