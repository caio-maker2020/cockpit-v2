# 0011 — Extravio parcial: dossiê de completude + gate da oc 33 (duas naturezas)

Data: 2026-07-01
Status: aceito (Fase 1 no ar em shadow; enforce após baseline)

## Contexto

Em **extravio total** o agente acerta muito: a premissa da **oc 33** (handoff pro time
de Ressarcimento — a partir dela a demanda do Relacionamento se encerra) é só o
**romaneio de coleta assinado**. Em **extravio parcial** (perdemos ALGUNS volumes da NF,
não todos) a premissa muda para **3 informações**: romaneio + **descrição dos itens** +
**valor dos itens**. E elas chegam **fatiadas**, em e-mails diferentes ao longo do tempo.

Até aqui o agente não rastreava o que já havia chegado, não avisava a operadora do que
faltava, e podia sugerir/lançar a oc 33 incompleta — abrindo o processo de indenização
sem os dados. Caso âncora **NF 66193 INOVAMED / Larissa**.

Há ainda uma ambiguidade que o contrato antigo do interpretador não separava: a oc 33
tem **duas naturezas** conforme o fluxo.

## Decisão

**Duas naturezas explícitas da oc 33:**
1. **OPERACIONAL (combo com 44)** — Caso 2 (cliente não autoriza parcial / recusa total →
   devolução): sai **só com romaneio**, destrava a devolução física. NÃO marca indenização
   completa. O cliente ainda nem sabe itens/valor — só saberá quando a devolução voltar.
2. **COMPLETUDE de indenização** — exige as **3 informações**. É a única oc 33 do Caso 1
   (parcial entregue, pós-oc 19, cliente já sabe itens/valor) e a 2ª do Caso 2 (pós-devolução).

**Contrato do interpretador (Ajuste 1):** o combo 33+44 deixa de exigir descrição/valor —
exige só o romaneio (fix do conflito com o Caso 2). O LLM passa a emitir
`contexto_extravio_parcial` + `evidencias_recebidas` (qual das 3 chegou, `fonte` corpo/anexo,
`trecho_verbatim`). A **evidência que vai ao SSW é a FONTE ORIGINAL** (anexo do cliente ou
trecho verbatim do corpo) — o LLM só rotula, nunca parafraseia/inventa (Ajuste 5).

**Dossiê** em `cards.agent_state.extravio_parcial.dossie` (jsonb existente, sem coluna nova),
populado pelo `interpretador-resposta-cliente` via `mergeEvidencia` (idempotente, monotônico —
uma evidência recebida não some se um e-mail posterior não a repetir). Guarda REFERÊNCIA da
evidência (`gmail_message_id`/`message_inbox_id`/filename) + trecho bruto — não o binário.

**Gate global (modo AVISADO):** módulo puro `_shared/extravio-parcial-dossie.ts`
(`classificarOc33`, `decidirGateOc33`, `avaliarDossie`, `ehExtravioParcial`). Choke-point
nos DOIS finalizadores de proposta (`propostas-pos-resposta-cliente.ts`, `regras-auto-acao.ts`):
anota `meta.gate_oc33` (natureza + bloqueada + faltando) — NÃO remove a proposta; o front
desabilita e mostra "faltam: X". Card não-parcial (`ehExtravioParcial=false`) → nada muda
(**extravio total intacto**).

**Enforce autoritativo no executor** (`gateOc33Enforce`): lê o dossiê VIVO na hora de lançar
(evidências podem ter chegado depois da proposta) e RECUSA a oc 33 de completude com dossiê
incompleto (e o combo operacional sem romaneio) — **só quando a flag
`extravio_parcial_gate_enforce`=ON** e o operador não forçou via
`extras.forcar_oc33_dossie_incompleto` (card_event `Oc33ForcadaDossieIncompleto`).

**Corte-em-70 → 500:** os handlers de oc 33 no executor truncavam o texto do SSW em 70 chars
antes de chamar o envelope — a descrição/valor do parcial se perdia. Agora `.slice(0,500)`
(`lancarOcorrenciaPortal` já divide f6(70)+observ(500)).

## Rollout

Shadow-first (mig 285): `extravio_parcial_dossie_enabled=ON` (popula dossiê + telemetria
`DossieExtravioAtualizado`/`Oc33BloqueadaDossieIncompleto`), `extravio_parcial_gate_enforce=OFF`
(observa, não bloqueia). Liga o enforce após baseline de sombra (pega falso-positivo do LLM).
Faseamento: **Fase 1** = Caso 1 (este ADR). **Fase 2** = Caso 2 (herança do dossiê no
sync-bastao, re-busca do romaneio do e-mail, sub-caso Tier B do relançar-54, 2ª oc 33, template).

## Consequências

- Zero regressão no extravio total (guard `ehExtravioParcial`) e nos demais fluxos.
- INV-034 + `_shared/extravio-parcial-dossie.test.ts` (21 testes) travam a regra.
- O combo 33+44 passa a disparar com romaneio-only (alinha ao Caso 2) — muda a sugestão em
  recusa/devolução parcial, mas mantém o guard NF 148558 (sem romaneio → sem combo).

## Alternativas descartadas

- **Gate rígido** (sumir a oc 33): Caio escolheu AVISADO (desabilitada + "faltam X", operador
  pode forçar) — dá escape hatch e não esconde a ação.
- **Copiar o romaneio pra storage persistente** (p/ reuso na 2ª oc 33 do Caso 2): descartado —
  o romaneio está no e-mail; re-buscar da fonte é mais robusto e não duplica storage (Fase 2).
- **Decidir completude no LLM**: descartado — a completude é derivada DETERMINISTICAMENTE do
  dossiê (`avaliarDossie`); o LLM só identifica/rotula as evidências.

## Adendo — Fase 2 (Caso 2 completo, 2026-07-01)

Implementado o fluxo Caso 2: devolução → **1ª oc 33 operacional + 44** (só romaneio) → oc 30
(CTE finalizado) → Ressarcimento lança **oc 49 pedindo descrição/valor** → card **reabre** →
agente sugere **54 + e-mail** pedindo descrição/valor → cliente responde → **2ª oc 33 de
completude** (romaneio reaproveitado + descrição + valor) → `indenizacao_completa`.

- **HOTFIX pré-Fase 2:** o interpretador selecionava `gmail_message_id`/`gmail_thread_id` como
  COLUNAS de `messages_inbox` (não existem — ficam em `raw_payload`), o que quebrava o
  interpretador pra TODO card. Corrigido pra ler `raw_payload` (+ `operador_id` pra re-busca).
- **Preservação do dossiê (sync-bastao):** `mesclarExtravioParcial` copia `extravio_parcial` do
  card existente nos 3 UPDATEs de agent_state e no snapshot passado a `proporAutoAcaoSeAplicavel`.
  A reabertura por oc 49 REUSA o card (não cria novo) → dossiê sobrevive. INV-004 intacto (não
  removi chaves); guard novo `INV34_SYNCPRES`.
- **Re-busca do romaneio:** `reprocessar-anexos-mensagem` resolve `gmail_message_id` via
  `raw_payload`, filtra `deletado_em` e RESSUSCITA o anexo apagado pós-1ª oc 33
  (`decidirReuploadAnexo`), retornando `anexos_disponiveis`; o executor filtra o romaneio certo
  por `filename+size+mime` (`acharAnexoDoDossie`).
- **Sub-caso Tier B-DV (agente-ressarcimento):** `detectarPedirDescricaoValor` — quando a oc 49
  pede docs E o dossiê tem romaneio mas falta descrição/valor → sugere **54 + e-mail** (template
  `EXTRAVIO_PARCIAL_PEDIR_DESCRICAO_VALOR`), MANUAL, RODA mesmo com `cliente_respondeu_em` setado.
  **Tier A segue o único autônomo.** `ressarc54_status` é resetado na reabertura (novo ciclo).
  O todo 54+email resolve `email_destino` (RPC) ou marca `precisa_email_destino`; e há **guard
  AUTORITATIVO no executor** (`deveBloquear54PedirDescValor`, fonte única `ORIGEM_PEDIR_DESCRICAO_VALOR`):
  se o todo B-DV chega sem destinatário válido, o executor REVERTE (card_event
  `Oc54PedirDescricaoValorSemDestinatario`) — nunca vira "54 sem e-mail", independente do front.
- **Marcações (executor, agent_state FRESCO):** `oc33_operacional_lancada` logo após `result33.ok`
  do combo (mesmo se a 44 falhar); `indenizacao_completa` após a oc 33 de completude. Eventos
  `Oc33OperacionalLancada`/`Oc33CompletudeLancada`.
- **Materialização da 2ª oc 33:** `montarTextoDescricaoValor` (desc+valor do dossiê) + romaneio
  reaproveitado; se o texto estoura o SSW (>500), gera evidência em imagem (`gerarJpegDescricaoValor`)
  com o texto ORIGINAL e resumo na instrução. Dedup por `acao_key` não bloqueia a 2ª oc 33
  (`lancar_combo_33_44:33` ≠ `lancar_oc33_solo_portal:33`).
- **Rollout:** flag própria `extravio_parcial_caso2_enabled` (OFF, mig 286) — todo o comportamento
  Caso 2 fica dormente até ligar. Enforce segue OFF. Deploy/migration só após nova auditoria Codex.

## Adendo — Seed histórico do romaneio (Codex 2026-07-02, NF 575330)

**Causa raiz (uma só):** o dossiê validava SÓ a resposta corrente (`montarEvidenciasRecebidas` recebe apenas
os anexos/corpo da mensagem atual). Romaneio recebido/aceito ANTES do dossiê nascer ficava invisível → falso
"faltando romaneio" (NF 575330: romaneio em `email_anexos` desde 12/06, oc 33 já lançada, mas o dossiê nasce
na resposta de desc/valor e não enxerga o PDF anterior). A Fase 2 (re-busca/herança) não cobre — pressupõe
dossiê prévio.

**Fix (determinístico, nunca via LLM; SÓ o romaneio — desc/valor seguem só corpo-corrente/anexo-validado):**
- **Nível 1 — `detectarRomaneioNoHistorico`** (`email_anexos` inbound + corpo `messages_inbox`): anexo PDF/imagem
  cujo e-mail-mãe (remetente ≠ `@salexpress`) tem sinal de ENVIO do romaneio e NÃO é linguagem de pedido →
  `fonte:"anexo"` com metadados completos p/ re-busca (message_inbox_id/gmail_message_id/thread/operador_id/
  filename/size/mime/visto_em). **NÃO filtra `deletado_em`** (registro deletado ainda é evidência
  reprocessável via message_inbox_id; `deletado_em` só decide reupload, downstream).
- **Nível 2 — `romaneioAceitoPorRessarcimento`** (histórico SSW): romaneio já ACEITO quando existe oc 33
  anterior + oc 49 que **pede explicitamente descrição/valor/itens** E **não menciona romaneio** E tem
  contexto Ressarcimento (oc 46 do mesmo usuário da 49). Evidência PROCESSUAL `fonte:"ssw"` (ref oc33/oc49),
  **sem** anexo. Provado pelas fixtures: 575330 (oc49 "DESCRICAO E VALOR" → aceito) × 66193 (oc49 "DESCRICAO,
  VALOR E ROMANEIO" → NÃO). `montarSeedRomaneio`: Nível 1 (anexo) tem precedência sobre Nível 2 (ssw).
- **Onde:** só no `interpretador-resposta-cliente` (antes do merge da resposta corrente; só enquanto
  `romaneio.presente=false`; monotônico). **sync-bastao NÃO infere evidência** (só preserva/mescla).
- **Blindagem do executor (obrigatória):** `decidirAcaoRomaneioCompletude` — `materializarOc33Completude`
  passa a materializar a 2ª oc 33 POR FONTE: `fonte:"anexo"` reanexa (falha→bloqueia, comportamento antigo);
  `fonte:"ssw"` NÃO reanexa, NÃO bloqueia, acrescenta nota processual; ausente/desconhecida → conservador
  (não inventa anexo). Sem isso, `fonte:"ssw"` (sem message_inbox_id) reverteria a 2ª oc 33 por falta de arquivo.
- **Fora desta rodada:** desc/valor histórico; detecção determinística de "é parcial" (Nível 3).
- **Rollout:** atrás de `extravio_parcial_dossie_enabled` (shadow). Sem migration, sem coluna nova. Type:
  `FonteEvidencia` ganha `"ssw"` (LLM raw segue só `"corpo"|"anexo"` — `"ssw"` só por helper determinístico).
- **Refino pré-deploy (Codex 2026-07-02):** Nível 1 — `RE_ROMANEIO_ENVIO` não aceita mais `"romaneio de
  coleta"` isolado (exige `"romaneio assinado"` OU verbo de envio perto de `romaneio`); anti-pedido ampliado
  (precisamos/necessitamos/solicitamos/aguardamos/favor encaminhar/poderiam enviar). Nível 2 — a oc 46 tem
  de ser do MESMO CICLO: sequência `oc49 → oc46 (mesmo usuário) → oc33` no histórico (mais-recente-1º), em
  vez de `.some()` (que casava oc 46 de ciclo antigo).
- **Guards:** +18 testes em `extravio-parcial-dossie.test.ts` (5 fixtures Codex + gating de fonte + refino
  regex/ciclo) + INV-034 (`montarSeedRomaneio` no interpretador, `decidirAcaoRomaneioCompletude` no executor).
