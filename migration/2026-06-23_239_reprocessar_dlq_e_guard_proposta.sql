-- ============================================================================
-- Cockpit v2 — INV-016: "cliente respondeu → SEMPRE visível no Cockpit"
-- Data: 2026-06-23
--
-- Incidente âncora (NF 761583, F E F DISTRIBUI A1): Anthropic 529 (Overloaded)
-- entre 14:18–14:57 UTC. O triador (classifica TODA mensagem via LLM) falhou e
-- jogou 13 respostas de clientes no dead_letter. SEM reprocessamento → cards
-- ficaram presos: 761583 mostrava "CLIENTE RESPONDEU" + IA sugeriu oc 44 mas
-- ZERO botões; outros 5 cards (AGUARDANDO_CLIENTE) nem apareceram como
-- respondidos. Regra inviolável violada.
--
-- Esta migration entrega a infra de defesa (o código vive nas edge functions):
--   1. RPC cards_cliente_respondeu_sem_proposta — alvos da rede de segurança
--      (cron-ia-resposta-pendentes recria propostas determinísticas).
--   2. RPC dlq_resumo_cliente — health-check alerta o Caio sobre mensagens de
--      cliente presas no DLQ.
--
-- ⚠️ NÃO criamos cron novo (Caio 2026-06-23): o apagão deste mesmo dia teve como
-- causa #2 o THUNDERING HERD de cron (14 jobs vs 6 worker slots do tier).
-- Ver memory project_incidente_apagao_rls_per_row_tier_ceiling_2026_06_23. Em vez
-- de um 15º cron, o `cron-ia-resposta-pendentes` (que já roda 1min) dispara o
-- `reprocessar-dlq` via invokeNext (fire-and-forget) — zero worker slot novo.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Cards "cliente respondeu mas sem proposta" — alvo da rede de segurança G2.
--    Card em AGUARDANDO_VALIDACAO_HUMANA com cliente_respondeu_em != null
--    DEVE ter propostas pendentes (operador precisa dos botões). Se tem 0, o
--    caminho primário (vinculador/scan-email) falhou → recriar.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cards_cliente_respondeu_sem_proposta(p_limit int DEFAULT 50)
RETURNS TABLE (id uuid, nf text, cliente_respondeu_em timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.id, c.nf, c.cliente_respondeu_em
  FROM public.cards c
  WHERE c.state = 'AGUARDANDO_VALIDACAO_HUMANA'
    AND c.cliente_respondeu_em IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.todos t
      WHERE t.card_id = c.id AND t.status = 'pendente'
    )
  ORDER BY c.cliente_respondeu_em ASC
  LIMIT GREATEST(1, LEAST(p_limit, 200));
$$;

COMMENT ON FUNCTION public.cards_cliente_respondeu_sem_proposta(int) IS
  'INV-016: cards em CLIENTE RESPONDEU (AVH + cliente_respondeu_em) sem nenhuma proposta pendente. Rede de segurança recria as propostas. NF 761583 / 2026-06-23.';

GRANT EXECUTE ON FUNCTION public.cards_cliente_respondeu_sem_proposta(int) TO service_role;

-- ----------------------------------------------------------------------------
-- 2. Resumo do DLQ de mensagens de cliente (agent_intake/agent_specialist).
--    Read-only (NÃO consome a fila — health-check usa pra alertar sem mexer no
--    vt que o reprocessador depende). Retorna só o que importa pro alerta.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dlq_resumo_cliente()
RETURNS TABLE (
  source_queue text,
  total bigint,
  travadas bigint,          -- já esgotaram MAX_REPROCESS (4) tentativas
  mais_antiga timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    (d.message->>'source_queue')::text AS source_queue,
    count(*) AS total,
    count(*) FILTER (
      WHERE COALESCE((d.message->'original_payload'->>'_reprocess_attempt')::int, 0) >= 4
    ) AS travadas,
    min((d.message->>'archived_at')::timestamptz) AS mais_antiga
  FROM pgmq.q_dead_letter d
  WHERE d.message->>'source_queue' IN ('agent_intake', 'agent_specialist')
    -- só falhas RECENTES (últimas 24h). Cruft ancestral no DLQ não vira alerta
    -- perpétuo; o reprocessador também só age em <60min (MAX_IDADE_REPROCESS_MS).
    AND (d.message->>'archived_at')::timestamptz > now() - interval '24 hours'
  GROUP BY 1;
$$;

COMMENT ON FUNCTION public.dlq_resumo_cliente() IS
  'INV-016: resumo read-only das mensagens de cliente presas no dead_letter. health-check alerta o Caio. NF 761583 / 2026-06-23.';

GRANT EXECUTE ON FUNCTION public.dlq_resumo_cliente() TO service_role;

-- 3. (SEM cron novo — ver nota no topo.) O `reprocessar-dlq` é disparado por
--    invokeNext dentro do `cron-ia-resposta-pendentes`. Se um dia o tier for
--    grande e quiser um cron dedicado, agende aqui replicando o padrão de
--    `2026-05-11_081_cron_ia_resposta_pendentes.sql`.
