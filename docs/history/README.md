# Histórico da entrega do runtime v2

Estes documentos vinham de `work/interactive-delivery/`, um diretório local
ignorado pelo git que foi apagado depois de preservados aqui. Eles não
descrevem como o código funciona hoje — para isso valem o
[`runtime/README.md`](../../outputs/claude-code-live/runtime/README.md) e o
[`SKILL.md`](../../outputs/claude-code-live/skills/claude-code-live/SKILL.md).
O que eles registram é **por que** o código é assim, que é a única parte não
derivável de ler o código.

| Documento | O que é |
|---|---|
| [`2026-09-implementation-brief.md`](2026-09-implementation-brief.md) | Contrato de produto aprovado antes da implementação do v2 |
| [`2026-09-implementation-phase.md`](2026-09-implementation-phase.md) | Escopo da fase de implementação, incluindo a política sobre o Buzz |
| [`2026-09-review-round-1.md`](2026-09-review-round-1.md) | Achados do coordenador durante as execuções 06 e 07 |
| [`2026-09-review-round-2.md`](2026-09-review-round-2.md) | Revisão independente, rodada 2 — 11 achados bloqueantes |
| [`2026-09-review-round-3.md`](2026-09-review-round-3.md) | Revisão independente, rodada 3 — 9 achados bloqueantes |

## Situação dos achados

Todos fechados. Verificado lendo o código em 13 de setembro de 2026, achado a
achado; alguns exemplos de onde cada um foi parar:

- *O hook `PreToolUse` precisa falhar fechado antes de qualquer trabalho* →
  `PRETOOLUSE_HOOK_NOT_APPLIED` em `worker/session.ts`.
- *Um PID reciclado nunca pode ser terminado* → identidade por PID mais
  instante de criação em `broker/process-identity.ts`; identidade desconhecida
  põe em quarentena em vez de matar.
- *A recuperação do singleton é uma corrida de ler-e-apagar* →
  `openSync(…, 'wx')` mais rename atômico em `broker/singleton.ts`.
- *A saída do pai não prova que os descendentes saíram* →
  `settleExitedTarget` em `broker/process-tree.ts` roda mesmo com
  `exitedAt` gravado.
- *Redação em streaming só olha 4096 caracteres para trás* → `carry` entre
  blocos em `events/redaction.ts`.
- *O shutdown não espera a preparação* → `stopping` recusa admissões antes de
  qualquer coisa, e `PREPARATION_DRAIN_MS` drena o que já começou.
- *O MCP fica preso à porta antiga após reinício do broker* → resolução de
  handle tratada como consulta idempotente em `mcp/main.ts`, e mutação com
  entrega incerta nunca é reenviada.

## O que não foi preservado

Os logs de execução (`run-01` a `run-12`), os arquivos de job, os prompts de
retomada e uma cópia temporária de diagnóstico dos scripts do v1. Os logs eram
saída de execução; a cópia de diagnóstico estava marcada no próprio código como
`Temporary orchestration harness only` e os conceitos dela graduaram para o
produto (`telemetryFailures` no painel, `state/atomic-file.ts`).

A última execução, `run-12`, ficou com `status: RUNNING` — foi interrompida no
meio dos ajustes da rodada 3, por fim de crédito. O trabalho dela está
commitado; só o arquivo de status nunca recebeu a escrita final.
