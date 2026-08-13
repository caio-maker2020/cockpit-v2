-- =============================================================================
-- 2026-08-13_339_fase4_loop_cobre_todos_agentes.sql
--
-- FASE 4 (Caio 2026-08-13): o loop de melhoria passa a enxergar TODOS os
-- agentes medidos, sem mudar uma linha do agente de aprendizado nem do chat.
--
-- DESCOBERTA QUE MUDOU O PLANO: o loop que o Caio descreveu — "roda no erro,
-- entende o que gerou a ação diferente, e pergunta especificamente o que
-- precisa saber" — JÁ EXISTE e funciona (`agente-aprendizado` +
-- `_shared/aprendizado-regras.ts`: agruparPorSugestao → montarPergunta →
-- selecionarPerguntas → learning_log → chat do agente-chefe).
-- Ele só estava cego: lia `v_agent_feedback_unificado`, que cobre 3 agentes
-- (com 6,9% de atribuição errada) em vez dos 5 da fonte única.
--
-- Por isso a Fase 4 NÃO reescreve o loop. Troca a IMPLEMENTAÇÃO da view que
-- ele consome, mantendo as 10 colunas do contrato
-- (agent_name, veredito, origem, oc_card, oc_sugerida, oc_executada,
--  reason_text, operador_card, nf, decidido_em).
-- Consequência: agente-aprendizado, chat do agente-chefe, painel e replay
-- passam a cobrir todos os agentes automaticamente. Zero mudança de código.
--
-- PRÉ-REQUISITO: mig 338 aplicada (fonte única populada e com dual-write).
-- REVERSÍVEL: a definição antiga está preservada em
--             `v_agent_feedback_unificado_legado` — basta um CREATE OR REPLACE
--             de volta se algo se comportar diferente.
-- =============================================================================

-- Guarda a implementação atual antes de trocar (rollback em 1 comando).
create or replace view public.v_agent_feedback_unificado_legado as
select * from public.v_agent_feedback_unificado;

comment on view public.v_agent_feedback_unificado_legado is
  'Fotografia do UNION ALL das 3 tabelas legadas, antes do corte pra fonte '
  'única (mig 339). Rollback: CREATE OR REPLACE VIEW v_agent_feedback_unificado '
  'AS SELECT * FROM v_agent_feedback_unificado_legado. Caio 2026-08-13.';

-- ─────────────────────────────────────────────────────────────────────────────
-- O corte: mesmo contrato, fonte nova.
--
-- `operador_card` e `nf` vêm de `cards` (a fonte única guarda card_id, não os
-- denormaliza). `fonte_tabela`/`fonte_id` seguem preenchidos pra auditoria.
-- ─────────────────────────────────────────────────────────────────────────────
-- ORDEM DAS COLUNAS É CONTRATO: `CREATE OR REPLACE VIEW` só aceita ACRESCENTAR
-- coluna no fim — não reordenar nem remover. As 18 abaixo estão na ordem exata
-- da view atual (conferida em information_schema antes de escrever).
create or replace view public.v_agent_feedback_unificado as
select
  af.agent_name,                                       -- 1
  af.card_id,                                          -- 2
  af.created_at                       as decidido_em,  -- 3
  af.veredito,                                         -- 4
  af.origem,                                           -- 5
  af.oc_card,                                          -- 6
  af.oc_sugerida,                                      -- 7
  af.oc_executada,                                     -- 8
  af.reason_code,                                      -- 9
  af.reason_text,                                      -- 10
  af.confianca,                                        -- 11
  op.nome                             as corrigido_por_nome, -- 12
  'agent_feedback'::text              as fonte_tabela, -- 13
  af.id                               as fonte_id,     -- 14
  opc.nome                            as operador_card,-- 15
  c.empresa_cliente,                                   -- 16
  c.pagador,                                           -- 17
  c.nf                                                 -- 18
from public.agent_feedback af
left join public.cards c        on c.id = af.card_id
left join public.operadores op  on op.id = af.operador_id
left join public.operadores opc on opc.id = c.assigned_operator_id;

comment on view public.v_agent_feedback_unificado is
  'Contrato do loop de aprendizado, agora servido pela FONTE ÚNICA '
  '(agent_feedback) em vez do UNION das 3 tabelas legadas — cobre todos os '
  'agentes medidos, com atribuição correta. Mesmas colunas de antes: o '
  'agente-aprendizado, o chat e o painel não precisaram mudar. Caio 2026-08-13.';

grant select on public.v_agent_feedback_unificado to authenticated, service_role;
grant select on public.v_agent_feedback_unificado_legado to authenticated, service_role;
