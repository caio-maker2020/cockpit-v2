# Lovable — Fix NaN no card "Acerto Agente IA — Ocs Padrão"

**Data:** 2026-05-23
**Backend:** view `v_agente_ocs_padrao_metricas` v2 já em produção (mig 161).

## Problema

Card mostrando `% acerto: NaN% · 1 sugestões, NaN corrigidas (7d)` e boxes "1 / NaN".

## Causa raiz no front

1. View foi atualizada com novos campos: `acertos_total`, `erros_total`, `sem_feedback`, `acertos_explicitos/implicitos`, `erros_explicitos/implicitos`. O front estava lendo só os antigos.
2. Cálculo "% acerto" tava dividindo por `total_sugestoes` (que pode ser 0 ou ter cards sem feedback) em vez de `acertos + erros` (denominador correto).
3. Renderização não tratava `null` → vinha como `NaN%`.

## Schema atualizado

```ts
type MetricaPadraoRow = {
  dia: string;
  codigo_oc: 10 | 11 | 19 | 35;
  operador: string | null;
  proposta_destacada: 54 | 56 | null;
  total_sugestoes: number;          // todos cards analisados
  acertos_total: number;            // veredito = acerto
  erros_total: number;              // veredito = erro
  sem_feedback: number;             // pendentes (sem decisão ainda)
  acertos_explicitos: number;       // 👍 do operador
  acertos_implicitos: number;       // executor: aprovou == sugerido
  erros_explicitos: number;         // 👎 do operador
  erros_implicitos: number;         // executor: aprovou != sugerido
  pct_acerto_ia: number | null;     // já calculado pela view (null se 0 decisões)
  // Legados (manter pra retrocompat se preciso):
  corrigidas_explicitas: number;
  corrigidas_implicitas: number;
  acertos_confirmados: number;
};
```

## Cálculos corrigidos

```ts
const totalSug = rows.reduce((s, r) => s + r.total_sugestoes, 0);
const acertos  = rows.reduce((s, r) => s + r.acertos_total, 0);
const erros    = rows.reduce((s, r) => s + r.erros_total, 0);
const semFb    = rows.reduce((s, r) => s + r.sem_feedback, 0);

// % de acerto: denominador = decisões TOMADAS (não inclui pendentes)
const decisoes = acertos + erros;
const pctAcerto = decisoes > 0
  ? Math.round(1000 * acertos / decisoes) / 10  // 1 casa decimal
  : null;

// Por OC (junta 10+35 em "RECUSA")
const porOc = new Map<number, { sug: number; acerto: number; erro: number }>();
for (const r of rows) {
  const grupo = r.codigo_oc === 35 ? 10 : r.codigo_oc;
  if (!porOc.has(grupo)) porOc.set(grupo, { sug: 0, acerto: 0, erro: 0 });
  const acc = porOc.get(grupo)!;
  acc.sug    += r.total_sugestoes;
  acc.acerto += r.acertos_total;
  acc.erro   += r.erros_total;
}
```

## Renderização (defensiva contra null)

```tsx
function PctDisplay({ pct }: { pct: number | null }) {
  if (pct === null) {
    return <span className="text-ink-mute">—</span>;
  }
  return <span className="text-signal font-bold">{pct.toFixed(1)}%</span>;
}

function ContagemSugErr({ sug, erro }: { sug: number; erro: number }) {
  return (
    <div className="text-2xl font-bold">
      {sug} / {erro}
    </div>
  );
}
```

## Layout esperado pós-fix

```
┌─ 🎯 Acerto Agente IA — Ocs Padrão (10/11/19/35) ───────────────────────┐
│ % acerto: 100.0% · 11 sugestões, 0 erros, 6 sem decisão (7d)          │
│                                                                        │
│ Período: [ 7d | 30d | Tudo ]    Operador: [ Todos ▾ ]    Oc: [Todas]  │
│                                                                        │
│ ┌──────────┐ ┌─────────────┐ ┌─────────────┐ ┌────────────┐           │
│ │ % ACERTO │ │ oc=10/35    │ │ oc=19       │ │ oc=11      │           │
│ │  100.0%  │ │ 9 / 0       │ │ 4 / 0       │ │ 0 / 0      │           │
│ │          │ │ sug / err   │ │ sug / err   │ │ sug / err  │           │
│ └──────────┘ └─────────────┘ └─────────────┘ └────────────┘           │
│                                                                        │
│ Detalhe: 3 acertos explícitos (👍) · 2 acertos implícitos              │
│          0 erros explícitos (👎) · 0 erros implícitos                  │
│                                                                        │
│ Top motivos de correção (0 erros marcados ainda):                      │
│ (nada ainda)                                                           │
│                                                                        │
│ Tabela detalhada (8 linhas):                                          │
│ Dia        OC  Operador  Destaque  Total  Acerto  Erro  Pend.  %      │
│ 2026-05-22 10  LARISSA   54        3      2       0     1      100%   │
│ ...                                                                    │
└────────────────────────────────────────────────────────────────────────┘
```

## Texto do header

Substitua:
```
% acerto: NaN% · 1 sugestões, NaN corrigidas (7d)
```
Por:
```
% acerto: {pctAcerto ?? '—'}% · {totalSug} sugestões, {erros} erros, {semFb} sem decisão ({periodo})
```

Quando `decisoes === 0` (todo mundo ainda pendente), `pctAcerto` é null e exibe `—` em vez de `NaN%`.

## Top motivos de correção

Query continua igual, só filtra explicitamente por errou:

```ts
const { data: motivos } = await supabase
  .from("agente_ocs_padrao_feedback")
  .select(`
    id, motivo_correcao, decisao_correta_codigo_ssw, codigo_oc_card,
    corrigido_por_nome, corrigido_em,
    card:cards (nf)
  `)
  .eq("tipo_feedback", "sugestao_errada_explicita")  // só explícitos com motivo
  .gte("corrigido_em", periodoInicio)
  .order("corrigido_em", { ascending: false })
  .limit(10);
```

## Replicar o mesmo fix no card "Acerto Agente IA — oc=13"

A mesma view `v_agente_oc13_metricas` provavelmente sofre do mesmo problema (excluir cards aprovados pós-oc=21). Se confirmar visual igual, abrimos uma migration paralela pra oc=13.

## Resumo

Sem mudança de UX/layout — só corrige a leitura dos campos da view e o tratamento de `null` no `pct_acerto_ia`. Backend já está pronto.
