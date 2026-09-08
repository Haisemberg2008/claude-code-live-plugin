# Execucao local controlada

Use este modo quando a tarefa precisa do checkout e das ferramentas do computador atual. Antes de iniciar, o executor confere a compatibilidade do CLI; se uma opcao necessaria nao existir, ele bloqueia a execucao sem enviar o prompt.

## Preparar o job

Crie um arquivo de prompt completo e um job JSON fora do checkout ou em pasta de trabalho autorizada. O executor opera em safe mode; leia `AGENTS.md`, `CLAUDE.md` e regras relevantes e coloque no prompt somente as instrucoes aplicaveis.

Campos do job:

- `workspace`: caminho absoluto da pasta autorizada.
- `promptFile`: caminho absoluto do prompt, sem segredos ou PII.
- `mode`: `chat`, `read`, `verify` ou `local`.
- `profile`: `diagnostic` ou `restricted`; se omitido, usa `diagnostic`.
- `model`: opcional; modelo fixo, incompativel com `modelPolicy`.
- `modelPolicy`: opcional; selecao opt-in entre Fable e Opus baseada no `/usage` antes de iniciar ou retomar.
- `effort`: opcional: `low`, `medium`, `high`, `xhigh` ou `max`.
- `coordination`: objeto obrigatorio com fase, identificador de escopo, revisao, resumo/aprovacao do plano e a matriz completa de responsaveis.
- `allowedCommands`: objetos com `rule` e `responsibility`, somente em `verify` ou `local`. Inspecione o script antes; nao permita Bash irrestrito, curingas ou interpretadores genericos.
- `resumeFrom`: caminho para `resultado.json` anterior no mesmo workspace.
- `timeoutSeconds`: opcional; padrao de 1800 segundos.

Modos de ferramenta:

- `chat`: nenhuma ferramenta.
- `read`: `Read`, `Glob` e `Grep`.
- `verify`: leitura e Bash apenas quando houver regras exatas de `inspection` ou `testing`; nunca oferece `Write` ou `Edit`.
- `local`: adiciona `Write` e `Edit`; Bash existe apenas para regras exatas de `inspection`, `implementation` ou `testing`.

Todos usam `dontAsk`, allowlist e `--permission-prompts none`: uma operacao fora do escopo e negada, nunca fica aguardando aprovacao invisivel.

## Coordenacao obrigatoria

Antes do job, mostre ao usuario o plano e uma tabela com `planning`, `inspection`, `implementation`, `testing`, `review`, `commit`, `push` e `deploy`. Cada linha recebe `codex`, `claude`, `user` ou `not_applicable`. Aguarde aprovacao explicita antes de usar `phase: execution`; Claude nao pode receber commit, push ou deploy.

Um job `planning` pode usar apenas `chat` ou `read` e nao requer plano final aprovado. Um job `execution` requer `planApproved: true` e resumo nao vazio. Em retomada sem mudanca, repita o mesmo contrato; mudanca de plano, escopo ou responsavel exige revisao maior e nova aprovacao.

Jobs antigos sem `coordination` e resultados anteriores sem o contrato completo nao podem iniciar ou retomar; crie um novo job depois da escolha e aprovacao. O validador tambem bloqueia comandos que revelem commit, push, criacao/merge de PR, deploy ou publicacao, mesmo quando estiverem rotulados como outra responsabilidade. Scripts permitidos continuam exigindo inspecao previa, pois classificacao textual nao substitui revisao de seu conteudo.

## Selecao por quota

Use somente quando o usuario tiver aprovado essa politica no job:

```json
"modelPolicy": {
  "mode": "quota-aware",
  "primary": "fable",
  "alternate": "opus",
  "switchAtRemainingPercent": 3
}
```

O limite padrao e 3 e aceita inteiros de 1 a 20. O executor usa Fable acima do limite; troca para Opus quando somente o restante efetivo do Fable esta no limite ou abaixo; e bloqueia quando sessao ou semana geral tambem estao no limite ou abaixo. Falha em `/usage` bloqueia o job quota-aware antes de abrir uma sessao Claude. A decisao e refeita em cada retomada, portanto uma renovacao devolve o job ao Fable. O painel e os arquivos de estado registram somente a decisao e os percentuais sanitizados. Alterar essa configuracao ao retomar requer `approvalRevision` maior.

Exemplo de execucao de testes sem edicao pelo Claude:

```json
{
  "workspace": "C:\\projeto-autorizado",
  "promptFile": "C:\\execucoes\\prompt.md",
  "mode": "verify",
  "profile": "restricted",
  "coordination": {
    "phase": "execution",
    "scopeId": "corrigir-validacao",
    "approvalRevision": 1,
    "planSummary": "Validar a mudanca local aprovada sem editar arquivos.",
    "planApproved": true,
    "responsibilities": {
      "planning": "codex",
      "inspection": "claude",
      "implementation": "codex",
      "testing": "claude",
      "review": "codex",
      "commit": "not_applicable",
      "push": "not_applicable",
      "deploy": "not_applicable"
    }
  },
  "allowedCommands": [
    {
      "rule": "Bash(pwsh -NoProfile -File tests.ps1)",
      "responsibility": "testing"
    }
  ]
}
```

## Perfis

| Perfil | Uso | Contencao |
|---|---|---|
| `diagnostic` | Diagnostico ou ambiente limpo sem personalizacoes do projeto | allowlist, permissao sem pergunta e ferramentas definidas pelo job |
| `restricted` | Leitura ou alteracao com a menor superficie pratica | restricao do CLI, MCP estrito e allowlist; confirme o comportamento na versao instalada |

Prefira `restricted` quando a tarefa nao depende de personalizacoes confiaveis. Nem `diagnostic` nem `restricted` sao sandbox de sistema operacional: nao prometa isolamento de rede, filesystem ou de dados fora do escopo configurado. O executor preserva a autenticacao existente e recusa iniciar quando os controles adicionais nao forem aceitos pelo CLI.

## Iniciar e acompanhar

Execute com PowerShell 7:

```powershell
pwsh -NoProfile -File '<plugin>\skills\claude-code-live\scripts\start-live.ps1' -JobFile '<job.json>' -RunDirectory '<nova-pasta>'
```

O script abre ou reutiliza um painel visivel unico. Use uma pasta de execucao nova. Acompanhe `acompanhamento.txt` e `status.json`; o modelo efetivo aparece no inicio. O mutex rejeita execucoes simultaneas desta integracao.

Para interromper, pressione `Q` no painel ou crie `stop.request` na pasta exata da execucao. `Ctrl+C` no executor tambem aciona a limpeza. `X` ou fechar o painel encerra apenas a visualizacao. Depois de queda ou fechamento forcado, verifique os processos antes de retomar.

`resultado.json` registra status, sessao, workspace, modelo, perfil, ferramentas, falhas, negativas de permissao e resposta final. Para continuar, crie outro job com `resumeFrom` e outra pasta de execucao.
