-- =============================================================================
-- 2026-08-26_360 — RPC canonica `remanejar_cliente_operador`
-- =============================================================================
-- Diretriz Caio 2026-08-26: remanejo de cliente entre operadores e operacao de
-- ROTINA (vinculo incorreto acontece; o Bastao troca com 1 clique) e nao pode
-- exigir migration nova + autorizacao do Caio a cada vez. Esta migration
-- congela a receita das migs 288/301/333/359 numa FUNCAO unica do banco.
-- A partir dela, remanejo = `SELECT public.remanejar_cliente_operador(...)`,
-- executavel pelo CARLOS sem migration (politica: docs/POLITICA_MIGRATIONS.md
-- — remanejo VIA ESTA RPC e liberado; remanejo A MAO continua TIPO B/so Caio).
--
-- A funcao reproduz as 7 camadas da mig 359 (fonte da verdade da receita):
--   0. clientes            — segmento novo (OPCIONAL: so se informado)
--   1. operadores.carteira — remove de todos que nao sejam o destino, add
--   2. contatos_cliente.operador_responsavel_id     -> destino
--   3. tracking_credentials.operador_responsavel_id -> destino
--   4. acoes_agendadas (veto) — SEMPRE desarma acao autonoma armada: o dono
--      novo nunca viu a proposta e nao teve janela pra vetar (mesmo se ele
--      estiver no piloto, devolver pro humano e o conservador correto)
--   5. cards (TODOS, inclusive terminais — decisao Caio migs 333/359)
--      + card_event `OperadorReatribuido` por card, segmento_codigo = NULL
--      (RLS mig 242: senao o operador antigo segue vendo pelo branch de
--      segmento; padrao das migs 300/301/307/330/333/359)
--   6. alertas_operador NAO LIDOS dos cards movidos -> destino
-- ...e os pos-checks a..i + invariante global c da mig 359. Pos-check falhou
-- => EXCEPTION => a chamada INTEIRA reverte sozinha (funcao e atomica).
--
-- Guards de entrada: destino ativo+cockpit_ativo (INV-036b), motivo e
-- autorizado_por obrigatorios (trilha de auditoria), CNPJ desconhecido no
-- Cockpit e recusado (protecao contra digitacao errada; escape explicito
-- p_cliente_novo_ok => true).
--
-- PORTA LATERAL (nao verificavel no banco): o trigger
-- `resolve_assigned_operator_from_name` (mig 007/305) casa card novo por NOME
-- do SSW e nao consulta carteira. Trocar a especie/responsavel no SSW ANTES
-- de chamar a RPC e pre-requisito do OPERADOR HUMANO — a funcao devolve esse
-- lembrete no relatorio (`avisos`). Evidencia: SULMEDIC 17-19/08.
--
-- Seguranca: sem SECURITY DEFINER (roda com o role do chamador: postgres via
-- psql, ou service_role). REVOKE de PUBLIC/anon/authenticated — operador
-- logado no front NAO consegue chamar.
--
-- Idempotente (re-rodar com o mesmo destino => relatorio zerado). Sem
-- BEGIN/COMMIT interno (regra Caio 13/08). Guard anti-regressao: INV-108 no
-- /verify-cockpit. skill: supabase-postgres-best-practices.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.remanejar_cliente_operador(
  p_cnpj             text,
  p_operador_destino text,
  p_motivo           text,
  p_autorizado_por   text,
  p_segmento_codigo  text    DEFAULT NULL,
  p_segmento_nome    text    DEFAULT NULL,
  p_cliente_novo_ok  boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_cnpj    text;
  v_destino text;
  v_dest    uuid;
  v_nome    text;
  v_de      text[];
  v_avisos  text[] := ARRAY[
    'Confira que a especie/responsavel do cliente JA FOI trocada no SSW — sem isso, card novo sem dono volta pro operador antigo (trigger resolve_assigned_operator_from_name; caso SULMEDIC 17-19/08).'
  ];
  v_cont int; v_track int; v_veto int; v_cards int; v_alert int;
  v int;
BEGIN
  -- ---------------------------------------------------------------------------
  -- Guards de entrada
  -- ---------------------------------------------------------------------------
  IF length(regexp_replace(coalesce(p_cnpj,''),'\D','','g')) NOT IN (11,14) THEN
    RAISE EXCEPTION 'STOP: CNPJ/CPF invalido (% digitos): %',
      length(regexp_replace(coalesce(p_cnpj,''),'\D','','g')), p_cnpj;
  END IF;
  v_cnpj := lpad(regexp_replace(p_cnpj,'\D','','g'),14,'0');

  IF coalesce(trim(p_motivo),'') = '' THEN
    RAISE EXCEPTION 'STOP: p_motivo obrigatorio (por que o cliente esta trocando de operador)';
  END IF;
  IF coalesce(trim(p_autorizado_por),'') = '' THEN
    RAISE EXCEPTION 'STOP: p_autorizado_por obrigatorio (quem pediu a troca — ex.: CAIO, CARLOS)';
  END IF;
  IF (p_segmento_codigo IS NULL) <> (p_segmento_nome IS NULL) THEN
    RAISE EXCEPTION 'STOP: p_segmento_codigo e p_segmento_nome andam juntos (ou os dois, ou nenhum)';
  END IF;

  v_destino := upper(trim(p_operador_destino));
  SELECT id INTO v_dest FROM public.operadores
   WHERE nome = v_destino AND ativo AND cockpit_ativo;
  IF v_dest IS NULL THEN
    -- INV-036b: card vivo em operador dormente so aparece pro gestor
    RAISE EXCEPTION 'STOP: operador % inexistente ou nao esta ativo no Cockpit (ativo/cockpit_ativo)', v_destino;
  END IF;

  -- Protecao contra CNPJ digitado errado: precisa existir em algum lugar
  IF NOT p_cliente_novo_ok
     AND NOT EXISTS (SELECT 1 FROM public.clientes WHERE cnpj_cpf = v_cnpj)
     AND NOT EXISTS (SELECT 1 FROM public.operadores o
                     CROSS JOIN LATERAL unnest(coalesce(o.carteira,'{}'::text[])) x
                      WHERE lpad(regexp_replace(x,'\D','','g'),14,'0') = v_cnpj)
     AND NOT EXISTS (SELECT 1 FROM public.cards c
                      WHERE lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = v_cnpj
                         OR lpad(regexp_replace(coalesce(c.pagador,''),'\D','','g'),14,'0') = v_cnpj)
  THEN
    RAISE EXCEPTION 'STOP: CNPJ % desconhecido no Cockpit (nem clientes, nem carteira, nem cards). Digitacao errada? Se for cliente novo mesmo, chame com p_cliente_novo_ok => true.', v_cnpj;
  END IF;

  -- Nome do cliente pro evento/relatorio (catalogo > pagador com letras > cnpj)
  SELECT nome INTO v_nome FROM public.clientes WHERE cnpj_cpf = v_cnpj;
  IF v_nome IS NULL THEN
    SELECT c.pagador INTO v_nome FROM public.cards c
     WHERE lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = v_cnpj
       AND c.pagador ~ '[A-Za-z]'
     LIMIT 1;
  END IF;
  v_nome := coalesce(v_nome, v_cnpj);

  -- De quem o cliente esta saindo (pro relatorio)
  SELECT coalesce(array_agg(o.nome ORDER BY o.nome),'{}'::text[]) INTO v_de
    FROM public.operadores o
   WHERE o.id IS DISTINCT FROM v_dest
     AND EXISTS (SELECT 1 FROM unnest(coalesce(o.carteira,'{}'::text[])) x
                  WHERE lpad(regexp_replace(x,'\D','','g'),14,'0') = v_cnpj);

  -- ---------------------------------------------------------------------------
  -- 0. Catalogo (opcional): so mexe no segmento se ele foi informado.
  --    ON CONFLICT nao sobrescreve `nome` (fonte da verdade e o sync).
  -- ---------------------------------------------------------------------------
  IF p_segmento_codigo IS NOT NULL THEN
    INSERT INTO public.clientes (cnpj_cpf, nome, segmento_codigo, segmento_nome, ativo)
    VALUES (v_cnpj, v_nome, p_segmento_codigo, p_segmento_nome, true)
    ON CONFLICT (cnpj_cpf) DO UPDATE SET
      segmento_codigo = EXCLUDED.segmento_codigo,
      segmento_nome   = EXCLUDED.segmento_nome,
      ativo           = true;

    IF NOT EXISTS (SELECT 1 FROM public.operadores
                    WHERE id = v_dest
                      AND p_segmento_codigo = ANY(coalesce(segmentos,'{}'::text[]))) THEN
      v_avisos := v_avisos || format(
        'Segmento %s nao esta em operadores.segmentos de %s — nada quebra (a visao vem de assigned_operator_id), mas confira se o segmento e o certo.',
        p_segmento_codigo, v_destino);
    END IF;
  END IF;

  -- ---------------------------------------------------------------------------
  -- 1. Carteira: 1 CNPJ = 1 operador. Remove de todos menos o destino, add.
  --    Comparacao normalizada (lpad 14, mig 332); gravacao em 14 digitos puros
  --    (o operador-resolver casa por string exata).
  -- ---------------------------------------------------------------------------
  UPDATE public.operadores o
     SET carteira = coalesce(
       (SELECT array_agg(x ORDER BY x) FROM unnest(o.carteira) x
         WHERE lpad(regexp_replace(x,'\D','','g'),14,'0') <> v_cnpj),
       '{}'::text[])
   WHERE o.id IS DISTINCT FROM v_dest
     AND EXISTS (SELECT 1 FROM unnest(o.carteira) x
                  WHERE lpad(regexp_replace(x,'\D','','g'),14,'0') = v_cnpj);

  UPDATE public.operadores o
     SET carteira = (SELECT array_agg(DISTINCT c ORDER BY c)
                       FROM unnest(coalesce(o.carteira,'{}'::text[]) || ARRAY[v_cnpj]) c)
   WHERE o.id = v_dest
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(o.carteira,'{}'::text[])) x
                      WHERE lpad(regexp_replace(x,'\D','','g'),14,'0') = v_cnpj);

  -- ---------------------------------------------------------------------------
  -- 2. contatos_cliente
  -- ---------------------------------------------------------------------------
  UPDATE public.contatos_cliente
     SET operador_responsavel_id = v_dest, updated_at = now()
   WHERE lpad(regexp_replace(coalesce(documento_cliente,''),'\D','','g'),14,'0') = v_cnpj
     AND operador_responsavel_id IS DISTINCT FROM v_dest;
  GET DIAGNOSTICS v_cont = ROW_COUNT;

  -- ---------------------------------------------------------------------------
  -- 3. tracking_credentials (senha preservada — so troca o responsavel)
  -- ---------------------------------------------------------------------------
  UPDATE public.tracking_credentials
     SET operador_responsavel_id = v_dest, updated_by = v_dest, updated_at = now()
   WHERE lpad(regexp_replace(coalesce(documento,''),'\D','','g'),14,'0') = v_cnpj
     AND operador_responsavel_id IS DISTINCT FROM v_dest;
  GET DIAGNOSTICS v_track = ROW_COUNT;

  -- ---------------------------------------------------------------------------
  -- 4. Desarma janela de veto armada (SEMPRE — o dono novo nunca viu a
  --    proposta). Vocabulario do executor + evento canonico da Auditoria;
  --    o trigger trg_espelho_acao_autonoma limpa cards.acao_autonoma sozinho.
  -- ---------------------------------------------------------------------------
  WITH desarmadas AS (
    UPDATE public.acoes_agendadas ag
       SET status           = 'cancelado',
           cancelado_motivo = 'Cliente mudou de operador (remanejar_cliente_operador) — acao devolvida pro humano',
           processed_at     = now()
      FROM public.cards c
     WHERE c.id = ag.card_id
       AND ag.tipo = 'executar_acao_autonoma'
       AND ag.status IN ('pendente','executando')
       AND (
           lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = v_cnpj
        OR lpad(regexp_replace(coalesce(c.pagador,''),'\D','','g'),14,'0') = v_cnpj
       )
    RETURNING ag.id AS ag_id, ag.card_id AS card_id, ag.payload->>'acao_key' AS acao_key
  )
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  SELECT card_id, 'AcaoAutonomaDevolvidaProHumano', 'system', 'rpc_remanejar_cliente',
    jsonb_build_object(
      'agendamento_id', ag_id,
      'acao_key',       acao_key,
      'motivo',         'reatribuicao de operador: dono novo nao viu a proposta',
      'cnpj_pagador',   v_cnpj,
      'operador_novo',  v_destino,
      'autorizado_por', trim(p_autorizado_por))
  FROM desarmadas;
  GET DIAGNOSTICS v_veto = ROW_COUNT;

  -- ---------------------------------------------------------------------------
  -- 5. cards — TODOS (inclusive terminais) + card_events. Casa por
  --    agent_state->>'cnpj_pagador' E pela coluna pagador (sync grava nome,
  --    vinculador grava cnpj — mig 359). Nome nao colide: lpad(digitos de um
  --    nome) = '00000000000000'.
  -- ---------------------------------------------------------------------------
  WITH afet AS (
    SELECT c.id, c.responsavel_relacionamento AS resp_old,
           c.assigned_operator_id AS aid_old, c.segmento_codigo AS seg_old
      FROM public.cards c
     WHERE (
         lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = v_cnpj
      OR lpad(regexp_replace(coalesce(c.pagador,''),'\D','','g'),14,'0') = v_cnpj
     )
       AND (c.assigned_operator_id IS DISTINCT FROM v_dest
         OR upper(coalesce(trim(c.responsavel_relacionamento),'')) IS DISTINCT FROM v_destino
         OR c.segmento_codigo IS NOT NULL)
  ), upd AS (
    UPDATE public.cards c
       SET assigned_operator_id       = v_dest,
           responsavel_relacionamento = v_destino,
           segmento_codigo            = NULL
      FROM afet a WHERE c.id = a.id
    RETURNING c.id, a.resp_old, a.aid_old, a.seg_old
  )
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  SELECT id, 'OperadorReatribuido', 'system', 'rpc_remanejar_cliente',
    jsonb_build_object(
      'responsavel_anterior', resp_old,
      'assigned_anterior',    aid_old,
      'segmento_anterior',    seg_old,
      'responsavel_novo',     v_destino,
      'cnpj_pagador',         v_cnpj,
      'cliente',              v_nome,
      'motivo',               trim(p_motivo),
      'autorizado_por',       trim(p_autorizado_por))
  FROM upd;
  GET DIAGNOSTICS v_cards = ROW_COUNT;

  -- ---------------------------------------------------------------------------
  -- 6. alertas_operador NAO LIDOS dos cards movidos -> destino (aviso pendente
  --    apontando pra card que o antigo nao enxerga mais viraria link morto)
  -- ---------------------------------------------------------------------------
  UPDATE public.alertas_operador a
     SET operador_id = v_dest
    FROM public.cards c
   WHERE c.id = a.card_id
     AND a.lido_em IS NULL
     AND a.operador_id IS DISTINCT FROM v_dest
     AND (
         lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = v_cnpj
      OR lpad(regexp_replace(coalesce(c.pagador,''),'\D','','g'),14,'0') = v_cnpj
     );
  GET DIAGNOSTICS v_alert = ROW_COUNT;

  -- ---------------------------------------------------------------------------
  -- POS-CHECKS (a..i da mig 359) — EXCEPTION reverte a chamada inteira
  -- ---------------------------------------------------------------------------
  -- a) o CNPJ esta na carteira do destino
  IF NOT EXISTS (SELECT 1 FROM public.operadores o, unnest(o.carteira) x
                  WHERE o.id = v_dest
                    AND lpad(regexp_replace(x,'\D','','g'),14,'0') = v_cnpj) THEN
    RAISE EXCEPTION 'STOP pos-check a: CNPJ % nao entrou na carteira de %', v_cnpj, v_destino;
  END IF;

  -- b) e em nenhuma outra carteira (1 CNPJ = 1 operador — INV-036a/INV-048)
  SELECT count(*) INTO v FROM public.operadores o, unnest(o.carteira) x
   WHERE o.id IS DISTINCT FROM v_dest
     AND lpad(regexp_replace(x,'\D','','g'),14,'0') = v_cnpj;
  IF v > 0 THEN
    RAISE EXCEPTION 'STOP pos-check b: CNPJ % ainda em % carteira(s) alem de %', v_cnpj, v, v_destino;
  END IF;

  -- c) invariante GLOBAL: nenhum CNPJ do sistema em duas carteiras
  SELECT count(*) INTO v FROM (
    SELECT lpad(regexp_replace(x,'\D','','g'),14,'0') AS n
      FROM public.operadores, unnest(carteira) x
     GROUP BY 1 HAVING count(*) > 1) d;
  IF v > 0 THEN
    RAISE EXCEPTION 'STOP pos-check c: % CNPJ(s) em mais de uma carteira', v;
  END IF;

  -- d) nenhum card do CNPJ com dono diferente do destino (inclui terminais)
  SELECT count(*) INTO v FROM public.cards c
   WHERE (
       lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = v_cnpj
    OR lpad(regexp_replace(coalesce(c.pagador,''),'\D','','g'),14,'0') = v_cnpj
   )
     AND c.assigned_operator_id IS DISTINCT FROM v_dest;
  IF v > 0 THEN
    RAISE EXCEPTION 'STOP pos-check d: % card(s) do CNPJ % com dono diferente de %', v, v_cnpj, v_destino;
  END IF;

  -- e) nenhum card do CNPJ com segmento_codigo preenchido (RLS mig 242)
  SELECT count(*) INTO v FROM public.cards c
   WHERE (
       lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = v_cnpj
    OR lpad(regexp_replace(coalesce(c.pagador,''),'\D','','g'),14,'0') = v_cnpj
   )
     AND c.segmento_codigo IS NOT NULL;
  IF v > 0 THEN
    RAISE EXCEPTION 'STOP pos-check e: % card(s) do CNPJ % com segmento_codigo preenchido', v, v_cnpj;
  END IF;

  -- f) catalogo coerente (so quando segmento foi informado)
  IF p_segmento_codigo IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.clientes
                      WHERE cnpj_cpf = v_cnpj AND segmento_codigo = p_segmento_codigo) THEN
    RAISE EXCEPTION 'STOP pos-check f: cliente % nao ficou no segmento %', v_cnpj, p_segmento_codigo;
  END IF;

  -- g) INV-038: responsavel_relacionamento coerente com o destino
  SELECT count(*) INTO v FROM public.cards c
   WHERE (
       lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = v_cnpj
    OR lpad(regexp_replace(coalesce(c.pagador,''),'\D','','g'),14,'0') = v_cnpj
   )
     AND upper(coalesce(trim(c.responsavel_relacionamento),'')) <> v_destino;
  IF v > 0 THEN
    RAISE EXCEPTION 'STOP pos-check g: % card(s) do CNPJ % com responsavel_relacionamento fora de %', v, v_cnpj, v_destino;
  END IF;

  -- h) nenhuma acao autonoma armada sobrou no CNPJ
  SELECT count(*) INTO v
    FROM public.acoes_agendadas ag
    JOIN public.cards c ON c.id = ag.card_id
   WHERE ag.tipo = 'executar_acao_autonoma'
     AND ag.status IN ('pendente','executando')
     AND (
         lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = v_cnpj
      OR lpad(regexp_replace(coalesce(c.pagador,''),'\D','','g'),14,'0') = v_cnpj
     );
  IF v > 0 THEN
    RAISE EXCEPTION 'STOP pos-check h: % acao(oes) autonoma(s) ainda armada(s) no CNPJ %', v, v_cnpj;
  END IF;

  -- i) espelho que o front escuta tambem limpo
  SELECT count(*) INTO v FROM public.cards c
   WHERE (
       lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = v_cnpj
    OR lpad(regexp_replace(coalesce(c.pagador,''),'\D','','g'),14,'0') = v_cnpj
   )
     AND coalesce(c.acao_autonoma->>'status','') IN ('pendente','executando');
  IF v > 0 THEN
    RAISE EXCEPTION 'STOP pos-check i: % card(s) do CNPJ % com espelho de veto ainda armado', v, v_cnpj;
  END IF;

  RAISE NOTICE 'remanejar % (% -> %): contatos=%, tracking=%, veto_desarmado=%, cards=%, alertas=%',
    v_cnpj, array_to_string(v_de, '+'), v_destino, v_cont, v_track, v_veto, v_cards, v_alert;

  RETURN jsonb_build_object(
    'cnpj',            v_cnpj,
    'cliente',         v_nome,
    'de',              to_jsonb(v_de),
    'para',            v_destino,
    'contatos',        v_cont,
    'tracking',        v_track,
    'veto_desarmado',  v_veto,
    'cards',           v_cards,
    'alertas',         v_alert,
    'autorizado_por',  trim(p_autorizado_por),
    'motivo',          trim(p_motivo),
    'avisos',          to_jsonb(v_avisos));
END $fn$;

COMMENT ON FUNCTION public.remanejar_cliente_operador(text,text,text,text,text,text,boolean) IS
  'Remanejo canonico de cliente entre operadores (receita migs 288/301/333/359: 7 camadas + pos-checks). Politica: docs/POLITICA_MIGRATIONS.md. Manual: docs/REMANEJAR_CLIENTE.md';

-- Operador logado no front NUNCA chama isso; so postgres (psql) e service_role.
REVOKE ALL ON FUNCTION public.remanejar_cliente_operador(text,text,text,text,text,text,boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remanejar_cliente_operador(text,text,text,text,text,text,boolean)
  TO service_role;
