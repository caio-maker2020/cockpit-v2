-- =============================================================================
-- 2026-10-08_442 — Semente dos membros da Operação vindos do Pendências (ADR 0042).
-- GERADA por scripts/gerar-semente-membros-operacao.ts a partir de: planilha vazia (aguardando o export da Sal)
-- Casa cada pessoa com auth.users pelo e-mail (minúsculas). Quem não tem login no Cockpit NÃO
-- é criado (nem login, nem senha): fica em op_membros_semente com status 'pendente'.
-- Idempotente: ON CONFLICT (user_id) DO NOTHING — nunca sobrescreve um cadastro feito à mão.
-- DEPENDÊNCIAS: 430 (operacao_membros) e 441 (setores, gerente_op).
-- CLASSIFICAÇÃO: TIPO B. AUTORIZACAO: "<quem>, <quando>: <ordem/motivo>" (--autorizado-por).
-- REVERSÃO: DELETE FROM public.operacao_membros WHERE criado_por = 'semente_pendencias_442';
--           DROP TABLE IF EXISTS public.op_membros_semente;
-- Ficaram de fora da planilha:
--   (nenhum)
-- ⚠ NÃO APLICADA. ⚠ SEM BEGIN/COMMIT interno.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.op_membros_semente (
  email       text PRIMARY KEY CHECK (email = lower(btrim(email))),
  nome        text NOT NULL,
  papel_op    text NOT NULL CHECK (papel_op IN ('operador_op', 'supervisor_op', 'gerente_op')),
  setores     text[] NOT NULL,
  unidades    text[] NOT NULL DEFAULT '{}',
  pode_lancar boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'cadastrado', 'ja_existia')),
  fonte       text NOT NULL DEFAULT 'Pendências (export da Sal)',
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.op_membros_semente ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.op_membros_semente FROM anon, authenticated;

-- Planilha vazia: regenere este arquivo com o export da Sal antes de aplicar.

-- Casa pelo e-mail e cadastra quem já tem login no Cockpit.
WITH casados AS (
  SELECT s.*, u.id AS user_id
    FROM public.op_membros_semente s
    JOIN auth.users u ON lower(u.email) = s.email
), ins AS (
  INSERT INTO public.operacao_membros (user_id, nome, email, papel_op, setores, unidades, pode_lancar, criado_por)
  SELECT user_id, nome, email, papel_op, setores, unidades, pode_lancar, 'semente_pendencias_442' FROM casados
  ON CONFLICT (user_id) DO NOTHING
  RETURNING email
)
UPDATE public.op_membros_semente s
   SET status = CASE WHEN s.email IN (SELECT email FROM ins) THEN 'cadastrado' ELSE 'ja_existia' END,
       atualizado_em = now()
 WHERE s.email IN (SELECT email FROM casados);

-- Conferência (leitura): quem ficou pendente por não ter login no Cockpit.
-- SELECT email, papel_op, setores, unidades FROM public.op_membros_semente WHERE status = 'pendente';
