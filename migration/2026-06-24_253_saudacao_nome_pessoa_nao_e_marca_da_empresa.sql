-- ============================================================================
-- 2026-06-24_253_saudacao_nome_pessoa_nao_e_marca_da_empresa
--
-- PROBLEMA (Caio 2026-06-24, print NF 345282 — ACACIA):
--   O e-mail saía "Olá Acácia," — 100% robotizado, com o NOME DA EMPRESA na
--   saudação. Causa-raiz comprovada nos dados:
--     contatos_cliente.nome_pessoa = 'ACÁCIA'  (a MARCA, salva no campo de
--     pessoa), empresa do card = 'ACACIA COM DE MEDIC LTDA'.
--   A mig 225 (resolver_primeiro_nome_email) já barrava empresa/rótulo, MAS:
--     - _nome_pessoa_usavel('ACÁCIA') = true  (é uma palavra comum com vogal,
--       não cai em nenhum padrão de razão social);
--     - o único guard contra empresa era igualdade EXATA com o nome completo
--       (nome_pessoa <> empresa). 'ACÁCIA' ≠ 'ACACIA COM DE MEDIC LTDA' → passou.
--   Mesma classe do resíduo já conhecido: IBITURUNA, SINERGIA (marca c/ vogal).
--   Levantamento: de 176 nomes "usáveis", só 4 são a marca da empresa — TODOS
--   pegos pelo guard novo, ZERO nome de pessoa real afetado:
--     ACÁCIA (ACACIA COM DE MEDIC LTDA), ACÁCIA (idem),
--     SINERGIA (SINERGIA MEDICAMENTOS LTDA), IBITURUNA (IBITURUNA COM PROD FARM).
--
-- DECISÃO (raiz, não caso-a-caso):
--   nome_pessoa NÃO é nome de PESSOA quando seu 1º token (sem acento, >=3 letras)
--   aparece como um TOKEN inteiro no nome da empresa do card. Isso é a marca,
--   não uma pessoa. Substitui o guard antigo de igualdade exata (que é mais
--   fraco e já está contido neste). Sem nome de pessoa => Prezado(a)/Pessoal,
--   exatamente como o Caio pediu (mig 225).
--
--   FONTE ÚNICA: a correção vive 100% em resolver_primeiro_nome_email, então
--   conserta de uma vez os 3 callers — RPC preview_email_todo (modal), executor
--   (envio real) e edge cobrar-cliente-aguardando — todos passam p_empresa.
--
-- skill: supabase-postgres-best-practices
--   * 1 função IMMUTABLE pura nova (_fold_accents, via translate — NÃO depende da
--     extensão unaccent, que não está instalada neste projeto) + CREATE OR REPLACE
--     do resolver. Sem mudança de schema/RLS/índice. SET search_path em ambas.
--   * O resolver continua STABLE INVOKER; callers já enxergam as linhas.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Dobra de acentos pura (sem extensão unaccent). Usada só p/ comparar
--    nome_pessoa vs nome da empresa de forma acento-insensível.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._fold_accents(p_txt text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT translate(
    lower(coalesce(p_txt, '')),
    'áàâãäéèêëíìîïóòôõöúùûüçñ',
    'aaaaaeeeeiiiiooooouuuucn'
  );
$$;

COMMENT ON FUNCTION public._fold_accents(text) IS
  'Lowercase + remove acentos via translate (sem extensão unaccent). '
  'Usada por resolver_primeiro_nome_email p/ comparar nome vs empresa. Mig 253.';

-- ----------------------------------------------------------------------------
-- 2. resolver_primeiro_nome_email: troca o guard de igualdade exata por
--    "1º token do nome NÃO é um token do nome da empresa" (acento-insensível).
--    Resto idêntico à mig 225.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolver_primeiro_nome_email(
  p_email   text,
  p_empresa text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_first text;
  v_local text;
  v_tok   text;
BEGIN
  IF p_email IS NULL OR btrim(p_email) = '' THEN
    RETURN '';
  END IF;

  -- Passo 1: nome cadastrado da pessoa. Descarta empresa/genérico (predicado
  -- _nome_pessoa_usavel) E o caso em que o 1º token do nome é, na verdade, um
  -- TOKEN do nome da empresa do card (= a marca: ACÁCIA, IBITURUNA, SINERGIA...).
  -- A comparação é acento-insensível e exige token >=3 letras p/ não casar com
  -- "de"/"e"/"m"/"b" de razões sociais.
  SELECT initcap(split_part(btrim(c.nome_pessoa), ' ', 1))
  INTO v_first
  FROM public.contatos_cliente c
  WHERE c.tipo = 'email'
    AND c.identificador = lower(btrim(p_email))
    AND c.nome_pessoa IS NOT NULL
    AND btrim(c.nome_pessoa) <> ''
    AND public._nome_pessoa_usavel(c.nome_pessoa)
    AND NOT (
      length(public._fold_accents(split_part(btrim(c.nome_pessoa), ' ', 1))) >= 3
      AND public._fold_accents(COALESCE(p_empresa, '')) ~ (
        '(^|[^a-z])'
        || public._fold_accents(split_part(btrim(c.nome_pessoa), ' ', 1))
        || '([^a-z]|$)'
      )
    )
  ORDER BY c.ordem NULLS LAST, c.id
  LIMIT 1;

  IF v_first IS NOT NULL AND v_first <> '' THEN
    RETURN v_first;
  END IF;

  -- Passo 2: deriva do e-mail SÓ quando há separador (nome.sobrenome@...).
  -- Sem separador (dbarcelos@) é arriscado (inicial+sobrenome) -> não deriva.
  -- MESMO guard de marca do Passo 1: se o token derivado é um token do nome da
  -- empresa, é a marca (ex.: dpk.out@... → 'dpk' ∈ 'DPK / COMERCIAL AUTOMOTIVA'),
  -- NÃO deriva. Senão a marca vazava pela esquerda do @.
  v_local := split_part(lower(btrim(p_email)), '@', 1);
  IF v_local ~ '[._+-]' THEN
    v_tok := (regexp_split_to_array(v_local, '[._+-]'))[1];
    IF v_tok ~ '^[a-zà-ÿ]{3,}$'
       AND v_tok <> ALL (ARRAY[
         'sac','contato','atendimento','logistica','comercial','ocorrencias',
         'noreply','compras','financeiro','rma','transporte','expedicao',
         'expedicaobh','central','pendencia','faturamento','fiscal','nfe',
         'vendas','suporte','recebimento','adm','administrativo','cobranca',
         'qualidade','diretoria','gerencia','recepcao','portaria','estoque'
       ])
       AND NOT (
         public._fold_accents(COALESCE(p_empresa, '')) ~ (
           '(^|[^a-z])' || public._fold_accents(v_tok) || '([^a-z]|$)'
         )
       ) THEN
      RETURN initcap(v_tok);
    END IF;
  END IF;

  RETURN '';
END;
$$;

COMMENT ON FUNCTION public.resolver_primeiro_nome_email(text, text) IS
  'Resolve {primeiro_nome} do destinatário p/ saudação de e-mail. Fonte única '
  'usada por preview_email_todo, executor e cobrar-cliente-aguardando. '
  'Mig 253: 1º token igual a token da empresa => marca, descarta (ACÁCIA/etc).';
