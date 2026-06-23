-- ============================================================================
-- Cockpit v2 — Retroativo: 54 "sem email (cliente sem contato)" → 54 + email
--                          com destino em branco (operadora preenche no modal)
-- Data: 2026-06-23
-- Caio (NF 59354, MEDH DISTRIBUIDORA 18917657000183)
--
-- CONTEXTO / RAIZ
--   A regra de auto-ação cria a opção "54 + email" pros cards de relacionamento.
--   Quando o pagador NÃO tem contato em contatos_cliente, o
--   resolver_email_cobranca_cliente volta null e proporAutoAcaoSeAplicavel
--   REBAIXAVA a proposta pro fallback `modoSemEmail` (tool=lancar_ocorrencia) →
--   o card só mostrava "54 sem email" e a operadora perdia a opção de notificar.
--   ~62 clientes sem contato caíam nisso; no print da NF 59354 (oc=20) só
--   apareciam "54 SEM E-MAIL" + "55".
--
-- FIX DE CÓDIGO (deploy junto)
--   regras-auto-acao.ts: template ativo + sem contato → NÃO rebaixa; cria
--   "54 + email" de verdade (tool=lancar_oc_e_enviar_email) com email_destino
--   em branco + meta.precisa_email_destino=true. Executor já aceita
--   extras.email_destinatarios e auto-cadastra o email em contatos_cliente
--   pros próximos cards (registrar-contato-cliente.ts).
--
-- ESTE SCRIPT (retroativo)
--   Converte os todos PENDENTES que já nasceram no fallback "sem email POR
--   FALTA DE CONTATO" (motivo_sem_email cita contatos_cliente) pro novo formato.
--   NÃO toca nos fallbacks por TEMPLATE inativo (esses realmente não podem
--   mandar email). Guard extra: só converte se o template do oc estiver ATIVO.
--
-- IDEMPOTÊNCIA
--   Após converter, o todo deixa de casar o WHERE (tool!='lancar_ocorrencia',
--   sem motivo_sem_email) → re-rodar é no-op.
-- ============================================================================

BEGIN;

WITH mapa(oc, template_id) AS (
  VALUES
    (8,  'FALTA_DE_VOLUME'),
    (10, 'RECUSA_TOTAL'),
    (11, 'PROBLEMAS_COM_ENDERECO'),
    (13, 'FALTA_DE_VOLUME'),
    (19, 'FALTA_DE_VOLUME'),
    (20, 'FALTA_DE_VOLUME'),
    (23, 'FALTA_DE_VOLUME'),
    (26, 'FALTA_DE_VOLUME'),
    (35, 'RECUSA_PARCIAL'),
    (43, 'FALTA_DE_VOLUME'),
    (49, 'FALTA_DE_VOLUME'),
    (54, 'FALTA_DE_VOLUME')
),
convertidos AS (
  UPDATE todos t
  SET
    proposta_payload =
      (
        jsonb_set(
          jsonb_set(
            jsonb_set(
              t.proposta_payload || jsonb_build_object('tool', 'lancar_oc_e_enviar_email'),
              '{args,template_id}', to_jsonb(m.template_id::text), true
            ),
            '{meta,modo}', '"completo"'::jsonb, true
          ),
          '{meta,precisa_email_destino}', 'true'::jsonb, true
        )
        #- '{meta,motivo_sem_email}'
        #- '{args,email_destino}'
      ),
    descricao =
      regexp_replace(t.descricao, '\s*\(sem email[^)]*\)\s*$', '')
      || ' (informe o e-mail do cliente no envio)'
  FROM cards c
  JOIN mapa m ON m.oc = c.cod_ultima_ocorrencia
  JOIN templates_email te ON te.id = m.template_id AND te.ativo = true
  WHERE t.card_id = c.id
    AND t.status = 'pendente'
    AND (t.proposta_payload->'args'->>'codigo_ssw') = '54'
    AND t.proposta_payload->>'tool' = 'lancar_ocorrencia'
    AND (t.proposta_payload->'meta'->>'motivo_sem_email') ILIKE '%contatos_cliente%'
  RETURNING t.card_id, t.id AS todo_id, c.cod_ultima_ocorrencia AS oc
)
INSERT INTO card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT
  card_id,
  'AutoProposicaoPedeEmailDestino',
  'system',
  'mig-247',
  jsonb_build_object(
    'todo_id', todo_id,
    'oc', oc,
    'retroativo', true,
    'motivo', 'Retroativo: 54 sem-email (cliente sem contato) convertida pra 54 + email com destino em branco. Operadora informa no modal; email é cadastrado pros próximos cards.'
  )
FROM convertidos;

COMMIT;

-- Verificação (rodar manual após aplicar):
-- SELECT c.cod_ultima_ocorrencia AS oc, count(*) AS convertidos
-- FROM todos t JOIN cards c ON c.id=t.card_id
-- WHERE t.status='pendente'
--   AND (t.proposta_payload->'args'->>'codigo_ssw')='54'
--   AND t.proposta_payload->>'tool'='lancar_oc_e_enviar_email'
--   AND (t.proposta_payload->'meta'->>'precisa_email_destino')='true'
-- GROUP BY 1 ORDER BY 1;
