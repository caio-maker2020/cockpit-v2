-- =============================================================================
-- 2026-07-21_304 — Rename de operadores: ISA E KAROL → ISABELY, CAMILA → FELIPE
-- =============================================================================
-- Pedido Caio 2026-07-21: mesmos e-mails (sac@ / auto.pecas@), só muda o nome.
-- NÃO é só cosmético: o Bastão renomeou às 17:00 UTC de 2026-07-21 (corte limpo
-- nos BastaoCardImportado) e o match por nome (operador-resolver Path 2 +
-- trigger cards_resolve_operator) parou de casar → 2 cards ativos órfãos
-- 'ISABELY' (únicos órfãos ativos do sistema) + filtros por nome no Bastão
-- (sync-prioridades-ai, full-pull Curva F) sem retorno pros dois.
--
-- O que faz (ordem importa — operadores ANTES dos cards, trigger lê na mesma tx):
--   1. Rename em operadores (+ nome_email_outbound 'Isabely'/'Felipe').
--   2. Cards ATIVOS trocam o texto responsavel_relacionamento + card_events
--      'OperadorRenomeado'. assigned_operator_id NÃO muda (trigger só preenche
--      quando NULL — mesma pessoa jurídica de card, mesmo operador id).
--   3. Retroativo: órfãos ativos 'ISABELY'/'FELIPE' (assigned NULL) re-disparam
--      o trigger via UPDATE OF responsavel_relacionamento → resolvem pro id
--      + card_events 'OperadorResolvidoRetroativo'.
--   4. Pós-check: 0 ativos com nome velho, 0 órfãos ativos dos nomes novos.
--
-- NÃO mexe: email, email_relacionamento, gmail_oauth_credentials, carteira,
-- segmentos, auth.users, tracking/contatos (FK por UUID). Cards terminais
-- (RESOLVIDO/CANCELADO/TRANSFERIDO) mantêm o texto da época (histórico).
-- Secrets SSW: leitura da ISABELY cai no fallback SSW_INTERNAL_* até o Caio
-- duplicar SSW_INTERNAL_ISA_E_KAROL_* → SSW_INTERNAL_ISABELY_*; FELIPE nada a
-- fazer (CAMILA nunca teve secret própria). Lançamento = ai.salex (INV-013).
--
-- Idempotente (re-run: renames 0 rows, sem evento duplicado). Event sourcing.
-- Guard permanente: INV-038 no /verify-cockpit. skill: supabase-postgres-best-practices.
-- =============================================================================
BEGIN;

DO $$
DECLARE
  v_isak    uuid := 'f67db0fc-90ca-4df0-bdd2-a985b64d3d1e';  -- ISA E KAROL → ISABELY
  v_camila  uuid := '3c9b0686-e6cc-4d98-a83d-75505a532b76';  -- CAMILA → FELIPE
  v_nome_isak   text;
  v_nome_camila text;
  v_n int;
  v_cards_isa int; v_cards_cam int; v_orfaos int; v_sobra int;
BEGIN
  -- ---------------------------------------------------------------------------
  -- Preflight
  -- ---------------------------------------------------------------------------
  SELECT nome INTO v_nome_isak   FROM public.operadores WHERE id = v_isak;
  SELECT nome INTO v_nome_camila FROM public.operadores WHERE id = v_camila;
  IF v_nome_isak IS NULL OR v_nome_camila IS NULL THEN
    RAISE EXCEPTION 'STOP: operador nao encontrado (isak=% camila=%)', v_nome_isak, v_nome_camila;
  END IF;
  IF v_nome_isak NOT IN ('ISA E KAROL','ISABELY') OR v_nome_camila NOT IN ('CAMILA','FELIPE') THEN
    RAISE EXCEPTION 'STOP: nome inesperado (isak=% camila=%) — banco divergiu do plano', v_nome_isak, v_nome_camila;
  END IF;
  -- colisao com a UNIQUE(nome): outro operador ja usando o nome novo
  IF EXISTS (SELECT 1 FROM public.operadores WHERE nome = 'ISABELY' AND id <> v_isak)
     OR EXISTS (SELECT 1 FROM public.operadores WHERE nome = 'FELIPE' AND id <> v_camila) THEN
    RAISE EXCEPTION 'STOP: ja existe OUTRO operador chamado ISABELY/FELIPE — colisao na unique(nome)';
  END IF;

  -- ---------------------------------------------------------------------------
  -- 1. Rename em operadores (0 rows no re-run = ok)
  -- ---------------------------------------------------------------------------
  UPDATE public.operadores
     SET nome = 'ISABELY', nome_email_outbound = 'Isabely'
   WHERE id = v_isak AND nome = 'ISA E KAROL';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'mig 304: rename ISA E KAROL→ISABELY rows=%', v_n;

  UPDATE public.operadores
     SET nome = 'FELIPE', nome_email_outbound = 'Felipe'
   WHERE id = v_camila AND nome = 'CAMILA';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'mig 304: rename CAMILA→FELIPE rows=%', v_n;

  -- ---------------------------------------------------------------------------
  -- 2. Cards ATIVOS: texto novo + evento. assigned_operator_id fica intacto
  --    (ja preenchido; trigger cards_resolve_operator so preenche NULL).
  -- ---------------------------------------------------------------------------
  WITH upd AS (
    UPDATE public.cards c
       SET responsavel_relacionamento = 'ISABELY'
     WHERE c.responsavel_relacionamento = 'ISA E KAROL'
       AND c.state NOT IN ('RESOLVIDO','CANCELADO','TRANSFERIDO')
    RETURNING c.id
  )
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  SELECT id, 'OperadorRenomeado', 'system', 'fix_mig_304',
    jsonb_build_object('responsavel_anterior','ISA E KAROL','responsavel_novo','ISABELY',
      'operador_id', v_isak,
      'motivo','Rename de operador (Caio 2026-07-21): mesmo operador/e-mail, so o nome muda; alinha com o Bastao (corte 17:00 UTC)')
  FROM upd;
  GET DIAGNOSTICS v_cards_isa = ROW_COUNT;

  WITH upd AS (
    UPDATE public.cards c
       SET responsavel_relacionamento = 'FELIPE'
     WHERE c.responsavel_relacionamento = 'CAMILA'
       AND c.state NOT IN ('RESOLVIDO','CANCELADO','TRANSFERIDO')
    RETURNING c.id
  )
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  SELECT id, 'OperadorRenomeado', 'system', 'fix_mig_304',
    jsonb_build_object('responsavel_anterior','CAMILA','responsavel_novo','FELIPE',
      'operador_id', v_camila,
      'motivo','Rename de operador (Caio 2026-07-21): mesmo operador/e-mail, so o nome muda; alinha com o Bastao (corte 17:00 UTC)')
  FROM upd;
  GET DIAGNOSTICS v_cards_cam = ROW_COUNT;

  -- ---------------------------------------------------------------------------
  -- 3. Retroativo: orfaos ativos dos nomes novos (assigned NULL — imports do
  --    Bastao entre o corte 17:00 UTC e esta migration). O UPDATE OF
  --    responsavel_relacionamento re-dispara o trigger, que agora casa o nome.
  -- ---------------------------------------------------------------------------
  WITH upd AS (
    UPDATE public.cards c
       SET responsavel_relacionamento = c.responsavel_relacionamento
     WHERE c.responsavel_relacionamento IN ('ISABELY','FELIPE')
       AND c.assigned_operator_id IS NULL
       AND c.state NOT IN ('RESOLVIDO','CANCELADO','TRANSFERIDO')
    RETURNING c.id, c.responsavel_relacionamento, c.assigned_operator_id
  )
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  SELECT id, 'OperadorResolvidoRetroativo', 'system', 'fix_mig_304',
    jsonb_build_object('responsavel_relacionamento', responsavel_relacionamento,
      'assigned_operator_id', assigned_operator_id,
      'motivo','Card orfao (Bastao mandou nome novo antes do rename no Cockpit); resolvido via trigger apos mig 304')
  FROM upd;
  GET DIAGNOSTICS v_orfaos = ROW_COUNT;

  -- ---------------------------------------------------------------------------
  -- 4. Pos-check (aborta a transacao inteira se falhar)
  -- ---------------------------------------------------------------------------
  SELECT count(*) INTO v_sobra FROM public.cards
   WHERE responsavel_relacionamento IN ('ISA E KAROL','CAMILA')
     AND state NOT IN ('RESOLVIDO','CANCELADO','TRANSFERIDO');
  IF v_sobra > 0 THEN
    RAISE EXCEPTION 'STOP pos-check: % cards ativos ainda com nome velho', v_sobra;
  END IF;

  SELECT count(*) INTO v_sobra FROM public.cards
   WHERE responsavel_relacionamento IN ('ISABELY','FELIPE')
     AND assigned_operator_id IS NULL
     AND state NOT IN ('RESOLVIDO','CANCELADO','TRANSFERIDO');
  IF v_sobra > 0 THEN
    RAISE EXCEPTION 'STOP pos-check: % cards ativos ISABELY/FELIPE ainda orfaos (trigger nao resolveu)', v_sobra;
  END IF;

  RAISE NOTICE 'mig 304 OK: cards ISA E KAROL→ISABELY=%, CAMILA→FELIPE=%, orfaos resolvidos=%',
    v_cards_isa, v_cards_cam, v_orfaos;
END $$;

COMMIT;
