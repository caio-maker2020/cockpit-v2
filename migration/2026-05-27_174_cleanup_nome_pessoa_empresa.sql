-- =============================================================================
-- 2026-05-27_174 — Cleanup contatos_cliente.nome_pessoa (empresas → NULL)
--
-- Caio 2026-05-27 (Cockpit Carlos): script de import populou `nome_pessoa`
-- com RAZÃO SOCIAL da empresa em vez do nome da PESSOA contato. Exemplos:
--   - tainara.tolentino@brautoparts.com.br → "BR AUTO PARTS - JF"
--   - robson.amorim@redeancora.com.br → "REDE ANCORA"
--   - autoglass@transpofrete.com.br → "MG VIDROS"
--
-- Resultado prático antes desta cleanup: emails saíam "Olá REDE,", "Olá BR,"
-- (operador IA derivava primeira palavra do nome_pessoa stale).
--
-- Esta migration zera nome_pessoa quando o valor casa heurísticas de "razão
-- social" — depois o executor cai automaticamente na derivação do email
-- (allyson.ferreira@... → Allyson) que JÁ está implementada via cascata.
--
-- Re-rodar: idempotente. Quem cadastrar nome real depois (no Lovable
-- Cadastros → Contatos) NÃO é tocado.
--
-- skill: supabase-postgres-best-practices
--   - UPDATE com WHERE explícito (sem side-effects em outras tabelas)
--   - Regex POSIX padrão Postgres
--   - Quantificação ANTES/DEPOIS pra audit
-- =============================================================================

DO $$
DECLARE
  v_antes integer;
  v_depois integer;
BEGIN
  SELECT count(*) INTO v_antes
  FROM public.contatos_cliente
  WHERE nome_pessoa IS NOT NULL AND trim(nome_pessoa) != '';

  UPDATE public.contatos_cliente
  SET nome_pessoa = NULL
  WHERE nome_pessoa IS NOT NULL
    AND trim(nome_pessoa) != ''
    AND (
      -- ALL CAPS com 2+ palavras (BR AUTO PARTS, MG VIDROS, REDE ANCORA)
      (nome_pessoa ~ '^[A-Z][A-Z\s\-\.\&]+$' AND array_length(string_to_array(trim(nome_pessoa), ' '), 1) >= 2)
      -- Sufixo " - XX" (região: JF, VGA, BH, UBERLANDIA)
      OR nome_pessoa ~ '\s-\s[A-Z0-9]{1,12}$'
      -- Razão social explícita
      OR nome_pessoa ~* '\m(LTDA|S\/A|S\.A|EIRELI|MICRO\s*EMPRES|EMPRESA|COMERCIO|COMÉRCIO|INDUSTRIA|INDÚSTRIA|DISTRIB|TRANSPORT|LOGISTIC|LOGÍSTIC|HOLDING|GROUP|GRUPO)\M'
      -- Sigla empresa ALL CAPS (GMI, NORTEL, AMPLA)
      OR (nome_pessoa ~ '^[A-Z]{3,}$' AND length(nome_pessoa) >= 3)
    );

  SELECT count(*) INTO v_depois
  FROM public.contatos_cliente
  WHERE nome_pessoa IS NOT NULL AND trim(nome_pessoa) != '';

  RAISE NOTICE 'cleanup nome_pessoa: % → % (% removidos)', v_antes, v_depois, v_antes - v_depois;
END $$;
