-- ============================================================================
-- Cockpit v2 — usuarios_ssw_perdas: cadastro dos logins SSW do time de
-- perdas/ressarcimento. Usado pelo agente-sugere-ocs-padrao pra detectar
-- Caso 1 (extravio não localizado) em oc=49.
-- Data: 2026-05-29
-- skill: supabase-postgres-best-practices
--
-- Quando o time de perdas lança a oc=49 no SSW, normalmente isso significa
-- "carga não localizada — operador agora notifica cliente". O agente checa
-- se o `usuario` da oc=49 está nesta tabela pra ativar o caso.
--
-- Lookup por login curto SSW (parser ssw-internal-client.ts extrai do XML f4).
--
-- skill checklist:
--   - PK em login (case-sensitive — mesmo formato do SSW) ✓
--   - RLS habilitada ✓
--   - SELECT pra authenticated (operadores precisam validar) ✓
--   - INSERT/UPDATE/DELETE só pra gestor (papel atual via current_operador_papel) ✓
--   - Trigger updated_at ✓
-- ============================================================================

CREATE TABLE public.usuarios_ssw_perdas (
  login           text PRIMARY KEY,
  nome_completo   text NOT NULL,
  ativo           boolean NOT NULL DEFAULT true,
  observacao      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER usuarios_ssw_perdas_set_updated_at
  BEFORE UPDATE ON public.usuarios_ssw_perdas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.usuarios_ssw_perdas ENABLE ROW LEVEL SECURITY;

CREATE POLICY usuarios_ssw_perdas_select
  ON public.usuarios_ssw_perdas
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY usuarios_ssw_perdas_modify
  ON public.usuarios_ssw_perdas
  FOR ALL TO authenticated
  USING (public.current_operador_papel() = 'gestor')
  WITH CHECK (public.current_operador_papel() = 'gestor');

GRANT SELECT ON public.usuarios_ssw_perdas TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.usuarios_ssw_perdas TO authenticated;
GRANT ALL ON public.usuarios_ssw_perdas TO service_role;

-- Caio 2026-05-29: 9 logins informados (2 imagens enviadas).
INSERT INTO public.usuarios_ssw_perdas (login, nome_completo) VALUES
  ('mario.s',  'MARIO JOSE HENRIQUE DA SILVA'),
  ('arthurp',  'ARTHUR GIOVANNI COSTA PRADO'),
  ('vitoria.', 'VITORIA ALVES RAMOS'),
  ('mar.augu', 'MARCELO AUGUSTO PEREIRA DE MAC'),
  ('marc.aug', 'MARCELO AUGUSTO PEREIRA DE MAC'),
  ('andrey.',  'ANDREY LUIZ BARBOSA CLARO'),
  ('lucianaf', 'LUCIANA LOPES FARIA'),
  ('t.darlan', 'THIAGO DARLAN'),
  ('marianab', 'MARIANA TEODORO BONFIM')
ON CONFLICT (login) DO NOTHING;

COMMENT ON TABLE public.usuarios_ssw_perdas IS
  'Caio 2026-05-29: cadastro dos logins SSW do time de perdas/ressarcimento. '
  'Usado pelo agente-sugere-ocs-padrao pra ativar Caso 1 (extravio) em oc=49. '
  'Lookup por login curto (parser XML SSW campo f4).';
