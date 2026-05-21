# Lovable — Indicador "🎯 Acerto Agente IA oc=13" (aba INDICADORES)

**Data:** 2026-05-22
**Backend:** view `v_agente_oc13_metricas` já existe em produção (migration 149). Esse prompt mexe SÓ no frontend.

**Skill ativada:** `frontend-design` — coerente com cards existentes da aba INDICADORES. Tipografia, espaçamentos e cores semânticas alinhados.

---

## Contexto

A aba INDICADORES já tem 2 cards:
1. 📊 Erros de Lançamento da Base (REPORTAR ERRO)
2. ⏱ Tempo médio oc=21 → oc=14

Adicionar **3º card**: "🎯 Acerto Agente IA oc=13" que mostra:
- % de acerto agregado do agente (autônomas + sugestões)
- Distribuição: total autônomas, autônomas corrigidas, total sugestões, sugestões corrigidas
- Top motivos textuais de correção (pra Caio entender o padrão)
- Filtro por operador + período (últimos 7d / 30d / todos)

A view `v_agente_oc13_metricas` agrega por dia × operador × tipo_decisao_ia.

---

## Schema da view

```ts
type MetricaRow = {
  dia: string;                          // 'YYYY-MM-DD'
  operador: string | null;              // 'larissa' | 'duilio' | null
  tipo_decisao_ia: 'autonoma' | 'sugerir_54_email' | 'operador_antecipou';
  total_decisoes: number;
  total_autonomas: number;
  autonomas_corrigidas: number;
  total_sugestoes: number;
  sugestoes_corrigidas: number;
  pct_acerto_ia: number | null;         // 0-100, NULL se sem decisões no dia
};
```

Query típica (front):
```ts
const { data } = await supabase
  .from("v_agente_oc13_metricas")
  .select("*")
  .gte("dia", dataInicio)  // 7d/30d/sempre
  .order("dia", { ascending: false });
```

---

## Layout

```
┌─ 🎯 Acerto Agente IA oc=13 ──────────────────────────────────────┐
│                                                                   │
│ Período: [ 7d | 30d | Tudo ]    Operador: [ Todos ▾ ]            │
│                                                                   │
│ ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│ │  % ACERTO    │  │  AUTÔNOMAS   │  │  SUGESTÕES   │             │
│ │              │  │              │  │              │             │
│ │   87%        │  │  42 / 5      │  │  18 / 3      │             │
│ │              │  │  exec / err  │  │  rec / err   │             │
│ └──────────────┘  └──────────────┘  └──────────────┘             │
│                                                                   │
│ Top motivos de correção (últimos 10):                            │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ • "Foto era do destinatário, IA classificou como aleatória" │ │
│ │   (Larissa, autonoma_errada, 2026-05-22)                    │ │
│ │ • "Motorista escreveu motivo embaixo da assinatura, IA não  │ │
│ │   pegou" (Duilio, autonoma_errada, 2026-05-22)              │ │
│ │ • "Era pra ser oc=41, não 54" (Larissa, sugestao_errada,    │ │
│ │   2026-05-21)                                                │ │
│ │ ...                                                          │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│ Tabela detalhada (colapsável):                                   │
│ Dia        Operador  Autônomas  Corrigidas  Sugestões  Corrigidas │
│ 2026-05-22 larissa   8          0           3          1         │
│ 2026-05-22 duilio    6          1           2          0         │
│ 2026-05-21 larissa   12         2           5          1         │
│ ...                                                              │
└──────────────────────────────────────────────────────────────────┘
```

---

## Cálculos

**% acerto agregado** (no período escolhido + operador):

```ts
const totalDecisoes = rows.reduce((acc, r) => acc + r.total_decisoes, 0);
const totalCorrigidas = rows.reduce(
  (acc, r) => acc + r.autonomas_corrigidas + r.sugestoes_corrigidas,
  0,
);
const pctAcerto = totalDecisoes > 0
  ? Math.round(100 * (1 - totalCorrigidas / totalDecisoes) * 10) / 10
  : null;
```

**Card 1 (% ACERTO):**
- Valor: `{pctAcerto}%` ou "—" se sem dados
- Cor:
  - ≥ 90% → verde
  - 70-89% → amarelo
  - < 70% → vermelho
- Tooltip: "Total de decisões: {totalDecisoes}. Corrigidas pelo operador: {totalCorrigidas}."

**Card 2 (AUTÔNOMAS exec / err):**
- `{totalAutonomas} / {autonomasCorrigidas}`
- Subtítulo: "Lançadas autônomas / Corrigidas pelo operador"

**Card 3 (SUGESTÕES rec / err):**
- `{totalSugestoes} / {sugestoesCorrigidas}`
- Subtítulo: "Recomendadas / Operador escolheu outra"

---

## Top motivos (lista colapsável, default fechada)

Query separada — joinar `agente_oc13_feedback` com `cards`:

```ts
const { data: motivos } = await supabase
  .from("agente_oc13_feedback")
  .select("tipo_feedback, motivo_correcao, decisao_correta_codigo_ssw, corrigido_por_nome, corrigido_em, card_id, cards(nf, responsavel_relacionamento)")
  .gte("corrigido_em", dataInicio)
  .not("motivo_correcao", "is", null)
  .order("corrigido_em", { ascending: false })
  .limit(20);
```

Filtra `motivo_correcao IS NOT NULL` (implícitos não têm motivo). Mostra os 10 mais recentes. Cada item:

```
"{motivo_correcao}"
({operador}, {tipo_feedback humanizado}, {corrigido_em})
NF {nf} → código sugerido pelo operador: {decisao_correta_codigo_ssw}
```

Mapping tipo_feedback humanizado:
```ts
const TIPO_FEEDBACK_LABELS = {
  autonoma_errada: "Autônoma errada",
  sugestao_errada_explicita: "Sugestão errada (operador clicou)",
  sugestao_errada_implicita: "Sugestão errada (operador aprovou outra)",
};
```

---

## Tabela detalhada (colapsável, default fechada)

Renderiza linhas do `v_agente_oc13_metricas` filtradas pelo período/operador escolhido. Colunas: Dia, Operador, Autônomas, Autônomas corrigidas, Sugestões, Sugestões corrigidas, % acerto dia.

Ordenar por dia DESC. Limite 30 linhas.

---

## Filtros

**Período:** botões `[ 7d | 30d | Tudo ]` com radio behavior. Default `7d`.

```ts
const periodos = {
  "7d": new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10),
  "30d": new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10),
  "Tudo": "2026-01-01",
};
```

**Operador:** dropdown com valores únicos de `operador` na view + "Todos" (default). Filtra view client-side.

---

## Resumo do que muda

| Onde | O que muda |
|---|---|
| Aba INDICADORES | Novo card "🎯 Acerto Agente IA oc=13" abaixo dos 2 existentes |
| Backend | Nada (view `v_agente_oc13_metricas` já criada na migration 149) |

Quando dados ainda forem zero (agente recém-deployado), mostrar "Sem dados ainda — agente ativo há poucas horas. Volte em breve." em vez dos 3 cards numerados.
