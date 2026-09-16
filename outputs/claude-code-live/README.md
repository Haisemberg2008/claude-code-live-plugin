# CodeOrquestra

![Arquitetura do CodeOrquestra: Codex Terra e Sol coordenam sessões isoladas do Claude Fable e Opus por MCP local, painel ao vivo e revisão independente](assets/codeorquestra-architecture-v2.png)

**Codex com Opus e Fable.** CodeOrquestra é a marca visível desta integração local independente para coordenar o Claude Code que você já instalou, local ou em nuvem. Modelos Codex, como Terra e Sol, usam sua capacidade de planejamento, supervisão e revisão para gerenciar sessões separadas do Claude Opus e Fable, sempre com responsáveis explícitos, permissões decididas ao vivo, acompanhamento e retomada controlados. Os modelos disponíveis dependem da configuração da conta e podem mudar. Não é um produto oficial nem representa parceria entre OpenAI e Anthropic.

Identificador técnico: `codeorquestra`. O alias `claude-code-live` continua em uso nos nomes de skill, diretórios de estado e arquivos derivados, preservando instalações, caminhos, automações e sessões existentes.

Este pacote contém uma única geração: o runtime em [`runtime/`](runtime/README.md) (Node 22+, TypeScript), com broker HTTP em loopback, um worker por tarefa Codex, adaptador MCP stdio (`codeorquestra_*`), CLI e painel web. O runner PowerShell (v1) foi aposentado em setembro de 2026; veja [Migração do v1](#migração-do-v1).

## Fluxo obrigatório

Antes de implementação ou mutação, o Codex:

1. inspeciona somente em leitura;
2. apresenta o plano;
3. atribui `planning`, `inspection`, `implementation`, `testing`, `review`, `commit`, `push` e `deploy` a `codex`, `claude`, `user` ou `not_applicable`;
4. aguarda aprovação explícita;
5. executa apenas as etapas atribuídas ao Claude e revisa os resultados independentemente.

Claude nunca pode receber `commit`, `push` ou `deploy`; o contrato recusa a atribuição. `deploy` também representa publicação e outras mutações externas. Mudanças de plano, escopo ou responsável exigem nova aprovação e `approvalRevision` maior.

## Contrato do job

```json
{
  "contractVersion": 2,
  "workspace": "C:\\projeto-autorizado",
  "prompt": "Implemente o recurso aprovado dentro do escopo.",
  "profile": "development",
  "model": { "requested": "claude-fable-5-1", "reason": "Tarefa longa de implementação." },
  "effort": "xhigh",
  "coordination": {
    "phase": "execution",
    "scopeId": "corrigir-validacao",
    "approvalRevision": 1,
    "planSummary": "Implementar a correção aprovada e rodar os testes.",
    "planApproved": true,
    "responsibilities": {
      "planning": "codex", "inspection": "claude", "implementation": "claude", "testing": "claude",
      "review": "codex", "commit": "codex", "push": "codex", "deploy": "not_applicable"
    }
  },
  "scope": { "summary": "módulo de validação", "paths": ["src/validacao/"] },
  "limits": { "maxTokens": 200000, "maxTurns": 20 }
}
```

- `profile`: `development` (ferramentas nativas completas dentro do escopo aprovado) ou `read` (somente leitura).
- As capacidades **derivam** do contrato, não de uma allowlist: `phase: planning` ou `profile: read` não concedem edição nem comandos; `implementation: claude` concede edição; `testing: claude` concede testes. O classificador de ações decide sobre o caminho resolvido; o que ele não decide sozinho vira um pedido de permissão visível ao coordenador.
- `model.requested` exige o identificador exato (`claude-fable-5-1` ou `claude-opus-5`) e `model.reason`; `effort` é sempre `xhigh`. Divergência entre modelo solicitado e observado, ou rebaixamento de esforço relatado pelo CLI, encerra a execução de forma visível.
- `execution: { "mode": "worktree" }` pede uma árvore isolada para trabalho em paralelo; `limits` fixa um orçamento por execução; `auth.allowApiBilling` só com autorização explícita do usuário. Todos opcionais.

## Executar

![Fluxo Painel Primeiro: registrar a tarefa, abrir ou reutilizar uma única aba, confirmar o painel, iniciar Claude, acompanhar ao vivo e revisar a entrega](assets/codeorquestra-panel-first.png)

Na tarefa Codex, as ferramentas `codeorquestra_*` conversam com o broker local. A ordem é verificada pelo broker:

1. **Identidade** — `codeorquestra task register` no terminal, ou `codeorquestra_pair` com o código curto exibido pelo painel, devolve o `taskHandle` da tarefa. Ele é a capacidade que autoriza todas as outras ferramentas; um novo registro rotaciona o anterior.
2. **Confiança** — `codeorquestra_inventory` lista o que o CLI carregaria (`CLAUDE.md`, `AGENTS.md`, hooks, skills, MCPs); o usuário aprova por `codeorquestra_trust`. Enquanto algo estiver pendente, nenhuma fonte de configuração é carregada.
3. **Canal de acompanhamento** — com `observation.mode: "painel"` (padrão), gere o link de uso único com `codeorquestra_dashboard_url` e abra ou reutilize uma única aba; sem assinante do fluxo de eventos, o início é recusado com `OBSERVATION_REQUIRED`. Com `observation.mode: "voz"`, o coordenador assume o acompanhamento narrado e a escolha fica registrada.
4. **Início** — `codeorquestra_start` com o job. Execuções da mesma tarefa serializam; uma trava de escrita por checkout atravessa tarefas; perfis somente leitura coexistem com um escritor.

Durante a sessão, durável e multiturno: `codeorquestra_wait` acompanha os eventos e registra a presença do coordenador; `codeorquestra_message` e `codeorquestra_annotate` enfileiram orientação para o próximo turno; `codeorquestra_answer` responde permissões e perguntas; `codeorquestra_interrupt` aborta o turno (a sessão continua); `codeorquestra_end` encerra a sessão e reconcilia a árvore de processos ainda atribuível; `codeorquestra_set_model` troca o modelo entre turnos, com motivo; `codeorquestra_usage_refresh` atualiza o consumo por fonte, somente leitura.

A supervisão só alerta (20 min sem atividade, 2 h decorridas, decisão pendente há mais de 2 min, orçamento em 80%, possível laço nas ferramentas); nada é encerrado sozinho. Um orçamento esgotado recusa o **próximo** turno sem abortar o atual. Só a interrupção explícita aborta um turno.

Diante de um laço, três respostas — todas decisão do coordenador, nenhuma automática: deixar seguir, **restringir** (`codeorquestra_set_policy`: comandos, escritas ou tudo passam a exigir decisão explícita, valendo já na próxima chamada, sem conceder nada que o contrato negou) ou **encerrar ao fim do turno** (`codeorquestra_end` com `afterTurn`, que espera o turno terminar sozinho e fecha como concluída).

O inspetor também presta contas da execução: quanto do contexto o último turno ocupou (a janela é presumida e a tela diz isso), quantas chamadas de ferramenta houve com erros e bloqueios por ferramenta, e o histórico da tarefa com o custo de cada execução encerrada — o mesmo que `codeorquestra_list` devolve ao Codex.

Cada execução preserva o log de eventos append-only e deriva `acompanhamento.txt`, `status.json` e `resultado.json`. `COMPLETED` indica término do transporte, não aceite técnico; `FAIL`, `CANCELLED` e `UNCERTAIN` nunca são sucesso. Um fim que ninguém pediu deixa a execução `UNCERTAIN` e exige revisão explícita antes de outra.

## Retomar

Na mesma tarefa Codex, a execução seguinte retoma automaticamente a última sessão Claude; a fila de orientações que ficou pendente é entregue quando houver turno. Retomar não desfaz edições nem repete ferramentas: reinspecione o estado e diga no prompt seguinte o que falta. Qualquer mudança aprovada exige `approvalRevision` maior.

## Nuvem

O mesmo plano e matriz são obrigatórios. Envie somente as etapas atribuídas ao Claude. O runtime local não controla o backend remoto, então o Codex preserva as restrições no prompt e na revisão. Não use nuvem para transportar credenciais, `.env`, PII, perfis reais ou payloads sensíveis. Detalhes em [`references/cloud.md`](skills/claude-code-live/references/cloud.md).

## Segurança

A skill não autoriza instalação, acesso a banco ou provedor, novos ambientes, diretórios adicionais, commit, push, PR, publicação ou deploy. Nunca inclua tokens, senhas, cookies, chaves, `.env`, dados reais de clientes ou payloads brutos em prompts, jobs ou logs.

O runtime falha fechado: credenciais de API no ambiente recusam a execução sem `auth.allowApiBilling`; personalizações do projeto só entram depois de aprovadas; o broker escuta só em loopback, com segredo por usuário e link de painel de uso único. Escopo, classificador e trust são camadas de política da aplicação, não sandbox de sistema operacional. Detalhes em [`references/security.md`](skills/claude-code-live/references/security.md).

## Conteúdo

- `.codex-plugin/plugin.json`: manifesto (`displayName` CodeOrquestra; `name` permanece `claude-code-live` como alias).
- `.mcp.json`: registra no Codex o adaptador MCP `codeorquestra` empacotado no runtime.
- `skills/claude-code-live/SKILL.md`: contrato principal que o Codex lê.
- `skills/claude-code-live/references/`: `runtime-v2.md` (comandos, ferramentas, estados, travas, worktrees, pareamento, orçamento), `security.md` e `cloud.md`.
- `runtime/`: broker, worker por tarefa, MCP stdio, CLI e painel web — ver [`runtime/README.md`](runtime/README.md).
- `assets/`: ícone, visão de arquitetura e fluxo visual de painel primeiro.

## Como o Claude Code é acionado

O Claude Code **não é empacotado aqui**: o runtime resolve e controla a instalação que já existe na máquina, com a autenticação que você já usa, e conversa diretamente com o processo do CLI pelo protocolo `stream-json` documentado, sem importar nem redistribuir o Agent SDK. Se a build instalada não anunciar as flags de que o runtime depende, a execução não inicia e o motivo é reportado; nenhum CLI alternativo é usado como substituto e nenhum caminho de cobrança por API é ativado automaticamente.

## Instalar

O Codex instala plugins por marketplace. Este pacote não altera marketplaces automaticamente.

1. Coloque a pasta sob `plugins/claude-code-live` do marketplace autorizado.
2. Adicione ou valide a entrada usando `plugin-creator`.
3. Em marketplace não padrão, execute `codex plugin marketplace add <raiz>`.
4. Execute `codex plugin add claude-code-live@<marketplace>`.
5. Abra uma nova tarefa para carregar a versão instalada.

Na tarefa nova, as ferramentas `codeorquestra_*` ficam disponíveis ao Codex. O adaptador MCP inicia ou reutiliza o broker em loopback; ele não cria uma sessão Claude compartilhada. Cada tarefa registra seu próprio `taskHandle`, e o broker mantém um worker e uma identidade Claude separados para cada tarefa.

O marketplace pessoal padrão em `~/.agents/plugins/marketplace.json` é descoberto automaticamente.

## Atualizar

Valide a fonte, atualize o cachebuster com o helper de `plugin-creator`, reinstale e teste em nova tarefa. Não edite `marketplace.json` manualmente.

## Validar

```bash
cd runtime && npm ci --ignore-scripts && npm run verify
```

`verify` faz typecheck, build, a suíte do broker com um CLI simulado (identidade, trust, travas, permissões, interrupção, encerramento, recuperação, orçamento, worktrees) e os testes de navegador do painel. Nada disso autentica nem inicia uma sessão Claude real. O mesmo fluxo roda no GitHub Actions, que também recusa `dist/` desatualizado. Para diagnóstico da instalação, `node runtime/dist/codeorquestra.mjs doctor` faz apenas sondagens somente leitura.

## Migração do v1

O runner PowerShell (`start-live.ps1`, job com `mode`/`allowedCommands`/`timeoutPolicy`) foi removido. Um job no formato antigo é recusado com `CONTRACT_VERSION_REQUIRED`; campos v1 num job v2 são recusados com `LEGACY_FIELD_IN_V2`, e a mensagem nomeia o equivalente:

| v1 | v2 |
|---|---|
| `mode: chat`/`read` | `profile: read` ou `phase: planning` |
| `mode: verify`/`local` | `profile: development`; edição e testes derivam de `implementation`/`testing: claude` |
| `profile: diagnostic`/`restricted` | `profile: development` ou `read` |
| `allowedCommands` | não há allowlist: classificador por caminho resolvido + permissões decididas ao vivo |
| `model: "fable"` / `modelPolicy` | `model: { requested: "claude-fable-5-1", reason }` + `codeorquestra_set_model` entre turnos |
| `timeoutPolicy` / `timeoutSeconds` | `limits.maxRuntimeSeconds` (alerta e recusa o próximo turno; nunca encerra) |
| `resumeFrom` (resultado.json) | retomada automática na mesma tarefa |
| painel de console, `stop.request`, `Q` | painel web, `codeorquestra_interrupt` / `codeorquestra_end` |

Os arquivos por execução (`status.json`, `resultado.json`, `acompanhamento.txt`) mantêm as mesmas chaves. O mutex de `/usage` mantém o nome do v1 para que uma instalação antiga que ainda o execute nunca consulte a conta ao mesmo tempo.

## Licença

Apache License 2.0 — veja [`LICENSE`](../../LICENSE) na raiz do repositório. Nome, logotipo e marca não estão licenciados (seção 6).
