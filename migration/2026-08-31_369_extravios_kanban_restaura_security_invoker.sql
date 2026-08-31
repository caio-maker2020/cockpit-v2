-- =============================================================================
-- 2026-08-31_369 — v_extravios_kanban voltou a rodar como DONA (RLS ignorada)
-- =============================================================================
-- TIPO B (docs/POLITICA_MIGRATIONS.md): muda enforcement de RLS de objeto JA
-- existente. Aplicada sob autonomia declarada pelo Carlos em 2026-08-31,
-- tratada como INCIDENTE (havia exposicao ativa de dado de cliente).
--
-- SINTOMA (operacao, 31/08/2026): na aba Extravios TODOS os operadores viam os
-- extravios de TODOS os clientes (196 NFs). Primeira vez que ocorre.
--
-- CAUSA RAIZ CONFIRMADA: a mig 367 (2026-08-28, commit d5e5a96, aplicada
-- 14:52Z) recriou a view com
--     CREATE OR REPLACE VIEW public.v_extravios_kanban AS ...
-- SEM repetir `WITH (security_invoker = on)`. Esse comando SUBSTITUI as
-- reloptions em bloco — nao as preserva. A view passou a executar com os
-- privilegios da DONA (`postgres`, rolbypassrls=true) e a RLS de `cards`
-- deixou de ser avaliada.
--
-- Cadeia de evidencia (verificada em producao em 2026-08-31):
--   a) pg_class.reloptions da view = NULL; a irma v_prioridades_ai = {security_invoker=on};
--   b) pg_get_viewdef contem 'extravio_retomado_pos43' — string que so existe na mig 367,
--      logo o objeto em prod E o que a 367 criou;
--   c) migs 213/215/256/257 TODAS traziam WITH (security_invoker = on);
--   d) RLS de cards intacta: relrowsecurity=true, policies cards_select_role e
--      cards_select_visibilidade integras — nao foi a RLS que quebrou;
--   e) o front NUNCA filtrou, por desenho: Extravios.tsx:56-60 e
--      prompts/lovable-aba-extravios.md:140-142 fazem select('*') cru.
--
-- SEGUNDO SINTOMA, MESMA CAUSA (achado 31/08, nao estava no report da operacao):
-- a chave `anon` (publica, embarcada no bundle do front) lia a view INTEIRA sem
-- login — NF, CTRC, razao social, base de destino, instrucao da ocorrencia.
--   GET /rest/v1/v_extravios_kanban  com anon -> 200 + linhas
--   GET /rest/v1/v_prioridades_ai    com anon -> 200 + []        (controle)
-- Mesma chave, mesmos grants (anon tem SELECT nas duas — default privilege
-- padrao do Supabase, NAO concedido pela 367). A unica variavel e o
-- security_invoker. Nao sao dois bugs: sao dois sintomas de "a RLS nao roda".
--
-- POR QUE `ALTER VIEW` E NAO `CREATE OR REPLACE VIEW ... WITH (...)`:
-- deliberado. ALTER VIEW SET nao toca na DEFINICAO — colunas, lanes D1..D4,
-- NAO_RODOU, relogio pos-43 da mig 367 e ORDER BY ficam byte a byte iguais.
-- Reescrever a definicao seria repetir exatamente o gesto que causou o bug.
--
-- SIMULACAO PRE-APLICACAO (producao, 31/08): dos 196 cards do kanban, CADA UM
-- casa com EXATAMENTE 1 operador nao-gestor. Zero orfaos (ninguem perde card),
-- zero cards visiveis a 2+ operadores (sem residuo de vazamento).
--   DUILIO 44 · FELIPE 30 · VICTOR 21 · ISABELY 21 · KAROLINE 20 · JULIA 19 ·
--   INGRID 18 · MARIA 12 · LARISSA 11  = 196
--
-- NAO REGRIDE O ROBO: agente-extravio-d4/index.ts:147 le a view com
-- SUPABASE_SERVICE_ROLE_KEY, e service_role tem rolbypassrls=true — continua
-- enxergando os 196. Gestores (papel='gestor') seguem vendo tudo: e o primeiro
-- OR das duas policies de SELECT.
--
-- NAO TOCA DADO: sem INSERT/UPDATE/DELETE. Historico, status e conteudo dos
-- extravios ficam intactos. Reversao: ALTER VIEW ... RESET (security_invoker).
--
-- FORA DE ESCOPO (registrado pro Caio decidir em separado): outras 5 views
-- estao com reloptions NULL — v_agent_feedback_unificado,
-- v_agent_feedback_unificado_legado, v_fatias_candidatas_autonomia,
-- v_placar_agente, v_placar_agente_erros. Algumas podem ser agregadas de gestor
-- por desenho. Esta migration NAO mexe nelas.
--
-- skill: supabase-postgres-best-practices (sem SECURITY DEFINER novo, sem
-- alterar grants, sem tocar definicao, idempotente). Sem BEGIN/COMMIT (13/08).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. O fix: devolve o enforcement pra RLS de `cards`.
--    Idempotente — reaplicar nao muda nada.
-- ---------------------------------------------------------------------------
ALTER VIEW public.v_extravios_kanban SET (security_invoker = on);

-- ---------------------------------------------------------------------------
-- 2. Ancora contra a proxima recriacao.
--    `pg_get_viewdef` NAO imprime a clausula WITH — quem copiar a definicao de
--    la pra fazer CREATE OR REPLACE derruba o atributo de novo e nao percebe,
--    porque tudo o mais continua funcionando. Foi exatamente o que houve na 367.
-- ---------------------------------------------------------------------------
COMMENT ON VIEW public.v_extravios_kanban IS
  'Kanban EXTRAVIOS. Cards state=EXTRAVIO_MONITORADO + oc in (6,9,16), mais o '
  'pos-43 devolvido (agent_state.extravio_retomado_pos43, mig 367). '
  'coluna_kanban = D1..D4 por dias uteis + lane NAO_RODOU. '
  '>>> security_invoker=on E OBRIGATORIO: e ele que faz a RLS de `cards` valer '
  'e cada operador ver so os seus. SEM ele a view roda como a dona (postgres, '
  'bypassrls), TODOS os operadores veem TODOS os extravios e ate a chave anon '
  'le a tabela inteira sem login. Ja aconteceu: mig 367 recriou sem o WITH e '
  'a mig 369 restaurou. AO RECRIAR ESTA VIEW, REPETIR SEMPRE '
  'WITH (security_invoker = on) — pg_get_viewdef nao mostra essa clausula. '
  'Guard: INV-121 do /verify-cockpit.';

-- ---------------------------------------------------------------------------
-- 3. Pos-checks — abortam a migration se o fix nao pegou.
--    Bloco unico: ou tudo passa, ou o DO levanta excecao.
-- ---------------------------------------------------------------------------
DO $mig369$
DECLARE
  v_opts    text;
  v_defrs   boolean;
  v_rls     boolean;
  v_pol     int;
  v_orfaos  int;
  v_multi   int;
  v_total   int;
BEGIN
  -- (a) o atributo esta la
  SELECT coalesce(reloptions::text, '') INTO v_opts
    FROM pg_class WHERE oid = 'public.v_extravios_kanban'::regclass;
  IF v_opts !~ 'security_invoker=(on|true)' THEN
    RAISE EXCEPTION 'STOP pos-check a: v_extravios_kanban sem security_invoker (reloptions=%)', v_opts;
  END IF;

  -- (b) a definicao NAO mudou: as marcas da mig 367 continuam la
  SELECT pg_get_viewdef('public.v_extravios_kanban'::regclass) LIKE '%extravio_retomado_pos43%'
     AND pg_get_viewdef('public.v_extravios_kanban'::regclass) LIKE '%NAO_RODOU%'
    INTO v_defrs;
  IF NOT v_defrs THEN
    RAISE EXCEPTION 'STOP pos-check b: a definicao da view mudou — esta migration so pode mexer em reloptions';
  END IF;

  -- (c) a RLS de cards, que agora volta a valer, esta de pe
  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = 'public.cards'::regclass;
  SELECT count(*) INTO v_pol FROM pg_policy
   WHERE polrelid = 'public.cards'::regclass AND polcmd IN ('r','*');
  IF NOT v_rls OR v_pol < 2 THEN
    RAISE EXCEPTION 'STOP pos-check c: RLS de cards fraca (rls=%, policies SELECT=%) — o invoker nao teria o que aplicar', v_rls, v_pol;
  END IF;

  -- (d) NINGUEM PERDE CARD: todo card do kanban tem pelo menos 1 operador
  --     nao-gestor que o enxerga pela policy (dono OU pagador na carteira OU
  --     segmento). Orfao aqui significaria card sumindo da tela de todo mundo.
  -- (e) SEM VAZAMENTO RESIDUAL: nenhum card visivel a 2+ operadores nao-gestor
  --     — e isso que responde "a visao ficou separada por operador".
  WITH alvo AS (
    SELECT v.card_id, c.assigned_operator_id, c.pagador, c.segmento_codigo
      FROM public.v_extravios_kanban v
      JOIN public.cards c ON c.id = v.card_id
  ), vis AS (
    SELECT a.card_id,
           count(*) FILTER (
             WHERE o.id = a.assigned_operator_id
                OR a.pagador        = ANY (o.carteira)
                OR a.segmento_codigo = ANY (o.segmentos)
           ) AS n_ops
      FROM alvo a
      CROSS JOIN public.operadores o
     WHERE o.ativo AND o.cockpit_ativo AND o.papel <> 'gestor'
     GROUP BY a.card_id
  )
  SELECT count(*) FILTER (WHERE n_ops = 0),
         count(*) FILTER (WHERE n_ops > 1),
         count(*)
    INTO v_orfaos, v_multi, v_total
    FROM vis;

  IF v_orfaos > 0 THEN
    RAISE EXCEPTION 'STOP pos-check d: % card(s) de extravio sem NENHUM operador que os enxergue — sumiriam da tela', v_orfaos;
  END IF;
  IF v_multi > 0 THEN
    RAISE EXCEPTION 'STOP pos-check e: % card(s) visiveis a 2+ operadores nao-gestor — visao NAO ficou separada por operador', v_multi;
  END IF;

  RAISE NOTICE 'mig 369 OK: security_invoker restaurado; % cards no kanban, 1 operador cada (0 orfaos, 0 compartilhados)', v_total;
END $mig369$;
