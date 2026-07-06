# RETROATIVO — Template errado no todo 54+email do oc 19 (NF 609867)

Data: 2026-07-02 · Status: **DEFINIDO, NÃO EXECUTADO** (roda SÓ depois do fix A/B/C deployado + auditado)

O fix A/B/C corrige o **futuro** (novos cards oc=19 já nascem com `ENTREGUE_COM_FALTA_PEDIR_ROMANEIO`) e as
**chamadas futuras do agente** (repatch do todo existente). Mas os cards oc=19 que **já têm** o todo 54+email
pendente com `FALTA_DE_VOLUME` (como a NF 609867) continuam errados até serem re-tocados. Este doc define como.

## Escopo (read-only — snapshot 2026-07-02): 6 cards
```sql
-- SOMENTE SELECT. Identifica os cards ATIVOS com o todo errado.
SELECT c.id AS card_id, c.nf, c.responsavel_relacionamento AS op, t.id AS todo_id,
       t.proposta_payload->'args'->>'template_id' AS template_atual
FROM cards c JOIN todos t ON t.card_id = c.id
WHERE c.state NOT IN ('RESOLVIDO','CANCELADO')
  AND c.cod_ultima_ocorrencia = 19
  AND t.status = 'pendente'
  AND t.proposta_payload->>'tool' = 'lancar_oc_e_enviar_email'
  AND t.proposta_payload->'args'->>'codigo_ssw' = '54'
  AND t.proposta_payload->'args'->>'template_id' = 'FALTA_DE_VOLUME';
-- count atual: 6
```

## Opção 1 (PREFERIDA) — re-invocar o agente (reusa o helper B, zero código novo)
Pós-deploy, para cada `card_id` do SELECT acima, invocar `agente-sugere-ocs-padrao` com `{ card_id }`. O agente
decide `ENTREGUE_COM_FALTA_PEDIR_ROMANEIO` e chama `proporAutoAcaoSeAplicavel` com `templateEmail54Override` →
o **repatch (B)** atualiza o PRÓPRIO todo (não cria gêmeo) e emite `TemplateEmail54OverrideAplicado`.
- Vantagem: caminho idêntico ao do fluxo normal; idempotente; sem SQL de escrita manual.
- Requer: SSW disponível (o agente re-puxa histórico). Rodar em lote pequeno (6), fora de pico.

## Opção 2 (FALLBACK) — backfill controlado, guarded e idempotente (SEM criar gêmeo)
Se preferir não depender do agente/SSW, UPDATE direto SÓ nos todos identificados, preservando o resto do
payload + card_event. **Idempotente** (só toca quem está em FALTA_DE_VOLUME). **Rodar em transação, revisar o
SELECT antes.** NÃO é migration (é backfill one-shot).
```sql
BEGIN;
WITH alvo AS (
  SELECT t.id AS todo_id, t.card_id
  FROM cards c JOIN todos t ON t.card_id = c.id
  WHERE c.state NOT IN ('RESOLVIDO','CANCELADO')
    AND c.cod_ultima_ocorrencia = 19
    AND t.status = 'pendente'
    AND t.proposta_payload->>'tool' = 'lancar_oc_e_enviar_email'
    AND t.proposta_payload->'args'->>'codigo_ssw' = '54'
    AND t.proposta_payload->'args'->>'template_id' = 'FALTA_DE_VOLUME'
),
upd AS (
  UPDATE todos t
  SET proposta_payload = jsonb_set(
        t.proposta_payload, '{args,template_id}', '"ENTREGUE_COM_FALTA_PEDIR_ROMANEIO"'::jsonb, true)
  FROM alvo WHERE t.id = alvo.todo_id
  RETURNING t.id AS todo_id, t.card_id
)
INSERT INTO card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT card_id, 'TemplateEmail54OverrideAplicado', 'system', 'backfill-2026-07-02',
       jsonb_build_object('todo_id', todo_id, 'de', 'FALTA_DE_VOLUME',
                          'para', 'ENTREGUE_COM_FALTA_PEDIR_ROMANEIO', 'origem', 'backfill_retroativo')
FROM upd;
-- conferir os counts; se OK: COMMIT;  senão: ROLLBACK;
COMMIT;
```
- Preserva `email_destino`/`acao_key`/`meta`/demais args (`jsonb_set` só troca `args.template_id`).
- Não cria todo novo → `uniq_todos_card_tool_cod_ativo` (INV-030) intacto.
- Emite `TemplateEmail54OverrideAplicado` (mesma trilha do helper B).

## Verificação pós-retroativo (read-only)
```sql
-- deve retornar 0 após o retroativo
SELECT count(*) FROM cards c JOIN todos t ON t.card_id=c.id
WHERE c.state NOT IN ('RESOLVIDO','CANCELADO') AND c.cod_ultima_ocorrencia=19
  AND t.status='pendente' AND t.proposta_payload->>'tool'='lancar_oc_e_enviar_email'
  AND t.proposta_payload->'args'->>'codigo_ssw'='54'
  AND t.proposta_payload->'args'->>'template_id'='FALTA_DE_VOLUME';
```

## Restrições
NÃO executar até o fix A/B/C estar deployado e auditado. Snapshot de 6 cards pode variar — re-rodar o SELECT
na hora. Preferir Opção 1; Opção 2 só se necessário, sempre com o SELECT revisado dentro da transação.
