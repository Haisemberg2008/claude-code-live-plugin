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

## Autenticacao e cobranca (runtime v2)

O runtime v2 nunca ativa cobranca por API sozinho. Antes de lancar, ele avalia o caminho de autenticacao que a execucao usaria e **falha fechado**:

- credenciais de API ou variaveis de provedor de nuvem presentes no ambiente (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `ANTHROPIC_FOUNDRY_*`, `ANTHROPIC_AWS_API_KEY`, `CLAUDE_CODE_USE_BEDROCK|VERTEX|FOUNDRY|MANTLE`, `ANTHROPIC_BASE_URL`) recusam a execucao com `AUTH_API_BILLING_NOT_AUTHORIZED`, a menos que o job autorize `auth.allowApiBilling` explicitamente. Sem essa autorizacao, essas variaveis sao **removidas** do ambiente do processo filho;
- uma sondagem inconclusiva nao vale como prova de assinatura: o resultado e `AUTH_STATUS_UNKNOWN` e a execucao nao inicia;
- `auth status --json` e lido somente para campos sanitizados (`loggedIn`, `authMethod`, `apiProvider`, `subscriptionType`). E-mail, organizacao, tokens e payloads brutos nunca aparecem em logs, eventos ou no painel.

A avaliacao e refeita a cada execucao; apenas a evidencia da sondagem do CLI e reaproveitada dentro do mesmo processo do broker.

O medidor Codex e uma integracao separada e somente leitura: abre uma unica conexao local `stdio` com `codex app-server` e chama exclusivamente `account/rateLimits/read` e `account/usage/read`. Ele nao abre `auth.json` nem outro arquivo de autenticacao, nao chama login/logout, nao inicia inferencia e nao consome reset de limite. A resposta bruta nao e persistida; apenas numeros de tokens/percentuais, modelo/esforco informados, qualidade e horario entram em `llmUsage`. Campos de creditos e valores financeiros sao descartados. Falha ou incompatibilidade deixa o medidor indisponivel sem bloquear Claude.

## Confianca em personalizacoes (runtime v2)

Antes de qualquer execucao, o runtime **inventaria** o que o CLI carregaria: `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` (ancestrais, projeto e subpastas), regras, `settings.json`/`settings.local.json`, hooks e os scripts locais que eles apontam, agentes, skills e servidores MCP. Cada item e identificado por hash do proprio conteudo.

A aprovacao e do usuario, registrada por projeto canonico + impressao digital e guardada **fora** do checkout. Qualquer mudanca material invalida a confianca e o recurso volta a pendente. Enquanto algo estiver pendente ou o inventario estiver incompleto, nenhuma fonte de configuracao e carregada (`--setting-sources` vazio) e nenhum MCP e ativado.

Limites honestos desse mecanismo:

- o hash cobre o conteudo do proprio recurso, nao as dependencias que um script carrega em tempo de execucao;
- politicas gerenciadas (`managed-settings.json`) sao aplicadas pelo CLI independentemente deste runtime; sao apenas **reportadas**, nunca aprovadas, alteradas ou desativadas aqui;
- aprovar um servidor MCP **nao** autoriza mutacoes externas desse servidor: cada ferramenta de mutacao continua exigindo decisao do coordenador;
- um entrypoint de hook que dependa de variavel nao resolvida marca o inventario como incompleto em vez de ser considerado confiavel.

## Escopo, caminhos e o que os filtros nao sao

A classificacao de acoes decide sobre o caminho **resolvido** (symlink/junction incluidos), nao sobre o texto digitado, e bloqueia arquivos sensiveis, escrita fora do escopo aprovado e operacoes reservadas ao Codex (commit, push, PR, deploy, publicacao, instalacao global, alteracao de configuracao instalada). Delegacao (`Task`/`Agent`/`Skill`) herda o contrato: subagente ou skill fora do inventario aprovado escala para decisao, outro modelo e recusado, e capacidade que a execucao nao concede nao pode ser obtida por delegacao.

Isso e uma camada de politica da aplicacao, nao um sandbox de sistema operacional. Filtros de texto nao impedem tudo; a decisao final de risco continua sendo do coordenador humano, que revisa o diff e os artefatos.

## Redacao em texto transmitido (runtime v2)

Segredos podem chegar partidos entre pedacos do transporte. O runtime acumula o texto e so publica um prefixo seguro: qualquer cauda que ainda possa virar uma credencial reconhecida fica retida, e uma janela curta adicional e retida porque as primeiras letras de uma credencial (`sk`, `https`, `client_sec`) sao indistinguiveis de texto comum. O texto publicado so cresce; nada ja exibido e reinterpretado depois.

Isso reduz exposicao e **nao e garantia**: um valor que nao corresponde a nenhum formato conhecido nao e reconhecido. Nao coloque segredos em prompts, jobs ou no workspace.

Raciocinio interno e assinaturas (`thinking`, `redacted_thinking`, `signature`) sao removidos em qualquer posicao da mensagem antes de qualquer persistencia ou exibicao, e o log duravel rejeita qualquer forma oculta remanescente.

## Superficie HTTP local (runtime v2)

O broker escuta apenas em 127.0.0.1, com segredo por usuario em arquivo (nunca impresso no anuncio) e link de painel de **uso unico e com validade**, que vira um cookie `HttpOnly; SameSite=Strict`. Todas as APIs, inclusive de leitura, exigem autenticacao; acoes do navegador exigem cabecalho anti-CSRF, `Origin` correspondente e `Host` de loopback; nao ha CORS curinga; a CSP e estrita e apenas uma lista fixa de ativos estaticos e servida.

Rotas administrativas exigem o segredo local e recusam a sessao do navegador. Ainda assim: qualquer processo do mesmo usuario do SO consegue ler o arquivo de segredo. Essa e uma fronteira de roteamento da aplicacao, nao isolamento de processos.

