# Permissoes, dados e segredos

## Limite de autorizacao

A skill nao concede permissao para instalar ou atualizar software, publicar, fazer deploy, acessar banco ou provedor externo, criar ambientes, habilitar integracoes ou ampliar o conjunto de arquivos. Cada uma dessas acoes exige estar no pedido atual ou receber autorizacao adicional.

Antes de qualquer mutacao, o usuario aprova o plano e a matriz de oito responsabilidades. Claude nunca e responsavel por commit, push, deploy, publicacao ou outra mutacao externa. O contrato local bloqueia essas atribuicoes; em nuvem, onde o runner local nao controla o backend, o Codex aplica o mesmo limite no prompt e na revisao.

## Dados proibidos por padrao

Nao inclua em prompt, job, log ou sessao remota:

- tokens, senhas, cookies, chaves privadas ou credenciais;
- arquivos `.env` ou dumps de configuracao;
- PII e dados reais de clientes;
- perfis reais de owner/administrador;
- payloads brutos de provedores e logs sensiveis.

Sanitizacao reduz exposicao, mas nao deve ser descrita como redacao automatica infalivel. Revise o material antes de delegar.

## Capacidades e limites

O modo local permite acesso somente conforme `mode`, perfil e allowlist do job. Mesmo assim, `diagnostic` nao e um sandbox de SO. O modo em nuvem opera no ambiente remoto disponivel para a sessao e nao deve receber arquivos locais por conveniencia. Em ambos, recursos de navegador, plugins, MCPs, agentes hospedados, diretorios extras e comandos de mutacao permanecem fora do caminho padrao.

Em uso por API, defina teto de gasto somente com autorizacao do usuario. Em uso por assinatura, apenas informe a janela/limite exibido pelo produto; nao tente contornar limites nem abra varias sessoes para isso.

