# 0008 — Agente "relançar 54 por ressarcimento" (round-trip 54→46→49)

Data: 2026-06-25
Status: aceito — **Tier A AUTÔNOMO LIGADO 2026-06-25** (Caio auditou, 100% correto);
Tier B segue como sugestão no card (validação manual do operador). Autonomia é
tier-aware: a flag só lança Tier A; Tier B nunca lança sozinho. No autônomo o scan
re-puxa o histórico SSW fresco antes de lançar (NF 374609 se auto-protegeu: SSW já
tinha 54).

## Contexto

Padrão recorrente que gera demanda manual no relacionamento. Sequência no SSW:

1. Operador notifica o cliente pedindo info → lança **oc 54** (aguardando cliente).
2. Time de **Ressarcimento** entra no caso → lança **oc 46** ("EM ANALISE DE RESSARCIMENTO").
3. A **mesma pessoa do Ressarcimento** relança **oc 49** ("tratativa de relacionamento")
   dizendo o que falta e mandando o relacionamento **LANÇAR 54 NOVAMENTE**.

A ação correta do relacionamento é só **relançar a oc 54 (sem e-mail novo** — o cliente
já foi notificado**)**, mantendo o card aguardando o cliente enquanto o ressarcimento
corre. Âncoras: NF 374609, 775461 (scan 2026-06-25).

## Decisão

Detector puro + agente que **recomenda** (e, com a flag, **relança**) a oc 54.

### Invariante INV-024 (inviolável)
A interpretação só vale com a sequência cronológica **54 → 46 → 49** (54 ANTES da 46).
**Sem a 54 antes da 46, o cliente nunca foi notificado** → relançar 54 não faz sentido →
detector retorna `null`. Além disso a **49 tem que ser a última oc codificada** (card
parado nela). Detector: `_shared/ressarcimento-relancar-54.ts` (12 testes).

### Dois tiers (Caio 2026-06-25)
- **Tier A (determinístico):** a instrução da 49 manda relançar 54 explicitamente
  ("LANCAR 54", "54 NOVAMENTE", "LANCAR NOVAMENTE"). Elegível pra autonomia.
- **Tier B (interpretação do agente):** a 49 (da MESMA pessoa que lançou a 46) pede
  romaneio/descrição/valor/itens/acareação sem escrever "54". O agente lê o **e-mail
  original da oc 54** (`cards_emails_outbound`): se pediu esses docs **e o cliente NÃO
  respondeu** (`cards.cliente_respondeu_em IS NULL`) → recomenda. Senão → não roda.
  Modelo: Haiku 4.5 (classificação).

### Exclusões (estrutura bate mas NÃO é "relançar 54")
- a 49 manda lançar OUTRA oc (ex.: "LANCAR 56 NOVAMENTE" — NF 2679036);
- a 49 diz "OC NÃO PROCEDE" (ressarcimento recusou);
- Tier B com 46 e 49 de pessoas diferentes (não é o round-trip do ressarcimento).

### Ação
Proposta `lancar_ocorrencia` codigo_ssw=54, `meta.sem_email_explicito=true`,
`meta.origem='ressarcimento_relancar_54'` (gêmeo lançar-só-54). Lançamento via envelope
`lancarSswPortal` (idempotência + guard tripé). Texto SSW: "AGUARDANDO RETORNO DO CLIENTE
PAGADOR - REITERACAO (PROCESSO DE RESSARCIMENTO EM ANALISE)".

### O todo Tier A carrega `forcar_lancamento_ctrc_baixado=true` (Caio 2026-06-30, NF 5631361)
No round-trip de ressarcimento o CTRC quase sempre está **baixado/entregue** (a entrega
ocorreu; o que segue aberto é a tratativa de ressarcimento). Por isso o todo da oc 54
que o agente cria/reusa **sempre** carrega, em `proposta_payload.args.extras`:
`forcar_lancamento_ctrc_baixado=true` + `forcar_lancamento_origem='ressarcimento_relancar_54'`
+ `forcar_lancamento_motivo='round-trip 54->46->49; ressarcimento em aberto'`. O executor
lê isso e passa `permitirLocalizacaoBaixada=true` ao guard tripé, que **dispensa só a
checagem (c) de localização** — (a) CTRC e (b) NF seguem validados e invioláveis
(proteção NF 142371). Antes disso a NF 5631361 lançava (Tier A) mas o tripé bloqueava 4×
em "CTRC ENTREGUE / BAIXADO" e o cliente nunca era reiterado. A flag é **por-todo**
(helper `_shared/forcar-lancamento-ctrc-baixado.ts`), nunca um override global; cobre o
todo novo E o reusado do gêmeo do menu (que vem sem extras).

### Rollout (espelha agente-extravio-d4, ADR implícito mig 256-259)
- `feature_flags.ressarcimento_relancar54_enabled` (master, ON) — liga o scan (sombra).
- `feature_flags.ressarcimento_relancar54_autonomo_enabled` (OFF) — Caio liga após
  validar a **taxa de acertos** manualmente. Reportes de erro → desligar.
- Cron: `agente-ressarcimento-relancar-54`, `30 11-21 * * 1-5` (horário comercial BRT).
- Auditoria: `v_ressarc54_auditoria` (timeline), `v_ressarc54_metricas` (contador por
  operador), RPC `reportar_erro_ressarc54` (operador marca "agente errou"). Migs 268-270.

## Consequências
- O scan é idempotente (filtra `ressarc54_status IS NULL`; proposta dedup por origem).
- Cards onde a 54 já foi relançada manualmente (cod_ultima_ocorrencia=54) caem fora
  naturalmente (detector exige última codificada=49) — não re-recomenda.
- Guard de não-regressão: `ressarcimento-relancar-54.test.ts` + item INV-024 no
  `/verify-cockpit`. **INV-024b** (Caio 2026-06-30): o todo Tier A carrega
  `forcar_lancamento_ctrc_baixado=true` — testes `forcar-lancamento-ctrc-baixado.test.ts`
  (helper) + `validar-tripe-ssw.test.ts` (a flag NÃO burla CTRC/NF divergente) + item no
  `/verify-cockpit`.
