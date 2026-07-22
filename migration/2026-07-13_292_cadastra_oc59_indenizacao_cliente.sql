-- ============================================================================
-- Cockpit v2 — cadastra a ocorrência SSW 59 (RETORNO INDENIZAÇÃO), responsabilidade 'Cliente'
-- Caio 2026-07-13 (Fase 4 — separação 54/59)
--
-- CONTEXTO: hoje a 54 ("Aguardando retorno cliente pagador") é o guarda-chuva de
-- TODO retorno pendente do cliente. Passamos a QUEBRAR em dois trilhos, ambos
-- responsabilidade='Cliente' e ambos residentes em AGUARDANDO_CLIENTE:
--   54 = RETORNO TRATATIVA   → decisão física pendente (devolver/reentregar/seguir parcial)
--   59 = RETORNO INDENIZAÇÃO → romaneio/descrição/valor pendente (antecede a oc 33)
--
-- A 59 já existe e está funcional no SSW; aqui é o cadastro no dicionário do Cockpit.
--
-- POR QUE ESTA MIGRATION É O PRIMEIRO PASSO (obrigatório): cards.cod_ultima_ocorrencia
-- tem FK -> ocorrencias_dicionario.codigo (mig 009). Sem a linha 59 aqui, qualquer
-- card que receba a oc 59 (via sync-bastao ou lançamento) VIOLA a FK e o upsert quebra.
--
-- ⚠️ NECESSÁRIA, MAS NÃO SUFICIENTE: a permanência do card em AGUARDANDO_CLIENTE NÃO é
-- decidida por esta tabela — é hardcoded em _shared/bastao-rules.ts (stateFinalAposBastao
-- + set.add(54)) e em ~dezenas de comparações `=== 54`. O espelhamento da 59 nesses
-- pontos (fonte única OCS_CLIENTE={54,59}) é feito no TS, na mesma entrega desta migration.
-- Rodar esta migration SOZINHA (sem o TS) faria a 59 cair em TRANSFERIDO. Deploy atômico.
--
-- UPSERT (não DELETE) porque a FK acima impede remoção; ON CONFLICT preserva created_at.
-- Descrição em sentence-case seguindo a convenção do dicionário (campo de exibição/JOIN
-- Lovable); a leitura do rótulo do SSW (caixa-alta, latin-1) ocorre no historico_ssw, não aqui.
--
-- skill: supabase-postgres-best-practices — INSERT em tabela seed pequena (lookup),
-- sem índice/RLS/perf novos. RLS de SELECT já é aberta (mig 008); nenhum GRANT novo.
-- Idempotente: rodar 2x não muda nada além de reafirmar descricao/responsabilidade.
-- ============================================================================

INSERT INTO public.ocorrencias_dicionario (codigo, descricao, responsabilidade) VALUES
  (59, 'Pendência de documentação para análise de ressarcimento', 'Cliente')
ON CONFLICT (codigo) DO UPDATE
  SET descricao = EXCLUDED.descricao,
      responsabilidade = EXCLUDED.responsabilidade;
