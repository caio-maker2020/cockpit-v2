-- ============================================================================
-- Cockpit v2 — DENTAL SORRIA sai da visão da LARISSA (cards já existentes)
-- Caio 2026-06-11
--
-- Contexto:
--   A mig 193 (2026-06-05) desativou contatos_cliente + colocou os 2 CNPJs
--   de DENTAL SORRIA em cnpjs_excluidos_cockpit. Isso barra NF NOVA e a
--   re-atribuição via sync-bastao (que pula CNPJ excluído antes de tocar o
--   card). MAS não mexeu nos cards que JÁ estavam no Cockpit atribuídos à
--   LARISSA — eles continuaram na visão dela, e ela seguiu operando o
--   cliente (em 2026-06-11 ainda aprovou ação + enviou resposta manual).
--
--   Cliente migrou pra operador que AINDA não está cadastrado na plataforma.
--   Enquanto o novo operador não entra, os cards ficam DESATRIBUÍDOS
--   (assigned_operator_id = NULL, responsavel_relacionamento = NULL) — mesmo
--   padrão "carteira_dormente" / AMPLA SLI TRANS. Saem da visão da LARISSA
--   em todos os estados (TRANSFERIDO/RESOLVIDO/AGUARDANDO_CLIENTE).
--
-- Acompanha (código): _shared/operador-resolver.ts passa a respeitar
--   cnpjs_excluidos_cockpit → CNPJ excluído resolve pra NULL/NULL. Fecha o
--   furo do vinculador / sync-prioridades-ai-do-bastao, que re-resolviam o
--   operador via segmento 010 (que a LARISSA possui) e devolviam o card pra
--   ela na próxima resposta do cliente.
--
-- Event sourcing (INV 0002): cada card desatribuído gera um card_event
--   ANTES do UPDATE da projeção, capturando o operador anterior.
--
-- Idempotente: alvo = cards de DENTAL SORRIA AINDA atribuídos à LARISSA.
--   Após rodar, ficam NULL → re-run não encontra nada (0 eventos, 0 updates).
--
-- skill: supabase-postgres-best-practices
--   * UPDATE por id (PK) em ~37 linhas — lock trivial, sem schema novo.
--   * Sem índice novo: o fallback do resolver usa o PK único de
--     cnpjs_excluidos_cockpit (cnpj_pagador).
-- ============================================================================

-- 1) Eventos (captura operador anterior ANTES de zerar a projeção)
INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT
  c.id,
  'CardDesatribuidoClienteMigrouDeOperador',
  'system',
  'migration-201-dental-sorria',
  jsonb_build_object(
    'motivo', 'cliente DENTAL SORRIA migrou pra operador ainda nao cadastrado na plataforma',
    'operador_anterior_id', c.assigned_operator_id,
    'responsavel_anterior', c.responsavel_relacionamento,
    'cnpjs', jsonb_build_array('03662136000155', '03662136000236'),
    'mig', 201
  )
FROM public.cards c
JOIN public.operadores o ON o.id = c.assigned_operator_id
WHERE o.nome = 'LARISSA'
  AND (
        c.agent_state->>'cnpj_pagador' IN ('03662136000155', '03662136000236')
        OR upper(coalesce(c.pagador, '')) LIKE '%DENTAL%SORRIA%'
      );

-- 2) Projeção: desatribui (NULL/NULL) os mesmos cards
UPDATE public.cards c
SET assigned_operator_id      = NULL,
    responsavel_relacionamento = NULL,
    updated_at                = now()
FROM public.operadores o
WHERE o.id = c.assigned_operator_id
  AND o.nome = 'LARISSA'
  AND (
        c.agent_state->>'cnpj_pagador' IN ('03662136000155', '03662136000236')
        OR upper(coalesce(c.pagador, '')) LIKE '%DENTAL%SORRIA%'
      );
