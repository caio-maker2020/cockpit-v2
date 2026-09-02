# ADR 0021 — Faxina: Prioridades AI (feature morta) e cadeia de cobrança de cliente

Data: 2026-09-02
Status: Aceito (Caio: "o prioridade ai não existe mais" + "já faça os pontos 1 2 e 3")

## Contexto

Ao medir "produção atrás do git" (ADR 0019) apareceram três funções nunca
deployadas e uma parada em produção desde 22/07, todas da aba Prioridades AI,
que o Caio confirmou morta. Inventário com evidência (API do Supabase, cron.job,
pg_depend, pg_proc, grep no repo e no front):

| Resto | Onde | Callers vivos |
|---|---|---|
| atualizar-batch-prioridades-ai, cron-sync-prioridades-ai, sync-kanban-status-prioridades | repo, nunca deployadas | nenhum |
| sync-prioridades-ai-do-bastao v6, agente-priorizador-ai v3, agente-insights-globais-ai v3, listar-contatos-cobranca v16 | prod, sem cron | nenhum |
| disparar-cobranca-escalonada v24, sugerir-cobranca-ai v21 | prod (botão "Cobrar X" da aba) | nenhum no front atual |
| processar-cobrancas-cliente-aguardando v14 (produtor do cron) | prod, cron INATIVO desde a mig 168 | só o cron inativo |
| `_shared/gerar-texto-cobranca-escalonada.ts` | repo | só as duas de cobrança |
| views v_prioridades_ai, _ultimo_sync, _saidas_recentes, v_oc21_paradas_prioridades, v_oc13_paradas_prioridades + RPC registrar_saidas_kanban | banco | só funções mortas |
| cron `cobranca-cliente-aguardando-daily` | banco, inativo | — |

O que **fica** porque está vivo: `cobrar-cliente-aguardando` (botão MANUAL "cobrar" do operador na aba RESPOSTA, `ConversationTabs.tsx`; o modo automático dele morre junto com o produtor — decisão do Caio se o botão manual também sai), `enviar-cobranca-base` (o front Indicadores
invoca em 3 pontos), `sugestao-texto-registro.ts` (redator-email-saida),
`evolution-outbound.ts` (WhatsApp), `dias_uteis_entre` (v_oc13_paradas,
v_oc21_finalizadas, v_extravios_kanban), `refresh-historico-cards-com-oc21`
(base do agente oc13), tabelas `analises_prioridades_ai` e
`prioridades_ai_saidas` (dado histórico; apagar dado é decisão à parte),
índice `idx_cards_prioridades_kanban_status` (inofensivo; fica pra não mexer
em `cards`).

## Decisão

1. Apagar as 10 pastas e o módulo compartilhado exclusivo.
2. Remover de produção as 7 que estavam deployadas.
3. Mig 376: remover as 5 views e o cron inativo, com guards de pré-condição
   (nenhuma função do banco lê; nenhum dependente externo) e pós-condição
   (vivas intactas).
4. Todos os 10 slugs em `funcoes_proibidas` do deploy-gate: um checkout velho
   não consegue ressuscitá-los.
5. Watchlist do guard destrutivo: sai `v_oc21_paradas_prioridades`; o texto
   de `dias_uteis_entre` passa a citar as views vivas; o casamento passa a ser
   por nome inteiro (a view viva `v_oc13_paradas` casava por substring com a
   morta `v_oc13_paradas_prioridades` e bloqueava a própria faxina).
6. Guard INV-138 no `/verify-cockpit`.

## Consequências

`deploy_pendente.py` zera. Qualquer volta da cobrança automática ou de
Prioridades AI falha no INV-137/138 e no deploy-gate. Reversão de código pelo
git; das views pelas migs 129/158/209/215; do cron pela mig 104.
