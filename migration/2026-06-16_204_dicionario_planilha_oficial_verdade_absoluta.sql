-- ============================================================================
-- Cockpit v2 — ocorrencias_dicionario adota a planilha oficial como VERDADE ABSOLUTA
-- Caio 2026-06-16 (arquivo "Responsáveis por Ocorrência.xlsx")
--
-- A planilha do Caio (Cód./Descrição/Responsável) passa a ser a FONTE ÚNICA do
-- significado e do setor responsável de cada ocorrência SSW. Substitui o seed
-- estático de 28/04 que havia drifado (ver mig 203, caso âncora NF 507827).
--
-- 58 códigos (1–58), responsáveis na taxonomia: Operação, Relacionamento,
-- Ressarcimento, Devolução, Perdas, Cliente, Agendamento.
--
-- UPSERT (não DELETE) porque cards.cod_ultima_ocorrencia tem FK em codigo
-- (mig 009). Atualiza descricao (display, JOIN Lovable) + responsabilidade
-- (roteamento setorDestino no sync-bastao; permanência no Cockpit segue por
-- bastao-rules/INV-008, não por aqui).
--
-- Mudanças de responsabilidade vs estado anterior (impactam rótulo de setor):
--   52: Relacionamento -> Operação;  57: Operação -> Relacionamento.
--
-- skill: supabase-postgres-best-practices — UPSERT em tabela seed pequena,
-- sem impacto em índice/RLS/perf. ON CONFLICT preserva created_at.
-- ============================================================================

INSERT INTO public.ocorrencias_dicionario (codigo, descricao, responsabilidade) VALUES
  (1, 'Entrega realizada normalmente', 'Operação'),
  (2, 'Emissão de CTRC - Subcontrato', 'Operação'),
  (3, 'Avaria na coleta', 'Relacionamento'),
  (4, 'Atraso na coleta', 'Operação'),
  (5, 'Início de viagem de transferência', 'Operação'),
  (6, 'Extravio na transferência', 'Perdas'),
  (7, 'Chegada na base para conexão', 'Operação'),
  (8, 'Avaria na transferência', 'Relacionamento'),
  (9, 'Extravio na coleta', 'Perdas'),
  (10, 'Recusa total da entrega', 'Relacionamento'),
  (11, 'Entrega impossibilitada: problemas com endereço', 'Relacionamento'),
  (12, 'Comprovante retido para conferência', 'Operação'),
  (13, 'Entrega impossibilitada: limitação cliente', 'Operação'),
  (14, 'Entrega iniciada', 'Operação'),
  (15, 'Entrega impossib: limit. base op. entreg', 'Operação'),
  (16, 'Extravio na entrega', 'Perdas'),
  (17, 'Avaria na entrega', 'Relacionamento'),
  (18, 'Carga sinistrada', 'Ressarcimento'),
  (19, 'Entrega realizada com falta de volumes', 'Relacionamento'),
  (20, 'Extravio localizado', 'Relacionamento'),
  (21, 'Reentrega solicitada pelo cliente', 'Operação'),
  (22, 'Retirada da carga (pelo cliente) na base', 'Operação'),
  (23, 'Problemas com documentação', 'Relacionamento'),
  (24, 'Problemas de força maior', 'Operação'),
  (25, 'Feriado local e/ou nacional', 'Operação'),
  (26, 'Conjunto de comprovantes incompletos', 'Relacionamento'),
  (27, 'Custo extra', 'Operação'),
  (28, 'Retenção de carga pela fiscalização públ.', 'Relacionamento'),
  (29, 'Agendamento de entrega', 'Operação'),
  (30, 'Devolução autorizada', 'Devolução'),
  (31, 'Aguardando agendamento', 'Agendamento'),
  (32, 'Operação cancelada', 'Operação'),
  (33, 'Reversão de perdas iniciada', 'Ressarcimento'),
  (34, 'CTRC complementar', 'Operação'),
  (35, 'Entrega realizada com recusa parcial', 'Relacionamento'),
  (36, 'Chegada na base para entrega', 'Operação'),
  (37, 'Entrega impossibilitada por problema no veículo', 'Operação'),
  (38, 'Problemas na transferência', 'Operação'),
  (39, 'Entrega impossib: problemas com janela', 'Operação'),
  (40, 'Redespacho final', 'Operação'),
  (41, 'Informação complementar', 'Operação'),
  (42, 'Ressarcimento finalizado - indenização devida', 'Ressarcimento'),
  (43, 'Manutenção perecível realizada', 'Relacionamento'),
  (44, 'Retorno de carga', 'Devolução'),
  (45, 'Carga cubada', 'Operação'),
  (46, 'Em análise de ressarcimento', 'Ressarcimento'),
  (47, 'Ressarcimento finalizado - indenização indevida', 'Ressarcimento'),
  (48, 'Inviabilidade de custo na transferência', 'Operação'),
  (49, 'Tratativa de relacionamento', 'Relacionamento'),
  (50, 'Manifestação indevida', 'Operação'),
  (51, 'Início do processo de destroca', 'Operação'),
  (52, 'Tratativa de relacionamento para retirada da carga', 'Operação'),
  (53, 'Devolução liberada', 'Devolução'),
  (54, 'Aguardando retorno cliente pagador', 'Cliente'),
  (55, 'Autorizado para seguir pra entrega / entrega parcial', 'Operação'),
  (56, 'Falta de informação operacional ou indevida', 'Operação'),
  (57, 'Volume de destroca coletado', 'Relacionamento'),
  (58, 'Aguardando liberação do setor de devolução', 'Devolução')
ON CONFLICT (codigo) DO UPDATE
  SET descricao = EXCLUDED.descricao,
      responsabilidade = EXCLUDED.responsabilidade;
