-- =============================================================================
-- 2026-09-21_405_gestao_op_timeout_proprio_rpc.sql
--
-- Caio 21/09 ("ainda está dando timeout", banner 57014 na Gestão Operadores):
-- pg_stat_statements mostrou a chamada real da RPC (envelope PostgREST) com
-- média 3,7s e MÁXIMO 7,5s — encostada no statement_timeout de 8s do role
-- authenticated; em carga, cancela (57014) e a página mostra o banner.
--
-- Parte 1 do fix (rede de segurança): a função ganha teto PRÓPRIO de 30s —
-- vale só DENTRO dela (SET por função), zero efeito no resto do sistema.
-- Parte 2 (mig 406) ataca a raiz com índice parcial pros lookups da view.
-- Sem BEGIN/COMMIT (padrão do projeto). Não toca cron/trigger.
-- =============================================================================

alter function public.gestao_operadores_tratativas(date)
  set statement_timeout = '30s';

comment on function public.gestao_operadores_tratativas(date) is
  'Mig 349: fonte da aba Gestão Operadores. Security definer com trava de gestor; devolve jsonb. '
  'Mig 405 (Caio 21/09): statement_timeout PRÓPRIO de 30s — a chamada real batia 7,5s (pg_stat_statements) '
  'e cancelava no teto de 8s do authenticated; mig 406 ataca a raiz (índice parcial dos lookups).';
