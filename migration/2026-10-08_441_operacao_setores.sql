-- =============================================================================
-- 2026-10-08_441 — Operação: SETORES (Operação, Agendamento, Devolução,
--                  Ressarcimento, Perdas, Cliente) e o setor dono de cada nota
--                  (ADR 0042; estende o ADR 0041 D2/D3/D4).
-- =============================================================================
-- NUMERAÇÃO: 441. Conferido em 08/10 com `git ls-tree -r --name-only` sobre todos os
-- `git branch -r` (origin/master, a integração matheuscastro12-eng/operacao-e-motorista
-- e as demais): o maior número em qualquer branch remota é 440
-- (2026-10-07_440_operacao_regras_modelo_e_condicoes). A faixa 440–449 é da Operação.
--
-- FONTE DAS REGRAS: o "Pendências" (repo tatiana-kelly/pendency-tracker @ a884368):
--   - src/types/pendencia.ts:63-86 — OCORRENCIA_RESPONSAVEL_MAP ("Tabela Oficial");
--   - etl/notas-ciclo/src/setores.js:44-58 — o mesmo mapa no ETL;
--   - tabela ocorrencias_setores (fonte de verdade lá desde 24/09/2026), com:
--       52 → OPERACAO (mig 20260615150051 do Pendências);
--       60 → CLIENTE  (decisão da gestão em 24/09/2026).
-- O espelho em TypeScript é apps/cockpit-web/src/lib/operacao/setores.ts; o teste
-- supabase/functions/_shared/operacao-setores.test.ts LÊ ESTE ARQUIVO (as linhas
-- `(<cod>, '<SETOR>', ...)` da semente de op_setor_por_oc) e trava a igualdade.
--
-- O que cria/muda:
--   1. op_setores (7 setores; na_fila = o setor entra na fila materializada).
--      Semente: só OPERACAO na_fila. LIGAR outro setor é decisão do dono, por
--      migration TIPO B com --autorizado-por:
--        UPDATE public.op_setores SET na_fila = true WHERE codigo = 'AGENDAMENTO';
--      RELACIONAMENTO NUNCA entra na fila (CHECK; ADR 0041 D2).
--   2. op_setor_por_oc (oc → setor), semente = o mapa do Pendências (60 códigos).
--   3. op_setor_do_item(responsavel, oc): responsavel_atual que é um setor conhecido
--      manda; senão o mapa pela oc; senão 'NAO_IDENTIFICADO' (régua do Pendências:
--      "não é um setor, é a recusa a chutar um"). Responsável DESCONHECIDO (ex.:
--      'indenizacao', citado na mig 029) cai no mapa, não em NAO_IDENTIFICADO.
--   4. operacao_membros: + setores text[] (default {OPERACAO}; nunca RELACIONAMENTO);
--      papel_op aceita 'gerente_op' (gerente de filial: vê só as SUAS unidades — a
--      op_pode_ver_unidade da 430 já trata todo não-supervisor pelas unidades —, mas
--      TODOS os setores, e a Gestão). Funções current_op_setores(), eh_gerente_op(),
--      op_pode_ver_setor(setor).
--   5. op_itens: policy RESTRICTIVE opi_setor_do_membro (SELECT). Restrictive é AND
--      com a opi_select (unidade): o membro vê item da SUA unidade E do SEU setor.
--      op_eventos, op_lancamentos e op_encaminhamentos herdam: as policies deles são
--      `EXISTS (SELECT 1 FROM op_itens ...)`, e a RLS de op_itens vale dentro do EXISTS.
--   6. Guarda de ESCRITA (as RPCs SECURITY DEFINER por id não olham setor):
--      triggers BEFORE INSERT em op_lancamentos e op_encaminhamentos e BEFORE UPDATE
--      OF assumido_por em op_itens recusam com 'fora_do_seu_setor' (P0001) quando
--      auth.uid() é operador_op e o setor do item não está nos setores dele.
--      auth.uid() nulo (service_role, worker, cron) passa.
--   7. op_minha_sessao: + membro.setores e eh_gerente (corpo da 430, mais nada).
--   8. op_v_fila: + coluna `setor` NO FIM (corpo da 436, a última definição).
--   9. op_setores_na_fila() (service_role): setores ligados e seus códigos, para o
--      materializador (_shared/operacao-materializar.ts).
--
-- ─── NOTAS DE RISCO ──────────────────────────────────────────────────────────
-- (a) TABELAS QUENTES do Relacionamento: nenhuma tocada. Só tabelas da 430/436.
-- (b) operacao_membros: ADD COLUMN com default constante = só metadado (PG ≥ 11);
--     os CHECKs novos validam a tabela inteira (dezenas de linhas, no máximo).
--     Membro que já existe ganha {OPERACAO} — exatamente o que vê hoje, SALVO o
--     item cujo setor deixa de ser OPERACAO pelo mapa (ver (d)).
-- (c) A policy RESTRICTIVE chama op_setor_do_item por LINHA de op_itens (lookup por
--     PK numa tabela de 60 linhas). As partes que não dependem da linha (gestor,
--     supervisor, gerente, current_op_setores) vão em (SELECT ...) e viram initPlan
--     (1x por consulta). A expressão é equivalente a op_pode_ver_setor(setor do
--     item) — o teste SQL prova por pessoa.
-- (d) DIVERGÊNCIA conhecida dicionário × Pendências: a oc 57 ("Volume de destroca
--     coletado") é 'Relacionamento' no ocorrencias_dicionario (mig 204) e OPERACAO no
--     mapa do Pendências. Com a 441 aplicada, o materializador passa a usar o MAPA
--     (op_setores_na_fila) — a 57 com responsável vazio ENTRA na fila da Operação
--     (hoje não entra). Antes de aplicar, o dono confirma qual vale.
-- (e) Os triggers mudam o retorno das RPCs para operador_op fora do setor: em vez de
--     {ok:false, erro} vem EXCEPTION 'fora_do_seu_setor' (SQLSTATE P0001). O front
--     trata como erro genérico de RPC. Supervisor, gerente e gestor não são tocados.
-- (f) LEITURA por RPC SECURITY DEFINER por id (op_item_detalhe da 430,
--     op_encaminhamentos_do_item da 436) continua olhando só a unidade: um operador
--     que tenha o uuid de um item de outro setor da SUA unidade lê o detalhe. O uuid
--     não aparece para ele (a RLS esconde o item); fechar isso é um follow-up.
-- (g) DEPENDÊNCIAS: 430 (tabelas, funções), 436 (op_encaminhamentos e a op_v_fila
--     copiada daqui), 438 (ordem da faixa; não usa objeto dela). Exige a 436 aplicada.
-- (h) CLASSIFICAÇÃO: TIPO B (ALTER em operacao_membros, CHECK trocado, CREATE POLICY
--     em op_itens, triggers novos, CREATE OR REPLACE de função/visão existentes).
-- (i) REVERSÃO (TIPO B):
--       DROP TRIGGER IF EXISTS opl_guarda_setor ON public.op_lancamentos;
--       DROP TRIGGER IF EXISTS openc_guarda_setor ON public.op_encaminhamentos;
--       DROP TRIGGER IF EXISTS opi_guarda_setor_assumir ON public.op_itens;
--       DROP POLICY IF EXISTS opi_setor_do_membro ON public.op_itens;
--       (op_v_fila: reaplicar o bloco da 436 — DROP VIEW + CREATE VIEW, porque
--        CREATE OR REPLACE não remove coluna; op_minha_sessao: reaplicar o bloco da 430)
--       DROP FUNCTION IF EXISTS public.op_setores_na_fila(), public.op_guarda_setor_do_item(),
--         public.op_pode_ver_setor(text), public.eh_gerente_op(), public.current_op_setores(),
--         public.op_setor_do_item(text, integer);
--       UPDATE public.operacao_membros SET papel_op = 'operador_op' WHERE papel_op = 'gerente_op';
--       ALTER TABLE public.operacao_membros DROP CONSTRAINT IF EXISTS opm_papel;
--       ALTER TABLE public.operacao_membros ADD CONSTRAINT opm_papel CHECK (papel_op IN ('operador_op', 'supervisor_op'));
--       ALTER TABLE public.operacao_membros DROP CONSTRAINT IF EXISTS opm_setores,
--         DROP COLUMN IF EXISTS setores;
--       DROP TABLE IF EXISTS public.op_setor_por_oc, public.op_setores;
--     Atenção: rebaixar gerente_op a operador_op REDUZ o que a pessoa vê; avisar antes.
--
-- ⚠ NÃO APLICADA (nem dry-run) — arquivo entregue ao time do Cockpit.
-- ⚠ SEM BEGIN/COMMIT interno (política de migrations).
-- AUTORIZACAO (TIPO B): "<quem>, <quando>: <ordem/motivo>".
-- =============================================================================

DO $$
BEGIN
  IF to_regclass('public.op_itens') IS NULL OR to_regclass('public.operacao_membros') IS NULL THEN
    RAISE EXCEPTION 'mig 441 exige a 430 aplicada antes';
  END IF;
  IF to_regclass('public.op_encaminhamentos') IS NULL THEN
    RAISE EXCEPTION 'mig 441 exige a 436 aplicada antes (a op_v_fila daqui é a da 436 + setor)';
  END IF;
  PERFORM set_config('cockpit.mig441_nascimento',
    CASE WHEN to_regclass('public.op_setor_por_oc') IS NULL THEN 'true' ELSE 'false' END, false);
END $$;

-- 1. Setores ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.op_setores (
  codigo   text PRIMARY KEY,
  nome     text NOT NULL,
  funcao   text NOT NULL,
  na_fila  boolean NOT NULL DEFAULT false,
  ordem    integer NOT NULL,
  CONSTRAINT ops_codigo CHECK (codigo IN ('OPERACAO', 'AGENDAMENTO', 'DEVOLUCAO', 'RESSARCIMENTO', 'PERDAS', 'CLIENTE', 'RELACIONAMENTO')),
  -- O Relacionamento nunca entra na fila da Operação (ADR 0041 D2).
  CONSTRAINT ops_relacionamento_fora_da_fila CHECK (codigo <> 'RELACIONAMENTO' OR NOT na_fila)
);
COMMENT ON TABLE public.op_setores IS
  'ADR 0042: setores do Pendências (tatiana-kelly/pendency-tracker@a884368, src/types/pendencia.ts:63-86). '
  'na_fila = o materializador traz as notas do setor para a fila. Nasce só OPERACAO; ligar outro é '
  'migration TIPO B com --autorizado-por. RELACIONAMENTO nunca na fila (CHECK; ADR 0041 D2).';

-- ON CONFLICT DO NOTHING: reaplicar NÃO desliga um setor que o dono já ligou.
INSERT INTO public.op_setores (codigo, nome, funcao, na_fila, ordem) VALUES
  ('OPERACAO', 'Operação', 'Transferência, chegada na base, entrega, reentrega, redespacho e informação operacional', true, 1),
  ('AGENDAMENTO', 'Agendamento', 'Aguardando agendamento com o destinatário', false, 2),
  ('DEVOLUCAO', 'Devolução', 'Devolução autorizada, retorno de carga e liberação de devolução', false, 3),
  ('RESSARCIMENTO', 'Ressarcimento', 'Sinistro, reversão de perdas e análise de ressarcimento', false, 4),
  ('PERDAS', 'Perdas', 'Extravio na coleta, na transferência e na entrega', false, 5),
  ('CLIENTE', 'Cliente', 'Aguardando retorno ou documentação do cliente pagador', false, 6),
  ('RELACIONAMENTO', 'Relacionamento', 'Avaria, recusa, falta, documentação e tratativa com o cliente (Cockpit do Relacionamento)', false, 7)
ON CONFLICT (codigo) DO NOTHING;

ALTER TABLE public.op_setores ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.op_setores FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.op_setores FROM authenticated;
GRANT SELECT ON public.op_setores TO authenticated;
DROP POLICY IF EXISTS ops_select ON public.op_setores;
CREATE POLICY ops_select ON public.op_setores FOR SELECT TO authenticated
  USING ((SELECT public.current_op_membro_id()) IS NOT NULL OR (SELECT public.op_eh_gestor()));

-- 2. Setor dono de cada oc (o mapa do Pendências) -----------------------------------
CREATE TABLE IF NOT EXISTS public.op_setor_por_oc (
  codigo_oc  smallint PRIMARY KEY,
  setor      text NOT NULL REFERENCES public.op_setores(codigo),
  fonte      text NOT NULL,
  CONSTRAINT opso_faixa CHECK (codigo_oc BETWEEN 1 AND 999),
  CONSTRAINT opso_fonte CHECK (char_length(btrim(fonte)) >= 5)
);
COMMENT ON TABLE public.op_setor_por_oc IS
  'ADR 0042: setor dono de cada código de ocorrência = OCORRENCIA_RESPONSAVEL_MAP do Pendências '
  '(tatiana-kelly/pendency-tracker@a884368: src/types/pendencia.ts:63-86 e etl/notas-ciclo/src/setores.js:44-58; '
  'tabela ocorrencias_setores com 52→OPERACAO pela mig 20260615150051 e 60→CLIENTE por decisão da gestão em 24/09/2026). '
  'Espelho TS: apps/cockpit-web/src/lib/operacao/setores.ts (teste trava a igualdade).';
COMMENT ON COLUMN public.op_setor_por_oc.fonte IS 'De onde veio a linha (arquivo:linhas, migration ou decisão com data).';
-- FK sem índice deixa o DELETE/UPDATE em op_setores varrer a tabela; 60 linhas, mas é a regra.
CREATE INDEX IF NOT EXISTS idx_op_setor_por_oc_setor ON public.op_setor_por_oc (setor);

-- Semente: UMA LINHA POR CÓDIGO, no formato `(<cod>, '<SETOR>', '<fonte>'),` — o teste
-- operacao-setores.test.ts lê estas linhas. ON CONFLICT DO NOTHING: reaplicar não
-- desfaz uma correção feita por migration posterior.
-- SETOR OPERACAO
INSERT INTO public.op_setor_por_oc (codigo_oc, setor, fonte) VALUES
  (1, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (2, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (4, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (5, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (7, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (12, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (13, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (14, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (15, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (21, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (22, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (24, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (25, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (27, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (29, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (32, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (34, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (36, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (37, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (38, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (39, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (40, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (41, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (45, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (48, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (50, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (51, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (52, 'OPERACAO', 'pendency-tracker ocorrencias_setores, mig 20260615150051'),
  (55, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (56, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (57, 'OPERACAO', 'pendency-tracker@a884368 pendencia.ts:63-86')
ON CONFLICT (codigo_oc) DO NOTHING;
-- SETOR PERDAS
INSERT INTO public.op_setor_por_oc (codigo_oc, setor, fonte) VALUES
  (6, 'PERDAS', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (9, 'PERDAS', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (16, 'PERDAS', 'pendency-tracker@a884368 pendencia.ts:63-86')
ON CONFLICT (codigo_oc) DO NOTHING;
-- SETOR RELACIONAMENTO
INSERT INTO public.op_setor_por_oc (codigo_oc, setor, fonte) VALUES
  (3, 'RELACIONAMENTO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (8, 'RELACIONAMENTO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (10, 'RELACIONAMENTO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (11, 'RELACIONAMENTO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (17, 'RELACIONAMENTO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (19, 'RELACIONAMENTO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (20, 'RELACIONAMENTO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (23, 'RELACIONAMENTO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (26, 'RELACIONAMENTO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (28, 'RELACIONAMENTO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (35, 'RELACIONAMENTO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (43, 'RELACIONAMENTO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (49, 'RELACIONAMENTO', 'pendency-tracker@a884368 pendencia.ts:63-86')
ON CONFLICT (codigo_oc) DO NOTHING;
-- SETOR AGENDAMENTO
INSERT INTO public.op_setor_por_oc (codigo_oc, setor, fonte) VALUES
  (31, 'AGENDAMENTO', 'pendency-tracker@a884368 pendencia.ts:63-86')
ON CONFLICT (codigo_oc) DO NOTHING;
-- SETOR RESSARCIMENTO
INSERT INTO public.op_setor_por_oc (codigo_oc, setor, fonte) VALUES
  (18, 'RESSARCIMENTO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (33, 'RESSARCIMENTO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (42, 'RESSARCIMENTO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (46, 'RESSARCIMENTO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (47, 'RESSARCIMENTO', 'pendency-tracker@a884368 pendencia.ts:63-86')
ON CONFLICT (codigo_oc) DO NOTHING;
-- SETOR DEVOLUCAO
INSERT INTO public.op_setor_por_oc (codigo_oc, setor, fonte) VALUES
  (30, 'DEVOLUCAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (44, 'DEVOLUCAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (53, 'DEVOLUCAO', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (58, 'DEVOLUCAO', 'pendency-tracker@a884368 pendencia.ts:63-86')
ON CONFLICT (codigo_oc) DO NOTHING;
-- SETOR CLIENTE
INSERT INTO public.op_setor_por_oc (codigo_oc, setor, fonte) VALUES
  (54, 'CLIENTE', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (59, 'CLIENTE', 'pendency-tracker@a884368 pendencia.ts:63-86'),
  (60, 'CLIENTE', 'decisão da gestão do Pendências, 24/09/2026 (ocorrencias_setores)')
ON CONFLICT (codigo_oc) DO NOTHING;

ALTER TABLE public.op_setor_por_oc ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.op_setor_por_oc FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.op_setor_por_oc FROM authenticated;
GRANT SELECT ON public.op_setor_por_oc TO authenticated;
DROP POLICY IF EXISTS opso_select ON public.op_setor_por_oc;
CREATE POLICY opso_select ON public.op_setor_por_oc FOR SELECT TO authenticated
  USING ((SELECT public.current_op_membro_id()) IS NOT NULL OR (SELECT public.op_eh_gestor()));

-- 3. Setor do item ------------------------------------------------------------------
-- Mesma hierarquia do Pendências e do state_pelo_bastao (mig 029):
--   1. responsavel_atual do Bastão, normalizado (minúsculas, sem acento, sem espaço
--      nas pontas), quando é um setor conhecido ('operacao', 'Operação ' → OPERACAO);
--   2. senão o mapa pela oc (responsável vazio OU desconhecido);
--   3. senão 'NAO_IDENTIFICADO'.
-- Espelho TS: setorDaPendencia (_shared/operacao-materializar.ts) e setorDoItem (front).
CREATE OR REPLACE FUNCTION public.op_setor_do_item(p_responsavel text, p_oc integer)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  -- Responsável preenchido manda, mesmo desconhecido (ex.: 'indenizacao', mig 029) →
  -- NAO_IDENTIFICADO; vazio → mapa pela oc; fora do mapa → NAO_IDENTIFICADO.
  SELECT CASE
    WHEN btrim(coalesce(p_responsavel, '')) <> '' THEN coalesce(
      (SELECT s.codigo FROM public.op_setores s
        WHERE s.codigo = upper(btrim(translate(lower(p_responsavel),
                                               'áàâãäéèêëíìîïóòôõöúùûüç',
                                               'aaaaaeeeeiiiiooooouuuuc')))),
      'NAO_IDENTIFICADO')
    ELSE coalesce((SELECT m.setor FROM public.op_setor_por_oc m WHERE m.codigo_oc = p_oc), 'NAO_IDENTIFICADO')
  END;
$$;
COMMENT ON FUNCTION public.op_setor_do_item(text, integer) IS
  'ADR 0042: setor dono da nota. responsavel_atual (setor conhecido) > op_setor_por_oc (mapa do Pendências, '
  'pendency-tracker@a884368 pendencia.ts:63-86) > NAO_IDENTIFICADO. Responsável desconhecido = NAO_IDENTIFICADO.';
REVOKE ALL ON FUNCTION public.op_setor_do_item(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.op_setor_do_item(text, integer) TO authenticated, service_role;

-- 4. Membros: setores e o gerente de filial ------------------------------------------
ALTER TABLE public.operacao_membros
  ADD COLUMN IF NOT EXISTS setores text[] NOT NULL DEFAULT '{OPERACAO}';
ALTER TABLE public.operacao_membros DROP CONSTRAINT IF EXISTS opm_setores;
ALTER TABLE public.operacao_membros ADD CONSTRAINT opm_setores CHECK (
  cardinality(setores) >= 1
  -- nunca RELACIONAMENTO: quem é do Relacionamento está em operadores (ADR 0041 D2)
  AND setores <@ ARRAY['OPERACAO', 'AGENDAMENTO', 'DEVOLUCAO', 'RESSARCIMENTO', 'PERDAS', 'CLIENTE']::text[]);
ALTER TABLE public.operacao_membros DROP CONSTRAINT IF EXISTS opm_papel;
ALTER TABLE public.operacao_membros ADD CONSTRAINT opm_papel CHECK (papel_op IN ('operador_op', 'supervisor_op', 'gerente_op'));
COMMENT ON COLUMN public.operacao_membros.setores IS
  'ADR 0042: setores que o membro atende (operador_op vê e age só nestes). supervisor_op e gerente_op veem todos. '
  'Nunca RELACIONAMENTO (CHECK).';
COMMENT ON COLUMN public.operacao_membros.papel_op IS
  'operador_op: suas unidades e seus setores. supervisor_op: tudo. gerente_op (ADR 0042, gerente de filial do '
  'Pendências): só as SUAS unidades (op_pode_ver_unidade, mig 430), mas todos os setores, e a Gestão.';

CREATE OR REPLACE FUNCTION public.current_op_setores()
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT m.setores FROM public.operacao_membros m
                    WHERE m.user_id = auth.uid() AND m.ativo LIMIT 1), '{}'::text[]);
$$;

CREATE OR REPLACE FUNCTION public.eh_gerente_op()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.operacao_membros m
                  WHERE m.user_id = auth.uid() AND m.ativo AND m.papel_op = 'gerente_op');
$$;

-- Predicado de setor (RPCs e front). A UNIDADE continua com op_pode_ver_unidade (430):
-- as duas condições valem juntas (a policy de setor é RESTRICTIVE).
CREATE OR REPLACE FUNCTION public.op_pode_ver_setor(p_setor text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.op_eh_gestor()
      OR public.eh_supervisor_op()
      OR public.eh_gerente_op()
      OR (p_setor IS NOT NULL AND p_setor = ANY (public.current_op_setores()));
$$;

REVOKE ALL ON FUNCTION public.current_op_setores() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.eh_gerente_op() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.op_pode_ver_setor(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_op_setores() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.eh_gerente_op() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.op_pode_ver_setor(text) TO authenticated, service_role;

-- 5. Leitura: o membro vê só o SEU setor (RESTRICTIVE = AND com opi_select) ----------
-- Equivalente a (SELECT op_pode_ver_setor(op_setor_do_item(responsavel_atual, cod_ultima_ocorrencia))),
-- escrito com as partes que não dependem da linha em (SELECT ...) para virarem initPlan.
-- service_role ignora RLS. op_eventos/op_lancamentos/op_encaminhamentos herdam (EXISTS em op_itens).
DROP POLICY IF EXISTS opi_setor_do_membro ON public.op_itens;
CREATE POLICY opi_setor_do_membro ON public.op_itens AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
       (SELECT public.op_eh_gestor())
    OR (SELECT public.eh_supervisor_op())
    OR (SELECT public.eh_gerente_op())
    OR public.op_setor_do_item(responsavel_atual, cod_ultima_ocorrencia) = ANY ((SELECT public.current_op_setores())::text[])
  );

-- 6. Escrita: as RPCs por id não olham setor; o trigger olha ---------------------------
-- Só operador_op é limitado (supervisor/gerente veem todos os setores; o gestor não está
-- em operacao_membros). auth.uid() nulo = service_role/worker/cron: passa.
CREATE OR REPLACE FUNCTION public.op_guarda_setor_do_item()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_papel text;
  v_setores text[];
  v_setor text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT m.papel_op, m.setores INTO v_papel, v_setores
    FROM public.operacao_membros m WHERE m.user_id = v_uid AND m.ativo;
  IF NOT FOUND OR v_papel IS DISTINCT FROM 'operador_op' THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'op_itens' THEN
    IF NEW.assumido_por IS NULL THEN
      RETURN NEW;  -- soltar o item não é agir sobre ele
    END IF;
    v_setor := public.op_setor_do_item(NEW.responsavel_atual, NEW.cod_ultima_ocorrencia);
  ELSE
    SELECT public.op_setor_do_item(i.responsavel_atual, i.cod_ultima_ocorrencia) INTO v_setor
      FROM public.op_itens i WHERE i.id = NEW.op_item_id;
  END IF;
  IF v_setor IS NULL OR NOT (v_setor = ANY (coalesce(v_setores, '{}'::text[]))) THEN
    RAISE EXCEPTION 'fora_do_seu_setor'
      USING ERRCODE = 'P0001',
            DETAIL = format('a nota é do setor %s; os seus setores: %s', coalesce(v_setor, '?'), array_to_string(v_setores, ', '));
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.op_guarda_setor_do_item() IS
  'ADR 0042: operador_op só lança/encaminha/assume nota do SEU setor (as RPCs SECURITY DEFINER por id não '
  'conferem setor). EXCEPTION fora_do_seu_setor (P0001). Sem auth.uid() (service_role) passa.';
REVOKE ALL ON FUNCTION public.op_guarda_setor_do_item() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS opl_guarda_setor ON public.op_lancamentos;
CREATE TRIGGER opl_guarda_setor BEFORE INSERT ON public.op_lancamentos
  FOR EACH ROW EXECUTE FUNCTION public.op_guarda_setor_do_item();
DROP TRIGGER IF EXISTS opi_guarda_setor_assumir ON public.op_itens;
CREATE TRIGGER opi_guarda_setor_assumir BEFORE UPDATE OF assumido_por ON public.op_itens
  FOR EACH ROW EXECUTE FUNCTION public.op_guarda_setor_do_item();
DO $$
BEGIN
  IF to_regclass('public.op_encaminhamentos') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS openc_guarda_setor ON public.op_encaminhamentos';
    EXECUTE 'CREATE TRIGGER openc_guarda_setor BEFORE INSERT ON public.op_encaminhamentos '
         || 'FOR EACH ROW EXECUTE FUNCTION public.op_guarda_setor_do_item()';
  ELSE
    RAISE NOTICE 'mig 441: op_encaminhamentos não existe (436 ausente); trigger de setor do encaminhamento não criado';
  END IF;
END $$;

-- 7. Sessão: + setores do membro e eh_gerente (corpo da 430) ---------------------------
CREATE OR REPLACE FUNCTION public.op_minha_sessao()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_m public.operacao_membros%ROWTYPE;
  v_gestor boolean := public.op_eh_gestor();
BEGIN
  SELECT * INTO v_m FROM public.operacao_membros WHERE user_id = auth.uid() AND ativo;
  IF NOT FOUND AND NOT v_gestor THEN
    RETURN jsonb_build_object('membro', NULL, 'eh_gestor', false);
  END IF;
  RETURN jsonb_build_object(
    'membro', CASE WHEN v_m.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_m.id, 'nome', v_m.nome, 'email', v_m.email, 'papel_op', v_m.papel_op,
      'unidades', to_jsonb(v_m.unidades), 'pode_lancar', v_m.pode_lancar,
      'setores', to_jsonb(v_m.setores)) END,
    'eh_gestor', v_gestor,
    'eh_supervisor', coalesce(v_m.papel_op = 'supervisor_op', false),
    'eh_gerente', coalesce(v_m.papel_op = 'gerente_op', false),
    'flags', jsonb_build_object(
      'operacao_tela', public.op_flag('operacao_tela'),
      'operacao_lancar_ssw', public.op_flag('operacao_lancar_ssw'),
      'operacao_fila', public.op_flag('operacao_fila')));
END;
$$;
REVOKE ALL ON FUNCTION public.op_minha_sessao() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.op_minha_sessao() TO authenticated;

-- 8. A fila: corpo da 436 + `setor` no FIM (CREATE OR REPLACE VIEW só acrescenta no fim) --
CREATE OR REPLACE VIEW public.op_v_fila WITH (security_invoker = true) AS
SELECT i.id AS op_item_id,
       i.ctrc, i.nf, i.unidade, i.status,
       i.cod_ultima_ocorrencia, d.descricao AS descricao_oc,
       i.data_ultima_ocorrencia, i.instrucao_ultima_ocorrencia,
       i.pagador, i.destinatario, i.cidade_destino, i.uf_destino,
       i.previsao_entrega, i.atraso_original, i.qtd_volumes,
       i.assumido_por, i.assumido_por_nome, i.assumido_em,
       i.sugestao, i.sugestao_em,
       l.id AS lancamento_id, l.status AS lancamento_status, l.codigo_oc AS lancamento_codigo_oc,
       l.solicitado_por_nome AS lancamento_solicitado_por_nome, l.solicitado_em AS lancamento_solicitado_em,
       i.materializado_em, i.updated_at,
       e.id AS encaminhamento_id, e.origem AS encaminhamento_origem, e.executar_apos AS encaminhamento_executar_apos,
       e.texto AS encaminhamento_texto,
       public.op_setor_do_item(i.responsavel_atual, i.cod_ultima_ocorrencia) AS setor
  FROM public.op_itens i
  LEFT JOIN public.ocorrencias_dicionario d ON d.codigo = i.cod_ultima_ocorrencia
  LEFT JOIN LATERAL (
    SELECT x.* FROM public.op_lancamentos x
     WHERE x.op_item_id = i.id
     ORDER BY x.solicitado_em DESC LIMIT 1) l ON true
  LEFT JOIN public.op_encaminhamentos e ON e.op_item_id = i.id AND e.status = 'agendado'
 WHERE i.status <> 'encerrado';
REVOKE ALL ON public.op_v_fila FROM anon;
GRANT SELECT ON public.op_v_fila TO authenticated;

-- 9. Para o materializador: setores ligados e seus códigos (service_role) ---------------
CREATE OR REPLACE FUNCTION public.op_setores_na_fila()
RETURNS TABLE (setor text, codigos smallint[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT s.codigo,
         coalesce(array_agg(m.codigo_oc ORDER BY m.codigo_oc) FILTER (WHERE m.codigo_oc IS NOT NULL), '{}'::smallint[])
    FROM public.op_setores s
    LEFT JOIN public.op_setor_por_oc m ON m.setor = s.codigo
   WHERE s.na_fila AND s.codigo <> 'RELACIONAMENTO'   -- o CHECK já garante; repetido de propósito
   GROUP BY s.codigo, s.ordem
   ORDER BY s.ordem;
$$;
COMMENT ON FUNCTION public.op_setores_na_fila() IS
  'ADR 0042: setores com na_fila e os códigos de cada um (op_setor_por_oc). Lido pelo materializar-fila-operacao; '
  'sem a função (441 não aplicada) o materializador segue só com OPERACAO pelo dicionário.';
REVOKE ALL ON FUNCTION public.op_setores_na_fila() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.op_setores_na_fila() TO service_role;

-- 10. Smoke (só no NASCIMENTO) ----------------------------------------------------------
DO $$
DECLARE
  v_total integer;
  v_faixa integer;
  v_na_fila text[];
  v_ruins integer;
BEGIN
  IF current_setting('cockpit.mig441_nascimento', true) IS DISTINCT FROM 'true' THEN
    RAISE NOTICE 'mig 441 reaplicada: smoke de nascimento pulado.';
    RETURN;
  END IF;
  SELECT count(*), count(*) FILTER (WHERE codigo_oc BETWEEN 1 AND 60) INTO v_total, v_faixa FROM public.op_setor_por_oc;
  IF v_total <> 60 OR v_faixa <> 60 THEN
    RAISE EXCEPTION 'mig 441: o mapa deveria ter as 60 ocs (1..60) do Pendências; tem % (% em 1..60)', v_total, v_faixa;
  END IF;
  SELECT array_agg(codigo ORDER BY codigo) INTO v_na_fila FROM public.op_setores WHERE na_fila;
  IF v_na_fila IS DISTINCT FROM ARRAY['OPERACAO'] THEN
    RAISE EXCEPTION 'mig 441 não nasceu só com OPERACAO na fila: %', v_na_fila;
  END IF;
  -- (sem checagem de membros aqui: depois da 442 há membros de outros setores e a 441 precisa
  --  continuar reaplicável)
  IF public.op_setor_do_item(NULL, 31) <> 'AGENDAMENTO' OR public.op_setor_do_item(' Operação ', 49) <> 'OPERACAO'
     OR public.op_setor_do_item('indenizacao', 13) <> 'NAO_IDENTIFICADO' OR public.op_setor_do_item(NULL, 999) <> 'NAO_IDENTIFICADO' THEN
    RAISE EXCEPTION 'mig 441: op_setor_do_item não segue a hierarquia responsável > mapa > NAO_IDENTIFICADO';
  END IF;
  RAISE NOTICE 'OK mig 441: 60 ocs mapeadas, só OPERACAO na fila.';
END $$;
