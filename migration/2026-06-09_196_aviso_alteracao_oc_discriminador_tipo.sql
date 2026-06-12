-- ============================================================================
-- Cockpit v2 — Discriminador `tipo` em cards.aviso_alteracao_oc
-- Data: 2026-06-09
--
-- Contexto:
--   A coluna `aviso_alteracao_oc` (jsonb) virou handle universal de "banner
--   ativo no card" — múltiplos shapes coexistem, discriminados por `tipo`:
--     - "alteracao_oc_durante_lock"  (sync-bastao Pass A/D, atualizar-card-via-portal-ssw)
--     - "ia_sugestao_ocs_padrao"     (agente-sugere-ocs-padrao)
--     - "ia_sugestao_oc13"           (agente-oc13-autonomo, sugestão)
--     - "ia_oc13_autonoma"           (agente-oc13-autonomo, execução autônoma)
--     - "ia_oc13_falhou"             (agente-oc13-autonomo, falha)
--     - "ia_ocs_padrao_aguardando"   (agente-sugere-ocs-padrao, retry transiente)
--     - "ia_ocs_padrao_falhou"       (agente-sugere-ocs-padrao, falha definitiva)
--
-- Bug observado (NF da imagem, oc=10):
--   sync-bastao escrevia `{oc_anterior, oc_atual, alterada_em}` SEM `tipo`.
--   Depois o agente-sugere-ocs-padrao sobrescreveu com `tipo: ia_sugestao_ocs_padrao`
--   (sem `oc_anterior/oc_atual/alterada_em`). Front [lovable-cards-acoes.md:290]
--   renderizava banner amarelo sem checar `tipo` → mostrava
--   "oc — para oc — em Invalid Date".
--
-- Fix (3 partes, esta migration é a parte SQL):
--   1. sync-bastao + atualizar-card-via-portal-ssw agora gravam
--      `tipo: "alteracao_oc_durante_lock"` (commit acompanhante).
--   2. Front discrimina por tipo antes de renderizar (lovable-cards-acoes.md).
--   3. Esta migration: backfill cards com shape inválido + comment atualizado.
-- ============================================================================

-- 1. Backfill: cards com aviso sem `tipo` MAS com oc_anterior → carimba o tipo
--    correto ("alteracao_oc_durante_lock"). Era o shape original da mig 041.
UPDATE public.cards
SET aviso_alteracao_oc = aviso_alteracao_oc || jsonb_build_object('tipo', 'alteracao_oc_durante_lock')
WHERE aviso_alteracao_oc IS NOT NULL
  AND NOT (aviso_alteracao_oc ? 'tipo')
  AND aviso_alteracao_oc ? 'oc_anterior';

-- 2. Backfill: cards com aviso sem `tipo` E sem `oc_anterior` → shape inválido
--    (resíduo de cenários onde agente IA sobrescreveu parcialmente o JSONB
--    em versões anteriores). Limpa pra null — o agente-sugere-ocs-padrao
--    re-roda no próximo cron e regrava com o shape correto se for o caso.
UPDATE public.cards
SET aviso_alteracao_oc = NULL
WHERE aviso_alteracao_oc IS NOT NULL
  AND NOT (aviso_alteracao_oc ? 'tipo')
  AND NOT (aviso_alteracao_oc ? 'oc_anterior');

-- 3. Documenta a coluna como discriminada por `tipo`.
COMMENT ON COLUMN public.cards.aviso_alteracao_oc IS
  'Estado de banner do card, discriminado por `tipo` (jsonb). Front renderiza componente diferente por `tipo`. Tipos válidos: alteracao_oc_durante_lock (sync-bastao Pass A/D + atualizar-card-via-portal-ssw quando oc muda durante lock), ia_sugestao_ocs_padrao / ia_sugestao_oc13 / ia_oc13_autonoma / ia_oc13_falhou / ia_ocs_padrao_aguardando / ia_ocs_padrao_falhou (agentes IA). RPCs aprovar_e_executar / voltar_para_to_do / marcar_retorno_inconclusivo limpam quando operadora age. Toda gravação NOVA aqui DEVE incluir `tipo` — sem `tipo` o front não consegue discriminar e o banner velho de alteração de oc renderiza com campos undefined.';
