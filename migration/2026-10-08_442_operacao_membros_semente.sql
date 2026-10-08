-- =============================================================================
-- 2026-10-08_442 — Semente dos membros da Operação vindos do Pendências (ADR 0042).
-- GERADA por scripts/gerar-semente-membros-operacao.ts a partir de: planilha vazia (aguardando os setores de cada membro, do Pendências)
-- Acerta SETORES (e gerente_op) dos membros que JÁ existem em operacao_membros, casando pelo
-- e-mail. Não insere membro, não cria login nem senha: quem não casa fica 'pendente'.
-- Idempotente (UPDATE só quando muda). pode_lancar e unidades NÃO são tocados.
-- DEPENDÊNCIAS: 430 (operacao_membros) e 441 (setores, gerente_op).
-- CLASSIFICAÇÃO: TIPO B. AUTORIZACAO: "<quem>, <quando>: <ordem/motivo>" (--autorizado-por).
-- REVERSÃO: UPDATE public.operacao_membros SET setores = '{OPERACAO}' (e papel_op de volta, se preciso);
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

-- Os membros JÁ existem em operacao_membros (90 linhas cadastradas em 08/10, vindas do
-- Pendências). Esta semente NÃO insere ninguém: só acerta setores (e gerente_op) dos que casam
-- pelo e-mail. Quem não está em operacao_membros fica 'pendente' (nenhum login é criado).
WITH alvo AS (
  SELECT s.*, m.id AS membro_id
    FROM public.op_membros_semente s
    JOIN public.operacao_membros m ON lower(m.email) = s.email
), upd AS (
  UPDATE public.operacao_membros m
     SET setores = a.setores,
         papel_op = CASE WHEN a.papel_op = 'gerente_op' AND m.papel_op = 'operador_op' THEN 'gerente_op' ELSE m.papel_op END,
         updated_at = now()
    FROM alvo a
   WHERE m.id = a.membro_id
     AND (m.setores IS DISTINCT FROM a.setores OR (a.papel_op = 'gerente_op' AND m.papel_op = 'operador_op'))
  RETURNING lower(m.email) AS email
)
UPDATE public.op_membros_semente s
   SET status = CASE WHEN s.email IN (SELECT email FROM upd) THEN 'cadastrado' ELSE 'ja_existia' END,
       atualizado_em = now()
 WHERE s.email IN (SELECT email FROM alvo);

-- Conferência (leitura): quem ficou pendente por não ter login no Cockpit.
-- SELECT email, papel_op, setores, unidades FROM public.op_membros_semente WHERE status = 'pendente';
