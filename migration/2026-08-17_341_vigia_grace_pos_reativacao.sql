-- =============================================================================
-- 2026-08-17_341_vigia_grace_pos_reativacao.sql
--
-- ALARME PREMATURO DO INV-042 (Caio 2026-08-17, NF 744476): o card reabriu às
-- 10:00:36 com uma resposta antiga pendente (capturada 2 dias antes, enquanto o
-- card estava terminal — fora do Cockpit por regra). O vigia rodou às 10:01:01
-- e ALERTOU; o reconciliador consumiu a resposta às 10:02:14. O Caio recebeu
-- e-mail de algo que se resolveu sozinho 73 segundos depois.
--
-- CAUSA: o grace da RPC conta APENAS da captura da resposta. Quando um card
-- volta a estado acionável com resposta antiga anexada, o grace já "venceu" há
-- dias → o caso entra na listagem no instante da reativação, correndo contra o
-- reconciliador (cron 1min).
--
-- FIX (raiz): o início efetivo da pendência é GREATEST(captura, última
-- REATIVAÇÃO do card). Card que acabou de voltar ganha o grace inteiro contado
-- da volta: o reconciliador (5min) resolve antes de o vigia (30min) gritar.
-- Violações persistentes (as verdadeiras, como as de 11-13/08 que duraram
-- horas) continuam saindo IGUAIS.
--
-- A RPC é fonte única de reconciliador + fiscal + vigia (INV-066/067) — o
-- ajuste alinha os três de uma vez. Efeito colateral aceito: resposta antiga em
-- card reaberto passa a ser consumida ~5min após a volta (era ~90s) — o preço
-- de o e-mail do Caio só reportar o que é real.
--
-- Eventos de reativação: cobrem os caminhos conhecidos de volta a estado
-- acionável. Evento fora da lista = comportamento atual (fail-open: alerta
-- prematuro ocasional, nunca alerta perdido).
--
-- SEM begin/commit interno (lição da mig 337).
-- =============================================================================

create or replace function public.cards_resposta_cliente_nao_acionada(
  p_limit integer default 20,
  p_grace_minutos integer default 5,
  p_dias integer default 90
) returns table (
  id uuid,
  nf text,
  state text,
  capturada_em timestamptz,
  message_id uuid
)
language sql
stable
security definer
set search_path to ''
as $function$
  WITH cap AS (
    SELECT ce.card_id, max(ce.created_at) AS capturada_em
    FROM public.card_events ce
    WHERE ce.event_type = 'RespostaClienteCapturada'
      AND ce.created_at > now() - make_interval(days => GREATEST(1, LEAST(p_dias, 365)))
      AND ce.created_at < now() - make_interval(mins => GREATEST(0, LEAST(p_grace_minutos, 1440)))
    GROUP BY ce.card_id
  )
  SELECT c.id,
         c.nf,
         c.state,
         cap.capturada_em,
         (SELECT mi.id FROM public.messages_inbox mi
           WHERE mi.card_id = c.id
           ORDER BY mi.recebido_em DESC
           LIMIT 1) AS message_id
  FROM cap
  JOIN public.cards c ON c.id = cap.card_id
  WHERE c.state IN ('AGUARDANDO_CLIENTE', 'ACAO_EXECUTADA', 'AGUARDANDO_VALIDACAO_HUMANA')
    -- já processada: marcador do acionamento OU ação do operador depois
    AND NOT EXISTS (
      SELECT 1 FROM public.card_events x
      WHERE x.card_id = c.id
        AND x.event_type IN ('RetornoClienteEmAguardo', 'AprovacaoOperador', 'AcaoExecutada')
        AND x.created_at >= cap.capturada_em - interval '1 minute'
    )
    -- operadora respondeu por fora depois da captura = tratada (guard do INV-042)
    AND NOT EXISTS (
      SELECT 1 FROM public.cards_emails_outbound o
      WHERE o.card_id = c.id AND o.sent_at > cap.capturada_em
    )
    -- NF 744476 (Caio 2026-08-17): o card acabou de VOLTAR a estado acionável?
    -- Então a pendência começa AGORA, não na captura — dá o grace inteiro pras
    -- camadas automáticas antes de listar (mata o alerta-de-90-segundos).
    AND NOT EXISTS (
      SELECT 1 FROM public.card_events ent
      WHERE ent.card_id = c.id
        AND ent.event_type IN (
          'CardReaberto',
          'BastaoReabriuNFFonteRelacionamento',
          'AguardandoClienteOcMudou',
          'AcaoRevertidaPosFalha',
          'ReaberturaIndefinida'
        )
        AND ent.created_at > now() - make_interval(mins => GREATEST(0, LEAST(p_grace_minutos, 1440)))
    )
  ORDER BY cap.capturada_em ASC
  LIMIT GREATEST(1, LEAST(p_limit, 200));
$function$;

comment on function public.cards_resposta_cliente_nao_acionada(integer, integer, integer) is
  'Fonte única INV-066/067 (reconciliador + fiscal + vigia): respostas de cliente '
  'capturadas sem acionamento em card acionável. Grace vale TAMBÉM a partir da '
  'última reativação do card (mig 341, NF 744476) — card que acabou de voltar dá '
  'tempo ao reconciliador antes de virar alerta. Caio 2026-08-17.';
