-- =============================================================================
-- 2026-06-10 — UNIQUE parcial em cards_emails_outbound(todo_id)
-- =============================================================================
-- Contexto: NF 156022 (OVD/DUILIO) — bug `env is not defined` no executor
-- causou 3 retries do PGMQ + 1 re-aprovação pós-falha. Cliente recebeu 4
-- emails idênticos pra mesma proposta aprovada (mesmo todo_id eb11f2ee).
--
-- Regra: 1 email por todo_id, sempre. Guard no app (executor) +
-- constraint UNIQUE defensiva no banco. Se algum fluxo futuro tentar
-- inserir 2 emails pro mesmo todo_id, o DB rejeita com violação UNIQUE
-- e o app trata como "skip" (não-fatal).
--
-- UNIQUE parcial: WHERE todo_id IS NOT NULL — porque cobrar-cliente-aguardando,
-- enviar-retificacao-evidencia, responder-email-cliente escrevem em
-- cards_emails_outbound SEM todo_id (fluxos avulsos sem to-do na fila).
-- Esses NULLs ficam fora da constraint (rule query-partial-indexes do
-- Supabase Postgres best practices: partial index ignora rows que não
-- precisam de proteção).
-- =============================================================================

-- 1. Limpa duplicatas históricas: pra cada todo_id com >1 envio, mantém
-- o MAIS ANTIGO (primeiro email que de fato saiu) e desassocia o todo_id
-- dos demais (seta NULL). Preserva histórico Gmail completo (gmail_message_id
-- continua UNIQUE), só perde o link to-do→email dos retries falsos.

WITH duplicatas AS (
  SELECT
    id,
    todo_id,
    ROW_NUMBER() OVER (PARTITION BY todo_id ORDER BY sent_at ASC, id ASC) AS rn
  FROM public.cards_emails_outbound
  WHERE todo_id IS NOT NULL
)
UPDATE public.cards_emails_outbound o
SET todo_id = NULL
FROM duplicatas d
WHERE o.id = d.id
  AND d.rn > 1;

-- 2. Sanity: garante que não restou duplicata.
DO $$
DECLARE
  remanescentes int;
BEGIN
  SELECT COUNT(*) INTO remanescentes
  FROM (
    SELECT todo_id
    FROM public.cards_emails_outbound
    WHERE todo_id IS NOT NULL
    GROUP BY todo_id
    HAVING COUNT(*) > 1
  ) q;

  IF remanescentes > 0 THEN
    RAISE EXCEPTION 'Ainda há % todo_id(s) com email duplicado — backfill incompleto, abortando criação do UNIQUE', remanescentes;
  END IF;
END $$;

-- 3. UNIQUE parcial. CONCURRENTLY pra não travar writes da tabela durante
-- o build (Supabase Postgres rule lock-create-index-concurrently).
-- NOTE: CREATE INDEX CONCURRENTLY não pode rodar dentro de transaction block.
-- Se aplicar via psql -f, rode com `\set ON_ERROR_STOP on` e SEM BEGIN/COMMIT.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  cards_emails_outbound_todo_id_unique
ON public.cards_emails_outbound (todo_id)
WHERE todo_id IS NOT NULL;

COMMENT ON INDEX public.cards_emails_outbound_todo_id_unique IS
  '2026-06-10 (NF 156022): garante 1 email por todo_id. Guard de segunda camada — '
  'app (executor) já faz check antes de sendGmailMessage via _shared/email-idempotencia.ts. '
  'Parcial pra ignorar registros sem todo_id (cobrar-cliente-aguardando, enviar-retificacao-evidencia).';
