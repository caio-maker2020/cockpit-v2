-- 2026-08-08_318 — Chat do Agente-Chefe na aba Aprendizado (Fase 1 do plano
-- aprovado pelo Caio 08/08).
--
-- Duas conversas: CHAT 1 (Isadora inicia, pergunta e propõe) e CHAT 2 (o
-- agente-chefe inicia no ciclo diário com a pauta de descasamentos). A engine
-- é a edge function `agente-chefe-chat` (Claude com ferramentas de LEITURA +
-- registro no learning_log — nunca SSW/deploy).
--
-- Aditiva e inerte: tabelas novas + feature flag DESLIGADA. Nenhum objeto
-- existente é alterado. Operadores não têm acesso (RLS gestor-only).

BEGIN;

-- ============================================================
-- 1. Sessões de conversa
-- ============================================================
CREATE TABLE public.aprendizado_chat_sessoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL CHECK (tipo IN ('isadora_iniciou', 'agente_iniciou')),
  status text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta', 'encerrada')),
  titulo text,
  -- agente do Cockpit em foco na conversa (ex: 'agente-sugere-ocs-padrao')
  agente_alvo text,
  -- operador que abriu (null quando o agente-chefe iniciou)
  criado_por uuid REFERENCES public.operadores(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- toca a cada mensagem nova (ordenação da lista de conversas)
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_chat_sessoes_status_updated
  ON public.aprendizado_chat_sessoes (status, updated_at DESC);

-- ============================================================
-- 2. Mensagens (append-only)
-- ============================================================
CREATE TABLE public.aprendizado_chat_mensagens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sessao_id uuid NOT NULL REFERENCES public.aprendizado_chat_sessoes(id) ON DELETE CASCADE,
  papel text NOT NULL CHECK (papel IN ('gestor', 'agente', 'sistema')),
  -- quem falou quando papel='gestor'
  operador_id uuid REFERENCES public.operadores(id),
  conteudo text NOT NULL,
  -- estrutura pra UI rica (casos citados, números, replay etc.)
  dados jsonb,
  -- paths no bucket 'aprendizado' (prints anexados)
  imagens text[],
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_chat_mensagens_sessao_created
  ON public.aprendizado_chat_mensagens (sessao_id, created_at);

-- Mensagem nova toca a sessão (lista ordena por atividade)
CREATE OR REPLACE FUNCTION public.chat_aprendizado_toca_sessao()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.aprendizado_chat_sessoes
  SET updated_at = now()
  WHERE id = NEW.sessao_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_chat_mensagem_toca_sessao
AFTER INSERT ON public.aprendizado_chat_mensagens
FOR EACH ROW EXECUTE FUNCTION public.chat_aprendizado_toca_sessao();

-- Append-only: mensagem não se edita nem se apaga (memória institucional —
-- mesmo racional do learning_log)
CREATE OR REPLACE FUNCTION public.chat_aprendizado_bloqueia_mutacao()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'aprendizado_chat_mensagens é append-only (% bloqueado)', TG_OP;
END;
$$;

CREATE TRIGGER trg_chat_mensagens_append_only
BEFORE UPDATE OR DELETE ON public.aprendizado_chat_mensagens
FOR EACH ROW EXECUTE FUNCTION public.chat_aprendizado_bloqueia_mutacao();

-- ============================================================
-- 3. RLS — gestor-only (Caio + Isadora); service_role bypassa
--    (regra security-rls-performance: função em subselect = initplan 1x)
-- ============================================================
ALTER TABLE public.aprendizado_chat_sessoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aprendizado_chat_mensagens ENABLE ROW LEVEL SECURITY;

CREATE POLICY chat_sessoes_gestor_select ON public.aprendizado_chat_sessoes
  FOR SELECT TO authenticated
  USING ((SELECT public.current_operador_papel()) = 'gestor');

CREATE POLICY chat_sessoes_gestor_insert ON public.aprendizado_chat_sessoes
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.current_operador_papel()) = 'gestor'
    AND tipo = 'isadora_iniciou'  -- humano só abre CHAT 1; CHAT 2 é do agente (service_role)
  );

CREATE POLICY chat_sessoes_gestor_encerra ON public.aprendizado_chat_sessoes
  FOR UPDATE TO authenticated
  USING ((SELECT public.current_operador_papel()) = 'gestor')
  WITH CHECK ((SELECT public.current_operador_papel()) = 'gestor');

CREATE POLICY chat_mensagens_gestor_select ON public.aprendizado_chat_mensagens
  FOR SELECT TO authenticated
  USING ((SELECT public.current_operador_papel()) = 'gestor');

-- INSERT de mensagem só via edge function (service_role): o front manda a
-- mensagem pra function, que valida gestor + grava + responde. Sem policy de
-- INSERT pra authenticated = negado por default.

-- ============================================================
-- 4. Realtime (chat ao vivo no front)
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.aprendizado_chat_sessoes;
ALTER PUBLICATION supabase_realtime ADD TABLE public.aprendizado_chat_mensagens;

-- ============================================================
-- 5. Kill-switch (nasce DESLIGADO — liga só após validação do Caio)
-- ============================================================
INSERT INTO public.feature_flags (key, enabled, description)
VALUES ('aprendizado_chat_enabled', false,
        'Chat fluido do agente-chefe na aba Aprendizado (Caio+Isadora). OFF = aba mantém só o fluxo de chips atual.')
ON CONFLICT (key) DO NOTHING;

COMMIT;
