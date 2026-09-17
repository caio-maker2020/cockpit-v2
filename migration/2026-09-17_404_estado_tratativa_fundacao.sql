-- =============================================================================
-- 2026-09-17_404 — MEMÓRIA DO CARD (estado da tratativa) — F0 fundação
-- =============================================================================
-- Plano aprovado pelo Caio 17/09 ("aprovado em branch separada"). Tudo nasce
-- INERTE: flags OFF, worker checa flag na 1ª linha, trigger só marca dirty
-- (mesmo UPDATE que já roda — custo ~zero). NADA muda de comportamento até as
-- flags ligarem, degrau a degrau, com ordem nominal.
-- TIPO A (aditiva + REPLACE do trigger de projeção preservando o corpo vigente
-- — definição base lida da PRODUÇÃO via pg_get_functiondef em 17/09).
-- Sem BEGIN. skill supabase-postgres-best-practices aplicada.
-- =============================================================================

-- ── colunas da memória ────────────────────────────────────────────────────────
ALTER TABLE public.cards ADD COLUMN IF NOT EXISTS estado_tratativa jsonb;
ALTER TABLE public.cards ADD COLUMN IF NOT EXISTS estado_tratativa_dirty_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_cards_estado_dirty
  ON public.cards (estado_tratativa_dirty_at)
  WHERE estado_tratativa_dirty_at IS NOT NULL;

-- ── trigger de projeção: MESMO update, agora marcando dirty nos eventos
--    relevantes (hub universal — cobre resposta, sync, execução, aprovação e
--    correções do operador sem tocar em nenhuma dessas lógicas) ───────────────
CREATE OR REPLACE FUNCTION public.project_card_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF NEW.card_id IS NOT NULL THEN
    UPDATE public.cards
    SET last_event_id = NEW.id,
        last_event_at = NEW.created_at,
        updated_at = now(),
        -- memória do card (mig 404): marca pra recompute; worker drena.
        estado_tratativa_dirty_at = CASE
          WHEN NEW.event_type IN (
            'BastaoCardImportado', 'ExtravioImportado',
            'BastaoReabriuNFFonteRelacionamento', 'CardReaberto',
            'CardReabertoPorRespostaCliente',
            'RetornoClienteEmAguardo',
            'HistoricoSswPuxado',
            'BastaoCardAtualizado', 'StateRecalculadoPorOc',
            'AcaoExecutadaConfirmadaPeloSsw', 'AcaoNaoConfirmadaPeloSsw',
            'AprovacaoOperador', 'AutoAprovacaoPermitida',
            'EstadoCorrigidoPeloOperador', 'InformacaoExternaRegistrada'
          ) THEN now()
          ELSE estado_tratativa_dirty_at
        END
    WHERE id = NEW.card_id;
  END IF;
  RETURN NEW;
END;
$function$;

-- ── claim atômico dos dirty (worker; SKIP LOCKED = sem corrida entre ticks) ──
CREATE OR REPLACE FUNCTION public.claim_estado_tratativa_dirty(p_limit int DEFAULT 20)
RETURNS SETOF uuid
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  UPDATE public.cards c
     SET estado_tratativa_dirty_at = NULL
   WHERE c.id IN (
     SELECT id FROM public.cards
      WHERE estado_tratativa_dirty_at IS NOT NULL
      ORDER BY estado_tratativa_dirty_at ASC
      LIMIT greatest(1, least(p_limit, 50))
      FOR UPDATE SKIP LOCKED
   )
  RETURNING c.id;
$$;
REVOKE ALL ON FUNCTION public.claim_estado_tratativa_dirty(int) FROM PUBLIC, anon, authenticated;
-- (service_role mantém o EXECUTE default — só o worker chama)

-- ── flags (TODAS OFF — a escada liga uma a uma com ordem nominal) ────────────
INSERT INTO public.feature_flags (key, enabled, description) VALUES
 ('estado_tratativa_worker_enabled', false,
  'Memória do card F1: worker recomputa cards dirty + backfill preguiçoso. OFF = coluna congelada.'),
 ('estado_tratativa_resumo_llm_enabled', false,
  'Memória do card F1: Haiku escreve o resumo/fatos de texto (só com texto novo). OFF = só determinístico.'),
 ('estado_no_prompt_interpretador', false,
  'Memória do card F3: bloco do estado entra no userPrompt do interpretador.'),
 ('estado_no_prompt_oc49', false,
  'Memória do card F3: bloco do estado entra no prompt da oc49 (ligar = bump VERSAO_REGRAS_ANALISE, horário calmo).'),
 ('estado_prompt_sombra_enabled', false,
  'Memória do card F3: numa fatia dos casos roda a 2ª chamada COM estado e grava o par (efeito sempre da oficial).'),
 ('cerca_estado_enforce', false,
  'Memória do card F3/F4: OFF = porteiro em log-only (anota, não bloqueia); ON = contradição barra o ARMAR do trilho.')
ON CONFLICT (key) DO NOTHING;

-- ── cron do worker (1/min; inerte com a flag OFF — edge sai na 1ª linha) ─────
SELECT cron.schedule(
  'atualizar-estado-tratativa-every-1min',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/atualizar-estado-tratativa',
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
  $$
);
