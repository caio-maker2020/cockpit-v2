-- ============================================================================
-- Cockpit v2 — Fix de dados: e-mails de contato truncados (.com.b → .com.br)
-- Data: 2026-06-23
--
-- Âncora: NF 45156 (VIP SPORTS NUTR). O contato `nfe@vipshowroom.com.b` estava
-- truncado na fonte (faltou o "r" de `.com.br`). O envio é assíncrono (front →
-- aprovar_e_executar → fila → executor), então o Gmail rejeitava com HTTP 400
-- "Invalid To header" DEPOIS, e o front mostrava "nada" pra operadora.
--
-- FIX EM 2 PARTES:
--   1. Código (guard sistêmico): `_shared/email-format.ts` + `gmail-sender.ts`
--      validam o formato ANTES de chamar o Gmail → erro claro e acionável em
--      vez do 400 silencioso. Testado em `email-format.test.ts`.
--   2. Esta migration: corrige os dados já truncados (`.com.b` → `.com.br`) em
--      `contatos_cliente` e nos `todos` pendentes que carregam o e-mail no
--      payload (senão re-aprovar o todo falha de novo com o e-mail velho).
--
-- Padrão `.com.b"` (b seguido de aspas/fim) NÃO casa com `.com.br` (b seguido
-- de r) → seguro: só toca os truncados. `.b` não é TLD válido.
--
-- skill: supabase-postgres-best-practices — UPDATE one-off seletivo, qualificado
-- em public.*, transação curta, sem função/índice/RLS novos.
-- ============================================================================

-- 1. Contatos (fonte). Só os que terminam em `.com.b` (TLD truncado de 1 letra).
UPDATE public.contatos_cliente
SET identificador = regexp_replace(identificador, '\.com\.b$', '.com.br'),
    updated_at = now()
WHERE tipo = 'email'
  AND identificador ~ '\.com\.b$';

-- 2. Todos pendentes com o e-mail truncado baked no proposta_payload
--    (email_destino e/ou extras.email_destinatarios). replace textual scoped
--    pelo sufixo `.com.b"` é seguro (não casa `.com.br"`).
UPDATE public.todos
SET proposta_payload = replace(proposta_payload::text, '.com.b"', '.com.br"')::jsonb
WHERE status = 'pendente'
  AND proposta_payload::text LIKE '%.com.b"%';

-- 3. Verificação: nada deve sobrar com `.com.b` truncado.
DO $$
DECLARE
  v_contatos int;
  v_todos int;
BEGIN
  SELECT count(*) INTO v_contatos FROM public.contatos_cliente
   WHERE tipo='email' AND identificador ~ '\.com\.b$';
  SELECT count(*) INTO v_todos FROM public.todos
   WHERE status='pendente' AND proposta_payload::text LIKE '%.com.b"%';
  RAISE NOTICE 'Pós-fix: contatos truncados restantes=%, todos truncados restantes=%', v_contatos, v_todos;
  IF v_contatos > 0 OR v_todos > 0 THEN
    RAISE EXCEPTION 'Ainda há e-mails truncados após o fix (contatos=%, todos=%)', v_contatos, v_todos;
  END IF;
END $$;
