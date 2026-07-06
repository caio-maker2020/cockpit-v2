-- 2026-07-06_290 — Consolidar template de oc=35 em RECUSA_PARCIAL
--
-- CONTEXTO (Caio 2026-07-06):
-- A oc=35 ("Entrega realizada com recusa parcial") tinha DOIS templates
-- concorrendo: RECUSA_PARCIAL (legado, corpo limpo) e
-- ENTREGA_PARCIAL_APOS_FALTA_VOLUME (default da IA). O segundo tem nome
-- ENGANOSO — "FALTA_VOLUME" é semântica de oc=19 (entrega COM falta =
-- extravio, só ressarcimento, nada a devolver), NÃO de oc=35 (recusa
-- parcial = SEMPRE tem volume físico parado pra devolver). O nome nasceu
-- de uma premissa da Larissa (mig 170) que o próprio Caio derrubou depois
-- (migs 176/177 esvaziaram o corpo de qualquer menção a falta de volume).
--
-- DECISÃO: consolidar 2 → 1. O template oficial da oc=35 é RECUSA_PARCIAL,
-- com o CORPO LEGADO (mais limpo — abre com "o destinatário recusou parte
-- da mercadoria", SEM a expressão "entregue parcialmente" que confundia
-- com a oc=19). ENTREGA_PARCIAL_APOS_FALTA_VOLUME é DEPRECADO (ativo=false),
-- não deletado — a linha persiste pra não quebrar FK/histórico de cards
-- que já a referenciam (o executor busca por ID mesmo com ativo=false; o
-- ativo só controla a visibilidade no dropdown).
--
-- Distinção inviolável (reforço INV-021, migs 254/267, NF 179799):
--   oc=19 → ENTREGUE_COM_FALTA_PEDIR_ROMANEIO (ressarcimento, nada a devolver)
--   oc=35 → RECUSA_PARCIAL (devolução dos volumes recusados)
--
-- Retroativo: cards que já carregam a sugestão antiga da IA em
-- analise_padrao_resultado e/ou aviso_alteracao_oc passam a apontar RECUSA_PARCIAL.
-- Idempotente: re-rodar é no-op (WHERE filtra pelo valor antigo).

BEGIN;

-- 1) RECUSA_PARCIAL permanece o template oficial da oc=35 (corpo já é o
--    escolhido desde a mig 210 — nada a alterar no corpo). Só garante ativo.
UPDATE public.templates_email
   SET ativo = true, updated_at = now()
 WHERE id = 'RECUSA_PARCIAL' AND ativo IS DISTINCT FROM true;

-- 2) Deprecar ENTREGA_PARCIAL_APOS_FALTA_VOLUME (nome enganoso). Mantém a
--    linha (histórico/FK), só tira do dropdown.
UPDATE public.templates_email
   SET ativo = false,
       descricao = 'DEPRECATED 2026-07-06 (mig 290) — consolidado em RECUSA_PARCIAL. Mesma ação (devolução dos volumes recusados na oc=35). Nome "FALTA_VOLUME" confundia com oc=19 (extravio/ressarcimento). Ver memória project_consolidar_template_recusa_parcial_oc35.',
       updated_at = now()
 WHERE id = 'ENTREGA_PARCIAL_APOS_FALTA_VOLUME';

-- 3) Retroativo — sugestão da IA gravada em cards.analise_padrao_resultado.
UPDATE public.cards
   SET analise_padrao_resultado =
         jsonb_set(analise_padrao_resultado, '{template_email_sugerido}', '"RECUSA_PARCIAL"'::jsonb, false)
 WHERE analise_padrao_resultado ->> 'template_email_sugerido' = 'ENTREGA_PARCIAL_APOS_FALTA_VOLUME';

-- 4) Retroativo — sugestão da IA replicada em cards.aviso_alteracao_oc (se presente).
UPDATE public.cards
   SET aviso_alteracao_oc =
         jsonb_set(aviso_alteracao_oc, '{template_email_sugerido}', '"RECUSA_PARCIAL"'::jsonb, false)
 WHERE aviso_alteracao_oc ->> 'template_email_sugerido' = 'ENTREGA_PARCIAL_APOS_FALTA_VOLUME';

COMMIT;

-- Verificação pós-migration (informativo — rodar manualmente):
--   select id, ativo from templates_email where id in ('RECUSA_PARCIAL','ENTREGA_PARCIAL_APOS_FALTA_VOLUME');
--     → RECUSA_PARCIAL=true, ENTREGA_PARCIAL_APOS_FALTA_VOLUME=false
--   select count(*) from cards where analise_padrao_resultado->>'template_email_sugerido' = 'ENTREGA_PARCIAL_APOS_FALTA_VOLUME';
--     → 0
