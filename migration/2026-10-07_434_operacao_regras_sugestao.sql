-- =============================================================================
-- 2026-10-07_434 — Operação: camada 1 da sugestão (regras APRENDIDAS do histórico)
--                  e a flag da camada 2 (agente de IA). ADR 0041 D10; INV-188.
-- =============================================================================
-- A sugestão da fila da Operação tem três camadas (a primeira que responde decide):
--   0. regra fixa (no código, _shared/operacao-sugestao.ts — vazia);
--   1. regra APRENDIDA do histórico — ESTA tabela, op_regras_sugestao;
--   2. agente de IA, só quando nenhuma regra casa (flag operacao_sugestao_ia, OFF).
--
-- TUDO NASCE INERTE: a tabela nasce VAZIA e a flag nasce OFF. Aplicar este arquivo
-- não muda nada do que roda hoje (nenhuma tabela existente é tocada).
--
-- FORMATO da carga (uma migration TIPO B separada, gerada a partir de regras.json;
-- cada elemento vira 1 linha — ver RegraAprendidaOperacao em operacao-sugestao.ts):
--   regras.json: [{ "id": "h13-vga-36",
--                   "estado": {"oc": 13, "unidade": "VGA"|null, "dias_parado_min": 2|null},
--                   "acao": "lancar_ocorrencia"|"encaminhar_relacionamento",
--                   "codigo": 36|null, "texto": "<= 70", "confianca": 0.83, "casos": 41,
--                   "base_regra": "historico:2026-07..2026-09" }]
--   INSERT INTO public.op_regras_sugestao (id, estado_oc, estado_unidade, estado_dias_parado_min,
--     acao, codigo, texto, confianca, casos, base_regra, carga) VALUES (...)
--   ON CONFLICT (id) DO UPDATE SET ... ;   -- carga nova substitui pela chave
--   Antes de gerar: validarRegrasAprendidas(regras) tem de devolver [] (o teste
--   operacao-sugestao.test.ts mostra o uso). Os CHECKs abaixo repetem a validação.
-- Uma regra só DECIDE com confiança ≥ 0.6 e casos ≥ 5 (MIN_* no código); abaixo
-- disso ela só vira contexto ("top-3 do histórico") para o agente.
--
-- ─── NOTAS DE RISCO ──────────────────────────────────────────────────────────
-- (a) Nenhum ALTER em tabela existente. Sem backfill.
-- (b) RLS ligada; só service_role lê/escreve (o materializador e a edge
--     sugerir-operacao). A tela não lê esta tabela: a sugestão chega pelo item.
-- (c) DEPENDÊNCIAS: mig 430 (feature_flags, ocorrencias_dicionario, set_updated_at).
-- (d) CLASSIFICAÇÃO: conteúdo TIPO A; o classificador acusa DROP TRIGGER IF EXISTS
--     (objeto deste arquivo) → aplicar como TIPO B com --autorizado-por.
-- (e) REVERSÃO (TIPO B):
--       DROP TABLE IF EXISTS public.op_regras_sugestao;
--       DROP FUNCTION IF EXISTS public.op_regra_sugestao_valida();
--       DELETE FROM public.feature_flags WHERE key = 'operacao_sugestao_ia';
--
-- ⚠ NÃO APLICADA (nem dry-run). ⚠ SEM BEGIN/COMMIT interno.
-- AUTORIZACAO (TIPO B): "<quem>, <quando>: <ordem/motivo>".
-- =============================================================================

DO $$
BEGIN
  IF to_regclass('public.op_itens') IS NULL THEN
    RAISE EXCEPTION 'mig 434 exige a 430 aplicada antes (op_itens ausente)';
  END IF;
END $$;

INSERT INTO public.feature_flags (key, enabled, description) VALUES
  ('operacao_sugestao_ia', false,
   'ADR 0041 D10: a edge sugerir-operacao chama o agente de IA (camada 2) para item da fila da '
   'Operação sem regra que case. Só item novo ou com oc nova (cache por item + oc). Grava em sombra '
   '(op_itens.sugestao); nada é lançado. OFF = nenhuma chamada à Anthropic.')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.op_regras_sugestao (
  id                      text PRIMARY KEY,
  estado_oc               smallint NOT NULL,
  estado_unidade          text,
  estado_dias_parado_min  integer,
  acao                    text NOT NULL,
  codigo                  smallint,
  texto                   text NOT NULL,
  confianca               numeric(4,3) NOT NULL,
  casos                   integer NOT NULL,
  base_regra              text NOT NULL,
  ativo                   boolean NOT NULL DEFAULT true,
  carga                   text NOT NULL,              -- de qual carga veio (ex.: 'regras.json@2026-10-08')
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oprs_id CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{1,63}$'),
  CONSTRAINT oprs_unidade CHECK (estado_unidade IS NULL OR estado_unidade = upper(btrim(estado_unidade))),
  CONSTRAINT oprs_dias CHECK (estado_dias_parado_min IS NULL OR estado_dias_parado_min BETWEEN 0 AND 365),
  CONSTRAINT oprs_acao CHECK (acao IN ('lancar_ocorrencia', 'encaminhar_relacionamento')),
  -- lançar: um código que a Operação pode sugerir (nunca proibido, nunca 41/56, nunca a própria oc);
  -- encaminhar: sem código (o 49 é do caminho de encaminhamento, ADR 0041 D11).
  CONSTRAINT oprs_acao_codigo CHECK (
    (acao = 'lancar_ocorrencia' AND codigo IS NOT NULL AND codigo NOT IN (49, 54, 59, 33, 44, 6, 9, 16, 41, 56)
       AND codigo <> estado_oc)
    OR (acao = 'encaminhar_relacionamento' AND codigo IS NULL)),
  CONSTRAINT oprs_texto CHECK (char_length(btrim(texto)) BETWEEN 3 AND 70),
  CONSTRAINT oprs_confianca CHECK (confianca BETWEEN 0 AND 1),
  CONSTRAINT oprs_casos CHECK (casos >= 0),
  CONSTRAINT oprs_base CHECK (char_length(btrim(base_regra)) >= 3),
  CONSTRAINT oprs_carga CHECK (char_length(btrim(carga)) >= 3)
);
COMMENT ON TABLE public.op_regras_sugestao IS
  'ADR 0041 D10: camada 1 da sugestão da Operação — regras aprendidas do histórico {estado → ação, '
  'código, texto, confiança, casos, base_regra}. Nasce VAZIA; carga por migration TIPO B a partir de regras.json.';
CREATE INDEX IF NOT EXISTS idx_oprs_estado ON public.op_regras_sugestao (estado_oc) WHERE ativo;

-- Código sugerido tem de ser de responsabilidade 'Operação' no dicionário.
CREATE OR REPLACE FUNCTION public.op_regra_sugestao_valida()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.codigo IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.ocorrencias_dicionario d WHERE d.codigo = NEW.codigo AND d.responsabilidade = 'Operação') THEN
    RAISE EXCEPTION 'regra %: oc % não é de responsabilidade da Operação no ocorrencias_dicionario (ADR 0041 D10)', NEW.id, NEW.codigo;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS oprs_valida ON public.op_regras_sugestao;
CREATE TRIGGER oprs_valida BEFORE INSERT OR UPDATE ON public.op_regras_sugestao
  FOR EACH ROW EXECUTE FUNCTION public.op_regra_sugestao_valida();
DROP TRIGGER IF EXISTS oprs_set_updated_at ON public.op_regras_sugestao;
CREATE TRIGGER oprs_set_updated_at BEFORE UPDATE ON public.op_regras_sugestao
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.op_regras_sugestao ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.op_regras_sugestao FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  RAISE NOTICE 'OK mig 434: op_regras_sugestao (vazia: % linhas) + flag operacao_sugestao_ia (enabled=%)',
    (SELECT count(*) FROM public.op_regras_sugestao),
    (SELECT enabled FROM public.feature_flags WHERE key = 'operacao_sugestao_ia');
END $$;
