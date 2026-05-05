-- ============================================================================
-- Cockpit v2 — Adiciona 'cancelado' ao check constraint de todos.status
-- Data: 2026-05-04
--
-- Bug: migrations 038 (multi_propostas_e_rpcs) e 041 (aviso_alteracao_oc)
-- introduziram lógica que faz UPDATE todos SET status='cancelado' (quando
-- aprovar_e_executar cancela outros pendentes, voltar_para_to_do cancela
-- todos, marcar_retorno_inconclusivo cancela todos), mas esqueceram de
-- atualizar o CHECK constraint que listava só:
--   ['pendente', 'aprovado', 'executando', 'executado', 'rejeitado', 'falhou', 'expirado']
--
-- Resultado: Larissa aprovava oc=54 e RPC quebrava com
--   "violates check constraint todos_status_check"
--
-- Fix: drop + recria o check incluindo 'cancelado'.
-- ============================================================================

ALTER TABLE public.todos DROP CONSTRAINT IF EXISTS todos_status_check;

ALTER TABLE public.todos ADD CONSTRAINT todos_status_check
  CHECK (status = ANY (ARRAY[
    'pendente'::text,
    'aprovado'::text,
    'executando'::text,
    'executado'::text,
    'rejeitado'::text,
    'cancelado'::text,
    'falhou'::text,
    'expirado'::text
  ]));
