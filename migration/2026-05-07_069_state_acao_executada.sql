-- ============================================================================
-- Cockpit v2 — State ACAO_EXECUTADA: card congelado até Bastão confirmar
-- Data: 2026-05-07
--
-- Regra Caio 2026-05-07: SEMPRE QUE A AÇÃO FOR EXECUTADA CONFORME COMANDO DA
-- OPERADORA, E SE EXECUTADO CORRETAMENTE, O CARD FICA EM ACAO_EXECUTADA ATÉ
-- O BASTÃO SINCRONIZAR E CONFIRMAR A OC LANÇADA. Não pode voltar pra
-- AGUARDANDO_VOCE no meio.
--
-- Liberação: Pass A do sync-bastao reconhece quando Bastão.oc == card.oc e
-- transita pro state final (54 → AGUARDANDO_CLIENTE; finalizadora → RESOLVIDO;
-- outras → TRANSFERIDO). NÃO há timer cego.
--
-- 1h é apenas alerta visual no front (banner amarelo "Bastão atrasado") —
-- card permanece em ACAO_EXECUTADA até confirmação real.
--
-- Caso real (NF 196537): Larissa aprovou oc=54 sem email. Bastão atrasado
-- regrediu card pra AGUARDANDO_VOCE. Larissa não percebeu, aprovou de novo
-- + email — mandou 2x pro cliente. Bug evitado pelo state ACAO_EXECUTADA
-- bloqueando aprovação até Bastão confirmar.
-- ============================================================================

-- 1. Adiciona ACAO_EXECUTADA ao constraint do state
ALTER TABLE public.cards DROP CONSTRAINT IF EXISTS cards_state_check;
ALTER TABLE public.cards ADD CONSTRAINT cards_state_check
  CHECK (state = ANY (ARRAY[
    'RECEBIDO',
    'EM_TRIAGEM',
    'AGUARDANDO_VINCULACAO',
    'AGUARDANDO_CONTEXTO',
    'AGUARDANDO_AGENTE',
    'EM_EXECUCAO_AUTOMATICA',
    'AGUARDANDO_VALIDACAO_HUMANA',
    'EXECUTANDO_ACAO',
    'ACAO_EXECUTADA',          -- novo (Caio 2026-05-07)
    'AGUARDANDO_CLIENTE',
    'AGUARDANDO_TERCEIRO',
    'BLOQUEADO_POR_ERRO',
    'ESCALADO_HUMANO',
    'TRANSFERIDO',
    'TRATATIVA_PENDENTE',
    'RESOLVIDO',
    'CANCELADO'
  ]));

-- 2. Coluna pra controlar quanto tempo está esperando Bastão confirmar
ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS acao_executada_em timestamptz;

CREATE INDEX IF NOT EXISTS idx_cards_acao_executada_pendente
  ON public.cards (acao_executada_em)
  WHERE state = 'ACAO_EXECUTADA';

COMMENT ON COLUMN public.cards.acao_executada_em IS
  'Caio 2026-05-07: timestamp do lançamento bem-sucedido pelo Cockpit. '
  'Card permanece em state=ACAO_EXECUTADA até Bastão confirmar a oc; '
  'após 1h sem confirmação, front mostra alerta "Bastão atrasado".';
