# CodeOrquestra

![Arquitetura do CodeOrquestra: Codex Terra e Sol coordenam sessões isoladas do Claude Fable e Opus por MCP local, painel ao vivo e revisão independente](outputs/claude-code-live/assets/codeorquestra-architecture-v2.png)

**Codex com Opus e Fable.** CodeOrquestra é a marca visível desta integração local independente para coordenar tarefas do Claude Code a partir do Codex. Modelos Codex, como Terra e Sol, usam sua capacidade de planejamento, supervisão e revisão para gerenciar sessões separadas do Claude Opus e Fable, sempre com responsáveis explícitos, permissões decididas ao vivo, acompanhamento e retomada controlados. Os modelos disponíveis dependem da configuração da conta e podem mudar. Não é um produto oficial nem representa parceria entre OpenAI e Anthropic.

Identificador técnico: `codeorquestra`. O alias `claude-code-live` continua em uso nos nomes de skill, diretórios de estado e arquivos derivados, preservando instalações, comandos, caminhos, automações e sessões existentes.

O pacote instalável fica em [`outputs/claude-code-live`](outputs/claude-code-live/README.md); o runtime, em [`outputs/claude-code-live/runtime`](outputs/claude-code-live/runtime/README.md). O diretório `work/`, quando existir, contém somente artefatos locais de validação e não faz parte do repositório.

## Como o Claude Code é acionado

Nada do Claude Code é empacotado aqui: o CodeOrquestra controla a instalação do Claude Code que já existe na sua máquina, com a autenticação que você já usa. O runtime conversa diretamente com o processo do CLI instalado pelo protocolo `stream-json` que o próprio CLI documenta, sem importar nem redistribuir o Agent SDK. Antes de iniciar, o preflight confirma que aquela build anuncia todas as flags de que o runtime depende; se faltar alguma, a execução não começa e o motivo é reportado. Nenhum CLI alternativo é usado como substituto e nenhum caminho de cobrança por API é ativado automaticamente.

## O que o plugin faz

- Escolhe entre execução local controlada e sessão em nuvem do Claude Code.
- Exige planejamento e uma matriz de responsáveis antes de implementação ou mutação.
- Deriva as capacidades do Claude (leitura, edição, testes) do contrato aprovado, e classifica cada ação pelo caminho resolvido.
- Mantém uma sessão Claude durável e multiturno por tarefa Codex, com fila de orientações, permissões e perguntas decididas ao vivo e interrupção de turno.
- Mostra tudo num painel web local e num log de eventos append-only; nunca inventa progresso nem expõe raciocínio interno.
- Permite trabalho em paralelo em worktrees isolados, com trava de escrita por árvore e teto de execuções por repositório.
- Fixa, quando pedido, um orçamento por execução (tokens, turnos, tempo) que recusa o próximo turno sem abortar o atual.
- Permite trocar entre Fable e Opus entre turnos, com motivo registrado, à vista do consumo por fonte.
- Mantém commit, push, PR, deploy, publicação e outras mutações externas fora do Claude.
- Obriga o Codex a revisar artefatos e testes; término do processo não equivale a aceite.

## Uma geração

O runtime (Node 22+, TypeScript) é a única geração: broker HTTP em loopback, um worker por tarefa Codex, adaptador MCP stdio (`codeorquestra_*`), CLI e painel web. O runner PowerShell (v1) foi aposentado em setembro de 2026; jobs no formato antigo são recusados com a orientação de migração — veja [Migração do v1](outputs/claude-code-live/README.md#migração-do-v1). A referência completa está em [`references/runtime-v2.md`](outputs/claude-code-live/skills/claude-code-live/references/runtime-v2.md).

## Fluxo obrigatório antes da execução

Quando a skill `claude-code-live` for usada, o Codex:

1. Inspeciona somente em leitura o necessário para preparar um plano realista.
2. Apresenta o plano e uma matriz com as oito responsabilidades.
3. Aguarda aprovação explícita do usuário.
4. Executa somente as etapas atribuídas ao Claude, com as capacidades que o contrato deriva.
5. Revisa o diff, os testes e os artefatos independentemente.

Silêncio, envio do plano ou autorização de outra tarefa não contam como aprovação. Se surgir uma ação não prevista ou mudar plano, escopo ou responsável, a execução deve parar para uma nova decisão.

### Matriz de responsáveis

Cada linha recebe exatamente um ator: `codex`, `claude`, `user` ou `not_applicable`.

| Responsabilidade | Abrange |
|---|---|
| `planning` | Planejamento e critérios de aceite |
| `inspection` | Leitura e diagnóstico do projeto |
| `implementation` | Criação ou edição de arquivos |
| `testing` | Testes, builds e verificações permitidas |
| `review` | Revisão técnica e decisão de aceite |
| `commit` | Criação de commits Git |
| `push` | Push e abertura ou merge de PR |
| `deploy` | Deploy, publicação e outras mutações externas |

Claude nunca pode ser responsável por `commit`, `push` ou `deploy`. Essas linhas aceitam somente `codex`, `user` ou `not_applicable`.

## Contrato do job

Um job é um objeto JSON `contractVersion: 2` com `workspace`, `prompt` (ou `promptFile`), `profile` (`development` ou `read`), `model` (`requested` exato e `reason`), `effort: "xhigh"`, `coordination` (fase, escopo, revisão, plano, matriz) e `scope` (resumo e caminhos). Opcionais: `execution` (worktree), `limits` (orçamento), `auth.allowApiBilling` (cobrança por API, só com autorização explícita). O exemplo completo e a semântica de cada campo estão no [README do pacote](outputs/claude-code-live/README.md#contrato-do-job).

## Execução e acompanhamento local

![Fluxo Painel Primeiro: registrar a tarefa, abrir ou reutilizar uma única aba, confirmar o painel, iniciar Claude, acompanhar ao vivo e revisar a entrega](outputs/claude-code-live/assets/codeorquestra-panel-first.png)

Na ordem que o broker verifica: identidade (`codeorquestra task register` ou `codeorquestra_pair`), confiança nas personalizações do projeto (`codeorquestra_inventory` + `codeorquestra_trust`), canal de acompanhamento (`codeorquestra_dashboard_url` + uma única aba, ou `observation.mode: "voz"`), e só então `codeorquestra_start`. Sem canal anexado, o início é recusado em vez de começar em silêncio.

Durante a sessão: `codeorquestra_wait` (eventos + presença do coordenador), `codeorquestra_message` e `codeorquestra_annotate` (orientação para o próximo turno), `codeorquestra_answer` (permissões e perguntas), `codeorquestra_interrupt` (aborta o turno), `codeorquestra_end` (encerra a sessão), `codeorquestra_set_model`, `codeorquestra_usage_refresh`. A supervisão só alerta; nada encerra sozinho.

O painel mostra o feed público cronológico, o inspetor (modelo, esforço, execução, orçamento, capacidade, consumo por fonte, arquivos alterados) e os controles nativos, com confirmação vinculada à tarefa exata. Cada execução preserva o log de eventos e deriva `acompanhamento.txt`, `status.json` e `resultado.json`. `COMPLETED` confirma o transporte, não o aceite.

## Retomada

Na mesma tarefa Codex, a execução seguinte retoma a última sessão Claude somente quando workspace, perfil, modelo, esforço, plano, revisão, responsáveis, escopo, destino e política de autenticação continuam compatíveis. Mudança material cria uma sessão nova, sem importar contexto anterior. Retomar não desfaz edições nem repete ferramentas: reinspecione o estado primeiro. Um fim de sessão que ninguém pediu deixa a execução `UNCERTAIN` e exige revisão explícita antes de outra.

## Sessões na nuvem

O mesmo plano, matriz e aprovação são obrigatórios antes de criar ou retomar uma sessão em nuvem. O prompt remoto contém somente as etapas atribuídas ao Claude. O runtime local não controla o backend de nuvem; o Codex aplica a matriz no prompt e na revisão. Não use nuvem para transportar credenciais, `.env`, PII, perfis reais ou payloads sensíveis. Sessões em nuvem e tarefas locais em segundo plano são backends diferentes.

## Segurança e limites

A skill não amplia a autorização do pedido. Ela não concede permissão para instalar ou atualizar software, acessar banco ou provedor, criar ambientes, ampliar diretórios, fazer commit, push, PR, publicação ou deploy.

Não coloque em prompt, job, log ou sessão remota tokens, senhas, cookies, chaves privadas, `.env`, dados reais de clientes, perfis administrativos ou payloads brutos de provedores.

O runtime falha fechado (credenciais de API sem autorização, trust pendente, hook de permissão não aplicado, build do CLI sem as flags exigidas) e escuta só em loopback. Escopo, classificador de ações e trust reduzem a superfície de acesso, mas não são sandbox de rede ou sistema operacional. O Codex valida o resultado no repositório e no ambiente autorizado.

## Estrutura do repositório

- `outputs/claude-code-live/.codex-plugin/plugin.json`: manifesto.
- `outputs/claude-code-live/.mcp.json`: registra no Codex o adaptador MCP `codeorquestra`, executado a partir do bundle local.
- `outputs/claude-code-live/skills/claude-code-live/SKILL.md`: regras principais que o Codex lê.
- `outputs/claude-code-live/skills/claude-code-live/references/`: runtime, segurança e nuvem.
- `outputs/claude-code-live/runtime/`: broker, worker, MCP stdio, CLI, painel web e testes.
- `outputs/claude-code-live/assets/`: ícone, visão de arquitetura e fluxo visual de painel primeiro.
- `docs/history/`: registro das rodadas de revisão e do brief de implementação.
- `docs/superpowers/plans/`: planos históricos.
- `.github/workflows/verify.yml`: o mesmo `npm run verify` de sempre, mais a recusa de `dist/` desatualizado.

## Instalação

O Codex instala plugins por marketplace. Este projeto não altera marketplaces automaticamente.

1. Coloque `outputs/claude-code-live` em `plugins/claude-code-live` do marketplace autorizado.
2. Adicione ou valide a entrada usando o fluxo oficial de `plugin-creator`.
3. Para marketplace não padrão, execute `codex plugin marketplace add <raiz>`.
4. Execute `codex plugin add claude-code-live@<marketplace>`.
5. Abra uma nova tarefa para carregar a versão instalada.

Na tarefa nova, o Codex passa a enxergar as ferramentas `codeorquestra_*`. O adaptador MCP inicia ou reutiliza o broker local; cada tarefa precisa registrar sua identidade uma vez para obter o `taskHandle` privado que limita todas as ações daquela sessão. O painel é aberto por um link local de uso único e continua funcionando mesmo que a aba seja fechada.

O marketplace pessoal padrão em `~/.agents/plugins/marketplace.json` é descoberto implicitamente e não exige `marketplace add`.

## Atualização

Após editar e validar:

1. Use `update_plugin_cachebuster.py`, da skill `plugin-creator`, para atualizar o sufixo de cache.
2. Reinstale com `codex plugin add claude-code-live@<marketplace>`.
3. Teste em uma nova tarefa.

Não edite `marketplace.json` manualmente.

## Validação

```bash
cd outputs/claude-code-live/runtime && npm ci --ignore-scripts && npm run verify
```

`verify` executa typecheck, build, a suíte do broker contra um CLI simulado e os testes de navegador do painel. Nada disso autentica nem inicia uma sessão Claude real; fluxos reais de permissão, interrupção, retomada ou nuvem exigem projeto descartável e autorização específica. O GitHub Actions roda o mesmo comando em `windows-latest` e recusa um `dist/` que não corresponda à fonte.

## Licença

Apache License 2.0 — veja [`LICENSE`](LICENSE). O código pode ser usado, modificado e redistribuído nos termos dessa licença, que inclui concessão explícita de patentes. Ela **não** concede uso do nome CodeOrquestra, do logotipo nem da marca YOU Telecom (seção 6 da licença). CodeOrquestra não é um produto oficial nem representa parceria entre OpenAI e Anthropic; o Claude Code e o Codex continuam sujeitos aos termos dos seus fornecedores.
