-- =============================================================================
-- Bump controlado (Caio 2026-06-23): auto "só daqui pra frente" + busca manual.
--
-- O poll lista o inbox de 30d e re-avalia a cada ciclo → a 1ª passada dragava o
-- backlog recente. Regra do Caio: AUTO só pra e-mail que CHEGAR daqui pra frente
-- (cutoff de timestamp). Casos ANTIGOS: o operador clica "JÁ TEM TRATATIVA" e aí
-- o agente busca sob demanda (mais barato — só quando o operador sabe que existe).
-- =============================================================================

-- 1. Config de 1 linha: cutoff "daqui pra frente". surfar (gmail-poll) só dispara
--    auto pra e-mail recebido >= cutoff. Re-baselinar = UPDATE cutoff = now().
CREATE TABLE IF NOT EXISTS public.scan_email_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  cutoff timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.scan_email_config (id, cutoff, atualizado_em)
VALUES (true, now(), now())
ON CONFLICT (id) DO UPDATE SET cutoff = now(), atualizado_em = now();

ALTER TABLE public.scan_email_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scan_email_config_read ON public.scan_email_config;
CREATE POLICY scan_email_config_read ON public.scan_email_config
  FOR SELECT TO authenticated USING (true);   -- leitura ok; escrita só service_role

COMMENT ON TABLE public.scan_email_config IS
  'Cutoff "daqui pra frente" do auto-scan de e-mail (Caio 2026-06-23). surfar só '
  'auto-adota e-mail recebido >= cutoff. Casos antigos = botão manual JÁ TEM TRATATIVA.';

-- 2. Busca MANUAL sob demanda: operador clica "JÁ TEM TRATATIVA" → enfileira um
--    scan BROAD (por NF, acha thread antiga também) pra esse card. Bypassa o
--    cutoff (é comando deliberado do operador).
CREATE OR REPLACE FUNCTION public.buscar_tratativa_do_card(p_card_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_operador_id uuid;
  v_operador_card uuid;
BEGIN
  SELECT id INTO v_operador_id FROM public.operadores WHERE user_id = auth.uid();
  SELECT assigned_operator_id INTO v_operador_card FROM public.cards WHERE id = p_card_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'card não encontrado');
  END IF;
  IF v_operador_id IS NOT NULL AND v_operador_card IS NOT NULL AND v_operador_card <> v_operador_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'card não pertence ao operador');
  END IF;

  -- scan BROAD (sem thread_hint → busca por NF, pega thread antiga) + contexto
  -- card_em_espera (auto-adota como principal se passar a trava NF+vínculo).
  PERFORM pgmq.send('scan_email_pre_card', jsonb_build_object(
    'card_id', p_card_id,
    'contexto', 'card_em_espera',
    'manual', true
  ));

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (p_card_id, 'BuscaTratativaManualSolicitada', 'operator',
          COALESCE(v_operador_id::text, 'desconhecido'), jsonb_build_object());

  RETURN jsonb_build_object('ok', true, 'enfileirado', true);
END;
$$;
REVOKE ALL ON FUNCTION public.buscar_tratativa_do_card(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buscar_tratativa_do_card(uuid) TO authenticated, service_role;
