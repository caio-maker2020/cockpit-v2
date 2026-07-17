-- =============================================================================
-- Materialização UNIVERSAL da oc 33 de completude — flag (DARK)
--
-- Caio 2026-07-17 (NF 135724 / DUILIO). Branch correcao-melhoria-oc33-
-- descricao-itens-pdfs-ssw. Bug: a oc 33 de completude do Caso 1 (100% dos
-- lançamentos reais) saía SEM descrição/valor dos itens — a materialização
-- (Emenda 2 Codex) só existia pro Caso 2, atrás de extravio_parcial_caso2_
-- enabled (OFF), e o curto-circuito "operador anexou → return vazio" suprimia
-- até o texto.
--
--   - extravio_parcial_materializacao_enabled (OFF neste mig — DARK): liga a
--     materialização em TODA oc 33 de completude (Caso 1 E Caso 2): texto do
--     dossiê SOMA com o do operador; anexos do dossiê reanexados quando o
--     operador não anexou (só image-mime; PDF → bloqueia com instrução);
--     imagem sintética se o texto estourar 500. Também nos handlers email+33
--     (texto). extravio_parcial_caso2_enabled segue valendo SÓ pro Tier B-DV
--     do agente-ressarcimento-relancar-54.
--
-- Rollout: mig 292 liga esta flag (após deploy do executor); mig 293 liga o
-- gate enforce. Idempotente (ON CONFLICT). Sem coluna nova.
-- =============================================================================

INSERT INTO public.feature_flags (key, description, enabled) VALUES
  ('extravio_parcial_materializacao_enabled',
   'Caio 2026-07-17 (NF 135724): materialização universal da oc 33 de '
   'completude (Caso 1 e 2) — desc/valor do dossiê SEMPRE no lançamento '
   '(texto soma com o do operador; imagem se >500; reanexo quando operador '
   'não anexou). OFF = comportamento antigo (dark).',
   false)
ON CONFLICT (key) DO NOTHING;
