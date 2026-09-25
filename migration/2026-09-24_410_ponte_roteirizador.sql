-- =============================================================================
-- 2026-09-24_410 — PONTE Roteirizador ↔ Cockpit (ADR 0034)
-- =============================================================================
-- Lado do Cockpit da ponte descrita em docs/PONTE-COCKPIT.md (repo do
-- Roteirizador Inteligente). TUDO NASCE INERTE:
--   - 3 flags OFF (consulta dos agentes / compromissos / sync de eventos);
--   - cron de 5 min que só lê a flag e devolve `skipped: flag_off`;
--   - sem env ROTEIRIZADOR_API_URL/ROTEIRIZADOR_PONTE_TOKEN o cliente também é
--     no-op (dupla trava).
-- Nada muda de comportamento em produção até alguém ligar uma flag.
--
-- O que cria:
--   1. feature_flags: roteirizador_ponte_consulta_enabled,
--      roteirizador_ponte_compromissos_enabled, roteirizador_ponte_sync_enabled.
--   2. audit_log.external_system aceita 'roteirizador' (CHECK ampliado — só
--      ACRESCENTA um valor; nenhuma linha existente muda).
--   3. roteirizador_ponte_cursor (singleton) — cursor `proximo` do /eventos.
--   4. roteirizador_ponte_eventos — 1 linha por (evento, CTRC). PK = trava de
--      idempotência: reprocessar o mesmo evento nunca duplica card_event.
--   5. RPC ponte_roteirizador_registrar_linha — grava a linha E o card_event
--      na MESMA transação (sem janela de crash entre os dois).
--   6. RPC ponte_roteirizador_anexar_pendentes — alerta que chegou antes do
--      card é anexado quando o card do CTRC aparece (72h); depois expira.
--   7. cron sync-roteirizador-ponte */5.
--
-- TIPO B (exige --autorizado-por): o item 2 é DROP/ADD de constraint em tabela
-- existente (o classificador do dbq.py acusa DROP) e o item 7 faz
-- cron.unschedule guardado por EXISTS (idempotência). Risco real: baixo — o
-- CHECK novo é superconjunto do atual; a flag nasce OFF.
-- Reversão: cron.unschedule('sync-roteirizador-ponte'); DROP FUNCTION x2;
-- DROP TABLE roteirizador_ponte_eventos, roteirizador_ponte_cursor;
-- DELETE FROM feature_flags WHERE key LIKE 'roteirizador_ponte_%';
-- recriar o CHECK sem 'roteirizador' (só se nenhuma linha usar o valor).
--
-- skill supabase-postgres-best-practices: não disponível nesta sessão;
-- aplicado dos precedentes (migs 380/404): idempotente (IF NOT EXISTS /
-- ON CONFLICT / unschedule antes de schedule), schema-qualified, RLS ON sem
-- policy (só service_role), SECURITY DEFINER com search_path='' e EXECUTE só
-- pro service_role, CHECK NOT VALID + VALIDATE (lock curto), índices parciais
-- pro que o worker varre, segredo do cron lido do vault.
-- ⚠ SEM BEGIN/COMMIT interno (política de migrations, regra 13/08).
--
-- ⚠ NÃO APLICADA (nem dry-run) — arquivo entregue pro time do Cockpit aplicar
-- pelo trilho. Duas notas pra quem for aplicar:
--   (a) LOCK do audit_log: o DROP/ADD + VALIDATE do
--       audit_log_external_system_check (item 2) roda na MESMA transação do
--       resto, então o ACCESS EXCLUSIVE do ALTER segura o audit_log durante a
--       varredura do VALIDATE (~27 mil linhas em 24/09) — executor e envio de
--       WhatsApp esperam nesse intervalo. SUGESTÃO: tirar o item 2 pra uma
--       migration separada, aplicada fora do horário de pico. Sem o item 2 o
--       código funciona: o INSERT em audit_log do compromisso falha no CHECK e
--       só vira log (best-effort); o card_event continua sendo gravado.
--   (b) SEGREDO do cron: o item 7 REUSA o segredo do vault
--       `cron_sync_bastao_key` (mesmo dos crons sync-bastao/sync-extravios). Se
--       ele rotacionar, este cron quebra junto — rotação atualiza os três.
--
-- AUTORIZACAO (TIPO B): preencher no --autorizado-por ao aplicar
--   "<quem>, <quando>: <ordem/motivo>".
-- ORDEM: aplicar DEPOIS do deploy de sync-roteirizador-ponte (o cron bateria
-- em função inexistente — inofensivo, mas polui cron.job_run_details).
-- PULSO (INV-156): migration toca cron → conferir que
-- `select max(start_time) from cron.job_run_details` avança nos 10 min seguintes.
-- =============================================================================

-- 1. Flags — todas OFF ---------------------------------------------------------
INSERT INTO public.feature_flags (key, enabled, description) VALUES
  ('roteirizador_ponte_consulta_enabled', false,
   'ADR 0034: agentes de rastreamento (redator) e extravio (IA oc 49) consultam '
   'GET /v3/ponte/notas/:ctrc (CTRC do card) e recebem a rota do dia no contexto. '
   'OFF = prompt de hoje, byte a byte.'),
  ('roteirizador_ponte_compromissos_enabled', false,
   'ADR 0034: depois da oc 21 lançada com extras.data_reentrega estruturado, o '
   'executor faz POST /v3/ponte/compromissos (idempotencyKey card_id:reentrega:data). '
   'Muda o PLANO do Roteirizador — ligar só com o time da base ciente.'),
  ('roteirizador_ponte_sync_enabled', false,
   'ADR 0034: sync-roteirizador-ponte puxa /v3/ponte/eventos por cursor e grava '
   'card_events RoteirizadorAlertaRota / RoteirizadorContextoRota em cards ATIVOS. '
   'Nunca cria card nem muda state.')
ON CONFLICT (key) DO NOTHING;

-- 2. audit_log aceita 'roteirizador' ----------------------------------------------
ALTER TABLE public.audit_log DROP CONSTRAINT IF EXISTS audit_log_external_system_check;
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_external_system_check
  CHECK (external_system IN ('ssw', 'evolution', 'resend', 'postmark', 'bastao', 'internal', 'roteirizador'))
  NOT VALID;
ALTER TABLE public.audit_log VALIDATE CONSTRAINT audit_log_external_system_check;

-- 3. Cursor (singleton) ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.roteirizador_ponte_cursor (
  id              smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  proximo         bigint NOT NULL DEFAULT 0 CHECK (proximo >= 0),
  atualizado_em   timestamptz NOT NULL DEFAULT now(),
  ultimo_ok_em    timestamptz,
  ultimo_erro     text,
  ultimo_erro_em  timestamptz
);
COMMENT ON TABLE public.roteirizador_ponte_cursor IS
  'ADR 0034: cursor `proximo` de GET /v3/ponte/eventos. Só avança depois que a página inteira foi gravada.';
INSERT INTO public.roteirizador_ponte_cursor (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.roteirizador_ponte_cursor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.roteirizador_ponte_cursor FROM anon, authenticated;

-- 4. Eventos recebidos (1 linha por evento × CTRC) -------------------------------
CREATE TABLE IF NOT EXISTS public.roteirizador_ponte_eventos (
  evento_id           bigint NOT NULL,
  ctrc                text NOT NULL DEFAULT '',
  tipo                text NOT NULL,
  classe              text NOT NULL CHECK (classe IN ('alerta', 'contexto', 'ignorado')),
  situacao            text NOT NULL CHECK (situacao IN ('aplicado', 'aguardando_card', 'sem_card', 'ignorado', 'expirado')),
  card_id             uuid REFERENCES public.cards(id) ON DELETE SET NULL,
  card_event_id       uuid,
  payload_card_event  jsonb,
  evento              jsonb NOT NULL,
  recebido_em         timestamptz NOT NULL DEFAULT now(),
  aplicado_em         timestamptz,
  PRIMARY KEY (evento_id, ctrc)
);
COMMENT ON TABLE public.roteirizador_ponte_eventos IS
  'ADR 0034: eventos da ponte do Roteirizador. PK (evento_id, ctrc) = idempotência do sync.';
-- Worker de pendentes varre só os aguardando (parcial = minúsculo).
CREATE INDEX IF NOT EXISTS idx_rpe_aguardando_card
  ON public.roteirizador_ponte_eventos (recebido_em)
  WHERE situacao = 'aguardando_card';
CREATE INDEX IF NOT EXISTS idx_rpe_card
  ON public.roteirizador_ponte_eventos (card_id)
  WHERE card_id IS NOT NULL;
ALTER TABLE public.roteirizador_ponte_eventos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.roteirizador_ponte_eventos FROM anon, authenticated;

-- 5. Grava linha + card_event atomicamente ---------------------------------------
-- Devolve: 'repetido' (linha já existia — nada gravado) ou a situação gravada.
CREATE OR REPLACE FUNCTION public.ponte_roteirizador_registrar_linha(
  p_evento_id bigint,
  p_ctrc text,
  p_tipo text,
  p_classe text,
  p_situacao text,
  p_card_id uuid,
  p_card_event_type text,
  p_payload jsonb,
  p_evento jsonb
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_evento_card uuid;
BEGIN
  IF p_card_event_type IS NOT NULL
     AND p_card_event_type NOT IN ('RoteirizadorAlertaRota', 'RoteirizadorContextoRota') THEN
    RAISE EXCEPTION 'event_type não permitido pela ponte: %', p_card_event_type;
  END IF;

  INSERT INTO public.roteirizador_ponte_eventos
    (evento_id, ctrc, tipo, classe, situacao, card_id, payload_card_event, evento)
  VALUES
    (p_evento_id, coalesce(p_ctrc, ''), p_tipo, p_classe, p_situacao,
     CASE WHEN p_card_event_type IS NOT NULL THEN p_card_id END, p_payload, p_evento)
  ON CONFLICT (evento_id, ctrc) DO NOTHING;
  IF NOT FOUND THEN
    RETURN 'repetido';
  END IF;

  IF p_card_id IS NOT NULL AND p_card_event_type IS NOT NULL THEN
    INSERT INTO public.card_events (card_id, event_type, payload, actor_type, actor_id)
    VALUES (p_card_id, p_card_event_type, coalesce(p_payload, '{}'::jsonb), 'system', 'sync-roteirizador-ponte')
    RETURNING id INTO v_evento_card;
    UPDATE public.roteirizador_ponte_eventos
       SET card_event_id = v_evento_card, aplicado_em = now()
     WHERE evento_id = p_evento_id AND ctrc = coalesce(p_ctrc, '');
  END IF;
  RETURN p_situacao;
END;
$$;
REVOKE ALL ON FUNCTION public.ponte_roteirizador_registrar_linha(bigint, text, text, text, text, uuid, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ponte_roteirizador_registrar_linha(bigint, text, text, text, text, uuid, text, jsonb, jsonb) TO service_role;

-- 6. Anexa alertas pendentes a cards que apareceram depois -----------------------
-- Match por igualdade exata de CTRC (cards.ctrc já é normalizado upper/trim —
-- conferido em produção 24/09: 0 de 29.653 fora do padrão), usando idx_cards_ctrc.
-- Card ATIVO = fora de RESOLVIDO/CANCELADO/TRANSFERIDO (INV-042). Mais recente vence.
-- Devolve quantos foram anexados; expira os pendentes com mais de p_janela_horas.
CREATE OR REPLACE FUNCTION public.ponte_roteirizador_anexar_pendentes(
  p_janela_horas integer DEFAULT 72,
  p_limite integer DEFAULT 200
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r record;
  v_card uuid;
  v_evento_card uuid;
  v_anexados integer := 0;
BEGIN
  UPDATE public.roteirizador_ponte_eventos
     SET situacao = 'expirado'
   WHERE situacao = 'aguardando_card'
     AND recebido_em < now() - make_interval(hours => p_janela_horas);

  FOR r IN
    SELECT evento_id, ctrc, payload_card_event
      FROM public.roteirizador_ponte_eventos
     WHERE situacao = 'aguardando_card'
     ORDER BY recebido_em
     LIMIT p_limite
     FOR UPDATE SKIP LOCKED
  LOOP
    SELECT c.id INTO v_card
      FROM public.cards c
     WHERE c.ctrc = r.ctrc
       AND c.state NOT IN ('RESOLVIDO', 'CANCELADO', 'TRANSFERIDO')
     ORDER BY c.created_at DESC
     LIMIT 1;
    CONTINUE WHEN v_card IS NULL;

    INSERT INTO public.card_events (card_id, event_type, payload, actor_type, actor_id)
    VALUES (v_card, 'RoteirizadorAlertaRota',
            coalesce(r.payload_card_event, '{}'::jsonb) || jsonb_build_object('anexado_depois', true),
            'system', 'sync-roteirizador-ponte')
    RETURNING id INTO v_evento_card;

    UPDATE public.roteirizador_ponte_eventos
       SET situacao = 'aplicado', card_id = v_card, card_event_id = v_evento_card, aplicado_em = now()
     WHERE evento_id = r.evento_id AND ctrc = r.ctrc;
    v_anexados := v_anexados + 1;
  END LOOP;
  RETURN v_anexados;
END;
$$;
REVOKE ALL ON FUNCTION public.ponte_roteirizador_anexar_pendentes(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ponte_roteirizador_anexar_pendentes(integer, integer) TO service_role;

-- 7. Cron de 5 min (inerte com a flag OFF) ---------------------------------------
SELECT cron.unschedule('sync-roteirizador-ponte')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-roteirizador-ponte');

SELECT cron.schedule(
  'sync-roteirizador-ponte',
  '*/5 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/sync-roteirizador-ponte',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'cron_sync_bastao_key'
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) AS request_id;
  $cron$
);

-- 8. Smoke test inline -------------------------------------------------------------
DO $$
DECLARE
  v_ligadas integer;
  v_jobs integer;
BEGIN
  SELECT count(*) INTO v_ligadas FROM public.feature_flags
   WHERE key IN ('roteirizador_ponte_consulta_enabled',
                 'roteirizador_ponte_compromissos_enabled',
                 'roteirizador_ponte_sync_enabled')
     AND enabled IS TRUE;
  IF v_ligadas > 0 THEN
    RAISE NOTICE 'ATENCAO: % flag(s) da ponte JA LIGADA(S) — o cron age no proximo ciclo.', v_ligadas;
  ELSE
    RAISE NOTICE 'OK: flags da ponte OFF — tudo inerte.';
  END IF;

  SELECT count(*) INTO v_jobs FROM cron.job WHERE jobname = 'sync-roteirizador-ponte';
  IF v_jobs <> 1 THEN
    RAISE EXCEPTION 'Esperado exatamente 1 job sync-roteirizador-ponte, encontrado %', v_jobs;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.roteirizador_ponte_cursor WHERE id = 1) THEN
    RAISE EXCEPTION 'cursor singleton ausente';
  END IF;
END $$;
