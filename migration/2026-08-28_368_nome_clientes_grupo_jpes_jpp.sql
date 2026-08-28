-- =============================================================================
-- 2026-08-28_368 — nome dos 3 clientes do grupo JPES/JPP (residuo da mig 360)
-- =============================================================================
-- TIPO B (docs/POLITICA_MIGRATIONS.md): UPDATE em dado de producao.
-- APLICACAO SO PELO CAIO. Carlos preparou e validou; nao aplicou.
--
-- CONTEXTO: em 2026-08-28 o remanejo do grupo JPES/JPP (VICTOR -> DUILIO,
-- segmento 022 MOTOBIKE) foi feito pela RPC canonica
-- `remanejar_cliente_operador` (mig 360) — ver
-- docs/remanejos/2026-08-28_grupo-jpes_victor_para_duilio.md.
--
-- Os 3 CNPJs nao existiam no Cockpit (so no Bastao). A RPC monta o nome do
-- cliente com `coalesce(clientes.nome, cards.pagador, cnpj)`; como nao havia
-- nem catalogo nem card, os 3 nasceram com **nome = o proprio CNPJ**.
--
-- ISSO NAO SE AUTOCORRIGE: `_shared/registrar-contato-cliente.ts:57-61` so faz
-- INSERT quando o cliente falta — nunca UPDATE do nome — e nenhuma outra edge
-- function escreve em `public.clientes`.
--
-- POR QUE NAO E "SO COSMETICO" (achado 2026-08-28, pergunta do Carlos):
--   1. `apps/cockpit-web/.../ModalCriarCard.tsx:93-99` busca cliente por
--      `ilike(nome, %termo%)` — quem digita "JPES" nao acha nada hoje.
--   2. `_shared/remetente-autorizado.ts:66-68,114-117` decide se um e-mail pode
--      CRIAR card comparando o dominio com o slug do NOME do cliente, e a
--      comparacao e BIDIRECIONAL (`domBase.includes(slug) OR
--      slug.includes(domBase)`). Com nome = 14 digitos, um dominio numerico
--      curto (ex.: `0001.com.br`) vira substring do CNPJ e passa no filtro.
--      Conferido: estes 3 eram os UNICOS entre 849 clientes ativos com nome
--      so de digitos — a categoria foi criada por nos.
--   O roteamento dos cards NAO depende disso (quem manda e a carteira, Path 1
--   do operador-resolver) — os 3 cards do JPES ja nasceram no DUILIO.
--
-- FONTE DOS NOMES:
--   37794121000162 — dos proprios cards criados em 2026-08-28 18:00-18:01
--                    (`cards.pagador`). Duas variantes truncadas pela origem;
--                    adotada a mais completa. Se o Caio preferir a curta
--                    ('JPES COM. ATACA C.'), trocar aqui antes de aplicar.
--   05378352000107 } informados nominalmente pelo Carlos em 2026-08-28.
--   05378352000360 } Sem card e sem registro no Bastao, nao ha outra fonte.
--                    Nome identico nos dois (matriz e filial da mesma raiz);
--                    o sufixo '(..)' e o marcador de truncagem da origem, ja
--                    usado no cadastro (ex.: 'SULMEDIC COMERCIO DE MEDI (..)').
--
-- SEGURANCA DO UPDATE: so toca linha cujo `nome` AINDA e numerico. Se um card
-- ou outro processo tiver gravado um nome de verdade nesse meio-tempo, a linha
-- e ignorada — nunca sobrescreve nome real. Isso tambem torna idempotente:
-- re-rodar nao muda nada.
--
-- Bloco UNICO: UPDATE + pos-checks no mesmo DO, entao ou tudo passa ou nada
-- fica (statement atomico). SEM BEGIN/COMMIT interno (regra 13/08).
-- skill: supabase-postgres-best-practices (set-based, schema-qualified,
-- sem SECURITY DEFINER, sem alterar RLS/grants).
-- =============================================================================

DO $mig368$
DECLARE
  v_upd int;
  v_falta int;
  v_num_global int;
  r record;
BEGIN
  -- -------------------------------------------------------------------------
  -- Correcao: so onde o nome AINDA e o proprio CNPJ (numerico)
  -- -------------------------------------------------------------------------
  UPDATE public.clientes cl
     SET nome = v.nome
    FROM (VALUES
      ('37794121000162', 'JPES COM. ATACADISTA DE PECAS E'),
      ('05378352000107', 'JPP IMPORTACAO E EXPORTAC (..)'),
      ('05378352000360', 'JPP IMPORTACAO E EXPORTAC (..)')
    ) AS v(cnpj, nome)
   WHERE cl.cnpj_cpf = v.cnpj
     AND cl.nome ~ '^[0-9]+$';
  GET DIAGNOSTICS v_upd = ROW_COUNT;

  -- -------------------------------------------------------------------------
  -- Pos-check a: nenhum dos 3 ficou com nome numerico
  -- -------------------------------------------------------------------------
  SELECT count(*) INTO v_falta FROM public.clientes
   WHERE cnpj_cpf IN ('37794121000162','05378352000107','05378352000360')
     AND nome ~ '^[0-9]+$';
  IF v_falta > 0 THEN
    RAISE EXCEPTION 'STOP pos-check a: % dos 3 CNPJs ainda com nome numerico', v_falta;
  END IF;

  -- -------------------------------------------------------------------------
  -- Pos-check b: os 3 existem e estao ativos (nao criamos nem apagamos nada)
  -- -------------------------------------------------------------------------
  SELECT count(*) INTO v_falta FROM public.clientes
   WHERE cnpj_cpf IN ('37794121000162','05378352000107','05378352000360') AND ativo;
  IF v_falta <> 3 THEN
    RAISE EXCEPTION 'STOP pos-check b: esperava 3 clientes ativos, achei %', v_falta;
  END IF;

  -- -------------------------------------------------------------------------
  -- Pos-check c: o segmento 022 dos 3 continua intacto (esta migration NAO
  -- pode mexer em segmento — isso e a mig 360 / RPC)
  -- -------------------------------------------------------------------------
  SELECT count(*) INTO v_falta FROM public.clientes
   WHERE cnpj_cpf IN ('37794121000162','05378352000107','05378352000360')
     AND segmento_codigo = '022' AND segmento_nome = 'MOTOBIKE';
  IF v_falta <> 3 THEN
    RAISE EXCEPTION 'STOP pos-check c: segmento 022 MOTOBIKE deveria estar nos 3, esta em %', v_falta;
  END IF;

  -- -------------------------------------------------------------------------
  -- Pos-check d (o que fecha a brecha): NENHUM cliente ativo do sistema com
  -- nome so de digitos. Era 3 antes desta migration, tem que virar 0.
  -- -------------------------------------------------------------------------
  SELECT count(*) INTO v_num_global FROM public.clientes
   WHERE ativo AND nome ~ '^[0-9]+$';
  IF v_num_global > 0 THEN
    RAISE EXCEPTION 'STOP pos-check d: ainda existem % cliente(s) ativo(s) com nome numerico (brecha do remetente-autorizado aberta)', v_num_global;
  END IF;

  -- -------------------------------------------------------------------------
  -- Pos-check e: o slug de cada nome novo tem letra e comprimento util — se
  -- virasse curto/numerico, a comparacao bidirecional do remetente-autorizado
  -- voltaria a super-casar.
  -- -------------------------------------------------------------------------
  FOR r IN
    SELECT cnpj_cpf,
           regexp_replace(lower(nome), '[^a-z0-9]', '', 'g') AS slug
      FROM public.clientes
     WHERE cnpj_cpf IN ('37794121000162','05378352000107','05378352000360')
  LOOP
    IF length(r.slug) < 8 OR r.slug !~ '[a-z]' THEN
      RAISE EXCEPTION 'STOP pos-check e: slug fraco em % -> "%" (len %)',
        r.cnpj_cpf, r.slug, length(r.slug);
    END IF;
  END LOOP;

  RAISE NOTICE 'mig 368 OK: % nome(s) corrigido(s); clientes ativos com nome numerico agora = %',
    v_upd, v_num_global;
END $mig368$;
