# Sessao em nuvem do Claude Code

Use este modo somente quando o repositorio, ambiente e dados necessarios ja estiverem disponiveis no destino remoto autorizado. A nuvem nao recebe automaticamente o checkout local e nao deve ser usada para transportar segredos ou dados sensiveis.

Antes de criar ou retomar a sessao, apresente o plano e a matriz de `planning`, `inspection`, `implementation`, `testing`, `review`, `commit`, `push` e `deploy`, e aguarde aprovacao explicita. Envie ao Claude somente as etapas atribuidas a ele. Commit, push, deploy e outras mutacoes externas permanecem com Codex, usuario ou `not_applicable`; o runner local nao consegue impor essa trava dentro do backend de nuvem, portanto preserve-a no prompt e na revisao.

Uma sessao em nuvem exige um terminal interativo. Em uma execucao sem TTY, o CLI recusa `--cloud`; nao tente contornar essa restricao nem a substitua silenciosamente por execucao local.

Os exemplos abaixo correspondem ao Claude Code CLI 2.1.263; consulte `claude --help` antes de operar outra versao.

## Criar ou conectar

No repositorio autorizado:

```powershell
claude --cloud "Descricao completa e sanitizada da tarefa"
```

Para conectar a sessao existente, use somente um identificador ou URL fornecido/confirmado:

```powershell
claude --cloud '<session-id-ou-url>'
```

Use `--environment <environment_id>` apenas quando o ambiente remoto especifico tiver sido indicado. `--cloud` nao herda os perfis `diagnostic` e `restricted` do executor local; portanto, limite o escopo no prompt e nas opcoes suportadas pela sessao remota e nao alegue equivalencia de contencao.

## Acompanhamento e retomada

Na versao atual, `--cloud` usa um backend diferente das tarefas locais em segundo plano. Nao combine `--cloud` com `--bg` nem use `agents`, `logs`, `attach` ou `stop` para administrar uma sessao em nuvem. Acompanhe a sessao pela interface ou pelo identificador/URL devolvido pelo proprio fluxo em nuvem e retome-a somente pela forma indicada pelo CLI.

Se precisar executar uma tarefa local em segundo plano, esse e outro fluxo: use `--bg` sem `--cloud` e administre-a com `agents`, `logs`, `attach`, `stop` e `rm`. Nao descreva esse fluxo como sessao em nuvem.

Nao trate presenca na lista, aceite do envio ou fim do processo como aprovacao. Confirme o resultado no repositorio/ambiente autorizado e valide os artefatos localmente quando esse for o criterio de aceite.
