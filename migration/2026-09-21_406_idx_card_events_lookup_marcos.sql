-- =============================================================================
-- 2026-09-21_406_idx_card_events_lookup_marcos.sql
--
-- Parte 2 do fix do timeout da Gestão Operadores (raiz). O EXPLAIN da
-- v_operador_tratativas (30d) mostrou 2×8.384 probes laterais em card_events
-- ("último evento-marco antes da tratativa") usando índice (card_id,
-- created_at) SEM predicado — cada probe varre eventos irrelevantes (Historico
-- SswPuxado etc., a maioria da tabela) e busca heap até achar um tipo-marco.
-- Execution: 3,27s só na view.
--
-- Índice PARCIAL com a UNIÃO das duas listas de tipos-marco das laterals
-- (oce: 5 tipos · ent: 8 tipos; união = 9) + INCLUDE(event_type) pro lookup
-- `ent` sair index-only. O planner prova IN ⊂ IN e usa o parcial nas duas.
-- CONCURRENTLY: não trava a tabela (dbq -f roda fora de transação).
-- Sem BEGIN/COMMIT. Não toca cron/trigger.
--
-- GUARD DE DRIFT: se as listas de event_types das laterals da view (mig 347)
-- mudarem, este predicado PRECISA acompanhar — senão o planner volta pro
-- índice genérico e a lentidão retorna silenciosamente.
-- =============================================================================

create index concurrently if not exists idx_card_events_lookup_marcos
  on public.card_events (card_id, created_at desc)
  include (event_type)
  where event_type in (
    'BastaoCardImportado','BastaoCardAtualizado','AguardandoClienteOcMudou',
    'CardReaberto','RetornoIntranetWurth',
    'TodoPropostoAutomaticamente','RespostaClienteCapturada',
    'RetornoClienteEmAguardo','CardReabertoPorRespostaCliente'
  );

comment on index public.idx_card_events_lookup_marcos is
  'Mig 406 (Caio 21/09): lookups laterais da v_operador_tratativas (oce/ent — último evento-marco '
  'antes da tratativa). Predicado = UNIÃO das listas das duas laterals da mig 347; se a view mudar '
  'as listas, atualizar aqui junto.';
