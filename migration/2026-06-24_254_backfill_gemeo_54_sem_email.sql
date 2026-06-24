-- =============================================================================
-- BACKFILL — gêmeo "Lançar SÓ oc 54 (sem email)" pro backlog (Caio 2026-06-24).
--
-- A opção sem-email é criada por garantirGemeosSemEmail (regras-auto-acao.ts), que
-- SÓ roda quando a auto-ação RE-PROCESSA o card. Cards parados em AVH/AGUARDANDO_
-- CLIENTE cuja 54+email foi criada antes da feature (2026-06-23) NUNCA re-rodam →
-- nunca ganham o gêmeo. A premissa "convergem no forward fix" estava errada: eram
-- 1.155 cards sem a opção. Âncora: NF 67342 (INOVAMED, Larissa).
--
-- Este backfill cria o gêmeo espelhando EXATAMENTE o que garantirGemeosSemEmail
-- gera (tool=lancar_ocorrencia, meta.sem_email_explicito=true, mesmos nf/cnpj/
-- chave_cte/descricao da 54+email existente, SEM template/email_destino).
--
-- IDEMPOTENTE + re-executável: só insere onde a 54+email está `pendente` e NÃO há
-- gêmeo ativo. Se o backlog reacumular (cards que não re-processam), rode de novo.
-- Marcado meta.retroativo_gemeo_2026_06_24=true (reversível: DELETE por essa flag).
-- 1ª execução 2026-06-24: INSERT 1.152.
-- =============================================================================

INSERT INTO public.todos (card_id, action_id, descricao, status, proposta_payload)
SELECT DISTINCT ON (e.card_id)
  e.card_id,
  gen_random_uuid(),
  'Lançar SÓ oc 54 (sem email) — re-aguardar cliente sem notificar',
  'pendente',
  jsonb_build_object(
    'tool', 'lancar_ocorrencia',
    'args', jsonb_build_object(
      'codigo_ssw', 54,
      'nf',             e.proposta_payload->'args'->>'nf',
      'chave_cte',      e.proposta_payload->'args'->>'chave_cte',
      'cnpj_remetente', e.proposta_payload->'args'->>'cnpj_remetente',
      'descricao',      e.proposta_payload->'args'->>'descricao'),
    'rationale', e.proposta_payload->>'rationale',
    'texto', null,
    'meta', jsonb_build_object(
      'tinha_intencao_email', false,
      'modo', 'sem_email',
      'sem_email_explicito', true,
      'gemeo_de_codigo_email', 54,
      'retroativo_gemeo_2026_06_24', true))
FROM public.todos e
WHERE e.status = 'pendente'
  AND e.proposta_payload->>'tool' = 'lancar_oc_e_enviar_email'
  AND (e.proposta_payload->'args'->>'codigo_ssw') = '54'
  AND NOT EXISTS (
    SELECT 1 FROM public.todos tw
    WHERE tw.card_id = e.card_id
      AND tw.status IN ('pendente','aprovado')
      AND (tw.proposta_payload->'meta'->>'sem_email_explicito') = 'true'
      AND (tw.proposta_payload->'args'->>'codigo_ssw') = '54')
ORDER BY e.card_id, e.created_at DESC;
