-- =============================================================================
-- 2026-10-08_442 — Semente dos membros da Operação vindos do Pendências (ADR 0042).
-- GERADA por scripts/gerar-semente-membros-operacao.ts a partir de: export do Pendências (SQL editor, 08/10 17:36: profiles + user_roles + user_sectors + user_branches)
-- Acerta SETORES (e gerente_op) dos membros que JÁ existem em operacao_membros, casando pelo
-- e-mail (gerente_filial → gerente_op; admin/diretor/head → supervisor_op; usuario_setor mantém
-- o papel atual; unidades e pode_lancar intocados). Não insere membro, não cria login nem senha: quem não casa fica 'pendente'.
-- Idempotente (UPDATE só quando muda). pode_lancar e unidades NÃO são tocados.
-- DEPENDÊNCIAS: 430 (operacao_membros) e 441 (setores, gerente_op).
-- CLASSIFICAÇÃO: TIPO B. AUTORIZACAO: "<quem>, <quando>: <ordem/motivo>" (--autorizado-por).
-- REVERSÃO: UPDATE public.operacao_membros SET setores = '{OPERACAO}' (e papel_op de volta, se preciso);
--           DROP TABLE IF EXISTS public.op_membros_semente;
-- CONFERIDO por leitura no Cockpit (08/10): 90 membros em operacao_membros, os 90 casam aqui.
-- Resultado esperado: papel gerente_op 63 (eram operador_op), supervisor_op 23, operador_op 4;
-- setores OPERACAO 69 · OPERACAO+DEVOLUCAO 18 · OPERACAO+DEVOLUCAO+PERDAS 1 · todos 1 · DEVOLUCAO 1.
-- As outras 28 linhas do export não são membros: ficam 'pendente' (nenhum login é criado).
-- ATENÇÃO gerente_op: vê só as SUAS unidades (op_pode_ver_unidade, mig 430) — conferir que os
-- 63 têm unidades preenchidas antes de aplicar, senão passam a ver nada.
-- Ficaram de fora da planilha:
--   (nenhum)
-- ⚠ NÃO APLICADA. ⚠ SEM BEGIN/COMMIT interno.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.op_membros_semente (
  email       text PRIMARY KEY CHECK (email = lower(btrim(email))),
  nome        text NOT NULL,
  papel_op    text NOT NULL CHECK (papel_op IN ('operador_op', 'supervisor_op', 'gerente_op')),
  setores     text[] NOT NULL,
  unidades    text[] NOT NULL DEFAULT '{}',
  pode_lancar boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'cadastrado', 'ja_existia')),
  fonte       text NOT NULL DEFAULT 'Pendências (export da Sal)',
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.op_membros_semente ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.op_membros_semente FROM anon, authenticated;

INSERT INTO public.op_membros_semente (email, nome, papel_op, setores, unidades, pode_lancar) VALUES
  ('ana.faria@salexpress.com.br', 'Ana Faria', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('ana.luiza@salexpress.com.br', 'Ana Luiza Rodrigues', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('betransporte2016@hotmail.com', 'ARI', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('arthur.campos@salexpress.com.br', 'Arthur Campos', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('eraldosilvanatransportes@gmail.com', 'AXR', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('emilioj19@yahoo.com.br', 'BCN', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('daniel.cristian@salexpress.com.br', 'BHE', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('eliana.silva@salexpress.com.br', 'BHE', 'gerente_op', ARRAY['OPERACAO', 'DEVOLUCAO']::text[], ARRAY[]::text[], false),
  ('mariane.parreiras@salexpress.com.br', 'BHE', 'gerente_op', ARRAY['OPERACAO', 'DEVOLUCAO']::text[], ARRAY[]::text[], false),
  ('jeferson.siqueira@salexpress.com.br', 'BHZ', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('bruno.lacerda@salexpress.com.br', 'Bruno Henrique de Lacerda Silva', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('caio@salexpress.com.br', 'Caio', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('agro.animal@salexpress.com.br', 'Camila', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('relacionamento.diversos@salexpress.com.br', 'Carlos', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('cleber.ramos@salexpress.com.br', 'Cleber Ramos', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('clenir.souto@salexpress.com.br', 'Clenir Souto', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('administrativo@rapidonorte.com.br', 'COR', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('galpaokta@gmail.com', 'CTG', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('daiene.lisboa@salexpress.com.br', 'Daiene Priscila Ferreira Lisboa', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('davi.lopes@salexpress.com.br', 'Davi Lopes', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('diogo.dangelo@salexpress.com.br', 'Diogo Dangelo', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('ferramentas.construcao@salexpress.com.br', 'Duilio / Ingrid', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('elaine.souza@salexpress.com.br', 'Elaine Souza', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('elissoncamilo@camilostransportes.com.br', 'Elisson CLV', 'gerente_op', ARRAY['OPERACAO', 'DEVOLUCAO']::text[], ARRAY[]::text[], false),
  ('joyce.erbst@salexpress.com.br', 'Farmacêutica - VGA', 'operador_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('flavia.rodrigues@salexpress.com.br', 'Flavia de Cassia Rodrigues', 'gerente_op', ARRAY['DEVOLUCAO']::text[], ARRAY[]::text[], false),
  ('francisco.junior@isamartransp.com.br', 'Francisco Junior', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('fred.amaral@salexpress.com.br', 'Fred Amaral', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('weberqueiroz@outlook.com', 'FRU', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('geraldo@salexpress.com.br', 'Geraldo Anselmo', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('gil.medeiros@salexpress.com.br', 'Gil Medeiros', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('heleandro.benedito@salexpress.com.br', 'Heleandro Benedito', 'gerente_op', ARRAY['OPERACAO', 'DEVOLUCAO', 'PERDAS']::text[], ARRAY[]::text[], false),
  ('deuseliosantos05@gmail.com', 'IMA', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('sac3.vix@transcherrer.com.br', 'Isabele - SES', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('isabella@salexpress.com.br', 'Isabella Costa', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('isadora.baldoni@salexpress.com.br', 'Isadora Baldoni', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('italoaurelio0@gmail.com', 'Ítalo Aurélio de Paula Vieira', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('betransportes.itaobim@outlook.com', 'ITB', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('jakson.santana@salexpress.com.br', 'Jakson Diego Santana', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('acarlos13@hotmail.com', 'JAU', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('parceiroaib@gmail.com', 'JIB', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('joao.penha@salexpress.com.br', 'João Penha', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('julia.barros@salexpress.com.br', 'Julia Barros', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('karoline.eduarda@salexpress.com.br', 'Karoline Julio', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('keldernagel57@gmail.com', 'Kelder Nagel', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('relacionamento.farmaceutico@salexpress.com.br', 'Larissa', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('leonel.prudente@salexpress.com.br', 'Leonel Ramos Prudente', 'gerente_op', ARRAY['DEVOLUCAO']::text[], ARRAY[]::text[], false),
  ('agendamento.coleta@salexpress.com.br', 'Luana', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('luciana.faria@salexpress.com.br', 'Luciana Lopes Faria', 'gerente_op', ARRAY['RESSARCIMENTO']::text[], ARRAY[]::text[], false),
  ('luis.eduardo@salexpress.com.br', 'Luiz Eduardo', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('magnoneves.log@gmail.com', 'Magno Neves', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('marcelo.soares@salexpress.com.br', 'Marcelo Soares', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('marcosmachadodev@gmail.com', 'Marcos Machado', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('operador.logistico@salexpress.com.br', 'Maria Eduarda', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('maria.paula@salexpress.com.br', 'Maria Paula', 'gerente_op', ARRAY['PERDAS']::text[], ARRAY[]::text[], false),
  ('mariana.costa@salexpress.com.br', 'Mariana Costa', 'supervisor_op', ARRAY['OPERACAO', 'AGENDAMENTO', 'DEVOLUCAO', 'RESSARCIMENTO', 'PERDAS', 'CLIENTE']::text[], ARRAY[]::text[], false),
  ('mariana.bonfim@salexpress.com.br', 'Mariana Teodoro Bonfim', 'gerente_op', ARRAY['RESSARCIMENTO']::text[], ARRAY[]::text[], false),
  ('marianne.silva@salexpress.com.br', 'Marianne Silva', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('mateus.gomes@salexpress.com.br', 'Mateus Gomes', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('mateus.montin@salexpress.com.br', 'Mateus Montin', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('mayra.silva@salexpress.com.br', 'Mayra Silva', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('minaslogoperacional1@gmail.com', 'MCU', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('ana.pereira@salexpress.com.br', 'MTC', 'gerente_op', ARRAY['OPERACAO', 'DEVOLUCAO']::text[], ARRAY[]::text[], false),
  ('deli.araujo@grupotransp.com.br', 'MTC', 'gerente_op', ARRAY['OPERACAO', 'DEVOLUCAO']::text[], ARRAY[]::text[], false),
  ('ourobranco@grupotransp.com.br', 'OUR', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('admlltlogistica01@gmail.com', 'PAS', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('paracatu@rodofar.com.br', 'PCT', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('p@p.com', 'Pedro', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('pedro@salexpress.com.br', 'Pedro Parucci', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('phelipe.junio@isamartransp.com.br', 'Phelipe Junio', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('operacionalpontenova@gmail.com', 'PNO', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('kelver.silva@salexpress.com.br', 'POA', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('luiz.henrique@grupotransp.com.br', 'POA', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('mirella.santos@salexpress.com.br', 'POA', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('rafaela.faria@salexpress.com.br', 'Rafaela Faria', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('rangel.paula@salexpress.com.br', 'Rangel Paula', 'gerente_op', ARRAY['RESSARCIMENTO', 'PERDAS']::text[], ARRAY[]::text[], false),
  ('ricardo.martins@salexpress.com.br', 'Ricardo Martins', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('robo.coletas@salexpress.com.br', 'Robô Coletas 103', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('rodrigo.maia@salexpress.com.br', 'Rodrigo Maia', 'gerente_op', ARRAY['DEVOLUCAO']::text[], ARRAY[]::text[], false),
  ('ronaldo.oliveira@salexpress.com.br', 'Ronaldo Oliveira', 'operador_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('ryan.faria@grupotransp.com.br', 'Ryan Faria', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('sac@salexpress.com.br', 'Sac Sal Express', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('sara.silva@salexpress.com.br', 'Sara Silva Melo', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('eng.processos@salexpress.com.br', 'sara teste', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('juliano.oliveira@salexpress.com.br', 'SJF', 'gerente_op', ARRAY['OPERACAO', 'DEVOLUCAO']::text[], ARRAY[]::text[], false),
  ('carlinhostransportes@hotmail.com', 'SLI', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('solange.santos@salexpress.com.br', 'Solange UDI', 'operador_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('victoria.silveira@alejotransportes.com', 'SPL', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('diovannia.cruz@salexpress.com.br', 'SPM', 'gerente_op', ARRAY['OPERACAO', 'DEVOLUCAO']::text[], ARRAY[]::text[], false),
  ('tatiana@salexpress.com.br', 'Tatiana Kelly', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('taynara.conde@isamartransp.com.br', 'Taynara Conde', 'supervisor_op', ARRAY['DEVOLUCAO']::text[], ARRAY[]::text[], false),
  ('leticia.chalub@grupotransp.com.br', 'TEO', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('gerencia@salexpress.com.br', 'TESTE', 'operador_op', ARRAY['OPERACAO', 'DEVOLUCAO', 'RESSARCIMENTO', 'PERDAS', 'CLIENTE']::text[], ARRAY[]::text[], false),
  ('banco.formulario@grupotransp.com.br', 'Teste Ana', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('thaini.rosa@salexpress.com.br', 'Thaini Rosa', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('thiago.darlan@salexpress.com.br', 'Thiago Darlan', 'gerente_op', ARRAY['RESSARCIMENTO']::text[], ARRAY[]::text[], false),
  ('th.silva@isamartransp.com.br', 'Thiago Millions', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('thiago.silva@salexpress.com.br', 'Thiago Silva', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('thomas.ferreira@salexpress.com.br', 'Thomas Ferreira', 'supervisor_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('conquista.gabriella@gmail.com', 'TUI', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('auto.pecas@salexpress.com.br', 'Tulio', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('otavio.assis@grupotransp.com.br', 'UBB', 'gerente_op', ARRAY['OPERACAO', 'DEVOLUCAO']::text[], ARRAY[]::text[], false),
  ('ana.carla@salexpress.com.br', 'UDI', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('rogerio.oliveira@salexpress.com.br', 'UDI', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('walber.silva@salexpress.com.br', 'UDI', 'gerente_op', ARRAY['OPERACAO', 'DEVOLUCAO']::text[], ARRAY[]::text[], false),
  ('suporte.relacionamento@salexpress.com.br', 'Vazio', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('igor.pedroso@salexpress.com.br', 'VGA', 'gerente_op', ARRAY['OPERACAO', 'DEVOLUCAO']::text[], ARRAY[]::text[], false),
  ('layara.paula@salexpress.com.br', 'VGA', 'gerente_op', ARRAY['OPERACAO', 'DEVOLUCAO']::text[], ARRAY[]::text[], false),
  ('luiz.furtado@salexpress.com.br', 'VGA', 'gerente_op', ARRAY['OPERACAO', 'DEVOLUCAO']::text[], ARRAY[]::text[], false),
  ('naiane.pereira@salexpress.com.br', 'VGA', 'gerente_op', ARRAY['OPERACAO', 'DEVOLUCAO']::text[], ARRAY[]::text[], false),
  ('saude.humana@salexpress.com.br', 'Victor', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false),
  ('vitoria.alves@salexpress.com.br', 'Vitória Alves', 'gerente_op', ARRAY['RESSARCIMENTO', 'PERDAS']::text[], ARRAY[]::text[], false),
  ('antonio.alves@salexpress.com.br', 'VIX', 'gerente_op', ARRAY['OPERACAO', 'DEVOLUCAO']::text[], ARRAY[]::text[], false),
  ('joao.amaro@salexpress.com.br', 'VIX', 'operador_op', ARRAY['OPERACAO', 'DEVOLUCAO']::text[], ARRAY[]::text[], false),
  ('marcia.souza@salexpress.com.br', 'VIX', 'operador_op', ARRAY['OPERACAO', 'DEVOLUCAO']::text[], ARRAY[]::text[], false),
  ('neuzinete.maria@salexpress.com.br', 'VIX', 'gerente_op', ARRAY['OPERACAO', 'DEVOLUCAO']::text[], ARRAY[]::text[], false),
  ('pedro.lima@salexpress.com.br', 'VIX', 'gerente_op', ARRAY['OPERACAO', 'DEVOLUCAO']::text[], ARRAY[]::text[], false),
  ('washington.vicente@salexpress.com.br', 'Washington Vicente Beuquis', 'gerente_op', ARRAY['OPERACAO']::text[], ARRAY[]::text[], false)
ON CONFLICT (email) DO UPDATE SET nome = EXCLUDED.nome, papel_op = EXCLUDED.papel_op, setores = EXCLUDED.setores,
  unidades = EXCLUDED.unidades, pode_lancar = EXCLUDED.pode_lancar, atualizado_em = now();

-- Os membros JÁ existem em operacao_membros (90 linhas cadastradas em 08/10, vindas do
-- Pendências). Esta semente NÃO insere ninguém: só acerta setores (e gerente_op) dos que casam
-- pelo e-mail. Quem não está em operacao_membros fica 'pendente' (nenhum login é criado).
WITH alvo AS (
  SELECT s.*, m.id AS membro_id
    FROM public.op_membros_semente s
    JOIN public.operacao_membros m ON lower(m.email) = s.email
), upd AS (
  UPDATE public.operacao_membros m
     SET setores = a.setores,
         papel_op = CASE WHEN a.papel_op IN ('gerente_op', 'supervisor_op') THEN a.papel_op ELSE m.papel_op END,
         updated_at = now()
    FROM alvo a
   WHERE m.id = a.membro_id
     AND (m.setores IS DISTINCT FROM a.setores OR (a.papel_op IN ('gerente_op', 'supervisor_op') AND m.papel_op IS DISTINCT FROM a.papel_op))
  RETURNING lower(m.email) AS email
)
UPDATE public.op_membros_semente s
   SET status = CASE WHEN s.email IN (SELECT email FROM upd) THEN 'cadastrado' ELSE 'ja_existia' END,
       atualizado_em = now()
 WHERE s.email IN (SELECT email FROM alvo);

-- Conferência (leitura): quem ficou pendente por não ter login no Cockpit.
-- SELECT email, papel_op, setores, unidades FROM public.op_membros_semente WHERE status = 'pendente';
