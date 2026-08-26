-- =============================================================================
-- 2026-08-26_358 — 5 CNPJs saem da Curva F (ISABELY) para VICTOR / KAROLINE /
--                  FELIPE / DUILIO
-- =============================================================================
-- Diretriz Caio 2026-08-26: os 5 CNPJs abaixo estao na carteira da ISABELY
-- porque a planilha de 2026-07-23 os classificou como 043 CURVA F. Curva F e a
-- faixa de baixo faturamento (`sync-bastao/index.ts:1106-1109` — "clientes
-- <20k/mes"). Todos passaram de 30k/mes, entao sairam da Curva F. Mesma receita
-- da mig 333 (AGROLIFE), agora para 5 clientes e 4 destinos:
--
--   86368206000194  HENRIQUE DISTRIBUIDORA DE PERFUMES  -> VICTOR    006 COSMETICOS
--   09944371000368  SULMEDIC COMERCIO DE MEDICAMENTOS   -> KAROLINE  010 HOSPITALAR
--   81676009001190  GIRANDO COMERCIO DE PECAS           -> FELIPE    001 AUTO PECAS
--   81676009001433  GIRANDO COMERCIO DE PECAS (C.)      -> FELIPE    001 AUTO PECAS
--   40279136000288  ATACADAO DAS FERRAMENTAS (B2)       -> DUILIO    014 FERRAMENTAS
--
-- Os 4 segmentos de destino JA EXISTEM no catalogo e JA estao no array
-- `operadores.segmentos` do respectivo dono (VICTOR 006, KAROLINE 010,
-- FELIPE 001, DUILIO 014) — nenhum segmento novo e criado aqui.
--
-- ESTADO VERIFICADO EM PRODUCAO 2026-08-26 (antes de aplicar):
--   • 168 cards no total, 24 abertos; 10 contatos; 4 tracking; 0 alertas
--     nao lidos; 2 acoes autonomas armadas (ambas no CNPJ do VICTOR).
--   • O SULMEDIC ja estava MEIO movido: carteira/contatos/tracking ja eram da
--     KAROLINE desde ~17/08, mas 12 cards seguiam na ISABELY e
--     clientes.segmento_codigo estava NULL. Esta migration TERMINA essa
--     mudanca (por isso ela e idempotente por construcao: o que ja esta certo
--     nao entra no UPDATE nem gera evento).
--   • 26 cards carregam `responsavel_relacionamento` = 'ISA E KAROL' (residuo
--     da mig 289) e 1 = 'CAMILA'. Nao sao nome de operador: normalizados aqui,
--     senao o pos-check (g) / INV-038 reprova.
--
-- CAMADAS (receita migs 288/301/333) + a 4 que e NOVA nesta migration:
--   0. clientes            — segmento 043 CURVA F -> segmento do destino
--   1. operadores.carteira — remove de TODOS que nao sejam o destino, add
--   2. contatos_cliente.operador_responsavel_id     -> destino
--   3. tracking_credentials.operador_responsavel_id -> destino
--   4. acoes_agendadas (veto) — DESARMA acao autonoma armada  << NOVA
--   5. cards + card_events                          -> destino
--   6. alertas_operador NAO LIDOS dos cards movidos -> destino
--
-- POR QUE A CAMADA 4 E NOVA (nao existia na mig 333): a janela de veto estreou
-- em 2026-08-25 (migs 353-357) como PILOTO de 3 operadores — FELIPE, ISABELY e
-- LARISSA. VICTOR, KAROLINE e DUILIO estao FORA do piloto. O executor
-- `processar-acoes-agendadas` revalida mensagem nova, destaque, mudanca de oc e
-- frescor do poll do Gmail no vencimento, mas NUNCA recheca se o dono ainda
-- esta no piloto (grep `acoes_autonomas_veto_operadores` no index.ts = 0
-- ocorrencias). Sem esta camada, uma acao armada sob a ISABELY dispararia
-- sozinha num card que agora e do VICTOR — operador que nunca optou por acao
-- autonoma e nao teria como vetar. O desarme cobre os 5 CNPJs (nao so os que
-- tem acao armada hoje), porque a ISABELY esta no piloto e o robo pode armar
-- algo entre agora e a aplicacao — assim o resultado nao depende do horario.
-- O trigger `trg_espelho_acao_autonoma` (mig 353:101) dispara em UPDATE, entao
-- `cards.acao_autonoma` — o que o front escuta — se atualiza sozinho.
--
-- ESCOPO DOS CARDS: TODOS, inclusive terminais (RESOLVIDO/CANCELADO/
-- TRANSFERIDO) — mesma decisao explicita do Caio na mig 333 ("esse cliente a
-- partir de agora e do X, entao deve estar no X"). Cada card carrega o dono
-- anterior no card_event, entao a trilha de auditoria continua integra mesmo
-- com os relatorios historicos de produtividade mudando de mao.
--
-- POR QUE `segmento_codigo = NULL` nos cards: a RLS (mig 242:41-48) mostra o
-- card tambem por `segmento_codigo = ANY(operadores.segmentos)`. ISABELY tem
-- segmentos={043}; deixar o card marcado 043 a manteria VENDO os cards de
-- clientes que nao sao mais dela. Zerar e o padrao das migs 300/301/307/330/333
-- — a visao passa a vir de assigned_operator_id, que e o vinculo correto.
--
-- CARDS NOVOS: o Path 1 do operador-resolver (carteira-CNPJ,
-- `operador-resolver.ts:171-177`) tem prioridade absoluta sobre o
-- `responsavel_relacionamento` que o Bastao manda, entao basta o CNPJ estar na
-- carteira do destino. O match la e string EXATA (`.includes(cnpj)`, sem
-- normalizacao) — por isso a carteira e gravada aqui em 14 digitos puros, que
-- e o formato 100% consistente das 4 carteiras hoje (conferido em prod).
-- Nenhuma edge function escreve cards.segmento_codigo, logo nascem com NULL.
--
-- PORTA LATERAL CONHECIDA: o trigger `resolve_assigned_operator_from_name`
-- (mig 007:39, revisto na 305:77) casa por NOME e NAO consulta carteira. Caio
-- confirmou em 2026-08-26 que a especie/responsavel dos 5 CNPJs JA foi trocada
-- no SSW — sem isso, card novo criado sem dono voltaria pra ISABELY. Evidencia
-- viva do problema: o SULMEDIC virou da KAROLINE em ~17/08 e cards seguiram
-- nascendo na ISABELY ate 19/08, porque o SSW ainda dizia o nome antigo.
--
-- NAO TOCA (de proposito): operadores.segmentos de ninguem,
-- recebe_cards_orfaos (segue ISABELY), o piloto do veto
-- (acoes_autonomas_veto_operadores), nenhuma edge function, e a mig 307 —
-- reescrever a 307 muda o sha256 e faz o apply_migrations.py abortar com DRIFT.
-- A planilha fonte e corrigida a parte, no .xlsx (4 das 5 linhas; o SULMEDIC
-- nao consta da planilha e pela regra ADITIVA no 2 do gerador fica onde esta).
--
-- Idempotente. Event sourcing. skill: supabase-postgres-best-practices
-- (set-based, transacao unica curta, schema-qualified, sem SECURITY DEFINER).
-- Guard anti-regressao: ancoras dos 5 CNPJs no INV-048 do /verify-cockpit.
-- =============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $mig358$
DECLARE
  r         record;
  v_op      text;
  v_dest    uuid;
  v_motivo  text;
  v_cont int; v_track int; v_veto int; v_cards int; v_alert int;
  t_cont int := 0; t_track int := 0; t_veto int := 0; t_cards int := 0; t_alert int := 0;
BEGIN
  -- ---------------------------------------------------------------------------
  -- Guarda de entrada: sem o destino ATIVO no Cockpit o card viraria invisivel
  -- (INV-036b: card vivo em operador dormente so aparece pro gestor).
  -- ---------------------------------------------------------------------------
  FOREACH v_op IN ARRAY ARRAY['VICTOR','KAROLINE','FELIPE','DUILIO'] LOOP
    IF NOT EXISTS (SELECT 1 FROM public.operadores
                    WHERE nome = v_op AND ativo AND cockpit_ativo) THEN
      RAISE EXCEPTION 'STOP: operador % ausente ou nao esta ativo no Cockpit (ativo/cockpit_ativo)', v_op;
    END IF;
  END LOOP;

  FOR r IN
    SELECT * FROM (VALUES
      ('86368206000194','HENRIQUE DISTRIBUIDORA DE PERFUMES' ,'VICTOR'  ,'006','DISTRIBUIDOR DE COSMETICOS'),
      ('09944371000368','SULMEDIC COMERCIO DE MEDICAMENTOS'  ,'KAROLINE','010','DISTRIBUIDOR HOSPITALAR'),
      ('81676009001190','GIRANDO COMERCIO DE PECAS LTDA'     ,'FELIPE'  ,'001','AUTO PECAS'),
      ('81676009001433','GIRANDO COMERCIO DE PECAS LTDA (C.)','FELIPE'  ,'001','AUTO PECAS'),
      ('40279136000288','ATACADAO DAS FERRAMENTAS LTDA'      ,'DUILIO'  ,'014','FERRAMENTAS E CONSTRUCAO')
    ) t(cnpj, nome, operador, seg_cod, seg_nome)
  LOOP
    SELECT id INTO v_dest FROM public.operadores WHERE nome = r.operador;

    v_motivo := format(
      'Faturamento acima de 30k (Caio 2026-08-26): cliente saiu da Curva F (043/ISABELY) e passou para %s, segmento %s %s',
      r.operador, r.seg_cod, r.seg_nome);

    -- -------------------------------------------------------------------------
    -- 0. Catalogo: 043 CURVA F -> segmento do destino.
    --    ON CONFLICT NAO sobrescreve `nome` de proposito — o nome gravado em
    --    prod e o truncado que o sync escreve; a fonte da verdade e ele.
    -- -------------------------------------------------------------------------
    INSERT INTO public.clientes (cnpj_cpf, nome, segmento_codigo, segmento_nome, ativo)
    VALUES (r.cnpj, r.nome, r.seg_cod, r.seg_nome, true)
    ON CONFLICT (cnpj_cpf) DO UPDATE SET
      segmento_codigo = EXCLUDED.segmento_codigo,
      segmento_nome   = EXCLUDED.segmento_nome,
      ativo           = true;

    -- -------------------------------------------------------------------------
    -- 1. Carteira: 1 CNPJ = 1 operador. Remove de TODOS menos o destino, add.
    --    Comparacao normalizada (lpad 14) igual a mig 332:19-23 — a carteira
    --    pode ter o CNPJ gravado com mascara. A GRAVACAO e em 14 digitos puros
    --    porque o resolver casa por string exata.
    -- -------------------------------------------------------------------------
    UPDATE public.operadores o
       SET carteira = coalesce(
         (SELECT array_agg(x ORDER BY x) FROM unnest(o.carteira) x
           WHERE lpad(regexp_replace(x,'\D','','g'),14,'0') <> r.cnpj),
         '{}'::text[])
     WHERE o.id IS DISTINCT FROM v_dest
       AND EXISTS (SELECT 1 FROM unnest(o.carteira) x
                    WHERE lpad(regexp_replace(x,'\D','','g'),14,'0') = r.cnpj);

    UPDATE public.operadores o
       SET carteira = (SELECT array_agg(DISTINCT c ORDER BY c)
                         FROM unnest(coalesce(o.carteira,'{}'::text[]) || ARRAY[r.cnpj]) c)
     WHERE o.id = v_dest
       AND NOT EXISTS (SELECT 1 FROM unnest(o.carteira) x
                        WHERE lpad(regexp_replace(x,'\D','','g'),14,'0') = r.cnpj);

    -- -------------------------------------------------------------------------
    -- 2. contatos_cliente
    -- -------------------------------------------------------------------------
    UPDATE public.contatos_cliente
       SET operador_responsavel_id = v_dest, updated_at = now()
     WHERE lpad(regexp_replace(coalesce(documento_cliente,''),'\D','','g'),14,'0') = r.cnpj
       AND operador_responsavel_id IS DISTINCT FROM v_dest;
    GET DIAGNOSTICS v_cont = ROW_COUNT;
    t_cont := t_cont + v_cont;

    -- -------------------------------------------------------------------------
    -- 3. tracking_credentials (senha preservada — so troca o responsavel)
    -- -------------------------------------------------------------------------
    UPDATE public.tracking_credentials
       SET operador_responsavel_id = v_dest, updated_by = v_dest, updated_at = now()
     WHERE lpad(regexp_replace(coalesce(documento,''),'\D','','g'),14,'0') = r.cnpj
       AND operador_responsavel_id IS DISTINCT FROM v_dest;
    GET DIAGNOSTICS v_track = ROW_COUNT;
    t_track := t_track + v_track;

    -- -------------------------------------------------------------------------
    -- 4. DESARMA a janela de veto (camada nova — ver cabecalho).
    --    Reusa o vocabulario do executor: status 'cancelado' + cancelado_motivo
    --    + processed_at, e o evento canonico EVENTO_DEVOLVIDA
    --    ('AcaoAutonomaDevolvidaProHumano', _shared/acao-autonoma-veto.ts:33),
    --    que a tela de Auditoria da janela ja sabe ler. O trigger de espelho
    --    limpa `cards.acao_autonoma` sozinho.
    -- -------------------------------------------------------------------------
    WITH desarmadas AS (
      UPDATE public.acoes_agendadas ag
         SET status           = 'cancelado',
             cancelado_motivo = 'Cliente mudou de operador (mig 358) — acao devolvida pro humano',
             processed_at     = now()
        FROM public.cards c
       WHERE c.id = ag.card_id
         AND ag.tipo = 'executar_acao_autonoma'
         AND ag.status IN ('pendente','executando')
         AND (
             lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = r.cnpj
          OR lpad(regexp_replace(coalesce(c.pagador,''),'\D','','g'),14,'0') = r.cnpj
         )
      RETURNING ag.id AS ag_id, ag.card_id AS card_id, ag.payload->>'acao_key' AS acao_key
    )
    INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
    SELECT card_id, 'AcaoAutonomaDevolvidaProHumano', 'system', 'mig_358',
      jsonb_build_object(
        'agendamento_id', ag_id,
        'acao_key',       acao_key,
        'motivo',         'reatribuicao de operador: dono novo fora do piloto da janela de veto',
        'cnpj_pagador',   r.cnpj,
        'operador_novo',  r.operador)
    FROM desarmadas;
    GET DIAGNOSTICS v_veto = ROW_COUNT;
    t_veto := t_veto + v_veto;

    -- -------------------------------------------------------------------------
    -- 5. cards — TODOS (inclusive terminais) + card_events.
    --    Casa por agent_state->>'cnpj_pagador' E pela coluna `pagador`: o sync
    --    grava o NOME do pagador na coluna (mig 263:12-14), mas o vinculador
    --    grava o CNPJ (vinculador:982) — casar so por uma delas deixaria cards
    --    pra tras. Nome nao colide: lpad(digitos_de_um_nome) = '00000000000000'.
    -- -------------------------------------------------------------------------
    WITH afet AS (
      SELECT c.id, c.responsavel_relacionamento AS resp_old,
             c.assigned_operator_id AS aid_old, c.segmento_codigo AS seg_old
        FROM public.cards c
       WHERE (
           lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = r.cnpj
        OR lpad(regexp_replace(coalesce(c.pagador,''),'\D','','g'),14,'0') = r.cnpj
       )
         AND (c.assigned_operator_id IS DISTINCT FROM v_dest
           OR upper(coalesce(trim(c.responsavel_relacionamento),'')) IS DISTINCT FROM r.operador
           OR c.segmento_codigo IS NOT NULL)
    ), upd AS (
      UPDATE public.cards c
         SET assigned_operator_id       = v_dest,
             responsavel_relacionamento = r.operador,
             segmento_codigo            = NULL
        FROM afet a WHERE c.id = a.id
      RETURNING c.id, a.resp_old, a.aid_old, a.seg_old
    )
    INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
    SELECT id, 'OperadorReatribuido', 'system', 'mig_358',
      jsonb_build_object(
        'responsavel_anterior', resp_old,
        'assigned_anterior',    aid_old,
        'segmento_anterior',    seg_old,
        'responsavel_novo',     r.operador,
        'cnpj_pagador',         r.cnpj,
        'cliente',              r.nome,
        'motivo',               v_motivo)
    FROM upd;
    GET DIAGNOSTICS v_cards = ROW_COUNT;
    t_cards := t_cards + v_cards;

    -- -------------------------------------------------------------------------
    -- 6. alertas_operador NAO LIDOS dos cards do CNPJ -> destino.
    --    Aviso ja lido e log entregue e fica com quem recebeu; aviso pendente
    --    apontando pra card que a ISABELY nao enxerga mais viraria link morto.
    -- -------------------------------------------------------------------------
    UPDATE public.alertas_operador a
       SET operador_id = v_dest
      FROM public.cards c
     WHERE c.id = a.card_id
       AND a.lido_em IS NULL
       AND a.operador_id IS DISTINCT FROM v_dest
       AND (
           lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = r.cnpj
        OR lpad(regexp_replace(coalesce(c.pagador,''),'\D','','g'),14,'0') = r.cnpj
       );
    GET DIAGNOSTICS v_alert = ROW_COUNT;
    t_alert := t_alert + v_alert;

    RAISE NOTICE 'mig 358 % (ISABELY -> %): contatos=%, tracking=%, veto_desarmado=%, cards=%, alertas=%',
      r.cnpj, r.operador, v_cont, v_track, v_veto, v_cards, v_alert;
  END LOOP;

  RAISE NOTICE 'mig 358 TOTAL: contatos=%, tracking=%, veto_desarmado=%, cards=%, alertas=%',
    t_cont, t_track, t_veto, t_cards, t_alert;
END $mig358$;

-- =============================================================================
-- POS-CHECKS — abortam a transacao inteira se falharem
-- =============================================================================
DO $chk358$
DECLARE
  r      record;
  v_dest uuid;
  v      int;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('86368206000194','VICTOR'  ,'006'),
      ('09944371000368','KAROLINE','010'),
      ('81676009001190','FELIPE'  ,'001'),
      ('81676009001433','FELIPE'  ,'001'),
      ('40279136000288','DUILIO'  ,'014')
    ) t(cnpj, operador, seg_cod)
  LOOP
    SELECT id INTO v_dest FROM public.operadores WHERE nome = r.operador;

    -- a) o CNPJ esta na carteira do destino
    IF NOT EXISTS (SELECT 1 FROM public.operadores o, unnest(o.carteira) x
                    WHERE o.id = v_dest
                      AND lpad(regexp_replace(x,'\D','','g'),14,'0') = r.cnpj) THEN
      RAISE EXCEPTION 'STOP pos-check a: CNPJ % nao entrou na carteira de %', r.cnpj, r.operador;
    END IF;

    -- b) e em nenhuma outra carteira ("1 CNPJ = 1 operador" — INV-036a/INV-048)
    SELECT count(*) INTO v
      FROM public.operadores o, unnest(o.carteira) x
     WHERE o.id IS DISTINCT FROM v_dest
       AND lpad(regexp_replace(x,'\D','','g'),14,'0') = r.cnpj;
    IF v > 0 THEN
      RAISE EXCEPTION 'STOP pos-check b: CNPJ % ainda em % carteira(s) alem de %', r.cnpj, v, r.operador;
    END IF;

    -- d) nenhum card do CNPJ com dono diferente do destino (inclui terminais)
    SELECT count(*) INTO v FROM public.cards c
     WHERE (
         lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = r.cnpj
      OR lpad(regexp_replace(coalesce(c.pagador,''),'\D','','g'),14,'0') = r.cnpj
     )
       AND c.assigned_operator_id IS DISTINCT FROM v_dest;
    IF v > 0 THEN
      RAISE EXCEPTION 'STOP pos-check d: % card(s) do CNPJ % com dono diferente de %', v, r.cnpj, r.operador;
    END IF;

    -- e) nenhum card do CNPJ com segmento_codigo preenchido (senao a ISABELY,
    --    segmentos={043}, continuaria vendo pelo branch de segmento da RLS)
    SELECT count(*) INTO v FROM public.cards c
     WHERE (
         lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = r.cnpj
      OR lpad(regexp_replace(coalesce(c.pagador,''),'\D','','g'),14,'0') = r.cnpj
     )
       AND c.segmento_codigo IS NOT NULL;
    IF v > 0 THEN
      RAISE EXCEPTION 'STOP pos-check e: % card(s) do CNPJ % com segmento_codigo preenchido', v, r.cnpj;
    END IF;

    -- f) catalogo coerente com o novo dono
    IF NOT EXISTS (SELECT 1 FROM public.clientes
                    WHERE cnpj_cpf = r.cnpj AND segmento_codigo = r.seg_cod) THEN
      RAISE EXCEPTION 'STOP pos-check f: cliente % nao ficou no segmento %', r.cnpj, r.seg_cod;
    END IF;

    -- g) INV-038: responsavel_relacionamento e assigned_operator_id coerentes
    --    (pega o residuo 'ISA E KAROL' / 'CAMILA' da mig 289)
    SELECT count(*) INTO v FROM public.cards c
     WHERE (
         lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = r.cnpj
      OR lpad(regexp_replace(coalesce(c.pagador,''),'\D','','g'),14,'0') = r.cnpj
     )
       AND upper(coalesce(trim(c.responsavel_relacionamento),'')) <> r.operador;
    IF v > 0 THEN
      RAISE EXCEPTION 'STOP pos-check g: % card(s) do CNPJ % com responsavel_relacionamento fora de %', v, r.cnpj, r.operador;
    END IF;

    -- h) nenhuma acao autonoma armada sobrou nesses CNPJs
    SELECT count(*) INTO v
      FROM public.acoes_agendadas ag
      JOIN public.cards c ON c.id = ag.card_id
     WHERE ag.tipo = 'executar_acao_autonoma'
       AND ag.status IN ('pendente','executando')
       AND (
           lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = r.cnpj
        OR lpad(regexp_replace(coalesce(c.pagador,''),'\D','','g'),14,'0') = r.cnpj
       );
    IF v > 0 THEN
      RAISE EXCEPTION 'STOP pos-check h: % acao(oes) autonoma(s) ainda armada(s) no CNPJ %', v, r.cnpj;
    END IF;

    -- i) e o espelho que o front escuta tambem esta limpo
    SELECT count(*) INTO v FROM public.cards c
     WHERE (
         lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = r.cnpj
      OR lpad(regexp_replace(coalesce(c.pagador,''),'\D','','g'),14,'0') = r.cnpj
     )
       AND coalesce(c.acao_autonoma->>'status','') IN ('pendente','executando');
    IF v > 0 THEN
      RAISE EXCEPTION 'STOP pos-check i: % card(s) do CNPJ % com espelho de veto ainda armado', v, r.cnpj;
    END IF;
  END LOOP;

  -- c) invariante GLOBAL: nenhum CNPJ do sistema em duas carteiras
  SELECT count(*) INTO v FROM (
    SELECT lpad(regexp_replace(c,'\D','','g'),14,'0') AS n
      FROM public.operadores, unnest(carteira) c
     GROUP BY 1 HAVING count(*) > 1) d;
  IF v > 0 THEN
    RAISE EXCEPTION 'STOP pos-check c: % CNPJ(s) em mais de uma carteira', v;
  END IF;

  RAISE NOTICE 'mig 358 pos-checks OK';
END $chk358$;

COMMIT;
