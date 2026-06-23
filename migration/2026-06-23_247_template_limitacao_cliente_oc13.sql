-- ============================================================================
-- Cockpit v2 — Template de e-mail próprio pra oc=13 (limitação cliente)
-- Data: 2026-06-23
--
-- Âncora NF 1090394 (UNIÃO QUÍMICA): oc=13 "Entrega impossibilitada: limitação
-- cliente" usava o template FALTA_DE_VOLUME — cujo ASSUNTO é "Extravio Parcial"
-- e corpo fala em extravio de volumes. Pro caso real (declaração para retenção
-- de comprovante) ficava "nada a ver". Caio aprovou criar template próprio.
--
-- Par com a mudança de código: `REGRAS_AUTO_ACAO[13]` proposta oc=54 passa de
-- FALTA_DE_VOLUME → LIMITACAO_CLIENTE (regras-auto-acao.ts). Esta migration deve
-- rodar ANTES do deploy (se o template não existir, a proposta cai no fallback
-- "sem_email" — sem crash, mas sem e-mail).
--
-- skill: supabase-postgres-best-practices — INSERT idempotente (ON CONFLICT),
-- UPDATE retroativo seletivo (oc=13 + template antigo), qualificado em public.*,
-- event sourcing (card_event por card afetado).
-- ============================================================================

-- 1. Template novo (idempotente — re-rodar atualiza o conteúdo).
INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'LIMITACAO_CLIENTE',
  'Limitação do cliente (oc 13)',
  'oc=13 — entrega impossibilitada por limitação do destinatário. Pede orientação do cliente pra prosseguir (reentrega/agendamento). Caio 2026-06-23 (NF 1090394).',
  'Entrega não concluída — NF {nf} — {empresa}',
  E'Olá {primeiro_nome},\n\nNa tentativa de entrega da NF {nf}, não foi possível concluir a entrega devido a uma limitação no recebimento por parte do destinatário.\n\nSegue a evidência registrada pelo motorista, que pode ser acessada através do link: {link_evidencia}\n\nPara seguirmos, poderia nos orientar sobre como deseja prosseguir (nova tentativa de entrega, agendamento ou outra instrução)?\n\nFicamos no aguardo do seu retorno para darmos andamento o quanto antes.\n\n{operadora_nome} Sal Express — Relacionamento',
  ARRAY['primeiro_nome','nf','operadora_nome','link_evidencia'],
  true
)
ON CONFLICT (id) DO UPDATE SET
  nome = EXCLUDED.nome,
  descricao = EXCLUDED.descricao,
  assunto = EXCLUDED.assunto,
  corpo_template = EXCLUDED.corpo_template,
  variaveis_esperadas = EXCLUDED.variaveis_esperadas,
  ativo = true,
  updated_at = now();

-- 2. Retroativo: todos pendentes de oc=13 que carregam FALTA_DE_VOLUME baked no
--    payload → trocar pra LIMITACAO_CLIENTE (senão a operadora vê "Extravio
--    Parcial" ao abrir o modal). Event sourcing: 1 card_event por card.
WITH afetados AS (
  SELECT t.id AS todo_id, t.card_id
  FROM public.todos t
  JOIN public.cards c ON c.id = t.card_id
  WHERE t.status = 'pendente'
    AND c.cod_ultima_ocorrencia = 13
    AND t.proposta_payload->'args'->>'template_id' = 'FALTA_DE_VOLUME'
),
upd AS (
  UPDATE public.todos t
  SET proposta_payload = jsonb_set(t.proposta_payload, '{args,template_id}', '"LIMITACAO_CLIENTE"', true)
  FROM afetados a
  WHERE t.id = a.todo_id
  RETURNING a.card_id
)
INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT DISTINCT
  card_id,
  'TemplateEmailCorrigido',
  'system',
  'migration_247_oc13_template',
  jsonb_build_object(
    'de', 'FALTA_DE_VOLUME',
    'para', 'LIMITACAO_CLIENTE',
    'motivo', 'oc=13 template próprio (limitação cliente) — NF 1090394'
  )
FROM upd;

-- 3. Verificação.
DO $$
DECLARE
  v_tpl int;
  v_restantes int;
BEGIN
  SELECT count(*) INTO v_tpl FROM public.templates_email WHERE id = 'LIMITACAO_CLIENTE' AND ativo;
  SELECT count(*) INTO v_restantes
    FROM public.todos t JOIN public.cards c ON c.id = t.card_id
   WHERE t.status='pendente' AND c.cod_ultima_ocorrencia=13
     AND t.proposta_payload->'args'->>'template_id' = 'FALTA_DE_VOLUME';
  RAISE NOTICE 'Template LIMITACAO_CLIENTE ativo=% | todos oc=13 ainda com FALTA_DE_VOLUME=%', v_tpl, v_restantes;
  IF v_tpl <> 1 OR v_restantes > 0 THEN
    RAISE EXCEPTION 'Falha: template ativo=% (esperado 1), restantes=% (esperado 0)', v_tpl, v_restantes;
  END IF;
END $$;
