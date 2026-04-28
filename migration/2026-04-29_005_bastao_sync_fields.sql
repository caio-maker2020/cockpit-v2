-- ============================================================================
-- Cockpit v2 — Sync Bastão: campos novos em cards + status novos em todos
-- Data: 2026-04-29
-- Pré-condição: ADR 0004 (Cockpit é work queue do relacionamento, Bastão é
-- fonte de verdade).
-- ============================================================================

-- ============================================================================
-- todos.status — adiciona 'executando' e 'falhou'
-- ============================================================================
-- Ciclo de vida da ação proposta:
--   pendente → aprovado → executando → executado    (caminho feliz)
--                    └──→ rejeitado                  (humano disse não)
--                       executando → falhou          (timeout / erro)
--                       pendente  → expirado         (ninguém validou em X dias)

ALTER TABLE public.todos DROP CONSTRAINT todos_status_check;
ALTER TABLE public.todos ADD CONSTRAINT todos_status_check
  CHECK (status IN (
    'pendente',
    'aprovado',
    'executando',
    'executado',
    'rejeitado',
    'falhou',
    'expirado'
  ));

-- ============================================================================
-- cards — campos populados pelo sync Bastão
-- ============================================================================
-- bastao_pendencia_id: id da row do Bastão. NÃO é FK física (cross-database);
--   é referência lógica usada pra "casar" cards do Cockpit com pendências do
--   Bastão na hora do sync.
-- cod_ultima_ocorrencia: cópia local do Bastão.cod_ultima_ocorrencia. Usado
--   pra detectar transição "saiu da lista de relacionamento" → fechar card.
-- bastao_data_ultima_ocorrencia: data da ocorrência atual (Bastão).
-- bastao_synced_at: última vez que a sync atualizou o card a partir do Bastão.

ALTER TABLE public.cards
  ADD COLUMN bastao_pendencia_id uuid,
  ADD COLUMN cod_ultima_ocorrencia integer,
  ADD COLUMN bastao_data_ultima_ocorrencia date,
  ADD COLUMN bastao_synced_at timestamptz;

-- Cada pendência do Bastão deve estar em no máximo 1 card ativo no Cockpit.
-- Estados terminais (RESOLVIDO, CANCELADO) não bloqueiam — quando reabrir,
-- o sync usa o card existente em vez de criar novo.
CREATE UNIQUE INDEX uniq_cards_bastao_pendencia_active
  ON public.cards(bastao_pendencia_id)
  WHERE bastao_pendencia_id IS NOT NULL
    AND state NOT IN ('RESOLVIDO', 'CANCELADO');

-- Lookup rápido por código de ocorrência (pass B do sync = release).
CREATE INDEX idx_cards_cod_ocorrencia
  ON public.cards(cod_ultima_ocorrencia)
  WHERE cod_ultima_ocorrencia IS NOT NULL;

-- Lookup rápido por sincronização recente (sync incremental no futuro).
CREATE INDEX idx_cards_bastao_synced_at
  ON public.cards(bastao_synced_at DESC)
  WHERE bastao_synced_at IS NOT NULL;

-- ============================================================================
-- COMMENT — documenta o significado dos campos pra quem ler o schema cru
-- ============================================================================
COMMENT ON COLUMN public.cards.bastao_pendencia_id IS
  'Referência lógica para Bastão.pendencias.id. NÃO é FK física — Bastão é '
  'banco externo. Atualizado pela Edge Function sync-bastao.';
COMMENT ON COLUMN public.cards.cod_ultima_ocorrencia IS
  'Cópia local de Bastão.cod_ultima_ocorrencia. Usado pra detectar transição '
  'pra fora da lista de relacionamento (16+54) e fechar card.';
COMMENT ON COLUMN public.cards.bastao_data_ultima_ocorrencia IS
  'Data da ocorrência mais recente registrada no Bastão.';
COMMENT ON COLUMN public.cards.bastao_synced_at IS
  'Última vez que sync-bastao atualizou esse card.';
