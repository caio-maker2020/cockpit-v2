-- =============================================================================
-- 2026-08-26_357_veto_piloto_operadores.sql
--
-- DECISÃO DO CAIO (26/08): a janela de veto estreia como PILOTO de 3
-- operadores — FELIPE, ISABELY e LARISSA (taxas ~80%+). Todos os demais
-- ficam EXATAMENTE como hoje: card de operador fora do piloto nunca vira
-- ação autônoma (cerca 'operador_fora_do_piloto' no agendador).
--
-- Esta tabela era a "válvula por operador" prevista no plano (etapa G) —
-- agora é a porta de entrada do piloto. Entrar/sair do piloto = INSERT/
-- UPDATE deliberado com registro de quem mandou. A ativação REAL continua
-- exigindo flag master + degrau da escada (nada muda só por estar aqui).
--
-- SEM begin/commit interno. Idempotente.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.acoes_autonomas_veto_operadores (
  operador_id uuid PRIMARY KEY REFERENCES public.operadores(id) ON DELETE CASCADE,
  ativo       boolean NOT NULL DEFAULT true,
  ativado_em  timestamptz NOT NULL DEFAULT now(),
  ativado_por text,
  observacao  text
);

ALTER TABLE public.acoes_autonomas_veto_operadores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS veto_operadores_select ON public.acoes_autonomas_veto_operadores;
CREATE POLICY veto_operadores_select ON public.acoes_autonomas_veto_operadores
  FOR SELECT TO authenticated USING (true);

GRANT SELECT ON public.acoes_autonomas_veto_operadores TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.acoes_autonomas_veto_operadores TO service_role;

COMMENT ON TABLE public.acoes_autonomas_veto_operadores IS
  'PILOTO da janela de veto (Caio 26/08): só card cujo operador dono está '
  'aqui com ativo=true pode virar ação autônoma. Fora da tabela = cockpit de '
  'hoje, intocado. Estreia: FELIPE, ISABELY, LARISSA. A ativação real segue '
  'exigindo flag master + degrau da escada.';

-- Seed do piloto — por NOME (ids conferidos em prod 26/08); INSERT deliberado
-- registrando a ordem nominal. Idempotente.
INSERT INTO public.acoes_autonomas_veto_operadores (operador_id, ativado_por, observacao)
SELECT o.id, 'Caio 2026-08-26 (ordem no chat)', 'piloto inicial — taxa ~80%+'
FROM public.operadores o
WHERE o.nome IN ('FELIPE', 'ISABELY', 'LARISSA') AND o.ativo
ON CONFLICT (operador_id) DO NOTHING;
