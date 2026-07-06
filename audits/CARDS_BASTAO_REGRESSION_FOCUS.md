# Plano focado: cards que somem ou se movem errado

Este documento aprofunda uma area especifica do risco em producao:

- cards que devem aparecer e nao aparecem;
- cards que deveriam se mover e nao se movem;
- cards que nao deveriam se mover e movem.

O diagnostico abaixo foi feito olhando diretamente o codigo atual, principalmente:

- `supabase/functions/sync-bastao/index.ts`
- `supabase/functions/_shared/bastao-client.ts`
- `supabase/functions/_shared/operador-resolver.ts`
- `supabase/functions/_shared/escopo-relacionamento.ts`
- `supabase/functions/audit-invariante/index.ts`
- migrations de RLS e reatribuicao de cards.

## 1. Diagnostico simples

O seu sentimento esta correto: o problema nao e um bug isolado. O risco esta na combinacao de 4 decisoes:

1. O Bastao decide quais pendencias entram.
2. O sync decide se cria, atualiza, reabre, transfere ou deixa parado.
3. A regra de atribuicao decide qual operador e dono do card.
4. A RLS decide se o operador consegue enxergar o card.

Quando essas 4 partes discordam, aparecem os sintomas:

- o card existe no banco, mas o operador nao ve;
- o card deveria sair de uma aba, mas fica preso;
- o card deveria continuar parado, mas o sync move;
- o card aparece para operador errado;
- uma migration corretiva resolve um caso, mas cria risco de outro.

O ponto mais perigoso e que parte das protecoes atuais nasceu de incidentes reais. Existem comentarios no codigo citando casos como cards movidos em massa, cards presos por dias, cards vazando para Camila/Julia/Victor e regras restauradas depois de regressao. Isso confirma que o sistema esta vulneravel a regressao nessa area.

## 2. Sintoma 1: card deveria aparecer e nao aparece

### Causa provavel A - O pull do Bastao depende da carteira dos operadores

No `sync-bastao`, o Pass A monta uma allowlist com a uniao das carteiras dos operadores ativos. O proprio comentario diz que cliente fora de toda carteira nao entra no Cockpit.

Impacto:

- se o CNPJ nao estiver na carteira certa, o card nem nasce;
- se a carteira estiver desatualizada, o Bastao pode ter pendencia real e o Cockpit nao puxar;
- onboarding de operador vira ponto critico: erro de planilha = card invisivel.

Risco atual: alto.

Correcao segura:

1. Antes de mudar comportamento, criar auditoria read-only:
   - pendencias do Bastao que seriam ignoradas por nao estarem em nenhuma carteira;
   - pendencias do Bastao cujo responsavel/segmento indicam operador ativo, mas CNPJ nao esta na carteira dele;
   - pendencias por segmento que nao tem dono claro.
2. So depois decidir se a allowlist deve continuar bloqueando entrada ou apenas marcar card como "sem dono".

Nao corrigir de cara mudando o filtro do Bastao, porque isso pode aumentar muito o volume e trazer cards que hoje estao conscientemente fora.

### Causa provavel B - `cards.segmento_codigo` nao e atualizado de forma confiavel pelo sync

`segmento_codigo` e usado na RLS para visibilidade por segmento. Ele foi criado e backfilled por migration, mas no fluxo principal do `sync-bastao`:

- o update de card existente nao inclui `segmento_codigo`;
- o insert de card novo tambem nao grava `segmento_codigo`;
- o valor vive dentro de `agent_state.segmento_cliente`, mas a RLS nao olha para `agent_state`.

Impacto:

- operador que deveria ver pelo segmento pode nao ver;
- cards podem continuar com segmento antigo;
- migrations corretivas precisam reetiquetar segmento depois;
- visibilidade vira historica/acidental, nao derivada do Bastao atual.

Risco atual: alto.

Correcao segura:

1. Criar relatorio read-only:
   - cards ativos onde `segmento_codigo is null` e `agent_state->>'segmento_cliente' is not null`;
   - cards ativos onde `segmento_codigo <> left(agent_state->>'segmento_cliente', 3)`;
   - cards ativos cujo `segmento_codigo` da visibilidade nao bate com o dono por carteira.
2. Depois, ajustar o sync para gravar `segmento_codigo` no insert e no update.
3. O sync tambem deve comparar `segmento_codigo` em `precisaEscrever`, senao calcula valor novo mas nao salva.

Essa correcao tem bom custo/beneficio, mas precisa validar antes/depois por operador.

### Causa provavel C - RLS compara `pagador` com carteira, mas `pagador` e nome

A RLS atual deixa operador ver card se:

- e gestor;
- `assigned_operator_id` e o operador;
- `pagador` esta na carteira;
- `segmento_codigo` esta nos segmentos do operador.

Mas migrations recentes deixam claro que `cards.pagador` e nome, nao CNPJ. A carteira e lista de CNPJs. Entao esse criterio de carteira pode nao funcionar.

Impacto:

- o sistema depende demais de `assigned_operator_id` e `segmento_codigo`;
- se ambos estiverem errados/nulos, o card some;
- se segmento estiver amplo demais, card aparece para quem nao deveria.

Risco atual: critico para visibilidade.

Correcao segura:

1. Criar coluna canonica `cards.cnpj_pagador` ou view/materializacao equivalente.
2. Backfill a partir de `agent_state->>'cnpj_pagador'`.
3. Criar auditoria comparando visibilidade atual vs visibilidade por CNPJ.
4. Trocar RLS para usar `cnpj_pagador`, nao `pagador`.
5. Manter fallback por segmento apenas onde for decisao explicita.

Nao trocar a RLS direto sem relatorio antes/depois por operador.

### Causa provavel D - Trigger antigo pode contrariar o resolver novo

Existe trigger antiga `cards_resolve_operator`, criada para preencher `assigned_operator_id` a partir de `responsavel_relacionamento`.

O problema: o codigo novo tem um resolver mais cuidadoso, que decide por:

1. CNPJ na carteira;
2. nome do responsavel;
3. segmento;
4. sem dono.

Mas a trigger antiga ainda pode preencher por nome quando `assigned_operator_id` vem nulo. Ela usa `ativo=true`, mas nao respeita toda a logica moderna de `cockpit_ativo`, carteira dormente, ambiguidade e decisao por CNPJ.

Impacto:

- o sync pode tentar deixar card sem dono e a trigger recoloca dono por nome;
- card pode ir para operador errado;
- fica dificil explicar por que um card mudou.

Risco atual: alto.

Correcao segura:

1. Auditar quantos cards foram atribuidos por trigger vs pelo resolver.
2. Garantir que todos os criadores de card setam `assigned_operator_id` explicitamente.
3. Depois desativar ou reescrever a trigger.
4. Registrar `resolver_via` no card ou em `card_events` para auditoria.

Nao remover a trigger sem testar criacao manual, criacao via SSW, vinculador e sync Bastao.

## 3. Sintoma 2: card deveria se mover e nao se move

### Causa provavel A - Estados protegidos seguram movimento automaticamente

`AGUARDANDO_VALIDACAO_HUMANA` e `AGUARDANDO_CLIENTE` sao protegidos. Se a ocorrencia sai do escopo, o sistema nao move automaticamente; ele marca conflito.

Isso e bom para evitar perda de card, mas tem efeito colateral:

- se o conflito nao aparece claramente para o operador;
- se o operador nao sabe que precisa "forcar atualizacao";
- se a flag `mudanca_suspeita` fica stale;

o card parece parado.

Correcao segura:

1. Criar dashboard de cards protegidos com `mudanca_suspeita`.
2. Alertar quando conflito fica aberto por mais de X horas.
3. Mostrar para gestor cards protegidos cujo SSW/Bastao ja indicam outra realidade.

Nao mudar a regra "nao sai sozinho" sem teste. Ela existe porque ja houve movimento errado.

### Causa provavel B - Pass B e Pass H podem nao rodar ou rodar parcialmente

O `sync-bastao` tem muitos passes. Os passes que liberam cards presos dependem de tempo disponivel, Bastao, SSW e flags.

Riscos:

- Pass A pode consumir muito tempo;
- Pass B tem budget/deadline;
- Pass H depende de consulta SSW;
- sem mutex, duas execucoes podem se sobrepor;
- se Bastao/SSW falhar, o sistema prefere nao mover.

Correcao segura:

1. Medir por run:
   - tempo Pass A;
   - quantos cards Pass B checou;
   - quantos ficaram para depois;
   - quantos `ACAO_EXECUTADA` foram liberados por G/H;
   - quantos ficaram presos por mais de 15/30/60 minutos.
2. Criar alerta para Pass B/H sem execucao efetiva.
3. Adicionar lock global no sync depois de testar.

Nao refatorar os passes agora; primeiro medir.

### Causa provavel C - Auditoria existente detecta existencia, mas nao visibilidade por operador

`audit-invariante` detecta:

- pendencia no Bastao sem card;
- card inativo com Bastao ativo;
- divergencia de OC.

Mas ela nao responde:

- qual operador deveria ver;
- se o operador realmente ve pela RLS;
- se o card esta visivel para mais de um operador;
- se o card esta atribuido ao operador errado.

Correcao segura:

Criar uma segunda auditoria: `audit-card-routing`, focada em dono e visibilidade.

Ela deve gerar violacoes como:

- `sem_dono_mas_deveria_ter`;
- `dono_errado_por_cnpj`;
- `visivel_para_operador_errado_por_segmento`;
- `invisivel_para_dono_por_rls`;
- `segmento_desatualizado`;
- `cnpj_em_duas_carteiras`;
- `trigger_atribuicao_suspeita`.

Essa e provavelmente a primeira coisa a pedir para o Claude Code.

## 4. Sintoma 3: card nao deveria se mover e move

### Causa provavel A - `AGUARDANDO_AGENTE` nao e protegido

O codigo diz explicitamente que `AGUARDANDO_AGENTE` nao entra no escopo protegido. Ou seja: ele pode sair naturalmente seguindo Bastao.

Isso pode ser correto para operacao, mas explica parte da percepcao:

- operador ve card em "Para Fazer";
- Bastao muda para uma OC fora de relacionamento;
- sync move para `TRANSFERIDO`;
- parece que o card sumiu.

Correcao segura:

Nao mudar isso diretamente. Primeiro medir quantos cards saem de `AGUARDANDO_AGENTE` para `TRANSFERIDO` e quais OCs causam isso.

Se houver falso positivo, criar uma regra mais especifica, nao proteger todos os `AGUARDANDO_AGENTE`.

### Causa provavel B - `state_pelo_bastao` confia primeiro em `responsavel_atual`

A funcao SQL `state_pelo_bastao` usa `responsavel_atual` do Bastao como fonte primaria. Se o Bastao diz que o responsavel atual nao e Relacionamento/Cliente, o card pode ir para `TRANSFERIDO`.

Impacto:

- se Bastao estiver atrasado ou errado, o Cockpit move errado;
- se a mesma OC continuar, mas o responsavel atual mudar, o estado pode mudar.

Correcao segura:

1. Auditar movimentos causados por mudanca de `responsavel_atual`.
2. Para estados sensiveis, exigir confirmacao SSW ou conflito em vez de transferencia direta.
3. Testar cada OC/regra com casos reais antes de mudar.

### Causa provavel C - Troca de CTRC encerra card antigo e cria novo

O sync tem regra: se a mesma NF aparece com CTRC diferente, encerra o card antigo como `RESOLVIDO` e cria novo.

Isso pode estar certo, mas e sensivel:

- NF pode ter mais de um CT-e;
- Bastao pode alternar ou retornar pendencia de outro CT-e;
- operador pode perceber como "card sumiu".

Correcao segura:

1. Criar relatorio de `CardEncerradoPorTrocaDeCtrc`.
2. Medir se ha oscilacao A -> B -> A.
3. Alertar quando a mesma NF tiver mais de um card ativo/inativo recente.

Nao mexer nessa regra sem teste com NFs reais de reentrega/devolucao/complementar.

## 5. Correcoes recomendadas em ordem segura

### Passo 1 - Criar auditoria read-only de roteamento e visibilidade

Objetivo: descobrir exatamente quais cards estao errados sem mudar producao.

O que criar:

- uma funcao ou script `audit-card-routing`;
- uma tabela de resultado, por exemplo `card_routing_violations`;
- consultas que comparem:
  - dono atual;
  - dono esperado por CNPJ;
  - dono esperado por segmento;
  - visibilidade atual por RLS;
  - `segmento_codigo` vs `agent_state.segmento_cliente`;
  - `pagador` vs `cnpj_pagador`;
  - CNPJs em duas carteiras.

Aceite:

- rodar sem alterar cards;
- produzir lista por operador;
- dizer: "este card deveria aparecer para X e aparece para Y/ninguem".

Prioridade: P0.

### Passo 2 - Adicionar relatorio de movimento de cards

Objetivo: explicar por que cada card mudou.

O que medir:

- cards que foram para `TRANSFERIDO`;
- cards que foram para `RESOLVIDO`;
- cards que sairam de `AGUARDANDO_CLIENTE`;
- cards que entraram em `CONFLITOS`;
- cards que ficaram em `ACAO_EXECUTADA`;
- origem do movimento: Pass A, Pass B, Pass G, Pass H, operador, migration.

Aceite:

- para qualquer NF reclamada, conseguir responder em 2 minutos: "quem moveu, quando e por qual regra".

Prioridade: P0.

### Passo 3 - Corrigir persistencia de `segmento_codigo` no sync

Objetivo: tornar visibilidade por segmento consistente.

Mudanca pequena esperada:

- no insert de card novo, salvar `segmento_codigo`;
- no update de card existente, salvar `segmento_codigo`;
- em `precisaEscrever`, comparar tambem:
  - `assigned_operator_id`;
  - `segmento_codigo`;
  - talvez `responsavel_relacionamento`.

Aceite:

- antes/depois por operador nao pode mostrar perda inesperada de cards;
- cards com `agent_state.segmento_cliente` devem ter `segmento_codigo` coerente, salvo excecoes documentadas.

Prioridade: P1.

### Passo 4 - Normalizar CNPJ no resolver

Objetivo: evitar que formatacao de CNPJ quebre dono do card.

Mudanca:

- no `operador-resolver`, limpar CNPJ para so digitos antes de comparar com carteira;
- se for CNPJ, usar 14 digitos;
- se for CPF, usar 11 digitos;
- registrar quando o CNPJ vier invalido.

Aceite:

- testes cobrindo CNPJ com mascara, sem mascara e com zeros;
- nenhum card muda de dono sem aparecer no relatorio de dry-run.

Prioridade: P1.

### Passo 5 - Neutralizar trigger antiga de atribuicao por nome

Objetivo: impedir que regra velha sobrescreva regra nova.

Ordem segura:

1. Auditar impacto da trigger.
2. Garantir que todos os caminhos de criacao de card setam dono explicitamente.
3. Reescrever ou desativar trigger.
4. Criar teste de regressao.

Prioridade: P1, mas com risco alto.

### Passo 6 - Migrar RLS para `cnpj_pagador` canonico

Objetivo: parar de depender de `pagador` nome e segmento amplo.

Ordem segura:

1. Criar coluna `cards.cnpj_pagador`.
2. Backfill.
3. Criar indice.
4. Comparar visibilidade atual vs nova por 2 ou 3 dias.
5. So depois trocar RLS.

Prioridade: P1/P2, risco alto.

### Passo 7 - Criar testes de regressao para os casos historicos

Objetivo: impedir que uma correcao quebre outro caso.

Cenarios minimos:

- card novo com CNPJ em carteira certa aparece para dono;
- card com CNPJ fora de qualquer carteira vira sem dono ou violacao auditada;
- card com segmento errado nao vaza para operador errado;
- Camila/Julia nao capturam por segmento cliente fora da planilha;
- `AGUARDANDO_CLIENTE` oc=54 nao sai sozinho;
- `AGUARDANDO_CLIENTE` com oc relacionamento diferente de 54 vai para AGUARDANDO VOCE;
- `AGUARDANDO_CLIENTE` com oc fora de escopo vira conflito, nao transferencia;
- `AGUARDANDO_AGENTE` saindo para TRANSFERIDO e comportamento esperado;
- troca de CTRC encerra card antigo so quando realmente e outro CT-e;
- Pass B nao move `ACAO_EXECUTADA`.

Prioridade: P1/P2.

## 6. O que pedir ao Claude Code primeiro

Pedir primeiro algo read-only, sem mudanca de comportamento:

> Criar uma auditoria de roteamento de cards Bastao/Cockpit, sem alterar dados.
> A auditoria deve identificar cards ativos invisiveis para o dono esperado,
> cards visiveis para operador errado, cards sem dono apesar de CNPJ em carteira,
> cards com `segmento_codigo` divergente de `agent_state.segmento_cliente`,
> CNPJs presentes em mais de uma carteira, cards cujo `pagador` e nome mas a RLS
> espera CNPJ, e casos onde a trigger antiga de atribuicao por nome pode ter
> interferido. Gerar tabela/visao/relatorio por operador, com NF, CTRC, CNPJ,
> state, assigned atual, assigned esperado, motivo da divergencia e acao sugerida.
> Nao mudar `sync-bastao`, nao mudar RLS e nao atualizar cards nesta etapa.

Esse primeiro passo e o mais seguro porque transforma a sensacao de regressao em lista concreta de cards afetados.

## 7. O que nao mexer agora

Nao pedir agora:

- refatorar `sync-bastao` inteiro;
- remover Pass B/G/H;
- mudar diretamente a RLS sem relatorio antes/depois;
- remover a trigger antiga sem testar todos os criadores de card;
- mudar a regra de CTRC como identidade;
- proteger todos os estados `AGUARDANDO_AGENTE`;
- abrir o pull do Bastao para todos os clientes sem allowlist.

Essas mudancas podem resolver um sintoma e criar um incidente maior.

## 8. Minha recomendacao objetiva

A sequencia mais segura e:

1. Auditoria read-only de roteamento/visibilidade.
2. Relatorio de movimento por card.
3. Dry-run do que o sync mudaria em dono/segmento.
4. Corrigir `segmento_codigo` e comparacao de `assigned_operator_id` no sync.
5. Normalizar CNPJ no resolver.
6. Reavaliar trigger antiga.
7. So depois mexer na RLS por CNPJ.

Isso reduz risco sem parar a operacao dos 12 operadores.
