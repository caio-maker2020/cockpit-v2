-- ============================================================================
-- 2026-08-11_326 — ALERTAS PRO OPERADOR + FISCAL DO INV-066.
--
-- Caio 2026-08-11: "Não podemos permitir que exista resposta dos clientes sem
-- mover card e sem o operador estar ciente." O reconciliador (mig 325) conserta
-- sozinho em ≤1min. Esta camada é o que acontece SE ele falhar: o operador dono
-- do card é avisado por e-mail E por um aviso dentro do Cockpit, com o relatório
-- do que aconteceu no mesmo ritual de diagnóstico que usamos aqui.
--
-- Três camadas de defesa, nesta ordem:
--   1. vinculador  → acionamento no caminho normal
--   2. reconciliador (cron 1min) → conserta o que a 1 não pegou
--   3. FISCAL (esta migration, cron 15min) → se ainda sobrou, AVISA O DONO
--      (o health-check segue avisando o Caio em paralelo)
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.alertas_operador (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operador_id      uuid NOT NULL REFERENCES public.operadores(id) ON DELETE CASCADE,
  card_id          uuid REFERENCES public.cards(id) ON DELETE CASCADE,
  nf               text,
  tipo             text NOT NULL,
  -- dedupe: mesma violação não vira 2 avisos. Inclui o instante da captura, então
  -- uma resposta NOVA do mesmo card gera aviso NOVO (é outro ciclo).
  chave            text NOT NULL UNIQUE,
  titulo           text NOT NULL,
  -- relatório no ritual: {sintoma, o_que_aconteceu[], qual_card, causa_provavel,
  -- o_que_verificar[], impacto}
  relatorio        jsonb NOT NULL DEFAULT '{}'::jsonb,
  criado_em        timestamptz NOT NULL DEFAULT now(),
  lido_em          timestamptz,
  encaminhado_em   timestamptz,
  encaminhado_obs  text,
  email_enviado_em timestamptz
);

COMMENT ON TABLE public.alertas_operador IS
  'INV-066: avisos direcionados ao operador dono do card (não ao gestor). Aparecem como barra inferior + conversa do agente no Cockpit. Caio 2026-08-11.';

-- Fila do operador: só os não lidos, mais novo primeiro.
CREATE INDEX IF NOT EXISTS idx_alertas_operador_pendentes
  ON public.alertas_operador (operador_id, criado_em DESC)
  WHERE lido_em IS NULL;

CREATE INDEX IF NOT EXISTS idx_alertas_operador_card
  ON public.alertas_operador (card_id);

ALTER TABLE public.alertas_operador ENABLE ROW LEVEL SECURITY;

-- Leitura: o dono vê os dele; gestor vê todos (mesma regra do resto do Cockpit).
-- (SELECT fn()) força initplan — a função roda 1x, não por linha.
DROP POLICY IF EXISTS alertas_operador_select ON public.alertas_operador;
CREATE POLICY alertas_operador_select ON public.alertas_operador
  FOR SELECT TO authenticated
  USING (
    operador_id = (SELECT public.current_operador_id())
    OR (SELECT public.current_operador_papel()) = 'gestor'
  );

-- Escrita direta NÃO é liberada pro front: marcar lido/encaminhar passa pelas
-- RPCs abaixo (que carimbam quem fez e quando). Insert é só service_role.

-- ── RPCs do fluxo do operador ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.marcar_alerta_operador_lido(p_alerta_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_op uuid; v_row public.alertas_operador;
BEGIN
  PERFORM public.assert_pode_executar();  -- modo visualização não interage (mig 324)
  v_op := public.current_operador_id();
  IF v_op IS NULL THEN
    RAISE EXCEPTION 'sem operador na sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_row FROM public.alertas_operador WHERE id = p_alerta_id;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'alerta % não encontrado', p_alerta_id; END IF;
  IF v_row.operador_id <> v_op AND public.current_operador_papel() <> 'gestor' THEN
    RAISE EXCEPTION 'alerta de outro operador' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.alertas_operador
     SET lido_em = coalesce(lido_em, now())
   WHERE id = p_alerta_id;

  -- Event sourcing: o "li e dispensei" fica no histórico do card (convenção 1).
  IF v_row.card_id IS NOT NULL THEN
    INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
    VALUES (v_row.card_id, 'AlertaOperadorLido', 'operator', v_op::text,
            jsonb_build_object('alerta_id', p_alerta_id, 'tipo', v_row.tipo, 'nf', v_row.nf));
  END IF;

  RETURN jsonb_build_object('ok', true, 'alerta_id', p_alerta_id);
END $$;

CREATE OR REPLACE FUNCTION public.encaminhar_alerta_operador_bug(
  p_alerta_id uuid,
  p_observacao text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_op uuid; v_row public.alertas_operador;
BEGIN
  PERFORM public.assert_pode_executar();
  v_op := public.current_operador_id();
  IF v_op IS NULL THEN
    RAISE EXCEPTION 'sem operador na sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_row FROM public.alertas_operador WHERE id = p_alerta_id;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'alerta % não encontrado', p_alerta_id; END IF;
  IF v_row.operador_id <> v_op AND public.current_operador_papel() <> 'gestor' THEN
    RAISE EXCEPTION 'alerta de outro operador' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.alertas_operador
     SET encaminhado_em  = coalesce(encaminhado_em, now()),
         encaminhado_obs = coalesce(p_observacao, encaminhado_obs),
         lido_em         = coalesce(lido_em, now())
   WHERE id = p_alerta_id;

  IF v_row.card_id IS NOT NULL THEN
    INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
    VALUES (v_row.card_id, 'AlertaOperadorEncaminhadoParaBug', 'operator', v_op::text,
            jsonb_build_object('alerta_id', p_alerta_id, 'tipo', v_row.tipo,
                               'nf', v_row.nf, 'observacao', p_observacao));
  END IF;

  RETURN jsonb_build_object('ok', true, 'alerta_id', p_alerta_id, 'encaminhado', true);
END $$;

REVOKE ALL ON FUNCTION public.marcar_alerta_operador_lido(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.encaminhar_alerta_operador_bug(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marcar_alerta_operador_lido(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.encaminhar_alerta_operador_bug(uuid, text) TO authenticated, service_role;

-- Realtime: a barra inferior aparece sem o operador dar refresh.
DO $rt$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.alertas_operador;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $rt$;

-- Flag do fiscal (ligado por padrão: ele só AVISA, não age em card).
INSERT INTO public.feature_flags (key, enabled, description)
VALUES ('fiscal_resposta_cliente_enabled', true,
        'INV-066: fiscal que avisa o OPERADOR (e-mail + aviso no Cockpit) quando sobra resposta de cliente sem acionamento.')
ON CONFLICT (key) DO NOTHING;

COMMIT;
