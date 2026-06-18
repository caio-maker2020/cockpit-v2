-- =============================================================================
-- "Atualizar todas" da aba EXTRAVIOS — cooldown (Caio 2026-06-18)
--
-- Botão no topo da aba Extravios que força refresh (via SSW) de todos os cards
-- de extravio do operador. Pra não martelar o SSW, dois bloqueios:
--   • pós-sync do Bastão (sync-extravios)  → bloqueia 20 min (dado já fresco)
--   • pós-clique do operador               → bloqueia 10 min
-- Vale o MAIOR dos dois. O front mostra countdown ("liberado em X").
--
-- Timeout: o refresh em si NÃO roda aqui — é o endpoint atualizar-extravios-todas
-- que processa em lotes (timeout-safe). Aqui só o estado do cooldown.
-- =============================================================================

-- 1. Coluna do último sync de extravios (global, single-row reaproveitando o
--    cache de sync). Dirige o cooldown de 20 min pós-Bastão.
ALTER TABLE public.sync_status_global
  ADD COLUMN IF NOT EXISTS ultimo_sync_extravios timestamptz;

-- RPC pro sync-extravios-bastao carimbar no fim (service_role).
CREATE OR REPLACE FUNCTION public.registrar_sync_extravios_concluido()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.sync_status_global (id, ultimo_sync_extravios, atualizado_em)
  VALUES (1, now(), now())
  ON CONFLICT (id) DO UPDATE SET
    ultimo_sync_extravios = EXCLUDED.ultimo_sync_extravios,
    atualizado_em = now();
$$;
REVOKE ALL ON FUNCTION public.registrar_sync_extravios_concluido() FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.registrar_sync_extravios_concluido() TO service_role;

-- 2. Clique do operador (per-operador). Dirige o cooldown de 10 min pós-clique.
CREATE TABLE IF NOT EXISTS public.extravios_atualizar_lock (
  operador_id uuid PRIMARY KEY REFERENCES public.operadores(id) ON DELETE CASCADE,
  ultimo_clique_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
-- RLS: ninguém lê/escreve direto (só via RPC SECURITY DEFINER / service_role).
ALTER TABLE public.extravios_atualizar_lock ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.extravios_atualizar_lock FROM PUBLIC, authenticated, anon;
GRANT ALL ON public.extravios_atualizar_lock TO service_role;

-- Constantes de cooldown (segundos): Bastão 1200s (20min), operador 600s (10min).
-- 3. RPC de STATUS — o front chama (com JWT) pra habilitar/desabilitar o botão
--    e mostrar o countdown. Sem efeito colateral.
CREATE OR REPLACE FUNCTION public.extravios_atualizar_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operador_id uuid;
  v_ultimo_bastao timestamptz;
  v_ultimo_clique timestamptz;
  v_lock_bastao timestamptz;
  v_lock_operador timestamptz;
  v_liberado_em timestamptz;
  v_motivo text;
BEGIN
  SELECT id INTO v_operador_id FROM public.operadores WHERE user_id = auth.uid();
  IF v_operador_id IS NULL THEN
    RETURN jsonb_build_object('bloqueado', false, 'sem_operador', true);
  END IF;

  SELECT ultimo_sync_extravios INTO v_ultimo_bastao FROM public.sync_status_global WHERE id = 1;
  SELECT ultimo_clique_em INTO v_ultimo_clique
    FROM public.extravios_atualizar_lock WHERE operador_id = v_operador_id;

  v_lock_bastao   := v_ultimo_bastao  + interval '20 minutes';
  v_lock_operador := v_ultimo_clique  + interval '10 minutes';
  v_liberado_em   := GREATEST(COALESCE(v_lock_bastao, to_timestamp(0)),
                              COALESCE(v_lock_operador, to_timestamp(0)));

  IF v_liberado_em = v_lock_bastao THEN v_motivo := 'sync_bastao';
  ELSIF v_liberado_em = v_lock_operador THEN v_motivo := 'clique_operador';
  ELSE v_motivo := NULL; END IF;

  RETURN jsonb_build_object(
    'bloqueado', v_liberado_em > now(),
    'liberado_em', v_liberado_em,
    'segundos_restantes', GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_liberado_em - now()))))::int,
    'motivo', v_motivo
  );
END;
$$;
REVOKE ALL ON FUNCTION public.extravios_atualizar_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.extravios_atualizar_status() TO authenticated, service_role;

COMMENT ON FUNCTION public.extravios_atualizar_status() IS
  'Status do cooldown do botão "Atualizar todas" da aba Extravios pro operador do '
  'JWT. Bloqueia 20min pós-sync Bastão e 10min pós-clique (vale o maior). '
  'Caio 2026-06-18.';
