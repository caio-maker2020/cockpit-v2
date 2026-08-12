-- =============================================================================
-- 2026-08-12_333 — AGROLIFE sai da Curva F (ISABELY) e passa pra JULIA (AGRO)
-- =============================================================================
-- Diretriz Caio 2026-08-12: o CNPJ 53628620000136 (AGROLIFE PRODUTOS
-- VETERINARIOS LTDA) está na carteira da ISABELY porque a planilha de
-- 2026-07-23 o classificou como 043 CURVA F. Curva F é a faixa de baixo
-- faturamento (`sync-bastao/index.ts:1106-1109` — "clientes <20k/mês"). O
-- cliente passou de 30k/mês, então saiu da Curva F: a partir de agora é da
-- JULIA, segmento 003 DISTRIBUIDOR AGRO.
--
-- ESCOPO DOS CARDS (decisão explícita do Caio, DIVERGE do padrão das migs
-- 288/301/307): move TODOS os cards do CNPJ, inclusive os terminais
-- (RESOLVIDO/CANCELADO/TRANSFERIDO) — "esse cliente a partir de agora é da
-- JULIA, então deve estar na Julia". Cada card carrega o dono anterior no
-- card_event, então a trilha de auditoria continua íntegra mesmo com os
-- relatórios históricos de produtividade mudando de mão.
--
-- VÍNCULO EM 4 CAMADAS (receita mig 288/301) + catálogo + avisos:
--   0. clientes            — segmento 043 CURVA F → 003 DISTRIBUIDOR AGRO
--   1. operadores.carteira — remove de TODOS que não sejam JULIA, add na JULIA
--   2. contatos_cliente.operador_responsavel_id     → JULIA
--   3. tracking_credentials.operador_responsavel_id → JULIA
--   4. cards + card_events                          → JULIA
--   5. alertas_operador NÃO LIDOS dos cards movidos → JULIA
--
-- POR QUE `segmento_codigo = NULL` nos cards: a RLS (mig 242:41-48) mostra o
-- card também por `segmento_codigo = ANY(operadores.segmentos)`. ISABELY tem
-- segmentos={043}; deixar o card marcado 043 a manteria VENDO os cards de um
-- cliente que não é mais dela. Zerar é o padrão das migs 300/301/307/330 — a
-- visão passa a vir de assigned_operator_id, que é o vínculo correto.
--
-- CARDS NOVOS: o Path 1 do operador-resolver (carteira-CNPJ) tem prioridade
-- absoluta sobre o responsavel_relacionamento que o Bastão manda, então basta
-- o CNPJ estar na carteira da JULIA. Nenhuma edge function escreve
-- cards.segmento_codigo hoje (grep sync-bastao = 0), logo nascem com NULL.
--
-- NÃO TOCA (de propósito): operadores.segmentos de ninguém,
-- recebe_cards_orfaos (segue ISABELY), e a mig 307 — reescrever a 307 muda o
-- sha256 e faz o apply_migrations.py abortar com DRIFT. A planilha fonte é
-- corrigida à parte, no .xlsx.
--
-- Idempotente. Event sourcing. skill: supabase-postgres-best-practices
-- (set-based, transação única curta, schema-qualified, sem SECURITY DEFINER).
-- Guard anti-regressão: âncora INV-048 no /verify-cockpit.
-- =============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  v_cnpj    text := '53628620000136';
  v_nome    text := 'AGROLIFE PRODUTOS VETERINARIOS LTDA';
  v_motivo  text := 'Faturamento acima de 30k (Caio 2026-08-12): cliente saiu da Curva F (043/ISABELY) e passou para a carteira AGRO da JULIA';
  v_isabely uuid;
  v_julia   uuid;
  v_cont int; v_track int; v_cards int; v_alertas int;
BEGIN
  SELECT id INTO v_isabely FROM public.operadores WHERE nome = 'ISABELY';
  SELECT id INTO v_julia   FROM public.operadores WHERE nome = 'JULIA';

  -- Guarda de entrada: sem JULIA ativa no Cockpit o card viraria invisível
  -- (INV-036b: card vivo em operador dormente só aparece pro gestor).
  IF v_julia IS NULL THEN
    RAISE EXCEPTION 'STOP: operador JULIA nao encontrado';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.operadores
                  WHERE id = v_julia AND ativo AND cockpit_ativo) THEN
    RAISE EXCEPTION 'STOP: JULIA nao esta ativa no Cockpit (ativo/cockpit_ativo)';
  END IF;

  -- ---------------------------------------------------------------------------
  -- 0. Catálogo: 043 CURVA F → 003 DISTRIBUIDOR AGRO
  --    (precedente inverso: mig 289:46, que jogou GIRANDO de 001 pra 043)
  -- ---------------------------------------------------------------------------
  INSERT INTO public.clientes (cnpj_cpf, nome, segmento_codigo, segmento_nome, ativo)
  VALUES (v_cnpj, v_nome, '003', 'DISTRIBUIDOR AGRO', true)
  ON CONFLICT (cnpj_cpf) DO UPDATE SET
    segmento_codigo = '003',
    segmento_nome   = 'DISTRIBUIDOR AGRO',
    ativo           = true;

  -- ---------------------------------------------------------------------------
  -- 1. Carteira: 1 CNPJ = 1 operador. Remove de TODOS menos JULIA, depois add.
  --    Comparação normalizada (lpad 14) igual à mig 332:19-23 — a carteira
  --    pode ter o CNPJ gravado com máscara.
  -- ---------------------------------------------------------------------------
  UPDATE public.operadores o
     SET carteira = coalesce(
       (SELECT array_agg(x ORDER BY x) FROM unnest(o.carteira) x
         WHERE lpad(regexp_replace(x,'\D','','g'),14,'0') <> v_cnpj),
       '{}'::text[])
   WHERE o.id IS DISTINCT FROM v_julia
     AND EXISTS (SELECT 1 FROM unnest(o.carteira) x
                  WHERE lpad(regexp_replace(x,'\D','','g'),14,'0') = v_cnpj);

  UPDATE public.operadores o
     SET carteira = (SELECT array_agg(DISTINCT c ORDER BY c)
                       FROM unnest(coalesce(o.carteira,'{}'::text[]) || ARRAY[v_cnpj]) c)
   WHERE o.id = v_julia
     AND NOT EXISTS (SELECT 1 FROM unnest(o.carteira) x
                      WHERE lpad(regexp_replace(x,'\D','','g'),14,'0') = v_cnpj);

  -- ---------------------------------------------------------------------------
  -- 2. contatos_cliente (a planilha não trouxe e-mail deste CNPJ; pode ser 0)
  -- ---------------------------------------------------------------------------
  UPDATE public.contatos_cliente
     SET operador_responsavel_id = v_julia, updated_at = now()
   WHERE lpad(regexp_replace(documento_cliente,'\D','','g'),14,'0') = v_cnpj
     AND operador_responsavel_id IS DISTINCT FROM v_julia;
  GET DIAGNOSTICS v_cont = ROW_COUNT;

  -- ---------------------------------------------------------------------------
  -- 3. tracking_credentials (senha preservada — só troca o responsável)
  -- ---------------------------------------------------------------------------
  UPDATE public.tracking_credentials
     SET operador_responsavel_id = v_julia, updated_by = v_julia, updated_at = now()
   WHERE lpad(regexp_replace(documento,'\D','','g'),14,'0') = v_cnpj
     AND operador_responsavel_id IS DISTINCT FROM v_julia;
  GET DIAGNOSTICS v_track = ROW_COUNT;

  -- ---------------------------------------------------------------------------
  -- 4. cards — TODOS (inclusive terminais, por decisão do Caio) + card_events.
  --    Casa por agent_state->>'cnpj_pagador' E pela coluna `pagador`: o sync
  --    grava o NOME do pagador na coluna (mig 263:12-14), mas o vinculador
  --    grava o CNPJ (vinculador:982) — casar só por uma delas deixaria cards
  --    pra trás. Nome não colide: lpad(digitos_de_um_nome) = '00000000000000'.
  -- ---------------------------------------------------------------------------
  WITH afet AS (
    SELECT c.id, c.responsavel_relacionamento AS resp_old,
           c.assigned_operator_id AS aid_old, c.segmento_codigo AS seg_old
    FROM public.cards c
    WHERE (
        lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = v_cnpj
     OR lpad(regexp_replace(coalesce(c.pagador,''),'\D','','g'),14,'0') = v_cnpj
      )
      AND (c.assigned_operator_id IS DISTINCT FROM v_julia
        OR c.responsavel_relacionamento IS DISTINCT FROM 'JULIA'
        OR c.segmento_codigo IS NOT NULL)
  ), upd AS (
    UPDATE public.cards c
       SET assigned_operator_id       = v_julia,
           responsavel_relacionamento = 'JULIA',
           segmento_codigo            = NULL
    FROM afet a WHERE c.id = a.id
    RETURNING c.id, a.resp_old, a.aid_old, a.seg_old
  )
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  SELECT id, 'OperadorReatribuido', 'system', 'mig_333',
    jsonb_build_object(
      'responsavel_anterior', resp_old,
      'assigned_anterior',    aid_old,
      'segmento_anterior',    seg_old,
      'responsavel_novo',     'JULIA',
      'cnpj_pagador',         v_cnpj,
      'cliente',              v_nome,
      'motivo',               v_motivo)
  FROM upd;
  GET DIAGNOSTICS v_cards = ROW_COUNT;

  -- ---------------------------------------------------------------------------
  -- 5. alertas_operador NÃO LIDOS dos cards do CNPJ → JULIA.
  --    Aviso já lido é log entregue e fica com quem recebeu; aviso pendente
  --    apontando pra card que a ISABELY não enxerga mais viraria link morto.
  -- ---------------------------------------------------------------------------
  UPDATE public.alertas_operador a
     SET operador_id = v_julia
    FROM public.cards c
   WHERE c.id = a.card_id
     AND a.lido_em IS NULL
     AND a.operador_id IS DISTINCT FROM v_julia
     AND (
         lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = v_cnpj
      OR lpad(regexp_replace(coalesce(c.pagador,''),'\D','','g'),14,'0') = v_cnpj
     );
  GET DIAGNOSTICS v_alertas = ROW_COUNT;

  RAISE NOTICE 'mig 333 AGROLIFE % (ISABELY=% → JULIA=%): contatos=%, tracking=%, cards=%, alertas=%',
    v_cnpj, v_isabely, v_julia, v_cont, v_track, v_cards, v_alertas;
END $$;

-- =============================================================================
-- PÓS-CHECKS — abortam a transação inteira se falharem
-- =============================================================================
DO $$
DECLARE
  v_cnpj text := '53628620000136';
  v_julia uuid;
  v int;
BEGIN
  SELECT id INTO v_julia FROM public.operadores WHERE nome = 'JULIA';

  -- a) o CNPJ está na carteira da JULIA
  IF NOT EXISTS (SELECT 1 FROM public.operadores o, unnest(o.carteira) x
                  WHERE o.id = v_julia
                    AND lpad(regexp_replace(x,'\D','','g'),14,'0') = v_cnpj) THEN
    RAISE EXCEPTION 'STOP pos-check a: CNPJ % nao entrou na carteira da JULIA', v_cnpj;
  END IF;

  -- b) e em nenhuma outra carteira ("1 CNPJ = 1 operador" — INV-036a/INV-048)
  SELECT count(*) INTO v
    FROM public.operadores o, unnest(o.carteira) x
   WHERE o.id IS DISTINCT FROM v_julia
     AND lpad(regexp_replace(x,'\D','','g'),14,'0') = v_cnpj;
  IF v > 0 THEN
    RAISE EXCEPTION 'STOP pos-check b: CNPJ % ainda em % carteira(s) alem da JULIA', v_cnpj, v;
  END IF;

  -- c) invariante global: nenhum CNPJ do sistema em duas carteiras
  SELECT count(*) INTO v FROM (
    SELECT lpad(regexp_replace(c,'\D','','g'),14,'0') AS n
      FROM public.operadores, unnest(carteira) c
     GROUP BY 1 HAVING count(*) > 1) d;
  IF v > 0 THEN
    RAISE EXCEPTION 'STOP pos-check c: % CNPJ(s) em mais de uma carteira', v;
  END IF;

  -- d) nenhum card do CNPJ com dono diferente da JULIA (inclui terminais)
  SELECT count(*) INTO v FROM public.cards c
   WHERE (
       lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = v_cnpj
    OR lpad(regexp_replace(coalesce(c.pagador,''),'\D','','g'),14,'0') = v_cnpj
   )
     AND c.assigned_operator_id IS DISTINCT FROM v_julia;
  IF v > 0 THEN
    RAISE EXCEPTION 'STOP pos-check d: % card(s) do CNPJ % com dono diferente da JULIA', v, v_cnpj;
  END IF;

  -- e) nenhum card do CNPJ com segmento_codigo preenchido (senao a ISABELY,
  --    segmentos={043}, continuaria vendo pelo branch de segmento da RLS)
  SELECT count(*) INTO v FROM public.cards c
   WHERE (
       lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = v_cnpj
    OR lpad(regexp_replace(coalesce(c.pagador,''),'\D','','g'),14,'0') = v_cnpj
   )
     AND c.segmento_codigo IS NOT NULL;
  IF v > 0 THEN
    RAISE EXCEPTION 'STOP pos-check e: % card(s) do CNPJ % com segmento_codigo preenchido', v, v_cnpj;
  END IF;

  -- f) catálogo coerente com o novo dono
  IF NOT EXISTS (SELECT 1 FROM public.clientes
                  WHERE cnpj_cpf = v_cnpj AND segmento_codigo = '003') THEN
    RAISE EXCEPTION 'STOP pos-check f: cliente % nao ficou no segmento 003', v_cnpj;
  END IF;

  -- g) INV-038: responsavel_relacionamento e assigned_operator_id coerentes
  SELECT count(*) INTO v FROM public.cards c
   WHERE (
       lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0') = v_cnpj
    OR lpad(regexp_replace(coalesce(c.pagador,''),'\D','','g'),14,'0') = v_cnpj
   )
     AND upper(coalesce(trim(c.responsavel_relacionamento),'')) <> 'JULIA';
  IF v > 0 THEN
    RAISE EXCEPTION 'STOP pos-check g: % card(s) do CNPJ % com responsavel_relacionamento fora de JULIA', v, v_cnpj;
  END IF;

  RAISE NOTICE 'mig 333 pos-checks OK';
END $$;

COMMIT;
