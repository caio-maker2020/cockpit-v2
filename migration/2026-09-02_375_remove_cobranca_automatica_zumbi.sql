-- =============================================================================
-- 2026-09-02_375_remove_cobranca_automatica_zumbi.sql
--
-- Cancela as acoes_agendadas tipo='cobranca_email' pendentes (zumbis) e
-- registra card_event por card. Complemento retroativo do fix de código
-- (executor deixa de AGENDAR; processar-acoes-agendadas deixa de PROCESSAR e
-- cancela qualquer sobra). Mesmo desenho da mig 168 (26/05).
--
-- Por quê: a mig 168 desligou só o produtor por cron. O executor continuou
-- agendando cobrança D+4 (e-mail inline, "enviado manual" e relançamento da
-- 54) e o processador continuou consumindo: sem contato de e-mail, lançava
-- erro e a ação ficava pendente pra sempre — retry a cada 5 min. Medido em
-- 02/09: 20 pendentes (27/08→02/09), 14.542 eventos CobrancaAdiadaSemContato
-- em 10 dias, 2.634 em 24h sobre 9 cards (NFs 9463, 376592, 50543, 56846,
-- 157516, 779852, 88000, 955150, 684248).
--
-- TIPO B (UPDATE em dado de produção). AUTORIZAÇÃO: Caio, 2026-09-02, sessão
-- Claude Code, literal: "a cobranca nao pode voltar e nao sera automatizada" +
-- "ja pode corrigir de uma vez". ADR 0020.
--
-- Idempotente. SEM BEGIN/COMMIT interno. Reversão: não há (dado cancelado
-- administrativamente fica cancelado; os eventos ficam — INV-047).
-- =============================================================================

DO $$
DECLARE v_pend int;
BEGIN
  SELECT count(*) INTO v_pend FROM public.acoes_agendadas WHERE tipo = 'cobranca_email' AND status = 'pendente';
  RAISE NOTICE 'mig 375: % cobranca_email pendentes antes', v_pend;
END $$;

WITH cancelados AS (
  UPDATE public.acoes_agendadas
     SET status = 'cancelado',
         cancelado_motivo = 'Caio 2026-09-02: cobrança automática REMOVIDA (ADR 0020). Produtor no executor e consumidor no processador retirados; a mig 168 só tinha desligado o cron.',
         processed_at = now()
   WHERE tipo = 'cobranca_email' AND status = 'pendente'
  RETURNING id, card_id
)
INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT card_id,
       'CobrancaAutomaticaCancelada',
       'system',
       'admin-cancel-2026-09-02',
       jsonb_build_object('acao_id', id, 'motivo', 'Cobrança automática removida (ADR 0020). Decisão Caio 2026-09-02.')
  FROM cancelados;

DO $$
DECLARE v_pend int;
BEGIN
  SELECT count(*) INTO v_pend FROM public.acoes_agendadas WHERE tipo = 'cobranca_email' AND status = 'pendente';
  IF v_pend <> 0 THEN RAISE EXCEPTION 'mig 375: ainda há % cobranca_email pendentes', v_pend; END IF;
  RAISE NOTICE 'mig 375 OK — zero cobranca_email pendentes';
END $$;
