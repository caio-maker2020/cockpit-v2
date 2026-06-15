-- ============================================================================
-- Cockpit v2 — Corrige drift do ocorrencias_dicionario vs SSW (códigos 52 e 58)
-- Caio 2026-06-15
--
-- Contexto: ocorrencias_dicionario é seed estático (28/04) que o Lovable junta
-- (FK mig 009: cards.cod_ultima_ocorrencia → ocorrencias_dicionario.codigo) pra
-- exibir a ÚLTIMA OCORRÊNCIA do card. Ele drifou do SSW. A maioria das
-- divergências é só cosmética (Title Case vs CAIXA-ALTA), mas DOIS códigos
-- estavam com SIGNIFICADO errado (apontavam "destroca", que não é o que o SSW
-- usa nesses códigos). Caso âncora: NF 507827 (DUILIO) mostrava oc=52 como
-- "Finalização do processo de destroca" sendo que o SSW diz "TRATATIVA DE
-- RELACIONAMENTO PARA RETIRADA DA CARGA".
--
-- `descricao` é DISPLAY-only (só o JOIN do Lovable usa). A lógica
-- (sync-bastao roteamento de setor, safe-oc-update validação) usa apenas
-- `responsabilidade` e `codigo` — nunca `descricao`. Logo corrigir descricao
-- é seguro. Para o 58, a responsabilidade TAMBÉM estava errada (Relacionamento;
-- o correto é Devolução, validado pelo Caio 2026-06-15).
--
-- Decisão Caio 2026-06-15: por ora corrigir só os 2 errados, mantendo o texto
-- curado (Title Case) dos demais. A adoção de uma planilha oficial de
-- código→nome→responsabilidade como FONTE ABSOLUTA virá num passo seguinte
-- (substitui o seed inteiro).
--
-- skill: supabase-postgres-best-practices — UPDATE pontual em tabela seed
-- pequena (~58 linhas), sem impacto em índice/RLS/perf.
-- ============================================================================

UPDATE public.ocorrencias_dicionario
SET descricao = 'Tratativa de relacionamento para retirada da carga'
WHERE codigo = 52;

UPDATE public.ocorrencias_dicionario
SET descricao = 'Aguardando liberação do setor de devolução',
    responsabilidade = 'Devolução'
WHERE codigo = 58;
