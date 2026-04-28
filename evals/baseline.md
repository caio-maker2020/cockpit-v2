# Baseline de evals — Triador (v0.1.0)

Como vamos medir se uma mudança no `prompts/triador.md` melhora ou piora a
classificação, sem rodar tudo na produção. **Este documento é spec, não código
ainda** — runner sai na Fase 1.

## Por que precisamos de baseline ANTES de mexer no prompt

O v1 já classifica em produção. Mensagens reais foram lidas, classificadas pelo
Claude Sonnet 4 (v1) e o operador depois aprovou, ajustou ou ignorou. Isso é o
único gabarito barato que temos. Sem fixar baseline:

- Mexer no prompt vira "achei que melhorou".
- Migrar de Sonnet 4 (v1) → Haiku 4.5 (v2) vira aposta — Haiku é mais barato e
  mais rápido, mas precisa provar que mantém qualidade.
- Quando o auditor (Opus 4.7) começar a recalibrar prompts, ele precisa de algo
  pra comparar.

## Dataset de eval — origem

Schema `legacy.*` (importado de `_backup_v1/data.sql`). Tabela primária:
`legacy.mensagens` — 2.435 cards.

### Filtragem

Não usamos os 2.435 inteiros. Aplica filtros:

1. `canal IN ('whatsapp', 'email')` — descarta `sistema` (oc 54 do Bastão; o triador não roda sobre essas).
2. `status_problema NOT IN ('arquivado')` — eram falsos-positivos descartados manualmente; ruído.
3. Pelo menos 1 movimentação em `legacy.movimentacoes` — sinal mínimo de que o card foi tocado.
4. `tipo IS NOT NULL` — descarta os que nunca chegaram a ser classificados.

Estimativa após filtro: **~1.500–1.800 mensagens**. Confirmar quando o legacy
schema estiver populado (`SELECT count(*)` com os filtros acima).

### Particionamento

- **Train (60%)** — não tocamos. Reserva pra futuro fine-tuning ou few-shot adicional.
- **Dev (20%)** — usado durante iteração de prompt. É contra esse set que rodamos a cada commit que muda `prompts/triador.md`.
- **Test (20%)** — só toca quando vamos fechar uma versão. Evita overfit no Dev.

Split estável por hash do `legacy.mensagens.id` — não embaralhar; queremos
runs reprodutíveis.

## Métricas

### M1 — Acerto de tipo (precisão por classe + macro-F1)

Comparamos `triador.tipo` contra `legacy.mensagens.tipo`. Sete classes
(rastreamento, reentrega, devolucao, avaria, extravio, inversao, cobranca,
outros).

**Meta inicial:** macro-F1 ≥ 0,80 no Dev. Se cair pra <0,75, rejeita o PR de
prompt. (Limiar pode subir depois — ver "calibração" abaixo.)

### M2 — Acerto de risco (binário alto/baixo)

Comparamos `triador.risco` contra `legacy.mensagens.nivel_risco`. Pesos
assimétricos: **falso negativo (alto → baixo) é 3x pior que falso positivo**.
Risco subestimado vira incidente; risco sobrestimado só vira ruído pro operador.

Calculamos: `cost = FN_alto * 3 + FP_alto * 1`. Quanto menor, melhor.

### M3 — Recall de NF/CTRC

Pra cada mensagem, comparamos `triador.nfs[]` e `triador.ctrcs[]` contra
`legacy.mensagens.nf` e `legacy.mensagens.ctrc` (campo único, mas
representa a NF principal). Métrica: **% das mensagens em que a NF principal
do legacy aparece em `triador.nfs[]`**.

**Meta:** ≥ 0,95. Errar NF significa não vincular ao card certo.

### M4 — Latência e custo

Por mensagem: `tokens_in`, `tokens_out`, `duration_ms`, `usd_cost`. Reportamos:

- p50 / p95 latência
- $ por 1.000 mensagens
- Comparação com baseline anterior (regressão > 30% bloqueia merge)

## Output esperado do runner (Fase 1)

```jsonl
{"id":"<legacy_msg_id>","ground_truth":{"tipo":"reentrega","risco":"baixo","nf":"26523"},"prediction":{"tipo":"reentrega","risco":"baixo","nfs":["26523"],"ctrcs":[]},"correct_tipo":true,"correct_risco":true,"nf_recall":1.0,"latency_ms":830,"tokens_in":420,"tokens_out":110,"usd":0.00018}
```

E um relatório agregado em Markdown na raiz de `evals/runs/<timestamp>.md` com
as 4 métricas + matriz de confusão dos tipos.

## O que NÃO está em escopo desta baseline

- **Vinculador.** O dedup do v1 era heurística + IA misturadas. Vamos medir as
  6 prioridades determinísticas separadamente quando o `lib/dedup-rules.ts`
  estiver plugado em DB real (Fase 1).
- **Agentes especialistas (reentrega, devolução, etc.).** Esses precisam de eval
  comportamental (sub-FSM correto, ferramenta certa, idempotência). Spec
  separada quando a Reentrega entrar em shadow mode.
- **Ações executadas.** Não testamos contra SSW de produção em eval.

## Calibração ao longo do tempo

A baseline deste documento é **provisional**. Após primeira rodada real (Fase 1):

1. Substituir as metas (`≥ 0,80`, `≥ 0,95`) pelos números observados.
2. Adicionar uma nova seção "histórico de baselines" com timestamp, modelo,
   prompt version e métricas observadas.
3. Cada PR que mudar `prompts/triador.md` precisa rodar o runner contra Dev e
   anexar o diff de métricas no commit.

## Decisões abertas

- **Operador-aprovado como fonte de verdade.** O `tipo` no legacy foi posto
  pelo Sonnet 4 e só algumas vezes corrigido manualmente. Isso polui o
  gabarito. Caminho: marcar 200 mensagens à mão no Dev para virar gabarito
  ouro. Custo estimado: 2–3h do Caio. Pendente decisão.
- **Custo limite por run.** Com Haiku 4.5 a $0,80/1M tokens out, 1.500 mensagens
  do Dev custam ≈ $0,30 por run completo. Aceitável. Opus 4.7 não roda em eval
  do triador — só auditoria periódica.

## Como vai ser rodado (esperado)

```bash
# Quando o runner existir (fase 1):
bun run evals --target=triador --split=dev
bun run evals --target=triador --split=test --tag=v0.2.0
```

Saída em `evals/runs/<timestamp>/`:
- `report.md` — métricas + diff vs último run
- `predictions.jsonl` — uma linha por mensagem
- `confusion.csv` — matriz de confusão dos tipos
