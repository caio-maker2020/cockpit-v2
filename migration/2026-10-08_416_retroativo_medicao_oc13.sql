-- =============================================================================
-- 2026-10-08_416_retroativo_medicao_oc13.sql  (INV-174)  — TIPO B (só dado)
--
-- Caio 08/10: "se for possível pegar os dados do passado já preciso que seja
-- resolvido". Dois buracos de medição da oc 13, ambos reconstruíveis a partir
-- de card_events (a verdade do card):
--
-- (1) PARES PERDIDOS no placar. Até a mig 337 (13/08 20:18 UTC) a RPC
--     `registrar_feedback_oc13_implicito` só gravava ERRO do ramo 54+e-mail
--     (acerto e os ramos 21/56 nunca viraram par). Depois dela, a re-análise
--     indevida do agente (filtro `.or()` com o relógio solto — corrigido no
--     mesmo PR) às vezes FALHAVA e sobrescrevia a análise boa com `erro_msg`,
--     e a RPC lia esse erro na hora da aprovação → abstenção em vez de par.
--     Reconstrução: par = cada AgenteOc13Decisao `sugerir_*` × a 1ª
--     AprovacaoOperador depois dela e antes da sugestão seguinte do card,
--     SÓ quando o SSW confirmou (AcaoExecutada sucesso=true do mesmo to-do),
--     SÓ aprovação humana (todos.auto_approval_rule nulo — INV-089: o agente
--     não se autoavalia) e SÓ onde ainda não existe par (card, oc sugerida)
--     em agent_feedback. Veredito pela MESMA régua da RPC: código igual =
--     seguida, diferente = corrigida (variante com/sem e-mail não é erro).
--     Insere em agente_oc13_feedback (o trigger espelho da mig 338 leva ao
--     agent_feedback com a data da aprovação). Ensaio BEGIN/ROLLBACK em 08/10:
--     153 pares (94 seguidas, 59 corrigidas) — mai 2 · jun 45 · jul 59 ·
--     ago 21 · set 22 · out 4.
--
-- (2) CARIMBO VAZIO na aprovação. O `sugestao_vigente` (mig 378) lê
--     `aviso_alteracao_oc.proposta_destacada(_acao)`; o agente-oc13 nunca
--     escreveu o número e mandava acao_key nula no ramo 21 → o carimbo nasceu
--     `{}` em 22/22 aprovações pós-"sugerir_21_cancel" de setembro (e em 17
--     dos ramos 54/56, banner apagado por outro processo). Com `{}` o I2 do
--     Duilio conta a ação como "sem sugestão". Reconstrução: nas aprovações
--     com carimbo `{}` cuja ÚLTIMA decisão de agente anterior no card é um
--     AgenteOc13Decisao `sugerir_*`, grava agente_oc + agente_acao_key +
--     marcador `reconstruido`. card_events é append-only por trigger
--     (`card_events_no_update`); o trigger é desligado DENTRO de um DO atômico,
--     a atualização é por id (lista pré-calculada em temp table, sem varredura
--     sob lock) e o trigger volta no mesmo bloco — qualquer erro desfaz tudo.
--     Nenhum outro campo do evento muda. Ensaio 08/10: 39 aprovações
--     (set 34 · out 5).
--
-- Idempotente: as duas partes checam o que já existe (marcadores `retroativo`
-- e `reconstruido`). Sem BEGIN/COMMIT (lição da mig 337). Reversível: as
-- linhas de feedback têm corrigido_por_nome = 'retroativo mig 416 (eventos)';
-- os carimbos têm a chave `reconstruido`.
--
-- skill: supabase-postgres-best-practices — a parte (2) segura ACCESS
-- EXCLUSIVE em card_events só durante o UPDATE por id (dezenas de linhas),
-- nunca durante a varredura; a varredura roda antes, sem lock.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- (1) pares perdidos → agente_oc13_feedback (→ trigger → agent_feedback)
-- ─────────────────────────────────────────────────────────────────────────────
WITH sug AS (
  SELECT id AS ev_id, card_id, created_at AS sug_em, event_type, payload,
         payload->>'decisao' AS dec,
         lead(created_at) OVER (PARTITION BY card_id ORDER BY created_at) AS prox
  FROM public.card_events
  WHERE event_type IN ('AgenteOc13Decisao','AgenteOcsPadraoDecisao','InterpretadorRespostaClienteConcluido')
),
s13 AS (
  SELECT *,
    CASE dec WHEN 'sugerir_54_email' THEN 54 WHEN 'sugerir_21_cancel' THEN 21 WHEN 'sugerir_56' THEN 56 END AS oc_sug,
    CASE dec WHEN 'sugerir_54_email' THEN 'lancar_oc_e_enviar_email:54'
             WHEN 'sugerir_21_cancel' THEN 'lancar_ocorrencia:21'
             WHEN 'sugerir_56' THEN 'lancar_ocorrencia:56' END AS acao
  FROM sug
  WHERE event_type = 'AgenteOc13Decisao' AND dec IN ('sugerir_54_email','sugerir_21_cancel','sugerir_56')
),
par AS (
  SELECT s.ev_id, s.card_id, s.sug_em, s.payload AS sug_payload, s.oc_sug, s.acao,
         a.id AS apr_id, a.created_at AS apr_em, a.actor_id,
         (a.payload->>'todo_id')::uuid AS todo_id,
         COALESCE(a.payload->'proposta_payload'->'args'->>'codigo_ssw',
                  a.payload->'proposta_payload'->'args'->>'codigo_ocorrencia',
                  NULLIF(split_part(COALESCE(a.payload->'proposta_payload'->>'acao_key',''),':',2),''))::int AS oc_exec
  FROM s13 s
  JOIN LATERAL (
    SELECT * FROM public.card_events a
    WHERE a.card_id = s.card_id AND a.event_type = 'AprovacaoOperador'
      AND a.created_at > s.sug_em AND (s.prox IS NULL OR a.created_at < s.prox)
    ORDER BY a.created_at LIMIT 1
  ) a ON true
),
elegiveis AS (
  SELECT p.*
  FROM par p
  WHERE p.oc_exec IS NOT NULL
    AND p.todo_id IS NOT NULL
    -- SSW confirmou a ação desse to-do (mesma condição do executor pra chamar a RPC)
    AND EXISTS (SELECT 1 FROM public.card_events x
                WHERE x.card_id = p.card_id AND x.event_type = 'AcaoExecutada'
                  AND (x.payload->>'todo_id')::uuid = p.todo_id
                  AND (x.payload->>'sucesso')::boolean IS TRUE)
    -- aprovação HUMANA (INV-089)
    AND NOT EXISTS (SELECT 1 FROM public.todos t WHERE t.id = p.todo_id AND t.auto_approval_rule IS NOT NULL)
    -- ainda não existe par (card, oc sugerida) — chave da RPC/placar
    AND NOT EXISTS (SELECT 1 FROM public.agent_feedback f
                    WHERE f.agent_name = 'agente-oc13-autonomo' AND f.card_id = p.card_id
                      AND f.oc_sugerida = p.oc_sug AND f.origem = 'implicit')
    AND NOT EXISTS (SELECT 1 FROM public.agente_oc13_feedback f
                    WHERE f.card_id = p.card_id AND f.decisao_ia->>'retroativo' = 'mig 416'
                      AND f.decisao_ia->>'evento_sugestao_id' = p.ev_id::text)
)
INSERT INTO public.agente_oc13_feedback (
  card_id, tipo_feedback, decisao_ia, decisao_correta_codigo_ssw,
  motivo_correcao, corrigido_por, corrigido_por_nome, corrigido_em
)
SELECT
  e.card_id,
  CASE WHEN e.oc_exec = e.oc_sug THEN 'sugestao_certa_implicita' ELSE 'sugestao_errada_implicita' END,
  e.sug_payload || jsonb_build_object(
    'proposta_destacada_acao', e.acao,
    'retroativo', 'mig 416',
    'sugerido_em', e.sug_em,
    'evento_sugestao_id', e.ev_id,
    'evento_aprovacao_id', e.apr_id
  ),
  CASE WHEN e.oc_exec = e.oc_sug THEN NULL ELSE e.oc_exec END,
  NULL,
  (SELECT o.id FROM public.operadores o WHERE o.id::text = e.actor_id),
  'retroativo mig 416 (eventos)',
  e.apr_em
FROM elegiveis e;

-- ─────────────────────────────────────────────────────────────────────────────
-- (2) carimbo `{}` → reconstruído a partir do AgenteOc13Decisao
-- ─────────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS tmp_carimbo_oc13;
CREATE TEMP TABLE tmp_carimbo_oc13 ON COMMIT DROP AS
WITH apr AS (
  SELECT id, card_id, created_at
  FROM public.card_events
  WHERE event_type = 'AprovacaoOperador'
    AND payload ? 'sugestao_vigente'
    AND payload->'sugestao_vigente' = '{}'::jsonb
),
ult AS (
  SELECT a.id AS apr_id, s.event_type, s.payload->>'decisao' AS dec, s.created_at AS sug_em, s.id AS ev_id
  FROM apr a
  JOIN LATERAL (
    SELECT * FROM public.card_events s
    WHERE s.card_id = a.card_id AND s.created_at < a.created_at
      AND s.event_type IN ('AgenteOc13Decisao','AgenteOcsPadraoDecisao','InterpretadorRespostaClienteConcluido')
    ORDER BY s.created_at DESC LIMIT 1
  ) s ON true
)
SELECT apr_id, ev_id, sug_em,
  CASE dec WHEN 'sugerir_54_email' THEN 54 WHEN 'sugerir_21_cancel' THEN 21 WHEN 'sugerir_56' THEN 56 END AS oc_sug,
  CASE dec WHEN 'sugerir_54_email' THEN 'lancar_oc_e_enviar_email:54'
           WHEN 'sugerir_21_cancel' THEN 'lancar_ocorrencia:21'
           WHEN 'sugerir_56' THEN 'lancar_ocorrencia:56' END AS acao
FROM ult
WHERE event_type = 'AgenteOc13Decisao' AND dec IN ('sugerir_54_email','sugerir_21_cancel','sugerir_56');

DO $$
DECLARE
  v_alvos int;
  v_upd int;
  v_pares int;
BEGIN
  SELECT count(*) INTO v_alvos FROM tmp_carimbo_oc13;
  IF v_alvos > 100 THEN
    RAISE EXCEPTION 'mig 416: % carimbos a reconstruir — esperado ~39 (set 34 · out 5). Reler antes de aplicar.', v_alvos;
  END IF;

  -- o guard append-only volta no fim deste bloco; erro no meio desfaz tudo
  EXECUTE 'ALTER TABLE public.card_events DISABLE TRIGGER card_events_no_update';

  UPDATE public.card_events e
     SET payload = jsonb_set(e.payload, '{sugestao_vigente}', jsonb_build_object(
           'agente_oc', t.oc_sug,
           'agente_acao_key', t.acao,
           'sugerido_em', t.sug_em,
           'reconstruido', 'mig 416 (evento AgenteOc13Decisao ' || t.ev_id::text || ')'
         ), true)
    FROM tmp_carimbo_oc13 t
   WHERE e.id = t.apr_id
     AND e.event_type = 'AprovacaoOperador'
     AND e.payload->'sugestao_vigente' = '{}'::jsonb;
  GET DIAGNOSTICS v_upd = ROW_COUNT;

  EXECUTE 'ALTER TABLE public.card_events ENABLE TRIGGER card_events_no_update';

  SELECT count(*) INTO v_pares FROM public.agente_oc13_feedback WHERE decisao_ia->>'retroativo' = 'mig 416';
  IF v_pares > 250 THEN
    RAISE EXCEPTION 'mig 416: % pares retroativos — esperado ~153. Reler antes de aplicar.', v_pares;
  END IF;

  RAISE NOTICE 'mig 416: pares retroativos acumulados=% · carimbos reconstruídos nesta rodada=% (alvos=%)', v_pares, v_upd, v_alvos;
END
$$;

-- Guarda final: o guard append-only tem que estar LIGADO.
DO $$
DECLARE
  v_en char;
BEGIN
  SELECT tgenabled INTO v_en FROM pg_trigger WHERE tgrelid = 'public.card_events'::regclass AND tgname = 'card_events_no_update';
  IF v_en IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'mig 416: card_events_no_update ficou DESLIGADO (tgenabled=%) — abortando', v_en;
  END IF;
END
$$;
