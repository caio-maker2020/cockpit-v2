-- ============================================================================
-- Cockpit v2 — Snapshot do histórico SSW dentro do card
-- Data: 2026-05-12
--
-- Caio 2026-05-12: feature "TRAZER HISTÓRICO SSW" — Larissa aperta botão no
-- card e o agente loga no SSW interno (sistema.ssw.inf.br, opção 101), busca
-- a NF do card e traz todas as ocorrências históricas pra dentro da aba
-- HISTÓRICO SSW. Útil pra inspeção rápida sem precisar abrir o SSW manualmente.
--
-- Schema:
--   - historico_ssw: jsonb array de ocorrências (cada uma com codigo, descricao,
--     instrucao, data, filial, usuario, tem_foto).
--   - historico_ssw_atualizado_em: timestamptz da última puxada — front mostra
--     "Atualizado há X min" e habilita botão "Atualizar".
-- ============================================================================

ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS historico_ssw jsonb,
  ADD COLUMN IF NOT EXISTS historico_ssw_atualizado_em timestamptz;

COMMENT ON COLUMN public.cards.historico_ssw IS
  'Caio 2026-05-12: snapshot do histórico de ocorrências do SSW (opção 101) pra '
  'essa NF. Array de objetos {codigo, descricao, instrucao, data, filial, '
  'usuario, tem_foto}. Atualizado via edge function puxar-historico-ssw-card.';

COMMENT ON COLUMN public.cards.historico_ssw_atualizado_em IS
  'Timestamp da última atualização do snapshot historico_ssw. Front mostra '
  '"Atualizado há X min" e habilita botão Atualizar.';
