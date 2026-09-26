# ADR 0035 — Painel da Operação: estado da tratativa para o Roteirizador e pedidos da operação

Data: 2026-09-25
Status: proposto. Código na branch `matheuscastro12-eng/ponte-operacao`, que parte da
`matheuscastro12-eng/ponte-cockpit` (ADR 0034). As migrations 411 e 412 **não foram
aplicadas** (nem dry-run). Nenhuma edge foi deployada, nenhuma flag foi ligada e nenhum
secret foi criado. Tudo aguarda o time do Cockpit, pelo trilho.
Contrato: ponte v2 (Painel da Operação), no repo do Roteirizador Inteligente. Os campos
usados aqui são os do contrato, **com as emendas de 25/09/2026** (NF opcional no pedido,
`tratativaDesde`, 409 para `pedidoId` reusado com outro conteúdo e token próprio
`PONTE_OPERACAO_TOKEN`), já aplicadas nesta branch.
Guards: **INV-161** · migrations `2026-09-25_411_ponte_operacao.sql` e
`2026-09-25_412_cron_processar_pedidos_operacao.sql`
Relacionados: 0004 (o Cockpit é do Relacionamento), 0016 (trilho de veto), 0033 (ação
irreversível é humana), 0034 (ponte v1).

## Contexto

Em 25/09 o Matheus decidiu que o painel da operação é uma **tela separada, do lado do
Roteirizador**. Nela a operação vê, por nota, o que o Roteirizador, o SSW e o Cockpit
sabem, e age num lugar só. Cada ação é executada pelo sistema dono dela:

- o Roteirizador cuida da rota: encaixar, segurar e tirar do plano;
- o Cockpit cuida da NF e do cliente: devolver ao Relacionamento e lançar ocorrência no
  SSW. **Ele continua sendo o único que escreve no SSW.**

Para isso o Cockpit precisa de duas coisas novas:

- **(A)** expor o estado da tratativa por CTRC (leitura);
- **(B)** receber pedidos da operação, que são dois: `devolver_ao_relacionamento`
  (evento no card e a 49 no SSW) e `lancar_ocorrencia` (códigos de uma lista).

(B) é a primeira vez que o Roteirizador **origina** uma escrita no SSW, mesmo que quem
escreve continue sendo o Cockpit. Por isso quase todo o ADR trata de (B).

## Decisão

### D1 — O Cockpit continua sendo do Relacionamento. A 0004 não é reaberta.

- O painel é uma tela do Roteirizador. Ninguém da operação ganha login no Cockpit, Inbox,
  aba ou RLS nova. O Cockpit expõe dois **endpoints de máquina** (`ponte-tratativas` e
  `ponte-pedido-operacao`), autenticados pelo segredo da ponte, e não uma tela.
- A 0004 rejeitou o "cockpit unificado" por falta de RBAC por área. Aqui não há RBAC a
  construir: quem autentica o operador da operação é o Roteirizador. O Cockpit recebe um
  **sistema** autenticado (o token) e a **pessoa** identificada (`solicitadoPor`), e grava
  quem pediu em cada evento.
- O que entra no Cockpit continua sendo trabalho do Relacionamento. O `devolver` põe a nota
  na fila do Relacionamento. O `lancar_ocorrencia` é executado sem card novo e sem Inbox, e
  só em nota cujo card já saiu do Relacionamento.
- Se um dia a operação quiser fila ou tela dentro do Cockpit, aí sim a 0004 precisa ser
  reaberta, em outro ADR.

### D2 — Um card pode nascer de pedido da operação (o "outro ADR" citado pela 0034)

A 0034 recusou criar card a partir de **evento de rota**, porque evento de rota é
automático e não tem pessoa por trás. Pedido da operação é outra coisa: uma pessoa diz
"esta nota precisa do Relacionamento". É o mesmo raciocínio da regra 2 da 0004 ("mensagem
do cliente puxa qualquer NF"): o pedido explícito é a razão para o Relacionamento agir.

O card nasce só quando **todas** as condições abaixo valem:

1. o pedido é `devolver_ao_relacionamento`. `lancar_ocorrencia` nunca cria card;
2. quem cria é o worker, nunca o POST, e só com dado do **Bastão**
   (`fetchPendenciaByCtrc`: NF, pagador, última oc). Nada de SSW para criar card (INV-159)
   e nada de NF inferida;
3. as regras de nascimento (`decidirNascimentoCard`, pura e testada) deixam:

   | Situação | Nasce? | Por quê |
   |---|---|---|
   | CTRC fora do Bastão | não, `recusado` | sem NF confirmada não há card nem tripé |
   | oc 1/30/32 (entregue, devolução autorizada, cancelada) | não | o SSW recusaria qualquer ação |
   | oc 6/9/16 (extravio) | não | card de extravio é do sync de extravios (INV-017) e a 49 do extravio é do agente (INV-022) |
   | CNPJ em `cnpjs_excluidos_cockpit` | não | o CNPJ está fora do Cockpit |
   | a NF já tem card ativo com outro CTRC | não | regra de ouro: o CTRC do card nunca é trocado; o Relacionamento decide |
   | 3 ou mais cards encerrados da NF em 24 h | não | guard anti-loop INV-040 |
   | oc 54/59 | sim, `AGUARDANDO_CLIENTE` | INV-006 |
   | qualquer outra | sim, `AGUARDANDO_VALIDACAO_HUMANA` + lock | a fila do operador; o lock impede o sync-bastao de mover o state antes de o operador agir (mig 023) |

4. o formato é o mesmo do `createCardFromBastao` do vinculador, com
   `agent_state.criado_via = 'ponte_operacao'` e `pedido_operacao_id`. A atribuição usa o
   `resolverCamposAtribuicaoDoCard` (carteira, depois nome, segmento e órfão), como em
   todo nascimento de card;
5. os eventos `CardCriadoPorPedidoOperacao` e `DevolvidoPelaOperacao` são gravados na mesma
   transação, pela RPC `ponte_operacao_vincular_card`.

Quando o card já existe, o pedido **nunca muda o state dele**. O evento entra e a memória
do card é marcada para recomputar. Quem move o card é o fluxo de sempre: com a 49 lançada,
o Bastão passa a mostrar a 49 e o sync-bastao faz com o card o que já faz com qualquer 49.

O INV-160 ("a ponte só acrescenta, nunca cria card") continua valendo para o **sync** da
v1. O nascimento por pedido é a exceção deste ADR, e quem a governa é o INV-161.

**A NF do pedido (emenda 1)** é opcional. Quando vem, ela é conferida contra a NF do
Bastão: se forem diferentes, o card não nasce (`nf_diverge_bastao`).

Limitação aceita: uma nota no prazo, que ainda não está no Bastão, e que não tem card, não
ganha card, **nem quando o pedido traz a NF**. Sem o Bastão não há pagador (para atribuir o
operador e checar CNPJ fora do Cockpit) nem oc para o state de nascimento, e buscar isso no
SSW seria login a partir do pedido (INV-159). O pedido termina `recusado`, com o motivo:
`sem_nf` quando não veio NF, `sem_card_fora_do_bastao` quando veio. O painel mostra isso.
Criar o card pela NF do pedido, confirmando no SSW dentro da mesma vazão (como o
`criar-card-manual`), é o próximo passo, se houver pedido real.

### D3 — A regra do `bloqueiaEntrega`

A regra responde a uma única pergunta: *o Relacionamento tem uma tratativa ABERTA nesta nota
cujo desfecho pode mudar a entrega?* O Roteirizador **não** tira nota do plano por causa
dela; só mostra no painel. Por isso, na dúvida, a regra **bloqueia**: um falso "bloqueia"
custa um olhar do operador, e um falso "libera" custa uma viagem.

As entradas são `cards.state`, `estado_tratativa.situacao`, `estado_tratativa.aguardando` e,
para saber **de quem** é a última ocorrência, `cod_ultima_ocorrencia` com
`ocorrencias_dicionario.responsabilidade`. A primeira linha que casa decide
(`_shared/ponte-operacao-bloqueio.ts`):

| # | Quando | Bloqueia | Motivo (texto do painel) |
|---|---|---|---|
| R0 | `RESOLVIDO`, `CANCELADO`, `TRANSFERIDO` | não | tratativa encerrada no Relacionamento |
| R1 | `EXTRAVIO_MONITORADO` ou última oc 6/9/16 | **sim** | "Extravio em monitoramento (oc N — …)": a carga não foi localizada |
| R2 | `AGUARDANDO_CLIENTE`, `situacao = aguardando_cliente` ou `aguardando.quem = cliente` | **sim** | "Aguardando retorno do cliente pagador desde DD/MM (oc 54 — …)": o cliente ainda vai dizer o que fazer |
| R3 | `EXECUTANDO_ACAO` | **sim** | "O Relacionamento está lançando uma ocorrência no SSW agora": o desfecho ainda não existe |
| R4 | `cards.tipo = rastreamento` | não | o cliente só cobrou a entrega; ele quer que a nota chegue |
| R5 | a última oc é da **Operação** (21, 55, 13…) | não | a nota voltou ao fluxo normal. Vale também para `ACAO_EXECUTADA`, por exemplo a 21 recém-lançada |
| R6 | qualquer outro card ativo, ou oc desconhecida | **sim** | "Ação do Relacionamento lançada no SSW, aguardando confirmação" (`ACAO_EXECUTADA`/`AGUARDANDO_TERCEIRO`), "agendada no trilho de veto" (`acao_agendada`), "aguardando decisão do operador" (`AGUARDANDO_VALIDACAO_HUMANA`/`pronto_para_acao`) ou "Tratativa aberta no Relacionamento" |

- A ordem importa: um card de rastreamento esperando o cliente responder (R2) bloqueia.
- Todo motivo termina com **"Tratativa aberta em DD/MM/AAAA."**, que é o `cards.created_at`.
  A mesma data vem também em campo próprio, **`tratativaDesde`** (ISO, -03:00; emenda 3).
- `aguardando` sai como está no `estado_tratativa`: `cliente`, `area_interna`, `operador`
  ou `ninguem`. Aqui `operador` é o operador **do Relacionamento**, não a operação.
- Leitura pura: busca só por CTRC normalizado, com igualdade exata a `cards.ctrc`, nunca
  por NF. O card que representa o CTRC é o ativo mais recente; sem ativo, o encerrado mais
  recente (`bloqueiaEntrega: false`). Sem card nenhum, o CTRC vai para `semCard`. O limite é
  de 1000 CTRCs por chamada, em lotes de 100 no `.in()`.

### D4 — A lista de códigos que a operação pode lançar

- **Nasce vazia.** Fica na tabela `ponte_operacao_codigos_permitidos` (mig 411). Com a
  lista vazia, todo `lancar_ocorrencia` responde 422 `codigo_nao_permitido`.
- **Dono da lista: Caio** (dono do Cockpit). Cada código entra com:
  - `criterio`: por que ele é fato da rota (obrigatório, com 10 caracteres ou mais);
  - `pedido_por`: quem da operação pediu o código;
  - `autorizado_por` e `autorizado_em`: o Caio, ou o Carlos pela autonomia de TIPO B de
    02/09 (`docs/POLITICA_MIGRATIONS.md`).

  Ligar (`ativo = true`) é um ato separado, TIPO B. O banco proíbe `ativo` sem esses campos.
- **Critério (proposta do auditor, adotada):** só entra ocorrência que é **fato da rota**,
  o que a rota viu acontecer com a nota (saiu, não coube, não chegou). Tratativa nunca
  entra. Isso é garantido em quatro camadas:
  1. um trigger exige `responsabilidade = 'Operação'` no `ocorrencias_dicionario`;
  2. um `CHECK` proíbe 49, 54 e 59;
  3. o código relê a lista e o dicionário na hora do pedido **e** de novo na hora do
     lançamento;
  4. o lançamento só acontece em nota cujo card já está encerrado. Com tratativa aberta, a
     resposta é 422 `tratativa_aberta` ("use `devolver_ao_relacionamento`"). Sem card e
     sem NF, a resposta é 422 `sem_nf_para_tripe` ("sem NF para o tripé", emenda 1). Sem
     card mas com NF, 422 `sem_card`: `lancar_ocorrencia` não cria card, e o envelope do
     SSW exige um.
- **Candidatos, NÃO cadastrados** (cada um precisa de dono e critério próprios): 14
  "Entrega iniciada", 36 "Chegada na base para entrega", 15 "Entrega impossib: limit. base
  op. entreg" (não coube ou não saiu), 37 "problema no veículo", 39 "problemas com janela".
- **A 49 não entra na lista.** Ela entra só por `devolver_ao_relacionamento`, que é um tipo
  separado: é o pedido explícito da Sal para devolver a nota ao Relacionamento.

### D5 — Execução: fila, vazão e o envelope do SSW

**O pedido nunca faz login.** O POST só grava no banco. Quem executa é o worker
`processar-pedidos-operacao` (cron de 1 min, mig 412), em quatro etapas:

0. **Prazos:** pedido parado há mais de 4 h vira `erro` ("expirou"). Pedido reservado para
   lançar que não terminou em 15 min vira `erro` ("lançamento interrompido: conferir no
   SSW") e **nunca é relançado às cegas**. Duplicar uma ocorrência é pior que atrasar.
1. **Vincular:** acha o card ativo do CTRC ou cria o card pelo D2. Tudo no banco e no
   Bastão, sem SSW.
2. **Decidir:** com `ponte_operacao_lancar_ssw` OFF, o `devolver` termina `executado` só com
   o evento no card ("a 49 não foi lançada") e o `lancar_ocorrencia` termina `recusado`.
   Com a flag ON, o pedido vai para a fila do SSW.
3. **SSW:** a RPC `ponte_operacao_reservar_lancamentos` reserva no máximo as vagas da
   janela, e o worker lança **um por vez** pelo envelope `lancarSswPortal`.

**A fila é a própria tabela, e não o pgmq `agent_executor`.** Três motivos:

- o `agent_executor` é acoplado a `todos`: `reverter_acao_falhou`, status do todo, Inbox e
  os watchdogs de execução presa (migs 279/361). Um pedido da operação não é proposta de
  agente aprovada por operador do Cockpit;
- o pgmq entrega pelo menos uma vez (reentrega pelo `vt`), e a idempotência do envelope é
  por `todo_id` (mig 202). Sem todo, o `todo_id` fica NULL, e NULL não deduplica;
- a vazão precisa de uma contagem **global** por janela, e o pgmq não oferece isso.

A reserva atômica na tabela garante **no máximo uma execução** por pedido.

**Vazão (INV-159):**

- advisory lock, janela de 60 s **global** (chamar o worker 100 vezes num minuto não muda
  nada), 2 lançamentos/min pedidos e **teto de 3/min** gravado na própria RPC;
- **quarentena de 30 min** depois de qualquer `sessao_invalida` (INV-159 d: esperar, nunca
  insistir);
- kill-switch relido antes de **cada** lançamento.

Na conta, cada lançamento faz no máximo 1 login (a sessão fica em cache no isolate), mais
o refresh de histórico que o envelope já dispara. São cerca de 4 logins/min no pior caso,
abaixo dos ~10/min do INV-159 (a).

**Envelope:** o worker chama `lancarSswPortal({ card: {id, nf, ctrc}, codigoSsw, texto })`.
O CTRC é sempre o do card. A NF é a do card; a do pedido (emenda 1) entra **só quando o
card não tem NF**, e aí é o tripé do envelope que confere com o SSW antes do submit. Se o
card e o pedido trazem NFs diferentes, o pedido termina `recusado` (`nf_diverge`), porque a
NF do card nunca é trocada. Sem NF nenhuma, `recusado` com "sem NF para o tripé"
(`nfParaTripe`, pura e testada). O texto é o do pedido mais "(pedido da operação VGA por Nome)", com até 500
caracteres. O tripé CTRC + NF + localização roda dentro do envelope, como sempre. O
envelope grava `acoes_executadas_ssw`, e é por isso que o INV-014 reconhece o lançamento
como do Cockpit.

**Cerca na hora de lançar** (`decidirLancamento`, com o card relido): não lança se o card
está em `EXECUTANDO_ACAO` ou `ACAO_EXECUTADA`, porque isso quebraria a confirmação; nem se é
extravio (no `devolver`, INV-022); nem se a nota está entregue ou baixada; nem se o CTRC do
card é outro. Se a 49 já é a última oc, o pedido termina `executado` sem relançar.

### D6 — Flags (todas OFF) e a dupla trava

| Flag | Liga | OFF = |
|---|---|---|
| `ponte_operacao_leitura` | `POST ponte-tratativas` | 503, nenhum SELECT de negócio |
| `ponte_operacao_pedidos` | `ponte-pedido-operacao` (POST/GET) e o worker (vincular/criar card, eventos) | 503; worker `skipped: flag_off` |
| `ponte_operacao_lancar_ssw` | o worker leva pedidos ao SSW | nenhum pedido chega ao SSW; `lancar_ocorrencia` responde 503 |

**Token próprio (emenda 5):** o Roteirizador chama o Cockpit com `PONTE_OPERACAO_TOKEN`
(`RI_COCKPIT_TOKEN` do lado dele). O `ROTEIRIZADOR_PONTE_TOKEN` da v1 serve só para o
Cockpit chamar o Roteirizador e **não autentica** as edges da v2. Sem o
`PONTE_OPERACAO_TOKEN` configurado, as duas edges respondem 503 antes de olhar a flag. Nunca há "meio ligado": `lancar_ocorrencia` com o SSW desligado responde 503 e não
registra nada.

### D7 — Idempotência e respostas (contrato)

- `pedidoId` é a PK. O mesmo id com o mesmo conteúdo responde **200** com o status atual e
  nunca grava nem vincula de novo. Numa corrida entre dois POST iguais, quem perde recebe
  200.
- **409** (emenda 4): o mesmo id com **conteúdo diferente** (tipo, CTRC, código, texto,
  base, NF ou quem pediu) responde `{erro: "conteudo_divergente", pedidoId, status, …}` com
  o status do pedido **original**, e nada é executado.
- **202** `{pedidoId, status: "recebido", cardId}`, com `cardId` null quando o worker ainda
  vai achar ou criar o card.
- **422** com a lista de motivos: validação (inclusive `nf_invalida`), código fora da lista,
  nota ENTREGUE/BAIXADA, `nf_diverge`, `tratativa_aberta`, `sem_nf_para_tripe`, `sem_card`.
- **503** para flag OFF ou token ausente, e **401** para token errado.
- **Duplicidade entre pedidos:** dois pedidos para a mesma nota geram dois eventos no card
  (cada pessoa aparece) e **uma** ocorrência no SSW. O segundo termina `recusado`
  `duplicado`, e também quando o executor lançou a mesma oc no card há menos de 10 min.

### D8 — Auditoria

- `card_events`, todos com `solicitado_por` `{id, nome, email}` no payload:
  - `DevolvidoPelaOperacao`
  - `OcorrenciaSolicitadaPelaOperacao`
  - `CardCriadoPorPedidoOperacao`
  - `PedidoOperacaoLancadoNoSsw`
  - `PedidoOperacaoNaoExecutado` (recusa ou erro, ADR 0033 regra 4)
- `actor_type = 'system'`, com `actor_id` igual a `ponte-pedido-operacao` ou
  `processar-pedidos-operacao`. Não usamos `operator` porque o `actor_id` de operador é o
  uuid de `operadores`, e a pessoa da operação não está nessa tabela.
- `audit_log` tem uma linha por ida ao SSW: `external_system = 'ssw'` (o CHECK de hoje já
  aceita, então não depende da mig 410) e `idempotency_key = 'ponte_operacao:<pedidoId>'`.
  O `request_payload` leva quem pediu.
- `ponte_operacao_pedidos` é o trilho completo: quem, quando, texto, etapa, motivo, o
  `acoes_executadas_ssw.id` e o protocolo.

### D9 — Origem humana (ADR 0033)

- Ocorrência lançada no SSW não tem desfazer. Aqui não há autonomia: **cada pedido é o
  clique de uma pessoa**. O Cockpit exige `solicitadoPor.id` e `nome` e recusa identidades
  de automação (sistema, agente, bot, robô, IA, cron, roteirizador…).
- **Ponto de confiança explícito:** o token prova o **sistema**, não a pessoa. A garantia de
  que o pedido nasceu de um clique é do Roteirizador, que só pode chamar o endpoint a
  partir de um botão, nunca a partir de agente. Por isso a lista nasce vazia e a 49 tem um
  kill-switch só dela.

## O que ficou DELIBERADAMENTE de fora

- **Tela no Cockpit.** Não há badge "a operação devolveu" (seria MODO LOVABLE, e não foi
  feito). Hoje:
  - o card que nasce do pedido já nasce em AGUARDANDO VOCÊ;
  - no card que já existe, o operador vê o evento na linha do tempo;
  - num card em `AGUARDANDO_CLIENTE`, o pedido não move o card (INV-006). Sem a 49, ele só
    aparece na linha do tempo. O badge é o próximo passo, se houver pedido real.
- **Memória do card.** O `estado_tratativa` não lê `DevolvidoPelaOperacao` como fato: o
  recompute só incorpora os eventos da lista da mig 404. Colocar o evento no trigger
  `project_card_event` é TIPO B (REPLACE de função existente), e fica para quando ele
  provar valor. Até lá, a RPC só marca o `estado_tratativa_dirty_at`.
- **Criar card pelo SSW para nota fora do Bastão.** Precisa da NF no contrato (ver furo).
- **Desfazer.** Não existe. Ocorrência no SSW não se desfaz.

## Consequências e riscos

- **Tabelas quentes:** nada de `ALTER` em `cards`, `card_events` ou `audit_log`. O
  `card_id` da tabela de pedidos não tem FK de propósito, porque a FK pegaria SHARE ROW
  EXCLUSIVE em `cards` no CREATE. O trigger `project_card_event` não é substituído.
- **Placar e monitor da 49** (migs 350/364/371) leem `acoes_executadas_ssw`. A 49 da
  operação conta ali como "o que foi feito no card". Se isso contaminar a régua, filtrar
  `todo_id IS NULL` e o evento `PedidoOperacaoLancadoNoSsw`.
- **A 49 por cima da 54:** com o lançamento ligado, uma 49 num card `AGUARDANDO_CLIENTE`
  troca a última oc no SSW, e o sync-bastao então move o card para AGUARDANDO VOCÊ
  (INV-019). É o efeito desejado, porque a operação trouxe fato novo, mas é uma mudança de
  estado **por consequência**, pelo fluxo que já existe.
- **Carga da leitura:** até 10 SELECTs por chamada de `ponte-tratativas`. Pedimos ao
  Roteirizador cache de 60 s ou mais por painel.
- **Segredo:** cada sentido tem o seu token (emenda 5). Vazar o da v1 não abre as edges da
  v2, e vice-versa. Rotacionar um não derruba o outro.
- **Cron por minuto** (mig 412): mais 1440 execuções por dia no pg_cron, inertes com a flag
  OFF. A mig 412 só é aplicada na hora de ligar os pedidos.

## Como ligar (time do Cockpit, pelo trilho, um passo por vez)

1. Revisar este ADR, `docs/PONTE-OPERACAO-REVISAO.md` e as 5 suítes
   (`deno test --no-check --allow-read --allow-env supabase/functions/_shared/ponte-operacao-*.test.ts`).
2. Confirmar a **paridade de CTRC** com um CTRC real (como na 0034): o Roteirizador manda
   `AMB642904-1`, igual a `cards.ctrc`.
3. Merge no master, depois da ponte v1.
4. Aplicar a **mig 411** (`dbq.py --autorizado-por`; TIPO B pelo classificador). Ela é
   inerte: o smoke confirma flags OFF, lista vazia e nenhum cron novo.
5. Secrets das edges: **`PONTE_OPERACAO_TOKEN`** (novo, com o mesmo valor do
   `RI_COCKPIT_TOKEN` do Roteirizador; não reusar o `ROTEIRIZADOR_PONTE_TOKEN`) e, opcional,
   `COCKPIT_APP_URL` para o `linkCard`.
6. Deploy de `ponte-tratativas`, `ponte-pedido-operacao` e `processar-pedidos-operacao`
   (`deploy_pendente.py`). As três respondem 503 ou `skipped`.
7. Ligar `ponte_operacao_leitura`. Conferir com 3 CTRCs conhecidos que estado, bloqueio e
   motivo batem com o que o operador vê no card.
8. Aplicar a **mig 412** (cron) e fazer a **prova de pulso** (INV-156).
9. Ligar `ponte_operacao_pedidos`, **ainda sem SSW**. Conferir:
   - pedido num CTRC com card ativo: `DevolvidoPelaOperacao` no card e status `executado`
     com "a 49 não foi lançada";
   - pedido num CTRC sem card e fora do Bastão: `recusado`, com o motivo.
10. Medir a taxa orgânica de login (INV-159 c). Só então ligar `ponte_operacao_lancar_ssw`,
    em horário calmo, com alguém olhando `acoes_executadas_ssw` e `AcaoFalhou` "login
    falhou". O primeiro pedido real vai num CTRC de teste.
11. `lancar_ocorrencia` fica por último, código a código: INSERT inativo com `criterio` e
    `pedido_por`, depois UPDATE `ativo = true` com `autorizado_por`/`autorizado_em`
    (TIPO B).

## Como desligar

- **Na hora, sem deploy:**
  - `ponte_operacao_lancar_ssw` OFF: é relida antes de cada lançamento. Os pedidos na fila
    esperam e expiram em 4 h;
  - `ponte_operacao_pedidos` OFF: POST e GET respondem 503 e o worker fica `skipped`;
  - `ponte_operacao_leitura` OFF: 503.
- **Um código:** `UPDATE ponte_operacao_codigos_permitidos SET ativo = false WHERE codigo = N`.
- **Remover:** `cron.unschedule('processar-pedidos-operacao')` e depois a reversão do
  cabeçalho da mig 411.
- O que já foi feito fica. Ocorrência lançada não se desfaz, e o card nascido de pedido
  segue como qualquer card.

## Furos no contrato e as emendas de 25/09/2026

Os furos achados na primeira versão viraram emendas do contrato (valem para os dois
lados) e estão aplicados nesta branch:

1. **NF no pedido (emenda 1):** `nf` opcional, normalizada sem zeros à esquerda e parte do
   hash. Ela é conferida contra a NF do card (422 `nf_diverge`) e a do Bastão
   (`nf_diverge_bastao`), e entra no tripé quando o card não tem NF. `lancar_ocorrencia`
   sem card e sem NF responde 422 "sem NF para o tripé".
2. **Valores de `aguardando` (emenda 2):** `cliente`, `area_interna`, `operador` e
   `ninguem`, repassados como estão.
3. **`tratativaDesde` (emenda 3):** campo ISO em cada tratativa. A data continua no texto
   do `motivoBloqueio`.
4. **409 (emenda 4):** mesmo `pedidoId` com conteúdo diferente responde 409 com o status do
   original e não executa. Substitui o `200 + conteudoDivergente` da primeira versão.
5. **Token próprio (emenda 5):** `PONTE_OPERACAO_TOKEN` no Cockpit. Sem ele, 503.
6. **Clique de pessoa (emenda 6):** garantido pelo Roteirizador (usuário logado); o Cockpit
   recusa `solicitadoPor` sem id e nome ou com identidade de automação.

O que continua em aberto, por decisão deste ADR: nota fora do Bastão e sem card **não**
ganha card nem com a NF do pedido (ver D2). O 202 do contrato continua sempre `recebido`:
quem decide é o worker, e o painel consulta pelo GET.
