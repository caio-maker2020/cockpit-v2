-- =============================================================================
-- 2026-09-14_393 — TESTE DE CONHECIMENTO E COMPORTAMENTO DO RELACIONAMENTO
-- =============================================================================
-- Fase 2 do teste (Caio 14/09: "sim, pode seguir pra fase 2"). App estático no
-- projeto vercel-monitor-capacidade, login = auth existente do Cockpit.
--
-- Desenho de segurança:
--   * O GABARITO NÃO EXISTE NO BANCO — só id/frente/pergunta. Correção é Fase 3.
--   * Tabelas com RLS ligada e SEM policy → acesso só pelas RPCs SECURITY
--     DEFINER (operador nunca lê frente, nem respostas — nem as próprias).
--   * Ordem e "sem voltar" impostos NO SERVIDOR: teste_rel_responder só aceita
--     a próxima pergunta não respondida; UNIQUE(user_id, pergunta_id) trava
--     reenvio.
--   * Painel só pro caio@salexpress.com.br (teste_rel_painel checa o e-mail
--     do JWT).
--   * Metadados do "jeito da resposta" (Caio 14/09): tempo_ms, n_chars,
--     paste_count + meta jsonb (teclas, backspaces, 1ª tecla, trocas de foco).
-- TIPO A (tabelas/RPCs novas, nada existente alterado). Sem BEGIN/COMMIT.
-- skill supabase-postgres-best-practices aplicada (RLS, definer c/ search_path
-- vazio, índice em FK, grants mínimos).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.teste_rel_perguntas (
  id       int PRIMARY KEY,
  ordem    int NOT NULL UNIQUE,          -- ordem de exibição (misturada, igual pra todos)
  frente   text NOT NULL,                -- tecnica_padrao|tecnica_cinzenta|tecnica_conflito|comportamento|raciocinio
  pergunta text NOT NULL,
  ativa    boolean NOT NULL DEFAULT true
);
ALTER TABLE public.teste_rel_perguntas ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.teste_rel_respostas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  pergunta_id int  NOT NULL REFERENCES public.teste_rel_perguntas(id),
  resposta    text NOT NULL,
  iniciado_em timestamptz,               -- enviado_em - tempo_ms (calculado na RPC)
  enviado_em  timestamptz NOT NULL DEFAULT now(),
  tempo_ms    int,
  n_chars     int,
  paste_count int NOT NULL DEFAULT 0,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (user_id, pergunta_id)
);
ALTER TABLE public.teste_rel_respostas ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_teste_rel_respostas_user
  ON public.teste_rel_respostas (user_id, pergunta_id);
CREATE INDEX IF NOT EXISTS idx_teste_rel_respostas_pergunta
  ON public.teste_rel_respostas (pergunta_id);

-- ─── RPC: estado do teste do usuário logado ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.teste_rel_estado()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_uid   uuid := (SELECT auth.uid());
  v_total int;
  v_resp  int;
  v_prox  record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'nao_autenticado';
  END IF;
  SELECT count(*) INTO v_total FROM public.teste_rel_perguntas WHERE ativa;
  SELECT count(*) INTO v_resp
    FROM public.teste_rel_respostas r
    JOIN public.teste_rel_perguntas p ON p.id = r.pergunta_id AND p.ativa
   WHERE r.user_id = v_uid;
  SELECT p.id, p.pergunta INTO v_prox
    FROM public.teste_rel_perguntas p
   WHERE p.ativa
     AND NOT EXISTS (SELECT 1 FROM public.teste_rel_respostas r
                      WHERE r.user_id = v_uid AND r.pergunta_id = p.id)
   ORDER BY p.ordem
   LIMIT 1;
  RETURN jsonb_build_object(
    'total', v_total,
    'respondidas', v_resp,
    'concluido', v_prox IS NULL,
    'proxima', CASE WHEN v_prox IS NULL THEN NULL
      ELSE jsonb_build_object('id', v_prox.id, 'numero', v_resp + 1, 'pergunta', v_prox.pergunta) END
  );
END $$;

-- ─── RPC: responder a pergunta da vez (servidor decide qual é a vez) ─────────
CREATE OR REPLACE FUNCTION public.teste_rel_responder(
  p_pergunta_id int,
  p_resposta    text,
  p_tempo_ms    int DEFAULT NULL,
  p_meta        jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_uid  uuid := (SELECT auth.uid());
  v_prox int;
  v_meta jsonb := coalesce(p_meta, '{}'::jsonb);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'nao_autenticado';
  END IF;
  IF p_resposta IS NULL OR length(btrim(p_resposta)) < 2 THEN
    RAISE EXCEPTION 'resposta_vazia';
  END IF;
  IF length(p_resposta) > 40000 THEN
    RAISE EXCEPTION 'resposta_grande_demais';
  END IF;
  IF pg_column_size(v_meta) > 8192 THEN
    v_meta := '{}'::jsonb;
  END IF;
  SELECT p.id INTO v_prox
    FROM public.teste_rel_perguntas p
   WHERE p.ativa
     AND NOT EXISTS (SELECT 1 FROM public.teste_rel_respostas r
                      WHERE r.user_id = v_uid AND r.pergunta_id = p.id)
   ORDER BY p.ordem
   LIMIT 1;
  IF v_prox IS NULL THEN
    RAISE EXCEPTION 'teste_concluido';
  END IF;
  IF v_prox <> p_pergunta_id THEN
    RAISE EXCEPTION 'fora_de_ordem';  -- front desatualizado → recarregar estado
  END IF;
  INSERT INTO public.teste_rel_respostas
    (user_id, pergunta_id, resposta, iniciado_em, enviado_em, tempo_ms, n_chars, paste_count, meta)
  VALUES (
    v_uid, p_pergunta_id, p_resposta,
    now() - make_interval(secs => greatest(coalesce(p_tempo_ms, 0), 0) / 1000.0),
    now(),
    p_tempo_ms,
    length(p_resposta),
    greatest(coalesce((v_meta->>'paste_count')::int, 0), 0),
    v_meta
  );
  RETURN public.teste_rel_estado();
END $$;

-- ─── RPC: painel do Caio (status + respostas brutas) ─────────────────────────
CREATE OR REPLACE FUNCTION public.teste_rel_painel()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_email text := (SELECT auth.jwt()->>'email');
BEGIN
  IF v_email IS DISTINCT FROM 'caio@salexpress.com.br' THEN
    RAISE EXCEPTION 'acesso_negado';
  END IF;
  RETURN jsonb_build_object(
    'total_perguntas', (SELECT count(*) FROM public.teste_rel_perguntas WHERE ativa),
    'status', COALESCE((
      SELECT jsonb_agg(s ORDER BY s->>'nome')
      FROM (
        SELECT jsonb_build_object(
          'nome', COALESCE(o.nome, r.user_id::text),
          'email', o.email,
          'respondidas', count(*),
          'primeira_em', min(r.enviado_em),
          'ultima_em', max(r.enviado_em),
          'tempo_total_ms', sum(coalesce(r.tempo_ms, 0)),
          'colagens', sum(r.paste_count)
        ) AS s
        FROM public.teste_rel_respostas r
        LEFT JOIN public.operadores o ON o.user_id = r.user_id
        GROUP BY o.nome, o.email, r.user_id
      ) x
    ), '[]'::jsonb),
    'respostas', COALESCE((
      SELECT jsonb_agg(j ORDER BY (j->>'nome'), (j->>'ordem')::int)
      FROM (
        SELECT jsonb_build_object(
          'nome', COALESCE(o.nome, r.user_id::text),
          'ordem', p.ordem,
          'pergunta_id', p.id,
          'frente', p.frente,
          'pergunta', p.pergunta,
          'resposta', r.resposta,
          'tempo_ms', r.tempo_ms,
          'n_chars', r.n_chars,
          'paste_count', r.paste_count,
          'meta', r.meta,
          'enviado_em', r.enviado_em
        ) AS j
        FROM public.teste_rel_respostas r
        JOIN public.teste_rel_perguntas p ON p.id = r.pergunta_id
        LEFT JOIN public.operadores o ON o.user_id = r.user_id
      ) y
    ), '[]'::jsonb)
  );
END $$;

REVOKE ALL ON FUNCTION public.teste_rel_estado() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.teste_rel_responder(int, text, int, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.teste_rel_painel() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.teste_rel_estado() TO authenticated;
GRANT EXECUTE ON FUNCTION public.teste_rel_responder(int, text, int, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.teste_rel_painel() TO authenticated;

-- ─── Seed: 25 perguntas validadas pelo Caio 14/09 (ordem MISTURADA, igual pra
--     todos; id = numeração original Q1–Q25 do documento de validação) ────────
INSERT INTO public.teste_rel_perguntas (id, ordem, frente, pergunta) VALUES
 (1 , 1 , 'tecnica_padrao'  , 'Card com ocorrência 10 (recusa total). A foto do canhoto já foi transcrita no card e traz a ressalva com o motivo da recusa. O cliente responde o e-mail pedindo o comprovante da recusa. O que você faz e por quê?'),
 (18, 2 , 'comportamento'   , 'Você pega um card de um tipo que nunca tratou e tem dúvida real do que fazer. Descreva EXATAMENTE o que você faz, na ordem.'),
 (4 , 3 , 'tecnica_padrao'  , 'NF de 10 volumes. Extravio na transferência: 4 volumes não localizados, 6 estão na unidade. O cliente ainda não foi consultado neste ciclo. O que você faz?'),
 (22, 4 , 'raciocinio'      , 'O mesmo cliente reclamou 3 vezes no mês de "falta de retorno". Antes de propor qualquer solução: como você descobre o PORQUÊ?'),
 (9 , 5 , 'tecnica_cinzenta', 'O cliente pede o comprovante da recusa. Não existe foto — só o texto da ocorrência: "CLIENTE RECUSOU ASSINAR". O que você responde ao cliente, e o que deixa registrado?'),
 (16, 6 , 'comportamento'   , 'Um cliente grande, educado, que você atende todo dia, pede para "só dessa vez" liberar a entrega sem a autorização formal que o processo exige — promete que manda o e-mail depois. O que você faz e o que diz a ele?'),
 (3 , 7 , 'tecnica_padrao'  , 'Chega uma 49 da base dizendo que foram feitas 3 tentativas de entrega sem sucesso. O que você confere ANTES de agir, e o que lança em cada caso?'),
 (11, 8 , 'tecnica_cinzenta', 'Você liga para a base e descobre por telefone uma informação que muda a tratativa (ex.: a mercadoria já saiu para entrega), mas ela ainda não aparece no Cockpit nem no SSW. O que você faz com essa informação?'),
 (25, 9 , 'raciocinio'      , 'Liberar a entrega HOJE resolve o cliente — mas sem a autorização do pagador, a Sal assume o risco do custo se der errado. Como você pensa essa decisão? Existe resposta única?'),
 (7 , 10, 'tecnica_padrao'  , 'Card em 13 (limitação do cliente). No histórico não há CTRC emitido para reentrega nem oc 21 depois. O cliente responde autorizando nova entrega. Você lança 55 ou 21? Por quê?'),
 (19, 11, 'comportamento'   , 'Você percebe que ONTEM respondeu um cliente com informação errada — por exemplo, prometeu uma entrega que não vai acontecer. Ninguém notou ainda. O que você faz?'),
 (5 , 12, 'tecnica_padrao'  , 'Card em 59 (pendência de documentação de ressarcimento). O cliente responde com romaneio de coleta, descritivo dos itens e valor. O que você faz? E se ele tivesse mandado só a NF-e?'),
 (21, 13, 'raciocinio'      , '9h da manhã. Você tem: (a) a caixa de e-mail estourando, com vários clientes sem retorno; (b) um cliente irritado no telefone; (c) 12 cards novos na fila; (d) um extravio cujo prazo de perdas vence HOJE. Não dá pra fazer tudo agora. Qual é o seu CRITÉRIO de ordem — não quero a lista, quero o porquê.'),
 (13, 14, 'tecnica_conflito', 'Extravio parcial. O DESTINATÁRIO exige por e-mail que a entrega parcial saia hoje e ameaça reclamação formal. O PAGADOR ainda não respondeu a 54. O que você faz?'),
 (2 , 15, 'tecnica_padrao'  , 'Ocorrência 11 (problemas com endereço). A instrução do motorista tem GPS e a baixa foi feita a 6 km do endereço de entrega. O que você faz e por quê? E se não tivesse GPS nenhum?'),
 (24, 16, 'raciocinio'      , 'Você acabou de resolver um caso raro que deu muito trabalho. O que você faz DEPOIS de resolver, pensando em "isso vai acontecer de novo?"'),
 (8 , 17, 'tecnica_padrao'  , 'Card em 54 aguardando o pagador. A Operação lança uma 49 pedindo retorno. O que você faz?'),
 (20, 18, 'comportamento'   , 'Você percebe que um colega resolve um tipo de card de um jeito diferente do combinado — e o jeito dele é MAIS RÁPIDO. A fila está alta. O que você faz?'),
 (10, 19, 'tecnica_cinzenta', 'Extravio parcial, mas a instrução não diz quantos volumes faltam e o histórico está confuso. O cliente pergunta: "posso contar com a entrega amanhã?". O que você faz e o que responde?'),
 (6 , 20, 'tecnica_padrao'  , 'Chega uma 49 da base pedindo para cobrar custo de entrega dedicada. O que você faz?'),
 (14, 21, 'tecnica_conflito', 'Um card traz a sugestão do agente: relançar a 59 SEM e-mail, porque o cliente já foi informado. O card vem de um processo de indenização em que foram lançadas a 46 (em análise de ressarcimento) e a 49 — e antes disso havia a 59. O que você faz?'),
 (17, 22, 'comportamento'   , 'Cliente diz: "se não resolver até as 14h eu mando e-mail direto pro Caio". O caso depende de um retorno da base que ainda não chegou. O que você faz?'),
 (12, 23, 'tecnica_cinzenta', 'O histórico mostra oc 30 com CT-e reversa emitido (devolução em curso). O destinatário cobra: "cadê minha entrega?". O que você faz no card, e o que responde ao cliente?'),
 (23, 24, 'raciocinio'      , 'Você precisa responder o cliente AGORA e falta um dado que só a base tem — e a base não atende. O que você responde e como decide o que pode ou não afirmar?'),
 (15, 25, 'tecnica_conflito', 'O cliente já retornou com todas as informações e a 33 já foi lançada. Mesmo assim, o Ressarcimento lança 46 e 49 indicando que faltam romaneio e descrição de itens. O que você faz?')
ON CONFLICT (id) DO UPDATE
  SET ordem = EXCLUDED.ordem, frente = EXCLUDED.frente,
      pergunta = EXCLUDED.pergunta, ativa = true;
