-- ============================================================================
-- registrar_saidas_kanban v2: motivo específico com oc lançada no SSW
-- Caio 2026-05-21
--
-- Bug UX: modal "Cards que saíram nesta atualização" mostrava motivo genérico
-- "SSW lançou ocorrência posterior à última oc=13/21". Caio quer ver QUAL oc
-- foi lançada (ex: "saiu pq SSW lançou oc=14 ENTREGA INICIADA").
--
-- Fix: extrai do historico_ssw o evento POSTERIOR à oc=13/21 do card (mesma
-- lógica das views v_oc13/21_paradas_prioridades mig 135). Inclui oc + desc
-- + data no motivo e em detalhes.
--
-- skill: supabase-postgres-best-practices — SECURITY DEFINER + search_path=''
-- preservados. Idempotente. Sem alteração de assinatura (mesmo nome/args).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.registrar_saidas_kanban(
  p_card_ids uuid[],
  p_fonte text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted integer := 0;
BEGIN
  IF p_card_ids IS NULL OR array_length(p_card_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  IF p_fonte NOT IN ('cron_autonomo','atualizar_geral_manual','outro') THEN
    RAISE EXCEPTION 'fonte inválida: %', p_fonte;
  END IF;

  WITH ainda_na_view AS (
    SELECT card_id FROM public.v_prioridades_ai
    WHERE card_id = ANY(p_card_ids)
  ),
  sairam AS (
    SELECT c.id, c.nf, c.responsavel_relacionamento,
           c.cod_ultima_ocorrencia, c.state, c.historico_ssw
    FROM public.cards c
    WHERE c.id = ANY(p_card_ids)
      AND c.id NOT IN (SELECT card_id FROM ainda_na_view)
  ),
  -- Parse historico_ssw JSONB → linhas tipadas (mesma lógica das views mig 135)
  historico_parsed AS (
    SELECT
      s.id AS card_id,
      ((h.elem ->> 'codigo')::integer) AS codigo,
      (h.elem ->> 'descricao') AS descricao,
      ((
        '20' || split_part(split_part(h.elem ->> 'data', ' ', 1), '/', 3) || '-' ||
        lpad(split_part(split_part(h.elem ->> 'data', ' ', 1), '/', 2), 2, '0') || '-' ||
        lpad(split_part(split_part(h.elem ->> 'data', ' ', 1), '/', 1), 2, '0') || ' ' ||
        split_part(h.elem ->> 'data', ' ', 2) || ':00-03'
      ))::timestamptz AS data_evento
    FROM sairam s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.historico_ssw, '[]'::jsonb)) h(elem)
    WHERE ((h.elem ->> 'codigo')::integer) IS NOT NULL
      AND (h.elem ->> 'data') ~ '^\d{1,2}/\d{1,2}/\d{2} \d{1,2}:\d{2}$'
  ),
  -- Timestamp da última oc=13/21 do card no histórico (= âncora temporal)
  ts_oc_card AS (
    SELECT hp.card_id, max(hp.data_evento) AS ts_ancora
    FROM historico_parsed hp
    JOIN sairam s ON s.id = hp.card_id
    WHERE hp.codigo = s.cod_ultima_ocorrencia
      AND hp.codigo IN (13, 21)
    GROUP BY hp.card_id
  ),
  -- Evento mais recente POSTERIOR à âncora — esse é o que "motivou a saída"
  motivadora AS (
    SELECT DISTINCT ON (hp.card_id)
      hp.card_id, hp.codigo AS oc_motivadora,
      hp.descricao AS desc_motivadora, hp.data_evento
    FROM historico_parsed hp
    JOIN ts_oc_card t ON t.card_id = hp.card_id
    WHERE hp.data_evento > t.ts_ancora
    ORDER BY hp.card_id, hp.data_evento DESC
  ),
  ins AS (
    INSERT INTO public.prioridades_ai_saidas
      (card_id, nf, responsavel_relacionamento, oc_antes, oc_depois,
       state_depois, motivo, fonte, detalhes)
    SELECT
      s.id, s.nf, s.responsavel_relacionamento,
      NULL,
      s.cod_ultima_ocorrencia,
      s.state,
      CASE
        WHEN s.state IN ('RESOLVIDO','CANCELADO') THEN 'Card foi pra ' || s.state
        WHEN m.oc_motivadora IS NOT NULL THEN
          'SSW lançou oc=' || m.oc_motivadora ||
          COALESCE(' (' || nullif(trim(m.desc_motivadora), '') || ')', '') ||
          ' após a oc=' || COALESCE(s.cod_ultima_ocorrencia::text, '?') || ' do card'
        WHEN s.cod_ultima_ocorrencia IS NOT NULL AND s.cod_ultima_ocorrencia NOT IN (13, 21) THEN
          'OC avançou para ' || s.cod_ultima_ocorrencia
        ELSE 'SSW lançou ocorrência posterior — card saiu por filtro temporal'
      END,
      p_fonte,
      jsonb_build_object(
        'cod_ultima_ocorrencia', s.cod_ultima_ocorrencia,
        'state', s.state,
        'oc_motivadora', m.oc_motivadora,
        'desc_motivadora', m.desc_motivadora,
        'data_motivadora', m.data_evento
      )
    FROM sairam s
    LEFT JOIN motivadora m ON m.card_id = s.id
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;

  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_saidas_kanban(uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registrar_saidas_kanban(uuid[], text) TO service_role;

COMMENT ON FUNCTION public.registrar_saidas_kanban IS
  'v2 2026-05-21: motivo agora inclui oc específica que foi lançada no SSW '
  '(ex: "SSW lançou oc=14 ENTREGA INICIADA após oc=21 do card"). Extrai do '
  'historico_ssw o evento posterior à âncora temporal (última oc=13/21).';
