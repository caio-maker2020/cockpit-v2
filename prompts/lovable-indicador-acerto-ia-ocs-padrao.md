# Lovable — Indicador "🎯 Acerto Agente IA — Ocs Padrão" (aba INDICADORES)

**Data:** 2026-05-23
**Backend:** view `v_agente_ocs_padrao_metricas` em produção (mig 151).

---

## Contexto

Adicionar **4º card** na aba INDICADORES: "🎯 Acerto Agente IA — Ocs Padrão (10/11/19/35)". Mesma estrutura do card oc=13 (`lovable-indicador-acerto-ia-oc13.md`), com 1 diferença: agrega também por **código de oc** (não só por operador).

## Schema da view

```ts
type MetricaPadraoRow = {
  dia: string;                              // YYYY-MM-DD
  codigo_oc: 10 | 11 | 19 | 35;
  operador: string | null;
  proposta_destacada: 54 | 56 | null;
  total_sugestoes: number;
  sugestoes_corrigidas: number;
  corrigidas_explicitas: number;
  corrigidas_implicitas: number;
  pct_acerto_ia: number | null;
};
```

## Layout

```
┌─ 🎯 Acerto Agente IA — Ocs Padrão ──────────────────────────────────┐
│                                                                       │
│ Período: [ 7d | 30d | Tudo ]    Operador: [ Todos ▾ ]                │
│                                                                       │
│ ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│ │  % ACERTO    │  │   oc=10/35   │  │   oc=19      │  │   oc=11    │ │
│ │              │  │  (RECUSA)    │  │ (FALTA VOL)  │  │ (ENDEREÇO) │ │
│ │     91%      │  │   24 / 2     │  │   18 / 1     │  │   12 / 3   │ │
│ │              │  │   sug/err    │  │   sug/err    │  │   sug/err  │ │
│ └──────────────┘  └──────────────┘  └──────────────┘  └────────────┘ │
│                                                                       │
│ Top motivos de correção (últimos 10):                                │
│ • "Foto na verdade tinha ressalva legível, IA classificou ilegível" │
│   (Larissa, oc=10, sugestao_errada_explicita, 2026-05-22)            │
│ • "GPS estava 3.800m mas era condomínio fechado — endereço correto" │
│   (Duilio, oc=11, sugestao_errada_implicita, 2026-05-22)             │
│                                                                       │
│ Tabela detalhada (colapsável):                                        │
│ Dia        OC  Operador  Destaque  Total  Corrig.  % Acerto          │
│ 2026-05-23 10  larissa   54        5      0        100%              │
│ 2026-05-23 11  larissa   56        3      1        66.7%             │
│ ...                                                                   │
└──────────────────────────────────────────────────────────────────────┘
```

## Cálculos (igual oc=13 mas agregado)

```ts
const totalSugestoes = rows.reduce((acc, r) => acc + r.total_sugestoes, 0);
const totalCorrigidas = rows.reduce((acc, r) => acc + r.sugestoes_corrigidas, 0);
const pctAcerto = totalSugestoes > 0
  ? Math.round(100 * (1 - totalCorrigidas / totalSugestoes) * 10) / 10
  : null;

// Por OC group
const porOc = rows.reduce((acc, r) => {
  const grupo = r.codigo_oc === 35 ? 10 : r.codigo_oc; // junta 10+35 em "RECUSA"
  acc[grupo] = acc[grupo] || { sugestoes: 0, corrigidas: 0 };
  acc[grupo].sugestoes += r.total_sugestoes;
  acc[grupo].corrigidas += r.sugestoes_corrigidas;
  return acc;
}, {} as Record<number, { sugestoes: number; corrigidas: number }>);
```

## Top motivos (lista colapsável)

Query joinando `agente_ocs_padrao_feedback` com `cards`:

```ts
const { data: motivos } = await supabase
  .from("agente_ocs_padrao_feedback")
  .select("tipo_feedback, motivo_correcao, decisao_correta_codigo_ssw, corrigido_por_nome, corrigido_em, card_id, codigo_oc_card, cards(nf)")
  .gte("corrigido_em", dataInicio)
  .not("motivo_correcao", "is", null)
  .order("corrigido_em", { ascending: false })
  .limit(20);
```

Cada item:
```
"{motivo_correcao}"
({operador}, oc={codigo_oc_card}, {tipo_feedback humanizado}, {corrigido_em})
NF {nf} → operador escolheu: {decisao_correta_codigo_ssw}
```

## Filtros

**Período / Operador:** mesmo padrão do indicador oc=13.

**Filtro adicional "OC":** `[ Todas | 10 | 11 | 19 | 35 ]` (radio, default "Todas").

## Empty state

Quando agente recém-deployado: "Sem dados ainda — agente ativo há poucas horas. Volte em breve."

---

## Resumo

| Onde | O que muda |
|---|---|
| Aba INDICADORES | Novo card "🎯 Acerto Agente IA — Ocs Padrão" abaixo do "Acerto Agente IA oc=13" |
| Backend | Nada (view + RPC já em produção) |
