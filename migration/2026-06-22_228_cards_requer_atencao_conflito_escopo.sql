-- =============================================================================
-- Aba ⚠️ CONFLITOS — card em escopo protegido cuja última oc saiu de
-- relacionamento por lançamento POR FORA (erro de operação / outro time).
--
-- Caio 2026-06-22 (invariante "card em escopo protegido nunca sai sozinho"):
-- card em AGUARDANDO_VALIDACAO_HUMANA (AGUARDANDO VOCÊ) ou AGUARDANDO_CLIENTE
-- (oc=54) NÃO é mais movido automaticamente pelo sync (Pass B / ex-Pass E).
-- Quando a oc real (Bastão/SSW) sai de escopo, o sync FLAGGA via
-- cards.mudanca_suspeita com tipo="saiu_de_escopo" e o card aparece nesta aba
-- até o operador clicar FORÇAR ATUALIZAÇÃO (liberar_card_suspeito_lockado +
-- atualizar-card-via-portal-ssw).
--
-- Reaproveita a infra da mig 218 (coluna mudanca_suspeita + índice parcial
-- idx_cards_mudanca_suspeita). Discriminador `tipo` separa os 2 casos:
--   - "saiu_de_escopo"  → esta aba (v_cards_requer_atencao)
--   - "virou_extravio" / ausente (legado) → banner extravio (v_mudancas_suspeitas)
--
-- Sem ALTER TABLE: o jsonb já aceita os campos novos (tipo, origem_pass).
-- Sem índice novo: o parcial da mig 218 já cobre
-- (mudanca_suspeita IS NOT NULL AND vista_em IS NULL).
-- =============================================================================

-- 1. View do banner de EXTRAVIO (mig 218) — agora EXCLUI o caso novo
--    "saiu_de_escopo" pra não poluir o banner laranja de extravio. Mantém
--    todos os outros (tipo ausente = legado "virou_extravio").
DROP VIEW IF EXISTS public.v_mudancas_suspeitas;
CREATE VIEW public.v_mudancas_suspeitas
WITH (security_invoker = on) AS
SELECT
  c.id AS card_id,
  c.nf,
  (c.mudanca_suspeita->>'de_oc')::int       AS de_oc,
  (c.mudanca_suspeita->>'para_oc')::int     AS para_oc,
  c.mudanca_suspeita->>'de_state'           AS de_state,
  (c.mudanca_suspeita->>'requer_ok')::bool  AS requer_ok,
  (c.mudanca_suspeita->>'detectada_em')     AS detectada_em,
  c.state,
  c.assigned_operator_id
FROM public.cards c
WHERE c.mudanca_suspeita IS NOT NULL
  AND (c.mudanca_suspeita->>'vista_em') IS NULL
  AND (c.mudanca_suspeita->>'tipo') IS DISTINCT FROM 'saiu_de_escopo'
ORDER BY (c.mudanca_suspeita->>'detectada_em') DESC NULLS LAST;
GRANT SELECT ON public.v_mudancas_suspeitas TO authenticated, service_role;

-- 2. View da aba ⚠️ CONFLITOS — só o caso novo "saiu_de_escopo", agregando os
--    cards das 2 abas protegidas (state mostra de qual aba veio). security_invoker
--    herda a RLS de cards (operador vê só os seus; gestor vê tudo). Usa o índice
--    parcial idx_cards_mudanca_suspeita.
DROP VIEW IF EXISTS public.v_cards_requer_atencao;
CREATE VIEW public.v_cards_requer_atencao
WITH (security_invoker = on) AS
SELECT
  c.id AS card_id,
  c.nf,
  c.ctrc,
  c.state,                                          -- aba atual: AGUARDANDO_VALIDACAO_HUMANA / AGUARDANDO_CLIENTE
  c.empresa_cliente,
  c.assigned_operator_id,
  (c.mudanca_suspeita->>'de_oc')::int        AS de_oc,
  (c.mudanca_suspeita->>'para_oc')::int      AS para_oc,
  (c.mudanca_suspeita->>'para_oc')::int      AS oc_fora_escopo,  -- alias explícito p/ o front
  c.mudanca_suspeita->>'de_state'            AS de_state,
  c.mudanca_suspeita->>'origem_pass'         AS origem_pass,
  (c.mudanca_suspeita->>'detectada_em')      AS detectada_em
FROM public.cards c
WHERE c.mudanca_suspeita IS NOT NULL
  AND (c.mudanca_suspeita->>'vista_em') IS NULL
  AND (c.mudanca_suspeita->>'tipo') = 'saiu_de_escopo'
ORDER BY (c.mudanca_suspeita->>'detectada_em') DESC NULLS LAST;
GRANT SELECT ON public.v_cards_requer_atencao TO authenticated, service_role;

-- 3. Documenta o discriminador `tipo` na coluna.
COMMENT ON COLUMN public.cards.mudanca_suspeita IS
  'Sinal de transição suspeita detectada pelo sync, jsonb discriminado por `tipo`: '
  '"saiu_de_escopo" (Caio 2026-06-22) = card em escopo protegido (AGUARDANDO_VALIDACAO_HUMANA '
  'ou AGUARDANDO_CLIENTE) cuja última oc saiu de relacionamento por lançamento por fora — '
  'aparece na aba CONFLITOS (v_cards_requer_atencao), card NÃO é movido até FORÇAR ATUALIZAÇÃO; '
  '"virou_extravio"/ausente (legado mig 218, ADR 0005) = relacionamento→extravio, banner '
  'laranja (v_mudancas_suspeitas). Campos: {tipo,de_oc,para_oc,de_state,requer_ok,origem_pass,'
  'detectada_em,vista_em}. Some do banner/aba ao setar vista_em (marcar_mudanca_suspeita_vista '
  '/ liberar_card_suspeito_lockado).';
