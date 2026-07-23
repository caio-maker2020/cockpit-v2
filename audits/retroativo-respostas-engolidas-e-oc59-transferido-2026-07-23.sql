-- =============================================================================
-- RETROATIVO 2026-07-23 — NF 73220 (LARISSA) + classes irmãs. NÃO RODAR SEM OK
-- DO CAIO. Rodar com: bash scripts/dbq.sh -f audits/<este arquivo>
--
-- Contexto (diagnóstico completo na memória bug-nf73220-resposta-engolida):
--   Classe 1: regressão pré-59 do confirmador (13-21/07, corrigida na
--     regularização de 22/07 10:38) mandou cards com oc 54/59 recém-lançada
--     pra TRANSFERIDO (state_novo:'TRANSFERIDO' no evento
--     AcaoExecutadaConfirmadaPeloSsw). Destino correto: AGUARDANDO_CLIENTE.
--   Classe 2: respostas REAIS de clientes capturadas (RespostaClienteCapturada)
--     em cards terminais ficaram MUDAS (sem carimbo/interpretador) — buraco de
--     design corrigido no vinculador nesta branch (INV-042).
--
-- Ordem importa: Classe 2 primeiro (cliente FALOU → AVH pra operadora ver);
-- Classe 1 depois só pega os SEM resposta (→ AGUARDANDO_CLIENTE, seguem
-- esperando retorno). A interpretação da IA é automática: cron-ia-resposta-
-- pendentes pega cliente_respondeu_em NOT NULL + ia_sugestao NULL em <=1min.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- PREVIEW (conferir antes do COMMIT; se algo estranho, ROLLBACK)
-- ---------------------------------------------------------------------------

-- Classe 2 — resposta de cliente engolida (14 dias). Correção Caio 23/07:
-- o critério é "RESPOSTA MUDA", não o estado atual do card — inclui também
-- AGUARDANDO_CLIENTE (caso âncora NF 73220: Karoline moveu na mão via FORÇAR
-- ATUALIZAÇÃO e o card saiu de TRANSFERIDO, mas as respostas seguem mudas).
-- Guard anti-falso-positivo: em AGUARDANDO_CLIENTE só entra se a operadora
-- NÃO respondeu depois da captura (outbound posterior = fluxo legítimo de
-- revert do gmail-poll: "operadora respondeu fora do Cockpit").
CREATE TEMP TABLE _retro_respostas AS
SELECT c.id AS card_id, c.nf, c.state AS state_anterior,
       max(e.created_at) AS ultima_resposta_em
FROM card_events e
JOIN cards c ON c.id = e.card_id
WHERE e.event_type = 'RespostaClienteCapturada'
  AND e.created_at > now() - interval '14 days'
  AND c.state IN ('TRANSFERIDO', 'RESOLVIDO', 'AGUARDANDO_CLIENTE')
  AND c.cliente_respondeu_em IS NULL
GROUP BY c.id, c.nf, c.state
HAVING NOT EXISTS (
  SELECT 1 FROM cards_emails_outbound o
  WHERE o.card_id = c.id AND o.sent_at > max(e.created_at)
);

SELECT 'CLASSE 2 (reabrir p/ AVH — cliente falou)' AS classe, nf, state_anterior,
       to_char(ultima_resposta_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS ultima_resposta
FROM _retro_respostas ORDER BY ultima_resposta_em;

-- Classe 1 — vítimas do confirmador pré-59 ainda paradas em TRANSFERIDO,
-- SEM resposta de cliente (senão já entraram na Classe 2), oc atual 54/59:
CREATE TEMP TABLE _retro_oc59 AS
SELECT DISTINCT c.id AS card_id, c.nf, c.cod_ultima_ocorrencia AS oc
FROM card_events e
JOIN cards c ON c.id = e.card_id
WHERE e.event_type = 'AcaoExecutadaConfirmadaPeloSsw'
  AND e.payload->>'state_novo' = 'TRANSFERIDO'
  AND (e.payload->>'oc_ssw') IN ('54', '59')
  AND e.created_at BETWEEN '2026-07-13' AND '2026-07-22 14:00+00'
  AND c.state = 'TRANSFERIDO'
  AND c.cod_ultima_ocorrencia IN (54, 59)
  AND c.id NOT IN (SELECT card_id FROM _retro_respostas);

SELECT 'CLASSE 1 (TRANSFERIDO → AGUARDANDO_CLIENTE)' AS classe, nf, oc
FROM _retro_oc59 ORDER BY nf;

-- ---------------------------------------------------------------------------
-- CLASSE 2 — reabre: AVH + lock + carimbo + ia_sugestao=null (cron-ia
-- interpreta em <=1min; NF 73220 está aqui — romaneio do dia 16 + cobrança
-- do dia 22 ficam visíveis na aba CLIENTE RESPONDEU com proposta da IA).
-- ---------------------------------------------------------------------------
UPDATE cards c
SET state = 'AGUARDANDO_VALIDACAO_HUMANA',
    lock_aguardando_validacao = true,
    cliente_respondeu_em = r.ultima_resposta_em,
    ia_sugestao_oc_resposta = NULL,
    acao_executada_em = NULL
FROM _retro_respostas r
WHERE c.id = r.card_id;

INSERT INTO card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT r.card_id, 'RetroativoRespostaClienteDestravada', 'system',
       'retroativo-2026-07-23',
       jsonb_build_object(
         'motivo', 'Resposta real de cliente estava MUDA em card terminal (bug NF 73220; fix INV-042 no vinculador). Reaberto retroativamente pra AVH; cron-ia interpreta.',
         'state_anterior', r.state_anterior,
         'ultima_resposta_em', r.ultima_resposta_em,
         'caso_ancora', 'NF 73220 LARISSA — romaneio mudo 7 dias')
FROM _retro_respostas r;

-- ---------------------------------------------------------------------------
-- CLASSE 1 — corrige destino: AGUARDANDO_CLIENTE (espelho do que o FORÇAR
-- ATUALIZAÇÃO fez na 73220 em 23/07 08:51, e do que o confirmador pós-
-- regularização teria feito).
-- ---------------------------------------------------------------------------
UPDATE cards c
SET state = 'AGUARDANDO_CLIENTE',
    lock_aguardando_validacao = false
FROM _retro_oc59 r
WHERE c.id = r.card_id;

INSERT INTO card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT r.card_id, 'RetroativoOc59TransferidoCorrigido', 'system',
       'retroativo-2026-07-23',
       jsonb_build_object(
         'motivo', 'Confirmador pré-59 (regressão 13-21/07, corrigida na regularização 22/07) classificou oc 54/59 como "outras" → TRANSFERIDO. Destino correto: AGUARDANDO_CLIENTE.',
         'oc', r.oc)
FROM _retro_oc59 r;

-- Resumo final
SELECT 'TOTAL classe 2 (reabertos AVH)' AS resumo, count(*) FROM _retro_respostas
UNION ALL
SELECT 'TOTAL classe 1 (→ AGUARDANDO_CLIENTE)', count(*) FROM _retro_oc59;

COMMIT;
