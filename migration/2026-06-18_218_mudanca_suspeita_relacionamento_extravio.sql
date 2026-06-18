-- =============================================================================
-- "Mudança suspeita" — card cuja última oc foi de relacionamento → extravio
--
-- Caio 2026-06-18 (ADR 0005): no sync único, quando a última oc de um card vai
-- de relacionamento p/ extravio (6/9/16), a regra primária move o card pra
-- Extravios, MAS sinaliza como SUSPEITO (erro de processo possível — não há
-- intertravamento na empresa). Card fica laranja + banner no topo do Cockpit.
--
-- Respeita o lock existente: card lockado em AGUARDANDO_VOCÊ
-- (AGUARDANDO_VALIDACAO_HUMANA) PERMANECE lockado lá até o operador dar OK
-- (regra alteracao_oc_durante_lock, mig 196 — podeRecalcular=false p/ lockado).
-- =============================================================================

-- 1. Sinal de mudança suspeita no card.
-- jsonb: { de_oc, para_oc, de_state, requer_ok (bool), detectada_em, vista_em }
ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS mudanca_suspeita jsonb;

-- Índice parcial p/ o banner (poucos cards têm o sinal ativo).
CREATE INDEX IF NOT EXISTS idx_cards_mudanca_suspeita
  ON public.cards(assigned_operator_id)
  WHERE mudanca_suspeita IS NOT NULL
    AND (mudanca_suspeita->>'vista_em') IS NULL;

-- 2. View do banner — só os não-vistos, RLS por operador (security_invoker).
DROP VIEW IF EXISTS public.v_mudancas_suspeitas;
CREATE VIEW public.v_mudancas_suspeitas
WITH (security_invoker = on) AS
SELECT
  c.id AS card_id,
  c.nf,
  (c.mudanca_suspeita->>'de_oc')::int       AS de_oc,
  (c.mudanca_suspeita->>'para_oc')::int     AS para_oc,
  c.mudanca_suspeita->>'de_state'           AS de_state,
  (c.mudanca_suspeita->>'requer_ok')::bool  AS requer_ok,
  (c.mudanca_suspeita->>'detectada_em')     AS detectada_em,
  c.state,
  c.assigned_operator_id
FROM public.cards c
WHERE c.mudanca_suspeita IS NOT NULL
  AND (c.mudanca_suspeita->>'vista_em') IS NULL
ORDER BY (c.mudanca_suspeita->>'detectada_em') DESC NULLS LAST;
GRANT SELECT ON public.v_mudancas_suspeitas TO authenticated, service_role;

-- 3. Marcar como VISTA (operador abriu o card) — só zera o banner.
--    Pra cards já em Extravios (não lockados).
CREATE OR REPLACE FUNCTION public.marcar_mudanca_suspeita_vista(p_card_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operador_id uuid;
BEGIN
  SELECT id INTO v_operador_id FROM public.operadores WHERE user_id = auth.uid();
  UPDATE public.cards
  SET mudanca_suspeita = mudanca_suspeita || jsonb_build_object('vista_em', now())
  WHERE id = p_card_id
    AND (assigned_operator_id = v_operador_id OR v_operador_id IS NULL)
    AND mudanca_suspeita IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.marcar_mudanca_suspeita_vista(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marcar_mudanca_suspeita_vista(uuid) TO authenticated, service_role;

-- 4. OK do operador p/ card LOCKADO em AGUARDANDO_VOCÊ: desbloqueia + marca
--    visto. O move pra Extravios é feito em seguida pela reconciliação/sync
--    (card destravado + última oc extravio → EXTRAVIO_MONITORADO).
CREATE OR REPLACE FUNCTION public.liberar_card_suspeito_lockado(p_card_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operador_id uuid;
  v_state text;
BEGIN
  SELECT id INTO v_operador_id FROM public.operadores WHERE user_id = auth.uid();
  SELECT state INTO v_state FROM public.cards WHERE id = p_card_id;
  IF v_state IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'card não encontrado');
  END IF;

  UPDATE public.cards
  SET lock_aguardando_validacao = false,
      mudanca_suspeita = mudanca_suspeita || jsonb_build_object('vista_em', now(), 'liberado_em', now())
  WHERE id = p_card_id
    AND (assigned_operator_id = v_operador_id OR v_operador_id IS NULL);

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (p_card_id, 'MudancaSuspeitaLiberadaPeloOperador', 'human',
          COALESCE(v_operador_id::text, 'desconhecido'),
          jsonb_build_object('state_anterior', v_state));

  RETURN jsonb_build_object('ok', true, 'desbloqueado', true);
END;
$$;
REVOKE ALL ON FUNCTION public.liberar_card_suspeito_lockado(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.liberar_card_suspeito_lockado(uuid) TO authenticated, service_role;

COMMENT ON COLUMN public.cards.mudanca_suspeita IS
  'Sinal de transição suspeita relacionamento→extravio (ADR 0005). jsonb '
  '{de_oc,para_oc,de_state,requer_ok,detectada_em,vista_em}. Front: card laranja '
  '+ banner via v_mudancas_suspeitas; some ao abrir (vista_em). Caio 2026-06-18.';
