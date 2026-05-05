-- ============================================================================
-- Cockpit v2 — Link de evidência via SSW (oc=10/11/35)
-- Data: 2026-05-01
--
-- Estratégia decidida com Caio em 2026-05-01:
--   - Cliente recebe email com {link_evidencia}
--   - Link aponta pra Edge Function r-evidencia/<token>
--   - Edge Function gera HTML com form auto-submit pra SSW (cnpj+nf+senha)
--   - Cliente vê SSW autenticado → clica "Mais detalhes" → vê foto SSWMobile
--
-- Tokens são time-bound (7 dias). Senha aparece momentaneamente no HTML
-- intermediário, mas: token único por email, expira, URL não vaza fora do
-- email do destinatário.
--
-- Ocorrências que ganham link de evidência:
--   - oc=11: PROBLEMAS_COM_ENDERECO (foto SSWMobile do endereço)
--   - oc=10: RECUSA_TOTAL (NFD - nota fiscal de devolução)
--   - oc=35: RECUSA_PARCIAL (NF com ressalva ou NFD parcial)
-- ============================================================================

-- 1. Cadastra senha do tracking pra Distribuidora ODON (cliente teste real)
INSERT INTO public.tracking_credentials (documento, nome_amigavel, senha, notes, ativo)
VALUES (
  '16366888000110',
  'Distribuidora De Produtos Odon',
  'DIM16366',
  'Cadastrada em 2026-05-01 pra testar link de evidência (NF 27668 oc=11). '
  || 'Senha informada por Caio.',
  true
)
ON CONFLICT (documento) DO UPDATE
SET senha = EXCLUDED.senha,
    nome_amigavel = EXCLUDED.nome_amigavel,
    notes = EXCLUDED.notes,
    ativo = true,
    updated_at = NOW();

-- 2. Renomeia template: ENDERECO_INCORRETO → PROBLEMAS_COM_ENDERECO
--    Caio: "oc 11 = PROBLEMAS COM ENDEREÇO (não necessariamente ENDERECO INCORRETO)"
INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'PROBLEMAS_COM_ENDERECO',
  'Problemas com endereço — confirmar dados de entrega',
  'Quando entrega não foi possível por divergência ou problemas com endereço. Cliente precisa confirmar dados corretos. Email inclui {link_evidencia} pro cliente ver foto do SSWMobile.',
  '[Sal Express] NF {nf} — confirmar endereço de entrega',
  E'Olá {primeiro_nome},\n\n' ||
  E'A entrega da NF {nf} não foi possível por problemas com o endereço.\n\n' ||
  E'Veja a evidência registrada pelo motorista: {link_evidencia}\n\n' ||
  E'Pode confirmar o endereço correto pra reentrega?\n\n' ||
  E'Aguardo retorno.\n\n' ||
  E'{operadora_nome}\nSal Express — Relacionamento',
  ARRAY['primeiro_nome', 'nf', 'operadora_nome', 'link_evidencia'],
  false
)
ON CONFLICT (id) DO UPDATE
SET nome = EXCLUDED.nome,
    descricao = EXCLUDED.descricao,
    variaveis_esperadas = EXCLUDED.variaveis_esperadas;

-- Marca antigo como inativo (não deleta pra preservar referências históricas)
UPDATE public.templates_email
SET ativo = false,
    descricao = 'DEPRECATED 2026-05-01 — substituído por PROBLEMAS_COM_ENDERECO'
WHERE id = 'ENDERECO_INCORRETO';

-- 3. Adiciona {link_evidencia} em RECUSA_TOTAL e RECUSA_PARCIAL
UPDATE public.templates_email
SET variaveis_esperadas = ARRAY['primeiro_nome', 'nf', 'operadora_nome', 'link_evidencia'],
    descricao = descricao || ' Email inclui {link_evidencia} pro cliente ver imagem da NFD.'
WHERE id = 'RECUSA_TOTAL';

UPDATE public.templates_email
SET variaveis_esperadas = ARRAY['primeiro_nome', 'nf', 'operadora_nome', 'link_evidencia'],
    descricao = descricao || ' Email inclui {link_evidencia} pro cliente ver imagem da NF com ressalva.'
WHERE id = 'RECUSA_PARCIAL';

-- 4. Tabela tokens_evidencia
CREATE TABLE IF NOT EXISTS public.tokens_evidencia (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id       uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  todo_id       uuid REFERENCES public.todos(id) ON DELETE SET NULL,
  cnpj_pagador  text NOT NULL,
  nf            text NOT NULL,
  expira_em     timestamptz NOT NULL,
  criado_em     timestamptz NOT NULL DEFAULT NOW(),
  ultimo_acesso timestamptz,
  total_acessos int NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tokens_evidencia_expira_em
  ON public.tokens_evidencia(expira_em);
CREATE INDEX IF NOT EXISTS idx_tokens_evidencia_card_id
  ON public.tokens_evidencia(card_id);

ALTER TABLE public.tokens_evidencia ENABLE ROW LEVEL SECURITY;

-- Edge Function usa service_role, só ela acessa essa tabela
DROP POLICY IF EXISTS tokens_evidencia_service_only ON public.tokens_evidencia;
CREATE POLICY tokens_evidencia_service_only
  ON public.tokens_evidencia
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.tokens_evidencia IS
  'Tokens time-bound (7d) pra clientes acessarem rastreio SSW autenticado via auto-submit POST. Cada token é gerado quando email com {link_evidencia} é renderizado.';
