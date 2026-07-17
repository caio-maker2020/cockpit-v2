-- 2026-07-17_299 — Loop de Aprendizado: fundação de dados (Fase 0)
-- Spec: docs/superpowers/specs/2026-07-17-loop-aprendizado-agentes-design.md
-- Plano: docs/superpowers/plans/2026-07-17-loop-aprendizado-implementacao.md
--
-- 100% ADITIVA: nenhuma tabela existente alterada além dos CHECKs do
-- learning_log (tabela vazia). Nenhum trigger em tabela quente. Views novas
-- não substituem as antigas.

BEGIN;

-- ============================================================
-- 1. agent_feedback — par universal para sinais NOVOS
--    (popup, árbitro T+7, agentes hoje cegos). Os sinais das 3
--    tabelas de feedback existentes NÃO são espelhados aqui;
--    entram pela view v_agent_feedback_unificado.
-- ============================================================

CREATE TABLE public.agent_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid REFERENCES public.cards(id) ON DELETE CASCADE,
  todo_id uuid REFERENCES public.todos(id) ON DELETE SET NULL,
  agent_name text NOT NULL,
  action_key_sugerida text,
  oc_sugerida integer,
  oc_executada integer,
  veredito text NOT NULL
    CHECK (veredito IN ('seguida','corrigida','rejeitada','abstencao','nao_rodou')),
  origem text NOT NULL
    CHECK (origem IN ('implicit','explicit','popup','outcome','audit','backfill')),
  reason_code text,
  reason_text text,
  confianca numeric,
  operador_id uuid REFERENCES public.operadores(id) ON DELETE SET NULL,
  modo text CHECK (modo IN ('sugestao','shadow','autonomo')),
  -- desfecho preenchido UMA vez pelo árbitro T+7 (únicas colunas atualizáveis)
  desfecho text
    CHECK (desfecho IN ('resolvido_limpo','reaberto','bounce','oc_nova','indefinido')),
  desfecho_arbitro text
    CHECK (desfecho_arbitro IN ('confirma_ia','confirma_operador','inconclusivo')),
  desfecho_em timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.agent_feedback IS
  'Par sugestão×decisão dos agentes IA — sinais novos do Loop de Aprendizado (spec 2026-07-17). Append-only; só colunas desfecho_* são atualizáveis (árbitro T+7).';

CREATE INDEX idx_agent_feedback_agent_dia
  ON public.agent_feedback (agent_name, created_at DESC);
CREATE INDEX idx_agent_feedback_card ON public.agent_feedback (card_id);
CREATE INDEX idx_agent_feedback_todo
  ON public.agent_feedback (todo_id) WHERE todo_id IS NOT NULL;
-- varredura do árbitro T+7: pares ainda sem desfecho
CREATE INDEX idx_agent_feedback_sem_desfecho
  ON public.agent_feedback (created_at) WHERE desfecho IS NULL;

-- Imutabilidade: DELETE proibido; UPDATE só nas colunas desfecho_*
CREATE OR REPLACE FUNCTION public.agent_feedback_guard_mutacao()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent_feedback é append-only (DELETE proibido)';
  END IF;
  IF (NEW.card_id, NEW.todo_id, NEW.agent_name, NEW.action_key_sugerida,
      NEW.oc_sugerida, NEW.oc_executada, NEW.veredito, NEW.origem,
      NEW.reason_code, NEW.reason_text, NEW.confianca, NEW.operador_id,
      NEW.modo, NEW.created_at)
     IS DISTINCT FROM
     (OLD.card_id, OLD.todo_id, OLD.agent_name, OLD.action_key_sugerida,
      OLD.oc_sugerida, OLD.oc_executada, OLD.veredito, OLD.origem,
      OLD.reason_code, OLD.reason_text, OLD.confianca, OLD.operador_id,
      OLD.modo, OLD.created_at) THEN
    RAISE EXCEPTION 'agent_feedback: só as colunas desfecho_* podem ser atualizadas';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_feedback_no_delete
  BEFORE DELETE ON public.agent_feedback
  FOR EACH ROW EXECUTE FUNCTION public.agent_feedback_guard_mutacao();
CREATE TRIGGER agent_feedback_update_so_desfecho
  BEFORE UPDATE ON public.agent_feedback
  FOR EACH ROW EXECUTE FUNCTION public.agent_feedback_guard_mutacao();

-- RLS: leitura só gestor (InitPlan — mig 242); escrita só service_role
-- (RPCs SECURITY DEFINER / edge functions). Sem policy de INSERT/UPDATE
-- para authenticated de propósito.
ALTER TABLE public.agent_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY agent_feedback_select_gestor ON public.agent_feedback
  FOR SELECT TO authenticated
  USING ((SELECT public.current_operador_papel()) = 'gestor');

-- ============================================================
-- 2. motivo_bank — chips versionados do popup de divergência.
--    Orquestrador PROPÕE (status=pendente, criado_por=orquestrador);
--    só admin aprova; o front só renderiza status=aprovado.
-- ============================================================

CREATE TABLE public.motivo_bank (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contexto text NOT NULL DEFAULT 'popup_divergencia',
  codigo text NOT NULL,
  label text NOT NULL,
  versao integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente','aprovado','aposentado')),
  criado_por text NOT NULL DEFAULT 'admin'
    CHECK (criado_por IN ('admin','orquestrador')),
  aprovado_por uuid REFERENCES public.operadores(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contexto, codigo, versao)
);

COMMENT ON TABLE public.motivo_bank IS
  'Chips/perguntas versionados exibidos ao operador (popup de divergência). IA propõe, admin aprova, front só mostra aprovados.';

ALTER TABLE public.motivo_bank ENABLE ROW LEVEL SECURITY;

-- operador precisa ler os chips aprovados no popup; gestor lê tudo
CREATE POLICY motivo_bank_select ON public.motivo_bank
  FOR SELECT TO authenticated
  USING (status = 'aprovado'
         OR (SELECT public.current_operador_papel()) = 'gestor');
-- escrita só via service_role (edge/RPC) — sem policy de escrita

INSERT INTO public.motivo_bank (contexto, codigo, label, status, criado_por) VALUES
  ('popup_divergencia', 'contexto_insuficiente', 'A IA não viu o contexto todo', 'aprovado', 'admin'),
  ('popup_divergencia', 'acao_errada',           'A ação sugerida era errada',   'aprovado', 'admin'),
  ('popup_divergencia', 'cliente_excecao',       'Esse cliente é exceção',       'aprovado', 'admin'),
  ('popup_divergencia', 'template_errado',       'E-mail/template errado',       'aprovado', 'admin'),
  ('popup_divergencia', 'ssw_desatualizado',     'SSW estava desatualizado',     'aprovado', 'admin'),
  ('popup_divergencia', 'nao_deveria_ter_agido', 'A IA não deveria ter sugerido nada', 'aprovado', 'admin'),
  ('popup_divergencia', 'outro',                 'Outro motivo',                 'aprovado', 'admin');

-- ============================================================
-- 3. learning_log — abre espaço pro orquestrador interno:
--    agente novo, tipos de pergunta/resposta/relatório, status respondido.
--    Tabela está vazia em produção (verificado 2026-07-17) → ALTER barato.
-- ============================================================

ALTER TABLE public.learning_log DROP CONSTRAINT learning_log_agente_check;
ALTER TABLE public.learning_log ADD CONSTRAINT learning_log_agente_check
  CHECK (agente = ANY (ARRAY['triagem-noturna','aprendizado-continuo','agente-aprendizado']));

ALTER TABLE public.learning_log DROP CONSTRAINT learning_log_tipo_check;
ALTER TABLE public.learning_log ADD CONSTRAINT learning_log_tipo_check
  CHECK (tipo = ANY (ARRAY[
    'incidente_detectado','incidente_resolvido','padrao_identificado',
    'ajuste_sugerido','ajuste_aprovado','ajuste_rejeitado','ajuste_aplicado',
    'ajuste_revertido','metrica_snapshot','impacto_medido',
    'pergunta','resposta_admin','relatorio_semanal']));

ALTER TABLE public.learning_log DROP CONSTRAINT learning_log_status_check;
ALTER TABLE public.learning_log ADD CONSTRAINT learning_log_status_check
  CHECK (status = ANY (ARRAY[
    'aberto','aprovado','rejeitado','aplicado','revertido','observacao','respondido']));

-- ============================================================
-- 4. v_agent_feedback_unificado — o Sinal de Ouro como view.
--    UNION ALL das 3 tabelas de feedback (normalizadas) + agent_feedback.
--    Método idêntico ao relatório validado de 13/07 (join POR SUGESTÃO,
--    nunca por card). Abstenção separada de erro (spec §9):
--    oc13 com decisao_ia.erro_msg = falha técnica → abstencao.
-- ============================================================

CREATE VIEW public.v_agent_feedback_unificado
WITH (security_invoker = on) AS
WITH base AS (
  SELECT
    'agente-sugere-ocs-padrao'::text AS agent_name,
    f.card_id,
    f.corrigido_em                   AS decidido_em,
    CASE
      WHEN f.tipo_feedback = 'caso_nao_reconhecido'   THEN 'abstencao'
      WHEN f.tipo_feedback LIKE 'sugestao_certa%'     THEN 'seguida'
      ELSE 'corrigida'
    END AS veredito,
    CASE WHEN f.tipo_feedback LIKE '%explicita' THEN 'explicit' ELSE 'implicit' END AS origem,
    f.codigo_oc_card                 AS oc_card,
    CASE WHEN f.decisao_ia->>'proposta_destacada' ~ '^\d+$'
         THEN (f.decisao_ia->>'proposta_destacada')::int END AS oc_sugerida,
    f.decisao_correta_codigo_ssw     AS oc_executada,
    NULL::text                       AS reason_code,
    f.motivo_correcao                AS reason_text,
    CASE WHEN f.decisao_ia->>'confianca' ~ '^[0-9.]+$'
         THEN (f.decisao_ia->>'confianca')::numeric END AS confianca,
    f.corrigido_por_nome,
    'agente_ocs_padrao_feedback'::text AS fonte_tabela,
    f.id                             AS fonte_id
  FROM public.agente_ocs_padrao_feedback f

  UNION ALL

  SELECT
    'agente-oc13-autonomo',
    f.card_id,
    f.corrigido_em,
    CASE
      WHEN f.decisao_ia ? 'erro_msg'              THEN 'abstencao'  -- falha técnica ≠ erro de decisão
      WHEN f.tipo_feedback LIKE 'sugestao_certa%' THEN 'seguida'
      ELSE 'corrigida'
    END,
    CASE WHEN f.tipo_feedback LIKE '%explicita' THEN 'explicit' ELSE 'implicit' END,
    13,
    CASE WHEN split_part(f.decisao_ia->>'proposta_destacada_acao', ':', 2) ~ '^\d+$'
         THEN split_part(f.decisao_ia->>'proposta_destacada_acao', ':', 2)::int END,
    f.decisao_correta_codigo_ssw,
    NULL::text,
    f.motivo_correcao,
    CASE WHEN f.decisao_ia->>'confianca' ~ '^[0-9.]+$'
         THEN (f.decisao_ia->>'confianca')::numeric END,
    f.corrigido_por_nome,
    'agente_oc13_feedback',
    f.id
  FROM public.agente_oc13_feedback f

  UNION ALL

  SELECT
    'interpretador-resposta-cliente',
    f.card_id,
    f.corrigido_em,
    CASE WHEN f.tipo_feedback LIKE 'acertou%' THEN 'seguida' ELSE 'corrigida' END,
    CASE WHEN f.tipo_feedback LIKE '%explicito' THEN 'explicit' ELSE 'implicit' END,
    f.oc_card_no_momento,
    f.oc_sugerida_pela_ia,
    f.decisao_correta_codigo_ssw,
    NULL::text,
    f.motivo_correcao,
    CASE WHEN f.decisao_ia->>'confianca' ~ '^[0-9.]+$'
         THEN (f.decisao_ia->>'confianca')::numeric END,
    f.corrigido_por_nome,
    'interpretador_resposta_cliente_feedback',
    f.id
  FROM public.interpretador_resposta_cliente_feedback f

  UNION ALL

  SELECT
    af.agent_name, af.card_id, af.created_at, af.veredito, af.origem,
    NULL::int, af.oc_sugerida, af.oc_executada, af.reason_code, af.reason_text,
    af.confianca, NULL::text, 'agent_feedback', af.id
  FROM public.agent_feedback af
)
SELECT
  b.*,
  c.responsavel_relacionamento AS operador_card,
  c.empresa_cliente,
  c.pagador,
  c.nf
FROM base b
LEFT JOIN public.cards c ON c.id = b.card_id;

COMMENT ON VIEW public.v_agent_feedback_unificado IS
  'Sinal de Ouro unificado: um par sugestão×decisão por linha, método do relatório validado 13/07. Fonte canônica do painel IA/Aprendizado e do orquestrador.';

-- ============================================================
-- 5. v_sinal_ouro_metricas_diarias — placar v2 (substitui, para o
--    painel novo, as v_*_metricas antigas que casavam feedback POR CARD
--    e inflavam números; as antigas ficam intactas até o merge).
--    Abstenção fora do denominador de acerto (spec §9).
-- ============================================================

CREATE VIEW public.v_sinal_ouro_metricas_diarias
WITH (security_invoker = on) AS
SELECT
  (u.decidido_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
  u.agent_name,
  u.oc_card,
  u.oc_sugerida,
  u.operador_card,
  count(*)                                        AS pares,
  count(*) FILTER (WHERE u.veredito = 'seguida')  AS seguidas,
  count(*) FILTER (WHERE u.veredito = 'corrigida') AS corrigidas,
  count(*) FILTER (WHERE u.veredito IN ('abstencao','nao_rodou')) AS abstencoes,
  count(*) FILTER (WHERE u.origem = 'explicit')   AS explicitos,
  round(100.0 * count(*) FILTER (WHERE u.veredito = 'seguida')
        / NULLIF(count(*) FILTER (WHERE u.veredito IN ('seguida','corrigida')), 0), 1)
    AS pct_acerto
FROM public.v_agent_feedback_unificado u
GROUP BY 1, 2, 3, 4, 5;

-- ============================================================
-- 6. v_oc_lancada_por_fora — divergência "fez por fora do Cockpit",
--    derivada do evento que o sync-bastao JÁ emite. Zero toque no sync.
-- ============================================================

CREATE VIEW public.v_oc_lancada_por_fora
WITH (security_invoker = on) AS
SELECT
  ce.card_id,
  ce.created_at AS ocorrido_em,
  CASE WHEN ce.payload->>'todo_id' ~ '^[0-9a-f-]{36}$'
       THEN (ce.payload->>'todo_id')::uuid END AS todo_id,
  CASE WHEN ce.payload->>'cod_atual_bastao' ~ '^\d+$'
       THEN (ce.payload->>'cod_atual_bastao')::int END AS oc_lancada_por_fora,
  t.proposta_payload->>'acao_key' AS acao_key_proposta,
  CASE WHEN split_part(t.proposta_payload->>'acao_key', ':', 2) ~ '^\d+$'
       THEN split_part(t.proposta_payload->>'acao_key', ':', 2)::int END AS oc_proposta,
  c.responsavel_relacionamento AS operador_card,
  c.empresa_cliente,
  c.pagador,
  c.nf
FROM public.card_events ce
LEFT JOIN public.todos t
  ON ce.payload->>'todo_id' ~ '^[0-9a-f-]{36}$'
 AND t.id = (ce.payload->>'todo_id')::uuid
LEFT JOIN public.cards c ON c.id = ce.card_id
WHERE ce.event_type = 'TodoAutoCanceladoOcLancadaPorFora';

COMMIT;
