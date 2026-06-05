-- ============================================================================
-- Cockpit v2 — Tira DENTAL SORRIA da carteira LARISSA + blacklist temporário
-- Caio 2026-06-05
--
-- Cliente DENTAL SORRIA (2 CNPJs) migrou pra outro operador que ainda não
-- está cadastrado na plataforma. Enquanto isso:
--
--   1. Desativa os 4 contatos_cliente da LARISSA (domínio + email pros
--      2 CNPJs) — operador_responsavel_id=LARISSA via RLS já não mais válido.
--
--   2. Adiciona os 2 CNPJs em cnpjs_excluidos_cockpit pra impedir que a
--      cascata de atribuição (carteira > nome > segmento) jogue de volta na
--      LARISSA via segmento 010 (DENTAL SORRIA é segmento_codigo=010 e
--      LARISSA possui segmentos {007,010,018}). Mesmo padrão usado pra
--      AMPLA SLI TRANS (mig 140).
--
-- Quando o novo operador for cadastrado: REMOVER os 2 CNPJs do blacklist
-- e re-atribuir contatos_cliente pra o novo operador.
--
-- skill: supabase-postgres-best-practices
--   * Idempotente via WHERE ativo=true + ON CONFLICT
--   * Sem mudança de schema, só dados
-- ============================================================================

UPDATE public.contatos_cliente cc
SET ativo = false,
    observacao = COALESCE(observacao || ' | ', '')
                 || 'desativado 2026-06-05: cliente migrou pra outro operador (ainda não cadastrado)'
FROM public.operadores o
WHERE cc.operador_responsavel_id = o.id
  AND o.nome = 'LARISSA'
  AND cc.documento_cliente IN ('03662136000155','03662136000236')
  AND cc.ativo = true;

INSERT INTO public.cnpjs_excluidos_cockpit (cnpj_pagador, nome_cliente, motivo, ativo)
VALUES
  ('03662136000155', 'DENTAL SORRIA LTDA', 'aguardando cadastro de novo operador (saiu da LARISSA 2026-06-05)', true),
  ('03662136000236', 'DENTAL SORRIA LTDA', 'aguardando cadastro de novo operador (saiu da LARISSA 2026-06-05)', true)
ON CONFLICT (cnpj_pagador) DO UPDATE
SET ativo = true,
    motivo = EXCLUDED.motivo,
    nome_cliente = EXCLUDED.nome_cliente,
    updated_at = now();
