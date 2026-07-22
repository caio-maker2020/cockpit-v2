-- ============================================================================
-- Cockpit v2 — Desliga o agente-ressarcimento-relancar-54 (separação 54/59)
-- Data: 2026-07-13 (Caio — separação 54/59, Bloco 6)
-- skill: supabase-postgres-best-practices
--
-- CONTEXTO: com a separação 54/59, o round-trip de ressarcimento (54→46→49)
-- passa a ser INDENIZAÇÃO (oc 59), não mais "relançar 54". O agente autônomo
-- `agente-ressarcimento-relancar-54` foi feito pro mundo 54-guarda-chuva e, em
-- modo sombra, cria propostas "relançar só a 54 sem e-mail" nos cards em oc 49 —
-- o que agora CONTRADIZ a lógica nova. Decisão do Caio (2026-07-13): desligar de
-- vez NESTA fase; NÃO substituir por um "relançar 59" agora (será recriado
-- depois). O operador trata o round-trip manualmente no intervalo (o card em oc
-- 49 aparece pra ele na aba correta). Caio aceitou explicitamente esse vão.
--
-- O QUE NÃO MEXER:
--   - A edge function `agente-ressarcimento-relancar-54` NÃO é apagada (será
--     recriada pro 59). O `_shared/ressarcimento-relancar-54.ts` também fica —
--     o EXECUTOR importa `deveBloquear54PedirDescValor` dele (guard B-DV).
--
-- COMO DESLIGA (2 camadas, à prova de reativação acidental):
--   1. Descadastra o cron `agente-ressarcimento-relancar-54` → a função nunca
--      mais é disparada automaticamente.
--   2. Master flag `ressarcimento_relancar54_enabled = false` → mesmo se alguém
--      invocar a função manualmente, ela retorna `flag_off` no 1º gate (index.ts
--      linha ~101), sem scan/proposta/lançamento. Autônomo explicitamente off.
--
-- skill checklist:
--   - cron.unschedule guardado por WHERE EXISTS (idempotente) ✓
--   - UPDATE feature_flags por key (idempotente) ✓
--   - sem RLS/índice/security_definer novos ✓
-- ============================================================================

-- 1. Descadastra o cron (idempotente — só se existir).
DO $$
BEGIN
  PERFORM cron.unschedule('agente-ressarcimento-relancar-54')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'agente-ressarcimento-relancar-54');
END $$;

-- 2. Master flag OFF (para o scan/sombra) + autônomo OFF (explícito). Idempotente:
--    enabled=false é no-op em re-run; o append de descrição é guardado por marcador.
UPDATE public.feature_flags
  SET enabled = false,
      description = CASE
        WHEN description LIKE '%[DESLIGADO 2026-07-13 pela separação 54/59%'
          THEN description
        ELSE description ||
          ' [DESLIGADO 2026-07-13 pela separação 54/59 (Bloco 6): round-trip vira '
          'oc 59 (indenização); operador trata manualmente até o agente ser recriado '
          'pro 59. Reativar exige recadastrar o cron 270 + revisar a regra pro 59.]'
      END
  WHERE key IN ('ressarcimento_relancar54_enabled', 'ressarcimento_relancar54_autonomo_enabled');

-- ----------------------------------------------------------------------------
-- 3. RETROATIVO (Caio 2026-07-13): as propostas-sombra que o agente criou
--    empurravam o operador pra LANÇAR 54 — mas o caso agora é INDENIZAÇÃO (oc
--    59). Em vez de cancelar e deixar o card pelado, REMAPEAMOS a proposta
--    54→59: o mesmo botão passa a "lançar 59" (COMO OPÇÃO no menu, nunca
--    autônomo — Caio 2026-07-13). Preserva template/e-mail/contexto que o agente
--    já resolveu. Dois tipos de proposta-sombra, ambos remapeiam igual:
--      (A) round-trip Tier A: tool=lancar_ocorrencia, sem e-mail
--          → "oc 59 sem e-mail" (reposiciona; cliente já notificado).
--          meta.origem='ressarcimento_relancar_54', acao_key='lancar_ocorrencia:54'
--      (B) pedir descrição/valor Tier B-DV: tool=lancar_oc_e_enviar_email + template
--          → "oc 59 + e-mail pedir descrição/valor".
--          meta.origem='ressarcimento_pedir_descricao_valor', acao_key='lancar_oc_e_enviar_email:54'
--    Remap = args.codigo_ssw 54→59 + acao_key ':54'→':59'. tool/template/e-mail
--    ficam intactos (o executor trata 59 via o mesmo caminho, stateFinalAposBastao(59)
--    → AGUARDANDO_CLIENTE). Se o agente nunca rodou em prod ("PENDENTE deploy"),
--    tudo aqui afeta 0 linhas — 100% idempotente/seguro.
-- ----------------------------------------------------------------------------

-- (a) card_event por card afetado ANTES das mutações (event sourcing, convenção 1).
--     Cobre os dois desfechos (remap ou cancelamento-por-colisão).
INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT DISTINCT t.card_id,
       'PropostaSombraRelancar54Tratada',
       'system',
       'mig_294_separacao_59',
       jsonb_build_object(
         'motivo', 'Separação 54/59: agente relançar-54 desligado; proposta de 54 remapeada p/ oc 59 (indenização) como OPÇÃO no menu — ou cancelada se o card já tinha a opção 59.',
         'origem_proposta', t.proposta_payload->'meta'->>'origem',
         'todo_id', t.id
       )
FROM public.todos t
WHERE t.status = 'pendente'
  AND (t.proposta_payload->'args'->>'codigo_ssw') = '54'
  AND t.proposta_payload->'meta'->>'origem'
      IN ('ressarcimento_relancar_54', 'ressarcimento_pedir_descricao_valor');

-- (b1) COLISÃO com o índice único uniq_todos_card_tool_cod_ativo (card_id, tool,
--      codigo_ssw): se o card JÁ tem um todo ATIVO de oc 59 no mesmo tool, o remap
--      violaria o índice. Nesse caso (raríssimo) cancela a proposta-sombra de 54 —
--      o card já tem a opção 59. Roda ANTES do remap pra limpar os colisores.
UPDATE public.todos
  SET status = 'cancelado',
      rejection_reason = 'Separação 54/59 (mig 294): card já tinha a opção de oc 59 no mesmo tool; proposta-sombra de 54 cancelada (evita duplicar).'
  WHERE status = 'pendente'
    AND (proposta_payload->'args'->>'codigo_ssw') = '54'
    AND proposta_payload->'meta'->>'origem'
        IN ('ressarcimento_relancar_54', 'ressarcimento_pedir_descricao_valor')
    AND EXISTS (
      SELECT 1 FROM public.todos t2
      WHERE t2.card_id = todos.card_id
        AND t2.id <> todos.id
        AND t2.status IN ('pendente', 'aprovado')
        AND (t2.proposta_payload->>'tool') = (todos.proposta_payload->>'tool')
        AND coalesce(t2.proposta_payload->'args'->>'codigo_ssw', '') = '59'
    );

-- (b2) remapeia a proposta 54→59 (codigo_ssw + acao_key) nos cards SEM colisão.
--      Preserva tool, template, email_destino e meta — só o alvo da oc muda. O
--      guard `= '54'` (+ já sem colisores após b1) torna idempotente e à prova do índice.
UPDATE public.todos
  SET proposta_payload = jsonb_set(
        jsonb_set(proposta_payload, '{args,codigo_ssw}', '59'::jsonb, false),
        '{acao_key}',
        to_jsonb(replace(proposta_payload->>'acao_key', ':54', ':59'))
      ),
      descricao = descricao || ' [remapeada p/ oc 59 — indenização (separação 54/59)]'
  WHERE status = 'pendente'
    AND (proposta_payload->'args'->>'codigo_ssw') = '54'
    AND proposta_payload->'meta'->>'origem'
        IN ('ressarcimento_relancar_54', 'ressarcimento_pedir_descricao_valor');

-- (c) limpa o banner (aviso_alteracao_oc) desses cards — o texto do banner falava
--     em "relançar 54" (agora stale) e era um DESTAQUE (quase-autônomo). Caio quer
--     59 só COMO OPÇÃO no menu, sem destaque. Só toca cards cujo aviso atual é de
--     um dos dois tipos do agente (não mexe em avisos de outra natureza).
UPDATE public.cards
  SET aviso_alteracao_oc = NULL
  WHERE aviso_alteracao_oc->>'tipo'
        IN ('ressarcimento_relancar_54', 'ressarcimento_pedir_descricao_valor');

-- (d) reseta o status interno 'recomendado' (pendente) → NULL. NÃO toca 'lancou'
--     (fato histórico: a 54 já foi relançada em algum momento).
UPDATE public.cards
  SET ressarc54_status = NULL,
      ressarc54_motivo = NULL
  WHERE ressarc54_status = 'recomendado';
