-- ============================================================================
-- Cockpit v2 — Idempotência SSW por AÇÃO (todo), não por vida do card
-- Caio 2026-06-15
--
-- REGRESSÃO QUE ISTO CORRIGE (commit be8435b, portal-101, 2026-06-09):
-- A mig 194 criou `acoes_executadas_ssw` com UNIQUE (card_id, codigo_oc, ctrc)
-- SEM dimensão de tempo/ciclo/ação. A intenção declarada era barrar PGMQ
-- redelivery + dupla aprovação acidental (dedup de AÇÃO, janela curta), mas o
-- índice ficou com escopo de VIDA INTEIRA do card: depois que uma oc dá certo
-- num CTRC, ela NUNCA MAIS pode ser relançada nesse CTRC.
--
-- Isso quebra uma regra inviolável do negócio: no ciclo de UMA NF a mesma oc se
-- repete legitimamente (ex: oc=54 pedir retorno → cliente responde → segue
-- entrega → recusa de novo → NOVA oc=54). Antes do portal-101 (WebAPI com
-- idempotency_key transiente) isso funcionava — pré-09/06 a NF 351193 lançou
-- oc=56 cinco vezes, NF 756800 oc=54 três vezes, etc. Primeiro skip indevido:
-- 2026-06-10 17:59 (NF 1084123). Caso âncora do diagnóstico: NF 345523 (oc=54
-- aprovada 2× em 15/06, ambas viraram idempotent_skip da linha de 11/06, SSW
-- nunca recebeu a oc nova — só o e-mail saiu).
--
-- FIX: a chave de idempotência passa a incluir `todo_id`. Cada `todo` (uma
-- aprovação / uma ação) lança no máximo 1×; PGMQ redelivery e duplo-clique do
-- MESMO todo continuam deduplicados (mesmo todo_id → conflito → skip). Ciclo
-- novo = proposta nova = todo_id novo = SEM conflito = lançamento real.
--
-- skill: supabase-postgres-best-practices
--   * Tabela pequena (~309 linhas) e baixa taxa de escrita → DROP/ADD CONSTRAINT
--     com lock ACCESS EXCLUSIVE é instantâneo na prática (sem CONCURRENTLY).
--   * As linhas existentes já são únicas em (card_id, codigo_oc, ctrc), logo
--     adicionar todo_id à chave NÃO pode gerar duplicata → ADD CONSTRAINT seguro
--     sem dedup prévio.
--   * todo_id é nullable (FK ON DELETE SET NULL). UNIQUE trata NULLs como
--     DISTINTOS (default NULLS DISTINCT): linhas com todo_id NULL não deduplicam
--     entre si — aceitável porque TODO lançamento via envelope `lancarSswPortal`
--     carrega o todo_id do executor (m.todo_id). Não usamos NULLS NOT DISTINCT
--     pra não colidir ações distintas que porventura percam o todo (FK SET NULL).
-- ============================================================================

ALTER TABLE public.acoes_executadas_ssw
  DROP CONSTRAINT acoes_executadas_ssw_card_id_codigo_oc_ctrc_key;

ALTER TABLE public.acoes_executadas_ssw
  ADD CONSTRAINT acoes_executadas_ssw_card_oc_ctrc_todo_key
  UNIQUE (card_id, codigo_oc, ctrc, todo_id);

COMMENT ON CONSTRAINT acoes_executadas_ssw_card_oc_ctrc_todo_key
  ON public.acoes_executadas_ssw IS
  'Idempotência por AÇÃO: dedup só do MESMO todo (PGMQ redelivery / duplo-clique). Ciclo novo = todo novo = lançamento real. Caio 2026-06-15 — corrige regressão be8435b que bloqueava relançar a mesma oc num ciclo novo.';
