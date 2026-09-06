---
name: claude-code-live
description: Coordene trabalho autorizado no Claude Code por execucao local controlada ou sessao em nuvem, com permissoes minimas, acompanhamento, retomada e interrupcao verificaveis.
---

# Claude Code Live

Use a instalacao e a autenticacao existentes do Claude Code. Esta skill coordena o trabalho; ela nao instala o CLI, nao conecta servicos, nao publica artefatos e nao amplia a autorizacao dada pelo usuario.

## Escolher o modo

| Modo | Escolha quando | Nao escolha quando |
|---|---|---|
| Local controlado | A tarefa depende do checkout atual, arquivos locais, testes locais ou uma allowlist precisa | O material necessario existe apenas no ambiente remoto autorizado |
| Sessao em nuvem | A tarefa pode ocorrer em repositorio/ambiente remoto ja autorizado e se beneficia de execucao hospedada independente | Seria necessario enviar segredos, arquivos `.env`, PII, perfis reais ou arquivos locais nao autorizados |

Se ambos servirem, prefira local para validacao no computador atual e nuvem para trabalho remoto independente. Antes de decidir, confira checkout, branch, alteracoes existentes e disponibilidade dos dados no destino. Leia [references/local.md](references/local.md) para execucao local ou [references/cloud.md](references/cloud.md) para nuvem. Para limites comuns, leia [references/security.md](references/security.md).

## Contrato comum

- Registre objetivo, pasta/repositorio autorizado, arquivos permitidos, criterios de aceite e regras aplicaveis do projeto.
- Use somente dados necessarios e sanitizados. Nunca delegue credenciais, tokens, `.env`, PII, perfis reais, payloads de provedor, deploy ou banco externo sem autorizacao especifica.
- Nao habilite Chrome, plugins, MCPs, agentes adicionais, diretorios extras ou ambientes remotos por conveniencia.
- A execucao em segundo plano nao amplia permissoes.
- Pare diante de bloqueio, desvio de escopo ou necessidade de nova autorizacao.
- Nao apresente eventos JSON brutos, stderr, argumentos/resultados sensiveis de ferramentas ou raciocinio interno.

## Acompanhar e concluir

Comunique apenas marcos reais, bloqueios e mudancas de estado. O termino do Claude confirma transporte/execucao, nao aprovacao. Reinspecione os arquivos e rode testes relevantes independentemente do relato do Claude. Classifique `FAIL`, `BLOCKED`, `CANCELLED` e `TIMEOUT` como insucesso; em execucao local, `COMPLETED` significa apenas que o CLI terminou.

Para retomar, preserve a sessao anterior, confira o estado dos artefatos e descreva explicitamente o trabalho restante. Nunca repita cegamente uma mutacao. Interromper deve preservar o que ja foi produzido sempre que o modo permitir.

