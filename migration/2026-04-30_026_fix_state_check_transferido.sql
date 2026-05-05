-- ============================================================================
-- Cockpit v2 — Fix: CHECK constraint cards_state_check sem TRANSFERIDO/TRATATIVA
-- Data: 2026-04-30
--
-- Bug: A migration 023 introduziu os states 'TRANSFERIDO' e 'TRATATIVA_PENDENTE'
-- mas esqueceu de atualizar o CHECK constraint `cards_state_check`. Por isso
-- todo UPDATE em cards.state pra esses dois valores falhava silenciosamente
-- com erro 23514 (check_violation).
--
-- Sintoma observado: 11 cards stuck em AGUARDANDO_AGENTE com até 20 tentativas
-- de release registradas em card_events (event_type='DevolvidoParaSetor') sem
-- nenhum efeito no state. O Pass B do sync-bastao tentava releaseCard, o
-- INSERT card_events ia, mas o UPDATE cards.state explodia. Erro engolido
-- pelo errors.push() do loop.
--
-- Pior caso real: NF 342756 — Larissa lançou oc 55 (Operação) no Bastão, o
-- card devia sair da visão dela mas continuou em "PARA FAZER" porque o state
-- nunca virou TRANSFERIDO.
--
-- Correção: DROP + ADD constraint com a lista completa de states. Após
-- aplicar, invocar sync-bastao manualmente desbloqueia os 11 cards stuck
-- (Pass B vai conseguir UPDATE com a oc real do Bastão).
-- ============================================================================

ALTER TABLE public.cards
  DROP CONSTRAINT IF EXISTS cards_state_check;

ALTER TABLE public.cards
  ADD CONSTRAINT cards_state_check
  CHECK (state = ANY (ARRAY[
    'RECEBIDO'::text,
    'EM_TRIAGEM'::text,
    'AGUARDANDO_VINCULACAO'::text,
    'AGUARDANDO_CONTEXTO'::text,
    'AGUARDANDO_AGENTE'::text,
    'EM_EXECUCAO_AUTOMATICA'::text,
    'AGUARDANDO_VALIDACAO_HUMANA'::text,
    'EXECUTANDO_ACAO'::text,
    'AGUARDANDO_CLIENTE'::text,
    'AGUARDANDO_TERCEIRO'::text,
    'BLOQUEADO_POR_ERRO'::text,
    'ESCALADO_HUMANO'::text,
    'TRANSFERIDO'::text,
    'TRATATIVA_PENDENTE'::text,
    'RESOLVIDO'::text,
    'CANCELADO'::text
  ]));
