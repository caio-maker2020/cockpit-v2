-- ============================================================================
-- Cockpit v2 — Dicionário das 58 ocorrências SSW (planilha Ocor_respon.xlsx)
-- Data: 2026-04-29
--
-- Tabela canônica de referência: cod → descrição + responsabilidade.
-- UI faz JOIN pra mostrar "54 — Aguardando retorno cliente pagador" em vez
-- de só o número. Agentes futuros usam pra raciocinar sobre tipos de ocorrência.
-- Read-only via UI (UPDATE só em migration nova quando planilha mudar).
-- ============================================================================

CREATE TABLE public.ocorrencias_dicionario (
  codigo integer PRIMARY KEY,
  descricao text NOT NULL,
  responsabilidade text NOT NULL CHECK (responsabilidade IN (
    'Operação',
    'Relacionamento',
    'Cliente',
    'Perdas',
    'Ressarcimento',
    'Devolução',
    'Agendamento'
  )),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ocorrencias_dicionario_responsabilidade
  ON public.ocorrencias_dicionario(responsabilidade);

INSERT INTO public.ocorrencias_dicionario (codigo, descricao, responsabilidade) VALUES
  (1,  'Entrega realizada normalmente',                       'Operação'),
  (2,  'Emissão de CTRC - Subcontrato',                       'Operação'),
  (3,  'Avaria na coleta',                                    'Relacionamento'),
  (4,  'Atraso na coleta',                                    'Operação'),
  (5,  'Início de viagem de transferência',                   'Operação'),
  (6,  'Extravio na transferência',                           'Perdas'),
  (7,  'Chegada na base para conexão',                        'Operação'),
  (8,  'Avaria na transferência',                             'Relacionamento'),
  (9,  'Extravio na coleta',                                  'Perdas'),
  (10, 'Recusa total da entrega',                             'Relacionamento'),
  (11, 'Entrega impossibilitada: problemas com endereço',     'Relacionamento'),
  (12, 'Comprovante retido para conferência',                 'Operação'),
  (13, 'Entrega impossibilitada: limitação cliente',          'Operação'),
  (14, 'Entrega iniciada',                                    'Operação'),
  (15, 'Entrega impossib: limit. base op. entreg',            'Operação'),
  (16, 'Extravio na entrega',                                 'Perdas'),
  (17, 'Avaria na entrega',                                   'Relacionamento'),
  (18, 'Carga sinistrada',                                    'Ressarcimento'),
  (19, 'Entrega realizada com falta de volumes',              'Relacionamento'),
  (20, 'Extravio localizado',                                 'Relacionamento'),
  (21, 'Reentrega solicitada pelo cliente',                   'Operação'),
  (22, 'Retirada da carga (pelo cliente) na base',            'Operação'),
  (23, 'Problemas com documentação',                          'Relacionamento'),
  (24, 'Problemas de força maior',                            'Operação'),
  (25, 'Feriado local e/ou nacional',                         'Operação'),
  (26, 'Conjunto de comprovantes incompletos',                'Relacionamento'),
  (27, 'Custo extra',                                         'Operação'),
  (28, 'Retenção de carga pela fiscalização públ.',           'Relacionamento'),
  (29, 'Agendamento de entrega',                              'Operação'),
  (30, 'Devolução autorizada',                                'Devolução'),
  (31, 'Aguardando agendamento',                              'Agendamento'),
  (32, 'Operação cancelada',                                  'Operação'),
  (33, 'Reversão de perdas iniciada',                         'Ressarcimento'),
  (34, 'CTRC complementar',                                   'Operação'),
  (35, 'Entrega realizada com recusa parcial',                'Relacionamento'),
  (36, 'Chegada na base para entrega',                        'Operação'),
  (37, 'Entrega impossibilitada por problema no veículo',     'Operação'),
  (38, 'Problemas na transferência',                          'Operação'),
  (39, 'Entrega impossib: problemas com janela',              'Operação'),
  (40, 'Redespacho final',                                    'Operação'),
  (41, 'Informação complementar',                             'Operação'),
  (42, 'Ressarcimento finalizado - indenização devida',       'Ressarcimento'),
  (43, 'Manutenção perecível realizada',                      'Relacionamento'),
  (44, 'Retorno de carga',                                    'Devolução'),
  (45, 'Carga cubada',                                        'Operação'),
  (46, 'Em análise de ressarcimento',                         'Ressarcimento'),
  (47, 'Ressarcimento finalizado - indenização indevida',     'Ressarcimento'),
  (48, 'Inviabilidade de custo na transferência',             'Operação'),
  (49, 'Tratativa de relacionamento',                         'Relacionamento'),
  (50, 'Manifestação indevida',                               'Operação'),
  (51, 'Início do processo de destroca',                      'Operação'),
  (52, 'Finalização do processo de destroca',                 'Relacionamento'),
  (53, 'Devolução liberada',                                  'Devolução'),
  (54, 'Aguardando retorno cliente pagador',                  'Cliente'),
  (55, 'Autorizado para seguir pra entrega / entrega parcial','Operação'),
  (56, 'Falta de informação operacional ou indevida',         'Operação'),
  (57, 'Falta de informação operacional / ocorrência indevida','Operação'),
  (58, 'Volume da destroca coletado',                         'Relacionamento');

-- ============================================================================
-- RLS — leitura aberta pra qualquer authenticated, escrita só service_role
-- (que bypassa RLS). Tabela é read-reference; mudanças vêm via migration nova.
-- ============================================================================
ALTER TABLE public.ocorrencias_dicionario ENABLE ROW LEVEL SECURITY;

CREATE POLICY ocorrencias_dicionario_select_all ON public.ocorrencias_dicionario
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.ocorrencias_dicionario IS
  'Dicionário canônico das 58 ocorrências SSW. Origem: planilha '
  'Ocor_respon.xlsx. Read-only via UI; mudanças via migration. UI faz '
  'JOIN com cards.cod_ultima_ocorrencia pra exibir descrição amigável.';
