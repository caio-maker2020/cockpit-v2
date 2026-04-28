-- ============================================================================
-- Cockpit v2 — Filas pgmq (Supabase Queues)
-- Data: 2026-04-29
-- Pré-requisito: extensão pgmq habilitada no projeto Supabase.
--   No Studio: Database → Extensions → procurar "pgmq" → enable.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgmq;

-- agent_intake — mensagem recém-recebida pra triagem.
SELECT pgmq.create('agent_intake');

-- agent_specialist — card classificado e vinculado, pronto pra agente especialista.
SELECT pgmq.create('agent_specialist');

-- agent_executor — ação aprovada (ou auto-aprovada) pronta pra executor.
SELECT pgmq.create('agent_executor');

-- dead_letter — jobs que falharam acima do limite de retry. Inspeção manual.
SELECT pgmq.create('dead_letter');

-- Verificação rápida — em produção, rodar `select * from pgmq.list_queues();`.
