-- =============================================================================
-- 2026-08-24_349_gestao_op_timeout_indice_e_rpc.sql
--
-- FIX do timeout da GESTÃO OPERADORES (Caio 24/08): a aba mostrava o banner
-- enganoso "migration 344 não aplicada" porque v_operador_tratativas passou a
-- demorar 9,5-18s e o role authenticated tem statement_timeout=8s (57014).
--
-- Atribuição medida (EXPLAIN ANALYZE em prod, 24/08):
--   - 13,2s dos 18s = lateral `oce` (oc_entrada, mig 347): backward scan em
--     card_events (654MB / ~1M eventos) lendo tuplas largas até achar 1 dos
--     5 tipos de evento do Bastão — por âncora, ×7.519 âncoras em 90d.
--   - RLS por linha (security_invoker) somava ~6s (9,5s gestor × ~3s postgres).
--   - paginarTudo re-executava a view inteira a cada página (~8 páginas).
--
-- Fix na raiz (2 peças):
--   1. Índice PARCIAL nos 9 tipos de evento usados pelas 2 laterais da view
--      (~92k linhas ≈ 9% da tabela) → cada lateral vira descida direta.
--      CONCURRENTLY: não bloqueia o executor/agentes escrevendo card_events.
--   2. RPC gestao_operadores_tratativas(p_dia_inicio): security definer com
--      TRAVA de gestor — computa a janela UMA vez (sem re-execução por página,
--      sem teto de 1000 do PostgREST — devolve jsonb), janela = período pedido
--      (o filtro em tratado_em empurra pro índice da âncora; a view sozinha
--      sempre varria 90d mesmo pro filtro de 7).
--
-- meu_dashboard_operacao (Seu Dashboard) lê a mesma view → ganha do índice.
-- SEM begin/commit interno (lição da mig 337; CONCURRENTLY exige autocommit).
-- Pós-aplicação: conferir `select indisvalid from pg_index where indexrelid =
-- 'idx_card_events_entrada_lookup'::regclass;` — CONCURRENTLY que falha deixa
-- índice INVALID (aí: drop + recriar).
-- =============================================================================

create index concurrently if not exists idx_card_events_entrada_lookup
  on public.card_events (card_id, created_at desc)
  where event_type in (
    -- lateral oce (oc_entrada — payload do Bastão)
    'BastaoCardImportado', 'BastaoCardAtualizado', 'AguardandoClienteOcMudou',
    'CardReaberto', 'RetornoIntranetWurth',
    -- lateral ent (entrada na fila) — tipos que ainda não estão acima
    'TodoPropostoAutomaticamente', 'RespostaClienteCapturada',
    'RetornoClienteEmAguardo', 'CardReabertoPorRespostaCliente'
  );

comment on index public.idx_card_events_entrada_lookup is
  'Mig 349: cobre as 2 laterais de v_operador_tratativas (entrada na fila + oc_entrada). Parcial: ~9% de card_events. Predicados das laterais são subconjuntos da lista — o planner prova e usa.';

-- ─── RPC: uma execução, sem RLS por linha, janela do período pedido ──────────
create or replace function public.gestao_operadores_tratativas(p_dia_inicio date)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_resultado jsonb;
  v_inicio date;
begin
  if public.current_operador_papel() is distinct from 'gestor' then
    raise exception 'Só gestão pode ver as tratativas de todos os operadores';
  end if;

  -- nunca além dos 90d da view (teto), nunca antes do pedido
  v_inicio := greatest(p_dia_inicio, ((now() at time zone 'America/Sao_Paulo')::date - 90));

  -- filtro em tratado_em (= a.created_at cru) empurra pro índice da âncora;
  -- o filtro em dia (coluna computada com AT TIME ZONE) não empurraria.
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
    into v_resultado
  from public.v_operador_tratativas t
  where t.dia > v_inicio
    and t.tratado_em > ((v_inicio::timestamp - interval '1 day') at time zone 'America/Sao_Paulo');

  return v_resultado;
end;
$$;

comment on function public.gestao_operadores_tratativas(date) is
  'Mig 349: fonte da aba Gestão Operadores. Security definer (sem custo de RLS por linha) com trava de gestor; devolve jsonb (sem teto de 1000 linhas do PostgREST, sem re-execução por página). Substitui o select paginado direto na view, que estourava o statement_timeout de 8s.';

revoke execute on function public.gestao_operadores_tratativas(date) from public, anon;
grant execute on function public.gestao_operadores_tratativas(date) to authenticated;
