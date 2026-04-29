-- ============================================================================
-- Cockpit v2 — De-para de ocorrências SSW (codigo_api → codigo_ssw)
-- Data: 2026-04-29
--
-- Confirmado empiricamente em testes (29/04): a API ocorrenciaParceiro do SSW
-- recebe codigo_api e registra como codigo_ssw no painel. Os 2 NÃO BATEM.
-- Ex.: mandar 29 via API → aparece como oc 21 no sistema.
--
-- Esta tabela centraliza o mapping pra que:
--   - Operadores e agentes trabalhem com codigo_ssw (linguagem natural deles)
--   - Executor traduz pra codigo_api antes de chamar /api/ocorrenciaParceiro
--   - Reconfiguração (raro) muda só esta tabela, sem mexer em código
--
-- Source: tabela enviada pelo Caio em 2026-04-29 com 13 mapeamentos do
-- relacionamento. Pode ser estendida quando outras áreas (Devolução,
-- Ressarcimento, etc.) montarem seus agentes.
-- ============================================================================

CREATE TABLE public.ocorrencias_dexpara (
  codigo_api integer PRIMARY KEY,
  codigo_ssw integer NOT NULL,
  descricao text NOT NULL,
  ativo boolean NOT NULL DEFAULT true,
  observacao text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_dexpara_codigo_ssw
  ON public.ocorrencias_dexpara(codigo_ssw)
  WHERE ativo = true;

CREATE TRIGGER ocorrencias_dexpara_set_updated_at
  BEFORE UPDATE ON public.ocorrencias_dexpara
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 13 mapeamentos confirmados pelo Caio em 2026-04-29
-- ============================================================================
INSERT INTO public.ocorrencias_dexpara (codigo_api, codigo_ssw, descricao) VALUES
  (75, 33, 'REVERSAO DE PERDAS INICIADA'),
  (76, 41, 'INFORMACAO COMPLEMENTAR'),
  (78, 56, 'FALTA DE INFORMACAO OPERACIONAL OU INDEVIDA'),
  (88, 44, 'RETORNO DE CARGA'),
  (77, 57, 'VOLUME DE DESTROCA COLETADO'),
  (21, 52, 'TRATATIVA DE RELACIONAMENTO PARA RETIRADA'),
  (70, 51, 'INICIO DO PROCESSO DE DESTROCA'),
  (58, 55, 'AUTORIZACAO PARA SEGUIR PARA ENTREGA / ENTREGA PARCIAL'),
  (66, 54, 'AGUARDANDO RETORNO DO CLIENTE PAGADOR'),
  (22, 58, 'AGUARDANDO LIBERACAO DO SETOR DE DEVOLUCAO'),
  (15, 29, 'AGENDAMENTO DE ENTREGA'),
  (29, 21, 'REENTREGA SOLICITADA PELO CLIENTE'),
  (52, 23, 'PROBLEMAS COM DOCUMENTACAO');

-- ============================================================================
-- RPC: lookup_codigo_api(codigo_ssw) → codigo_api correspondente
-- Usado pelo executor pra traduzir antes de chamar SSW
-- ============================================================================
CREATE OR REPLACE FUNCTION public.lookup_codigo_api(p_codigo_ssw integer)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT codigo_api
  FROM public.ocorrencias_dexpara
  WHERE codigo_ssw = p_codigo_ssw AND ativo = true
  ORDER BY created_at DESC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.lookup_codigo_api(integer) TO authenticated, service_role;

-- ============================================================================
-- RLS — gestor edita; todos leem
-- ============================================================================
ALTER TABLE public.ocorrencias_dexpara ENABLE ROW LEVEL SECURITY;

CREATE POLICY dexpara_select_authenticated ON public.ocorrencias_dexpara
  FOR SELECT TO authenticated USING (true);

CREATE POLICY dexpara_modify_gestor ON public.ocorrencias_dexpara
  FOR ALL TO authenticated
  USING (public.current_operador_papel() = 'gestor')
  WITH CHECK (public.current_operador_papel() = 'gestor');

COMMENT ON TABLE public.ocorrencias_dexpara IS
  'De-para de ocorrências SSW. codigo_api é o que enviamos via /api/ocorrenciaParceiro; '
  'codigo_ssw é o que aparece registrado no painel SSW. Caso típico: codigo_api 29 → codigo_ssw 21 (reentrega).';
