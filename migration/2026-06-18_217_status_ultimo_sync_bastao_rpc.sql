-- =============================================================================
-- RPC status_ultimo_sync_bastao() — data+hora ABSOLUTA do último sync (BRT)
--
-- Caio 2026-06-18: o header do Cockpit mostrava "SYNC há 125min" mesmo com o
-- último sync tendo sido ~9min antes (cálculo relativo bugado no front, fuso do
-- client). Operadores sempre perguntam "quando foi a última atualização". Fix:
-- mostrar data+hora absoluta (igual a plataforma do Bastão: "18/06/26, 11:47"),
-- formatada NO SERVIDOR em BRT → sem bug de fuso no front.
--
-- Fonte: sync_status_global (cache single-row, atualizado pelo sync-bastao).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.status_ultimo_sync_bastao()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'ultimo_sync_bastao', ultimo_sync_bastao,
    -- formatado em BRT pro header: "18/06/26, 11:47"
    'ultimo_sync_bastao_fmt',
      to_char(ultimo_sync_bastao AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YY, HH24:MI'),
    -- minutos computados no servidor (confiável, sem fuso do client)
    'minutos', public.minutos_desde_ultimo_sync_bastao()
  )
  FROM public.sync_status_global
  WHERE id = 1;
$$;

REVOKE ALL ON FUNCTION public.status_ultimo_sync_bastao() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.status_ultimo_sync_bastao() TO authenticated, anon, service_role;

COMMENT ON FUNCTION public.status_ultimo_sync_bastao() IS
  'Header do Cockpit: data+hora absoluta (BRT, "DD/MM/YY, HH24:MI") + minutos do '
  'último sync-bastao. Formatação no servidor evita o bug de "há Xmin" no front. '
  'Caio 2026-06-18.';
