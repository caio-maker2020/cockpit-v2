-- =============================================================================
-- 2026-07-03_289 — GIRANDO/ROLEMAR: unifica em CURVA F (ISA E KAROL),
--                  descadastra da CAMILA
-- =============================================================================
-- Diretriz Caio 2026-07-03: os 2 CNPJs da GIRANDO COMERCIO DE PECAS (ROLEMAR)
-- devem ficar ambos em CURVA F (ISA E KAROL) e sair totalmente da CAMILA:
--   - 81676009001190 (0011-90): hoje AUTO PECAS (001) / CAMILA  → MOVE
--   - 81676009001433 (0014-33): hoje CURVA F   (043) / ISA E KAROL → já OK (no-op)
--
-- Diferença vs mig 288 (CENTERVIDA): aqui o SEGMENTO muda de propósito
-- (001 AUTO PECAS → 043 CURVA F). Reetiquetar clientes E cards é obrigatório:
-- card de ISA E KAROL com segmento_codigo=001 vazaria na visão da CAMILA
-- (lição da mig 264). Resolver: carteira = prioridade absoluta ("1 CNPJ = 1 op").
--
-- Cards terminais (RESOLVIDO/CANCELADO) NÃO movem (histórico) — padrão mig 264/288.
-- Idempotente. Event sourcing preservado. skill: supabase-postgres-best-practices.
-- =============================================================================
BEGIN;

DO $$
DECLARE
  v_cnpjs    text[] := ARRAY['81676009001190','81676009001433'];
  v_camila   uuid;
  v_isakarol uuid;
  v_cli int; v_cont int; v_track int; v_cards int;
BEGIN
  SELECT id INTO v_camila   FROM public.operadores WHERE nome = 'CAMILA';
  SELECT id INTO v_isakarol FROM public.operadores WHERE nome = 'ISA E KAROL';
  IF v_camila IS NULL OR v_isakarol IS NULL THEN
    RAISE EXCEPTION 'operador nao encontrado (camila=% isakarol=%)', v_camila, v_isakarol;
  END IF;

  -- 1. carteira: remove os 2 CNPJs da CAMILA; garante na ISA E KAROL (dedup)
  UPDATE public.operadores
     SET carteira = (SELECT COALESCE(array_agg(x), '{}')
                     FROM unnest(carteira) x WHERE x <> ALL(v_cnpjs))
   WHERE id = v_camila;

  UPDATE public.operadores
     SET carteira = (SELECT array_agg(DISTINCT x)
                     FROM unnest(carteira || v_cnpjs) x)
   WHERE id = v_isakarol;

  -- 2. clientes: reetiqueta segmento p/ CURVA F (043) — 0014-33 já é 043 (no-op)
  UPDATE public.clientes
     SET segmento_codigo = '043', segmento_nome = 'CURVA F', updated_at = now()
   WHERE regexp_replace(cnpj_cpf, '\D', '', 'g') = ANY(v_cnpjs)
     AND segmento_codigo IS DISTINCT FROM '043';
  GET DIAGNOSTICS v_cli = ROW_COUNT;

  -- 3. contatos_cliente: CAMILA -> ISA E KAROL
  UPDATE public.contatos_cliente
     SET operador_responsavel_id = v_isakarol, updated_at = now()
   WHERE regexp_replace(documento_cliente, '\D', '', 'g') = ANY(v_cnpjs)
     AND operador_responsavel_id = v_camila;
  GET DIAGNOSTICS v_cont = ROW_COUNT;

  -- 4. tracking_credentials: CAMILA -> ISA E KAROL
  UPDATE public.tracking_credentials
     SET operador_responsavel_id = v_isakarol, updated_at = now()
   WHERE regexp_replace(documento, '\D', '', 'g') = ANY(v_cnpjs)
     AND operador_responsavel_id = v_camila;
  GET DIAGNOSTICS v_track = ROW_COUNT;

  -- 5. cards nao-terminais CAMILA -> ISA E KAROL + segmento 043 + card_events
  WITH upd AS (
    UPDATE public.cards c
       SET assigned_operator_id       = v_isakarol,
           responsavel_relacionamento = 'ISA E KAROL',
           segmento_codigo            = '043'
     WHERE lpad(regexp_replace(c.agent_state->>'cnpj_pagador', '\D', '', 'g'), 14, '0') = ANY(v_cnpjs)
       AND c.assigned_operator_id = v_camila
       AND c.state NOT IN ('RESOLVIDO', 'CANCELADO')
    RETURNING c.id,
              lpad(regexp_replace(c.agent_state->>'cnpj_pagador', '\D', '', 'g'), 14, '0') AS cnpj
  )
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  SELECT id, 'OperadorReatribuido', 'system', 'fix_mig_289',
         jsonb_build_object(
           'responsavel_anterior', 'CAMILA',
           'responsavel_novo',     'ISA E KAROL',
           'cnpj_pagador',         cnpj,
           'segmento_anterior',    '001',
           'segmento_novo',        '043',
           'motivo',               'Diretriz Caio 2026-07-03: GIRANDO/ROLEMAR move de CAMILA (AUTO PECAS) para ISA E KAROL (CURVA F)')
  FROM upd;
  GET DIAGNOSTICS v_cards = ROW_COUNT;

  RAISE NOTICE 'mig 289 GIRANDO: clientes=%, contatos=%, tracking=%, cards=%',
    v_cli, v_cont, v_track, v_cards;
END $$;

COMMIT;
