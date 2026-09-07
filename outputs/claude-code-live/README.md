# Claude Code Live para Codex

Plugin local que empacota a skill `claude-code-live` e seu executor PowerShell. Ele ajuda o Codex a escolher entre execucao local controlada e sessao em nuvem do Claude Code, acompanhar o trabalho, interromper/retomar e validar o resultado sem ampliar permissoes.

## Conteudo

- `.codex-plugin/plugin.json`: manifesto do plugin.
- `skills/claude-code-live/SKILL.md`: roteamento e contrato comum.
- `skills/claude-code-live/references/`: guias de modo local, nuvem e seguranca.
- `skills/claude-code-live/scripts/`: executor, painel, contrato de modelo/esforco e consulta sanitizada dos limites de uso.
- `skills/claude-code-live/tests/`: testes do contrato e do parser de uso, executados pelo smoke test.

## Instalar localmente

O Codex instala plugins por marketplace. Este projeto nao cria nem modifica marketplace automaticamente. Para instalar com autorizacao explicita:

1. Coloque esta pasta sob `plugins/claude-code-live` de um marketplace local.
2. Adicione/valide a entrada desse plugin no `marketplace.json` usando o fluxo oficial de `plugin-creator`.
3. Se for um marketplace nao padrao, configure sua raiz com `codex plugin marketplace add <raiz-do-marketplace>`.
4. Execute `codex plugin add claude-code-live@<nome-do-marketplace>`.
5. Abra uma nova tarefa do Codex para carregar a skill instalada.

O marketplace pessoal padrao em `~/.agents/plugins/marketplace.json` e descoberto implicitamente e nao requer `marketplace add`.

## Atualizar

Edite a fonte, valide novamente e use o helper `update_plugin_cachebuster.py` da skill `plugin-creator` para substituir o sufixo de cache da versao. Depois reinstale com `codex plugin add claude-code-live@<nome-do-marketplace>` e teste em uma nova tarefa. Nao edite manualmente o marketplace durante esse ciclo.

## Validar

Use o validador autocontido do pacote. Ele localiza um Python disponivel, fornece o adaptador YAML necessario somente ao processo de validacao e executa os validadores oficiais e o parser do PowerShell:

```powershell
pwsh -NoProfile -File '<caminho-do-plugin>\scripts\validate.ps1'
```

Para a verificacao completa que nao usa autenticacao nem inicia uma sessao, execute `scripts\smoke-test.ps1`. Ele verifica a estrutura, a sintaxe e os controles anunciados pelo CLI. Para validar um fluxo real de permissao, parada, retomada ou nuvem, use somente um projeto descartavel e autorizacao explicita; essa etapa cria uma sessao real e nao e automatizada pelo teste de fumaça.
