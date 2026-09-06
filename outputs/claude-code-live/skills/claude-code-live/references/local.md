# Execucao local controlada

Use este modo quando a tarefa precisa do checkout e das ferramentas do computador atual. Antes de iniciar, o executor confere a compatibilidade do CLI; se uma opcao necessaria nao existir, ele bloqueia a execucao sem enviar o prompt.

## Preparar o job

Crie um arquivo de prompt completo e um job JSON fora do checkout ou em pasta de trabalho autorizada. O executor opera em safe mode; leia `AGENTS.md`, `CLAUDE.md` e regras relevantes e coloque no prompt somente as instrucoes aplicaveis.

Campos do job:

- `workspace`: caminho absoluto da pasta autorizada.
- `promptFile`: caminho absoluto do prompt, sem segredos ou PII.
- `mode`: `chat`, `read` ou `local`.
- `profile`: `diagnostic` ou `restricted`; se omitido, usa `diagnostic`.
- `model`: opcional; omita para manter o modelo configurado.
- `effort`: opcional: `low`, `medium`, `high`, `xhigh` ou `max`.
- `allowedCommands`: regras Bash exatas, somente em `local`, como `Bash(node check.cjs)`. Inspecione o script antes; nao permita Bash irrestrito, curingas ou interpretadores genericos.
- `resumeFrom`: caminho para `resultado.json` anterior no mesmo workspace.
- `timeoutSeconds`: opcional; padrao de 1800 segundos.

Modos de ferramenta:

- `chat`: nenhuma ferramenta.
- `read`: `Read`, `Glob` e `Grep`.
- `local`: adiciona `Write` e `Edit`; `Bash` existe apenas para regras exatas em `allowedCommands`.

Todos usam `dontAsk`, allowlist e `--permission-prompts none`: uma operacao fora do escopo e negada, nunca fica aguardando aprovacao invisivel.

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
