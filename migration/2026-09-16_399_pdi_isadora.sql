-- =============================================================================
-- 2026-09-16_399 — PDI da Isadora (Plano de Desenvolvimento) — fundações
-- =============================================================================
-- Caio 16/09: "perfeito, pode implementar em branch separada" (plano aprovado
-- na íntegra). Aba nova no cockpit-web visível SÓ pra Isadora + Caio.
-- 3 frentes com gating (nasce liberada só a 1 — Delegar e Rotina); entregas
-- com definição de pronto + aceite do Caio; kanban; Mapa de Demanda em 2
-- momentos (captura ≤20s + endereçamento semanal a 4 destinos); 1:1 com áudio
-- do iPhone → transcrição (Whisper, ADR 0029) + resumo (Sonnet) + compromissos
-- viram cards; nota privada do Caio em tabela separada (RLS só dele).
-- TIPO A (tudo novo). Sem BEGIN. skill supabase-postgres-best-practices aplicada.
-- =============================================================================

-- ── helpers de acesso (e-mail do JWT) ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pdi_participante()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT (SELECT auth.jwt()->>'email') IN
    ('isadora.baldoni@salexpress.com.br', 'caio@salexpress.com.br');
$$;
CREATE OR REPLACE FUNCTION public.pdi_eh_caio()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT (SELECT auth.jwt()->>'email') = 'caio@salexpress.com.br';
$$;
REVOKE ALL ON FUNCTION public.pdi_participante(), public.pdi_eh_caio() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pdi_participante(), public.pdi_eh_caio() TO authenticated;

-- ── frentes (gating) ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pdi_frentes (
  id          int PRIMARY KEY,
  nome        text NOT NULL,
  descricao   text NOT NULL,
  liberada    boolean NOT NULL DEFAULT false,
  liberada_em timestamptz,
  liberada_por text
);
ALTER TABLE public.pdi_frentes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pdi_frentes_select ON public.pdi_frentes;
CREATE POLICY pdi_frentes_select ON public.pdi_frentes
  FOR SELECT TO authenticated USING (public.pdi_participante());
-- liberação SÓ via RPC pdi_liberar_frente (Caio)

INSERT INTO public.pdi_frentes (id, nome, descricao, liberada, liberada_em, liberada_por) VALUES
 (1, 'Delegar e Rotina',
    'Mapa de demanda, matriz de alçada e rotina-mestra: tirar da Isadora o que não é dela e proteger o tempo do que é.',
    true, now(), 'caio (nascimento do PDI, 16/09)'),
 (2, 'Pessoas e Performance',
    'Scorecard por operador, ritual de feedback e 9box: medir e desenvolver o time com dado, não com impressão.',
    false, NULL, NULL),
 (3, 'Processos e Rituais',
    'Inventário de processos com dono e SLA + ritual de melhoria contínua (o playbook de vetos é o case-modelo).',
    false, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- ── treinamentos e frameworks (documentos vivos) ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.pdi_treinamentos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  frente_id    int NOT NULL REFERENCES public.pdi_frentes(id),
  titulo       text NOT NULL,
  resumo       text,
  realizado_em date,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pdi_treinamentos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pdi_trein_all ON public.pdi_treinamentos;
CREATE POLICY pdi_trein_all ON public.pdi_treinamentos
  FOR ALL TO authenticated USING (public.pdi_participante()) WITH CHECK (public.pdi_participante());
CREATE INDEX IF NOT EXISTS idx_pdi_trein_frente ON public.pdi_treinamentos (frente_id);

CREATE TABLE IF NOT EXISTS public.pdi_frameworks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  frente_id  int NOT NULL REFERENCES public.pdi_frentes(id),
  titulo     text NOT NULL,
  conteudo   text NOT NULL DEFAULT '',
  versao     int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pdi_frameworks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pdi_fw_all ON public.pdi_frameworks;
CREATE POLICY pdi_fw_all ON public.pdi_frameworks
  FOR ALL TO authenticated USING (public.pdi_participante()) WITH CHECK (public.pdi_participante());
CREATE INDEX IF NOT EXISTS idx_pdi_fw_frente ON public.pdi_frameworks (frente_id);

INSERT INTO public.pdi_frameworks (frente_id, titulo, conteudo)
SELECT 1, 'Matriz de Alçada',
  E'Níveis de delegação (preencher a partir dos itens "vira alçada" do Mapa de Demanda):\n\n1. Decide sozinha —\n2. Decide e informa —\n3. Consulta antes —\n4. Traz opções —\n5. Traz o problema —'
WHERE NOT EXISTS (SELECT 1 FROM public.pdi_frameworks WHERE titulo = 'Matriz de Alçada');

-- ── entregas (com definição de pronto + aceite do Caio) ──────────────────────
CREATE TABLE IF NOT EXISTS public.pdi_entregas (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  frente_id          int NOT NULL REFERENCES public.pdi_frentes(id),
  titulo             text NOT NULL,
  definicao_de_pronto text NOT NULL,
  prazo              date,
  status             text NOT NULL DEFAULT 'a_fazer',  -- a_fazer|fazendo|entregue|validada|devolvida
  conteudo           text NOT NULL DEFAULT '',          -- onde a Isadora entrega
  devolutiva         text,                              -- quando o Caio devolve
  entregue_em        timestamptz,
  validada_em        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pdi_entregas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pdi_entregas_all ON public.pdi_entregas;
CREATE POLICY pdi_entregas_all ON public.pdi_entregas
  FOR ALL TO authenticated USING (public.pdi_participante()) WITH CHECK (public.pdi_participante());
CREATE INDEX IF NOT EXISTS idx_pdi_entregas_frente ON public.pdi_entregas (frente_id);
-- validar/devolver SÓ via RPC pdi_validar_entrega (Caio)

INSERT INTO public.pdi_entregas (frente_id, titulo, definicao_de_pronto, prazo)
SELECT 1, 'Mapa de Demanda — 2 semanas de registro fiel',
  'Toda demanda/acionamento registrado no dia em que aconteceu (captura ≤20s), 100% dos itens da semana endereçados no ritual de sexta, e leitura escrita de 5 linhas: qual classe de causa domina e o que ela propõe atacar primeiro.',
  (current_date + 14)
WHERE NOT EXISTS (SELECT 1 FROM public.pdi_entregas WHERE titulo LIKE 'Mapa de Demanda%');

-- ── kanban ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pdi_todos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  frente_id    int REFERENCES public.pdi_frentes(id),
  titulo       text NOT NULL,
  detalhe      text,
  origem       text NOT NULL DEFAULT 'manual',  -- entrega|compromisso_1a1|demanda|manual
  origem_id    uuid,
  prazo        date,
  status       text NOT NULL DEFAULT 'a_fazer', -- a_fazer|fazendo|entregue|validado
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  concluido_em timestamptz
);
ALTER TABLE public.pdi_todos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pdi_todos_all ON public.pdi_todos;
CREATE POLICY pdi_todos_all ON public.pdi_todos
  FOR ALL TO authenticated USING (public.pdi_participante()) WITH CHECK (public.pdi_participante());
CREATE INDEX IF NOT EXISTS idx_pdi_todos_status ON public.pdi_todos (status);

-- ── mapa de demanda (captura + endereçamento) ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pdi_demanda_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  criado_em     timestamptz NOT NULL DEFAULT now(),
  ator          text NOT NULL,      -- quem acionou / o que ela executou
  pedido        text NOT NULL,
  canal         text NOT NULL,      -- whatsapp|email|telefone|presencial|cockpit
  tempo_min     int  NOT NULL,      -- 5|15|30|60
  classe_causa  text NOT NULL,      -- falta_conhecimento|processo_disfuncional|expectativa_desalinhada|excecao
  destino       text,               -- vira_conhecimento|vira_alcada|vira_projeto|fica_execucao (null = pendente)
  destino_det   text,               -- alçada: quem+regra; projeto: causa raiz; conhecimento: o que documentar
  enderecada_em timestamptz
);
ALTER TABLE public.pdi_demanda_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pdi_demanda_all ON public.pdi_demanda_log;
CREATE POLICY pdi_demanda_all ON public.pdi_demanda_log
  FOR ALL TO authenticated USING (public.pdi_participante()) WITH CHECK (public.pdi_participante());
CREATE INDEX IF NOT EXISTS idx_pdi_demanda_criado ON public.pdi_demanda_log (criado_em);
CREATE INDEX IF NOT EXISTS idx_pdi_demanda_pendente ON public.pdi_demanda_log (enderecada_em) WHERE destino IS NULL;

-- ── 1:1 (áudio → transcrição → resumo → compromissos) ────────────────────────
CREATE TABLE IF NOT EXISTS public.pdi_1a1 (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data        date NOT NULL DEFAULT current_date,
  audio_path  text,                 -- storage: pdi_1a1/<id>.<ext>
  transcricao text,
  resumo      jsonb,                -- {pauta[], feedbacks[], compromissos[{titulo,prazo}], sinais[]}
  status      text NOT NULL DEFAULT 'aguardando_audio', -- aguardando_audio|processando|resumido|erro
  erro        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pdi_1a1 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pdi_1a1_select ON public.pdi_1a1;
CREATE POLICY pdi_1a1_select ON public.pdi_1a1
  FOR SELECT TO authenticated USING (public.pdi_participante());
DROP POLICY IF EXISTS pdi_1a1_caio_write ON public.pdi_1a1;
CREATE POLICY pdi_1a1_caio_write ON public.pdi_1a1
  FOR INSERT TO authenticated WITH CHECK (public.pdi_eh_caio());
DROP POLICY IF EXISTS pdi_1a1_caio_update ON public.pdi_1a1;
CREATE POLICY pdi_1a1_caio_update ON public.pdi_1a1
  FOR UPDATE TO authenticated USING (public.pdi_eh_caio()) WITH CHECK (public.pdi_eh_caio());

-- nota privada do Caio: tabela separada, RLS só dele (privacidade por linha,
-- nunca por coluna — a Isadora não enxerga nem a existência)
CREATE TABLE IF NOT EXISTS public.pdi_1a1_notas_caio (
  sessao_id  uuid PRIMARY KEY REFERENCES public.pdi_1a1(id) ON DELETE CASCADE,
  nota       text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pdi_1a1_notas_caio ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pdi_1a1_notas_caio_all ON public.pdi_1a1_notas_caio;
CREATE POLICY pdi_1a1_notas_caio_all ON public.pdi_1a1_notas_caio
  FOR ALL TO authenticated USING (public.pdi_eh_caio()) WITH CHECK (public.pdi_eh_caio());

-- ── storage: bucket privado do áudio ─────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('pdi_1a1', 'pdi_1a1', false)
ON CONFLICT (id) DO NOTHING;
DROP POLICY IF EXISTS pdi_1a1_storage_select ON storage.objects;
CREATE POLICY pdi_1a1_storage_select ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'pdi_1a1' AND public.pdi_participante());
DROP POLICY IF EXISTS pdi_1a1_storage_insert ON storage.objects;
CREATE POLICY pdi_1a1_storage_insert ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'pdi_1a1' AND public.pdi_eh_caio());

-- ── RPCs de ação exclusiva do Caio (enforcement no servidor, não no front) ───
CREATE OR REPLACE FUNCTION public.pdi_liberar_frente(p_frente_id int)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT public.pdi_eh_caio() THEN RAISE EXCEPTION 'acesso_negado'; END IF;
  UPDATE public.pdi_frentes
     SET liberada = true, liberada_em = now(),
         liberada_por = (SELECT auth.jwt()->>'email')
   WHERE id = p_frente_id AND NOT liberada;
END $$;

CREATE OR REPLACE FUNCTION public.pdi_validar_entrega(p_id uuid, p_aceita boolean, p_devolutiva text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT public.pdi_eh_caio() THEN RAISE EXCEPTION 'acesso_negado'; END IF;
  IF p_aceita THEN
    UPDATE public.pdi_entregas SET status = 'validada', validada_em = now() WHERE id = p_id;
  ELSE
    UPDATE public.pdi_entregas
       SET status = 'devolvida', devolutiva = coalesce(p_devolutiva, 'devolvida sem comentário')
     WHERE id = p_id;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pdi_validar_todo(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT public.pdi_eh_caio() THEN RAISE EXCEPTION 'acesso_negado'; END IF;
  UPDATE public.pdi_todos SET status = 'validado', concluido_em = now(), updated_at = now()
   WHERE id = p_id AND status = 'entregue';
END $$;

REVOKE ALL ON FUNCTION public.pdi_liberar_frente(int) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pdi_validar_entrega(uuid, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pdi_validar_todo(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pdi_liberar_frente(int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pdi_validar_entrega(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pdi_validar_todo(uuid) TO authenticated;
