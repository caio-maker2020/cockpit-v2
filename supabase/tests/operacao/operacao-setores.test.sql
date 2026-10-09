-- =============================================================================
-- Teste dos SETORES da Operação (mig 441; ADR 0042; fonte: Pendências,
-- tatiana-kelly/pendency-tracker@a884368 src/types/pendencia.ts:63-86).
-- Roda SÓ no Postgres descartável (rodar-local.sh). Transação com ROLLBACK.
-- Cobre: semente (60 ocs, só OPERACAO na fila), CHECKs (Relacionamento nunca na fila
-- nem nos setores do membro), op_setor_do_item (responsável > mapa > NAO_IDENTIFICADO),
-- RLS por setor (operador vê o SEU setor; gerente vê todos os setores da SUA unidade;
-- supervisor e gestor tudo; op_eventos herda), equivalência da policy com
-- op_pode_ver_setor, guarda de escrita (assumir, lançar, encaminhar), op_minha_sessao,
-- op_v_fila.setor e op_setores_na_fila (só service_role).
-- =============================================================================
BEGIN;
CREATE SCHEMA ts;
CREATE FUNCTION ts.ok(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FALHOU: %', msg; END IF; END $$;
CREATE FUNCTION ts.recusado(cmd text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE cmd; RETURN false; EXCEPTION WHEN others THEN RETURN true; END $$;
-- a mensagem do erro (NULL se passou)
CREATE FUNCTION ts.erro(cmd text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE cmd; RETURN NULL; EXCEPTION WHEN others THEN RETURN SQLERRM; END $$;
CREATE FUNCTION ts.item(p_ctrc text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id FROM public.op_itens WHERE ctrc = p_ctrc AND status <> 'encerrado' $$;
-- quantos itens a pessoa DEVERIA ver pelos predicados (lidos como dono, avaliados como ela)
CREATE FUNCTION ts.itens_todos() RETURNS TABLE (unidade text, responsavel_atual text, oc integer)
  LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT unidade, responsavel_atual, cod_ultima_ocorrencia FROM public.op_itens $$;
GRANT USAGE ON SCHEMA ts TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ts TO anon, authenticated, service_role;

-- ── semente e CHECKs ─────────────────────────────────────────────────────────
SELECT ts.ok((SELECT count(*) FROM public.op_setor_por_oc) = 60, 'mapa sem 60 ocs');
SELECT ts.ok((SELECT array_agg(codigo_oc ORDER BY codigo_oc) FROM public.op_setor_por_oc)
             = (SELECT array_agg(g::smallint ORDER BY g) FROM generate_series(1, 60) g), 'mapa não cobre 1..60');
SELECT ts.ok((SELECT string_agg(setor || ':' || n, ',' ORDER BY setor) FROM (
               SELECT setor, count(*) n FROM public.op_setor_por_oc GROUP BY setor) x)
             = 'AGENDAMENTO:1,CLIENTE:3,DEVOLUCAO:4,OPERACAO:31,PERDAS:3,RELACIONAMENTO:13,RESSARCIMENTO:5', 'contagem por setor');
SELECT ts.ok((SELECT setor FROM public.op_setor_por_oc WHERE codigo_oc = 52) = 'OPERACAO', '52 → OPERACAO (mig 20260615150051)');
SELECT ts.ok((SELECT setor FROM public.op_setor_por_oc WHERE codigo_oc = 60) = 'CLIENTE', '60 → CLIENTE (gestão 24/09)');
SELECT ts.ok((SELECT array_agg(codigo) FROM public.op_setores WHERE na_fila) = ARRAY['OPERACAO'], 'só OPERACAO na fila');
SELECT ts.ok(ts.recusado($$UPDATE public.op_setores SET na_fila = true WHERE codigo = 'RELACIONAMENTO'$$), 'RELACIONAMENTO entrou na fila');
SELECT ts.ok(ts.recusado($$INSERT INTO public.op_setores (codigo, nome, funcao, ordem) VALUES ('MOTORISTA', 'x', 'x', 9)$$), 'setor fora da lista');
SELECT ts.ok(ts.recusado($$INSERT INTO public.op_setor_por_oc VALUES (61, 'INEXISTENTE', 'fonte qualquer')$$), 'oc com setor inexistente (FK)');

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'rel@sal'), ('00000000-0000-0000-0000-0000000000a2', 'gestor@sal'),
  ('00000000-0000-0000-0000-0000000000b1', 'op.vga@sal'), ('00000000-0000-0000-0000-0000000000b2', 'agend.vga@sal'),
  ('00000000-0000-0000-0000-0000000000b3', 'sup.op@sal'), ('00000000-0000-0000-0000-0000000000b4', 'ger.vga@sal'),
  ('00000000-0000-0000-0000-0000000000b9', 'x@sal');
INSERT INTO public.operadores (user_id, nome, email, papel) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'LARISSA', 'rel@sal', 'operador'),
  ('00000000-0000-0000-0000-0000000000a2', 'CAIO', 'gestor@sal', 'gestor');
INSERT INTO public.operacao_membros (user_id, nome, email, papel_op, unidades, pode_lancar) VALUES
  ('00000000-0000-0000-0000-0000000000b1', 'Joao VGA', 'op.vga@sal', 'operador_op', '{VGA}', true);
SELECT ts.ok((SELECT setores FROM public.operacao_membros WHERE email = 'op.vga@sal') = '{OPERACAO}', 'default {OPERACAO}');
INSERT INTO public.operacao_membros (user_id, nome, email, papel_op, unidades, pode_lancar, setores) VALUES
  ('00000000-0000-0000-0000-0000000000b2', 'Bia Agenda', 'agend.vga@sal', 'operador_op', '{VGA}', true, '{AGENDAMENTO}'),
  ('00000000-0000-0000-0000-0000000000b3', 'Sup Op', 'sup.op@sal', 'supervisor_op', '{}', true, '{OPERACAO}'),
  ('00000000-0000-0000-0000-0000000000b4', 'Gerente VGA', 'ger.vga@sal', 'gerente_op', '{VGA}', true, '{OPERACAO}');
SELECT ts.ok(ts.recusado($$INSERT INTO public.operacao_membros (user_id, nome, email, setores) VALUES ('00000000-0000-0000-0000-0000000000b9', 'Xx', 'x@sal', '{OPERACAO,RELACIONAMENTO}')$$), 'membro com RELACIONAMENTO');
SELECT ts.ok(ts.recusado($$INSERT INTO public.operacao_membros (user_id, nome, email, setores) VALUES ('00000000-0000-0000-0000-0000000000b9', 'Xx', 'x@sal', '{}')$$), 'membro sem setor');
SELECT ts.ok(ts.recusado($$INSERT INTO public.operacao_membros (user_id, nome, email, setores) VALUES ('00000000-0000-0000-0000-0000000000b9', 'Xx', 'x@sal', '{operacao}')$$), 'setor em minúsculas');
SELECT ts.ok(ts.recusado($$INSERT INTO public.operacao_membros (user_id, nome, email, papel_op) VALUES ('00000000-0000-0000-0000-0000000000b9', 'Xx', 'x@sal', 'diretor_op')$$), 'papel fora da lista');

-- ── op_setor_do_item ───────────────────────────────────────────────────────────
SELECT ts.ok(public.op_setor_do_item(NULL, 13) = 'OPERACAO', 'vazio → mapa (13)');
SELECT ts.ok(public.op_setor_do_item('', 31) = 'AGENDAMENTO', 'vazio → mapa (31)');
SELECT ts.ok(public.op_setor_do_item('relacionamento', 13) = 'RELACIONAMENTO', 'responsável manda sobre o mapa');
SELECT ts.ok(public.op_setor_do_item(' Operação ', 49) = 'OPERACAO', 'responsável com acento e espaço');
SELECT ts.ok(public.op_setor_do_item('DEVOLUÇÃO', NULL) = 'DEVOLUCAO', 'responsável em maiúsculas com acento');
SELECT ts.ok(public.op_setor_do_item('indenizacao', 13) = 'NAO_IDENTIFICADO', 'responsável desconhecido não cai no mapa (revisão 08/10)');
SELECT ts.ok(public.op_setor_do_item('indenizacao', 999) = 'NAO_IDENTIFICADO', 'desconhecido e fora do mapa');
SELECT ts.ok(public.op_setor_do_item(NULL, NULL) = 'NAO_IDENTIFICADO', 'sem nada');

-- ── itens ───────────────────────────────────────────────────────────────────────
INSERT INTO public.op_itens (ctrc, nf, unidade, cod_ultima_ocorrencia, responsavel_atual) VALUES
  ('VOP1-1', '101', 'VGA', 13, NULL),            -- OPERACAO pelo mapa
  ('VOP2-2', '102', 'VGA', 13, 'Operação'),      -- OPERACAO pelo responsável (acento/maiúscula)
  ('VAG1-1', '103', 'VGA', 31, NULL),            -- AGENDAMENTO pelo mapa
  ('VAG2-2', '104', 'VGA', 13, 'agendamento'),   -- AGENDAMENTO pelo responsável
  ('VNI1-1', '105', 'VGA', NULL, NULL),          -- NAO_IDENTIFICADO
  ('BOP1-1', '106', 'BHZ', 13, NULL);            -- OPERACAO, outra unidade
INSERT INTO public.op_eventos (op_item_id, tipo, ator_tipo) SELECT id, 'ItemMaterializado', 'system' FROM public.op_itens;
UPDATE public.feature_flags SET enabled = true WHERE key IN ('operacao_tela', 'operacao_lancar_ssw');

-- ── operador VGA, setor OPERACAO ──────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
SELECT ts.ok((SELECT string_agg(ctrc, ',' ORDER BY ctrc) FROM public.op_itens) = 'VOP1-1,VOP2-2', 'operador OPERACAO VGA: ' || coalesce((SELECT string_agg(ctrc, ',' ORDER BY ctrc) FROM public.op_itens), '-'));
SELECT ts.ok((SELECT count(*) FROM public.op_itens) = (SELECT count(*) FROM ts.itens_todos() x
               WHERE public.op_pode_ver_unidade(x.unidade) AND public.op_pode_ver_setor(public.op_setor_do_item(x.responsavel_atual, x.oc))),
             'policy ≠ op_pode_ver_setor (operador)');
SELECT ts.ok((SELECT count(*) FROM public.op_eventos) = 2, 'op_eventos não herdou o setor');
SELECT ts.ok((SELECT bool_and(setor = 'OPERACAO') AND count(*) = 2 FROM public.op_v_fila), 'op_v_fila.setor');
SELECT ts.ok((SELECT count(*) FROM public.op_setores) = 7 AND (SELECT count(*) FROM public.op_setor_por_oc) = 60, 'membro não lê setores/mapa');
SELECT ts.ok(ts.recusado($$UPDATE public.op_setores SET na_fila = true WHERE codigo = 'AGENDAMENTO'$$), 'membro ligou setor');
SELECT ts.ok(ts.recusado($$DELETE FROM public.op_setor_por_oc$$) OR (SELECT count(*) FROM public.op_setor_por_oc) = 60, 'membro apagou o mapa');
SELECT ts.ok(public.op_minha_sessao()->'membro'->'setores' = '["OPERACAO"]'::jsonb, 'sessão sem setores');
SELECT ts.ok((public.op_minha_sessao()->>'eh_gerente')::boolean = false, 'operador virou gerente');
-- escrita: assumir item do SEU setor passa; de outro setor é recusado no trigger
SELECT ts.ok((public.op_assumir(ts.item('VOP1-1'))->>'ok')::boolean, 'assumir item do próprio setor');
SELECT ts.ok(ts.erro(format('SELECT public.op_assumir(%L)', ts.item('VAG1-1'))) = 'fora_do_seu_setor', 'assumiu item de outro setor (por id)');
SELECT ts.ok(ts.erro(format('SELECT public.op_assumir(%L)', ts.item('VNI1-1'))) = 'fora_do_seu_setor', 'assumiu item sem setor');
RESET ROLE;
SELECT ts.ok((SELECT assumido_por IS NULL FROM public.op_itens WHERE ctrc = 'VAG1-1'), 'item de outro setor ficou assumido');

-- lançar / encaminhar com a pessoa na sessão (como as RPCs definer fazem): trigger recusa
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
SELECT ts.ok(ts.erro(format($f$INSERT INTO public.op_lancamentos (op_item_id, ctrc, nf, codigo_oc, texto_ssw, confirmacao, solicitado_por, solicitado_por_nome)
  SELECT %L, 'VAG1-1', '103', 36, 'x', 'tok', m.id, m.nome FROM public.operacao_membros m WHERE m.email = 'op.vga@sal'$f$, ts.item('VAG1-1'))) = 'fora_do_seu_setor',
  'lançamento em item de outro setor');
SELECT ts.ok(ts.erro(format($f$INSERT INTO public.op_lancamentos (op_item_id, ctrc, nf, codigo_oc, texto_ssw, confirmacao, solicitado_por, solicitado_por_nome)
  SELECT %L, 'VOP2-2', '102', 36, 'x', 'tok', m.id, m.nome FROM public.operacao_membros m WHERE m.email = 'op.vga@sal'$f$, ts.item('VOP2-2'))) IS NULL,
  'lançamento no próprio setor recusado');
SELECT ts.ok(ts.erro(format($f$INSERT INTO public.op_encaminhamentos (op_item_id, ctrc, texto, origem, executar_apos, solicitado_por, solicitado_por_nome)
  SELECT %L, 'VAG2-2', 'cliente pediu outra data', 'manual', now(), m.id, m.nome FROM public.operacao_membros m WHERE m.email = 'op.vga@sal'$f$, ts.item('VAG2-2'))) = 'fora_do_seu_setor',
  'encaminhamento de item de outro setor');
-- sem auth.uid() (service_role / worker): passa
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT ts.ok(ts.erro(format($f$INSERT INTO public.op_encaminhamentos (op_item_id, ctrc, texto, origem, executar_apos, solicitado_por_nome, confianca)
  VALUES (%L, 'VAG2-2', 'cliente pediu outra data', 'auto', now(), 'Agente', 0.95)$f$, ts.item('VAG2-2'))) IS NULL, 'serviço barrado pelo trigger de setor');
SELECT ts.ok(ts.erro(format($f$UPDATE public.op_itens SET assumido_por = (SELECT id FROM public.operacao_membros WHERE email = 'op.vga@sal') WHERE id = %L$f$, ts.item('VAG1-1'))) IS NULL,
  'serviço barrado ao atribuir');
UPDATE public.op_itens SET assumido_por = NULL, assumido_por_nome = NULL, assumido_em = NULL WHERE ctrc = 'VAG1-1';

-- ── operador VGA, setor AGENDAMENTO ────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b2', true);
SELECT ts.ok((SELECT string_agg(ctrc, ',' ORDER BY ctrc) FROM public.op_itens) = 'VAG1-1,VAG2-2', 'operador AGENDAMENTO VGA');
SELECT ts.ok((SELECT bool_and(setor = 'AGENDAMENTO') FROM public.op_v_fila), 'op_v_fila.setor (agendamento)');
SELECT ts.ok((public.op_assumir(ts.item('VAG1-1'))->>'ok')::boolean, 'agendamento assume o dele');
SELECT ts.ok(ts.erro(format('SELECT public.op_assumir(%L)', ts.item('VOP2-2'))) = 'fora_do_seu_setor', 'agendamento assumiu item da operação');
RESET ROLE;

-- ── gerente de filial VGA: todos os setores, só a SUA unidade ─────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b4', true);
SELECT ts.ok((SELECT string_agg(ctrc, ',' ORDER BY ctrc) FROM public.op_itens) = 'VAG1-1,VAG2-2,VNI1-1,VOP1-1,VOP2-2', 'gerente VGA: ' || coalesce((SELECT string_agg(ctrc, ',' ORDER BY ctrc) FROM public.op_itens), '-'));
SELECT ts.ok((SELECT count(*) FROM public.op_itens) = (SELECT count(*) FROM ts.itens_todos() x
               WHERE public.op_pode_ver_unidade(x.unidade) AND public.op_pode_ver_setor(public.op_setor_do_item(x.responsavel_atual, x.oc))),
             'policy ≠ op_pode_ver_setor (gerente)');
SELECT ts.ok((public.op_minha_sessao()->>'eh_gerente')::boolean AND NOT (public.op_minha_sessao()->>'eh_supervisor')::boolean, 'sessão do gerente');
SELECT ts.ok(public.op_eh_gestor() = false AND public.eh_gerente_op(), 'eh_gerente_op');
SELECT ts.ok((public.op_assumir(ts.item('VNI1-1'))->>'ok')::boolean, 'gerente assume item sem setor da sua unidade');
SELECT ts.ok(public.op_assumir(ts.item('BOP1-1'))->>'erro' = 'fora_da_sua_unidade', 'gerente assumiu item de outra unidade');
RESET ROLE;

-- ── supervisor e gestor: tudo ───────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b3', true);
SELECT ts.ok((SELECT count(*) FROM public.op_itens) = 6, 'supervisor não vê tudo');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
SELECT ts.ok((SELECT count(*) FROM public.op_itens) = 6 AND (SELECT count(*) FROM public.op_v_fila) = 6, 'gestor não vê tudo');
SELECT ts.ok((SELECT count(*) FROM public.op_setores) = 7, 'gestor não lê setores');
RESET ROLE;

-- ── Relacionamento e sem papel: nada ──────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
SELECT ts.ok((SELECT count(*) FROM public.op_itens) = 0, 'Relacionamento leu op_itens');
SELECT ts.ok((SELECT count(*) FROM public.op_setores) = 0 AND (SELECT count(*) FROM public.op_setor_por_oc) = 0, 'Relacionamento leu setores');
SELECT ts.ok(ts.recusado($$SELECT * FROM public.op_setores_na_fila()$$), 'authenticated chamou op_setores_na_fila');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT ts.ok(ts.recusado($$SELECT count(*) FROM public.op_setores$$), 'anon leu op_setores');
RESET ROLE;

-- ── materializador: op_setores_na_fila ──────────────────────────────────────────
SET LOCAL ROLE service_role;
SELECT ts.ok((SELECT count(*) FROM public.op_setores_na_fila()) = 1, 'na fila ≠ só OPERACAO');
SELECT ts.ok((SELECT setor = 'OPERACAO' AND cardinality(codigos) = 31 AND 52 = ANY (codigos) AND NOT (49 = ANY (codigos))
                FROM public.op_setores_na_fila()), 'códigos da OPERACAO');
RESET ROLE;
UPDATE public.op_setores SET na_fila = true WHERE codigo = 'AGENDAMENTO';
SET LOCAL ROLE service_role;
SELECT ts.ok((SELECT string_agg(setor || '=' || array_to_string(codigos, '|'), ';' ORDER BY setor) FROM public.op_setores_na_fila() WHERE setor = 'AGENDAMENTO') = 'AGENDAMENTO=31', 'AGENDAMENTO ligado');
RESET ROLE;

DO $$ BEGIN RAISE NOTICE 'OK operacao-setores.test.sql'; END $$;
ROLLBACK;
