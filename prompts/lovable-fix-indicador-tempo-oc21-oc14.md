# Lovable — Fix Indicador "Tempo oc=21 → oc=14"

**Data:** 2026-05-23
**Escopo:** apenas frontend do card "Tempo oc=21 → oc=14" na aba INDICADORES.

---

## Problemas reportados (Caio 2026-05-23)

1. **Aba "PENDENTES" é redundante** com PRIORIDADES AI — operador já vê cards parados em oc=21 lá, com botão de cobrança. **Remover.**
2. **Aparecem NFs de OUTROS operadores** (ex: Duilio aparecendo na visão da Larissa). **Filtrar pelo operador logado.**
3. **Botão "COBRAR AGORA" + "ATUALIZAR"** ficaram redundantes — toda cobrança vai por PRIORIDADES AI. **Remover.**
4. O indicador deve mostrar **ciclos COMPLETOS oc=21 → oc=14** (pares fechados, com tempo medido). Não importa o que veio depois — se a NF teve nova oc=21 mês depois, é OUTRO ciclo, contado separadamente.
   - Exemplo NF 1004188: oc=21 em 08/05 → oc=14 em 14/05 = ciclo 1 (6 dias). Se em 18/05 teve nova oc=21 e em 20/05 oc=14 = ciclo 2 (2 dias). Ambos contam.

---

## Comportamento alvo

Indicador = **histórico retrospectivo** de pares 21→14 do operador logado. Foco: KPI de performance das bases (quanto tempo a base XYZ leva pra responder ao pedido de reentrega).

### Layout proposto

```
┌─ Tempo oc=21 → oc=14 ─────────────────────────────────────────────────────┐
│                                                                            │
│ Período: [ 7d | 30d | Tudo ]                                              │
│ ─────────────────────────────────────────────────────────────────────────  │
│                                                                            │
│ ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                      │
│ │ TEMPO MÉDIO  │  │ % DENTRO SLA │  │ TOTAL CICLOS │                      │
│ │              │  │              │  │              │                      │
│ │   1.8 d.u.   │  │     67%      │  │     15       │                      │
│ │              │  │              │  │              │                      │
│ └──────────────┘  └──────────────┘  └──────────────┘                      │
│                                                                            │
│ Por base (top 10 piores):                                                 │
│ ───────────────────────────────────────────────────────────────────────    │
│ VIT      ████████████ 6.08 d.u.   1 ciclo    fora SLA                     │
│ SAA      ███████      2.82 d.u.   3 ciclos   67% dentro                   │
│ COR      ██████       1.61 d.u.   2 ciclos   50% dentro                   │
│ ...                                                                        │
│                                                                            │
│ Tabela detalhada (colapsável):                                            │
│ NF       Cliente               Base   Lançou em      Entregou em   Tempo  │
│ 422938   LAB COMPRAS LTD       VIT    08/05 14:32   14/05 10:15   6.08    │
│ 757623   PRATI DONADUZZI B2    SAA    10/05 09:15   12/05 16:42   2.82    │
│ ...                                                                        │
└────────────────────────────────────────────────────────────────────────────┘
```

**Diferenças do antes:**
- ❌ Sem aba "PENDENTES" — só FINALIZADAS (ciclos completos)
- ❌ Sem botão "COBRAR AGORA"
- ❌ Sem botão "ATUALIZAR" (sync automático já roda a cada 30min via cron)
- ✅ Filtro por operador logado (RLS + query do front)
- ✅ Tempo em **dias úteis** (não horas) — alinhado com PRIORIDADES AI
- ✅ Foco em KPI de bases (quais respondem rápido, quais demoram)

---

## Schema da view

```ts
type CicloRow = {
  id: number;
  card_id: string;
  nf: string;
  ctrc: string;
  responsavel_relacionamento: string;       // ← FILTRO obrigatório (= operador logado)
  empresa_cliente: string;
  base_destino_card: string;
  cidade_destino: string;
  uf_destino: string;
  data_oc21: string;                        // timestamptz
  data_oc14: string;                        // timestamptz
  delta_minutos: number;
  delta_horas: number;
  delta_dias_uteis: number;
  dentro_sla: boolean;
  base_oc14: string;                        // sigla SSW da base que lançou oc=14
  usuario_oc14: string;
  base_oc21: string;
  usuario_oc21: string;
  created_at: string;
};
```

### Query

```ts
const { data: ciclos } = await supabase
  .from("v_tempo_oc21_oc14_detalhe")
  .select("*")
  .eq("responsavel_relacionamento", operadorNomeLogado)   // ← FILTRO PESSOAL
  .gte("data_oc14", dataInicio)                            // 7d/30d/tudo
  .order("data_oc14", { ascending: false });
```

`operadorNomeLogado` vem de `operadores` table (já tem session do Supabase Auth).

---

## Cálculos

```ts
const totalCiclos = ciclos.length;
const tempoMedio = totalCiclos > 0
  ? ciclos.reduce((acc, c) => acc + c.delta_dias_uteis, 0) / totalCiclos
  : null;
const dentroSla = ciclos.filter(c => c.dentro_sla).length;
const pctDentroSla = totalCiclos > 0
  ? Math.round((dentroSla / totalCiclos) * 100)
  : null;

// Agregado por base (base_oc14 = base que lançou a oc=14)
const porBase = ciclos.reduce((acc, c) => {
  const k = c.base_oc14;
  acc[k] = acc[k] || { base: k, total: 0, dentro: 0, soma_dias: 0 };
  acc[k].total += 1;
  acc[k].soma_dias += c.delta_dias_uteis;
  if (c.dentro_sla) acc[k].dentro += 1;
  return acc;
}, {});

const basesOrdenadas = Object.values(porBase)
  .map(b => ({
    ...b,
    media_dias: b.soma_dias / b.total,
    pct_dentro: Math.round((b.dentro / b.total) * 100),
  }))
  .sort((a, b) => b.media_dias - a.media_dias);  // pior primeiro
```

---

## Cards principais

**Card 1 — TEMPO MÉDIO:**
- Valor: `{tempoMedio}` em dias úteis (1 casa decimal)
- Cor: ≤1 d.u. positive · 1-2 warning · >2 signal vermelho
- Tooltip: "Média dos {totalCiclos} ciclos de reentrega do período"

**Card 2 — % DENTRO SLA:**
- Valor: `{pctDentroSla}%`
- Cor: ≥90% positive · 70-89% warning · <70% signal
- Tooltip: "{dentroSla} de {totalCiclos} ciclos entregaram em até 1 dia útil após oc=21"

**Card 3 — TOTAL CICLOS:**
- Valor: `{totalCiclos}`
- Cor: neutro ink
- Tooltip: "Pares oc=21 → oc=14 completos no período"

---

## Tabela "Por base" (top 10 piores)

```tsx
{basesOrdenadas.slice(0, 10).map(b => (
  <div key={b.base} className="flex items-center gap-4 py-2 border-b border-border">
    <span className="font-mono text-body w-12 font-semibold">{b.base}</span>
    <div className="flex-1 h-1.5 bg-bg-subtle rounded overflow-hidden">
      <div
        className="h-full bg-signal"
        style={{ width: `${Math.min(100, (b.media_dias / maxMediaDias) * 100)}%` }}
      />
    </div>
    <span className="font-mono text-caption w-20 text-right">{b.media_dias.toFixed(2)} d.u.</span>
    <span className="text-caption text-ink-mute w-20 text-right">{b.total} ciclo{b.total > 1 ? 's' : ''}</span>
    <span className={`text-caption font-mono w-20 text-right ${b.pct_dentro >= 90 ? 'text-positive' : b.pct_dentro >= 70 ? 'text-warning' : 'text-signal'}`}>
      {b.pct_dentro}% SLA
    </span>
  </div>
))}
```

---

## Tabela detalhada (colapsável, default fechada)

Renderiza `ciclos` ordenado por `data_oc14 DESC`. Colunas:

```tsx
<table className="w-full text-body">
  <thead className="text-label uppercase tracking-[0.06em] text-ink-mute border-b border-border">
    <tr>
      <th className="py-2 text-left">NF</th>
      <th className="text-left">Cliente</th>
      <th className="text-left">Base</th>
      <th className="text-right">oc=21 em</th>
      <th className="text-right">oc=14 em</th>
      <th className="text-right">Tempo</th>
      <th className="text-center">SLA</th>
    </tr>
  </thead>
  <tbody>
    {ciclos.map(c => (
      <tr key={c.id} className="border-b border-border hover:bg-bg-subtle">
        <td className="py-2 font-mono">{c.nf}</td>
        <td className="truncate max-w-[200px]">{c.empresa_cliente}</td>
        <td className="font-mono font-medium">{c.base_oc14}</td>
        <td className="text-right font-mono text-caption text-ink-soft">
          {format(c.data_oc21, 'dd/MM HH:mm')}
        </td>
        <td className="text-right font-mono text-caption text-ink-soft">
          {format(c.data_oc14, 'dd/MM HH:mm')}
        </td>
        <td className="text-right font-mono">
          <span className={c.dentro_sla ? 'text-positive' : 'text-signal'}>
            {c.delta_dias_uteis.toFixed(2)} d.u.
          </span>
        </td>
        <td className="text-center">
          {c.dentro_sla ? '✓' : '✗'}
        </td>
      </tr>
    ))}
  </tbody>
</table>
```

---

## Filtros

**Período:** botões radio `[ 7d | 30d | Tudo ]`. Default `7d`.

**Operador:** **NÃO há filtro de operador.** O indicador é PESSOAL — sempre filtra pelo operador logado (usa session Supabase Auth + tabela operadores).

```ts
// No carregamento do indicador:
const { data: { user } } = await supabase.auth.getUser();
const { data: op } = await supabase.from("operadores")
  .select("nome").eq("user_id", user.id).single();
const operadorNomeLogado = op.nome;  // "LARISSA" ou "DUILIO" etc

// Usado na query:
.eq("responsavel_relacionamento", operadorNomeLogado)
```

---

## **REMOVER**

- ❌ Aba "PENDENTES" (botão tab no topo)
- ❌ Botão "COBRAR AGORA" em cada linha
- ❌ Botão "ATUALIZAR" em cada linha
- ❌ Botão "ATUALIZAR TUDO" no header
- ❌ Coluna "STATUS ALERTA"

Toda essa funcionalidade já existe em **PRIORIDADES AI** — esse indicador deve ser **read-only retrospectivo**.

---

## Empty state

Se operador logado não tem ciclos no período:

```
✦ Nenhum ciclo oc=21 → oc=14 fechado nos últimos 7d
Pendências ativas estão na aba PRIORIDADES AI
```

---

## Resumo

| Antes | Depois |
|---|---|
| Mostrava PENDENTES + FINALIZADAS | Só FINALIZADAS (ciclos fechados) |
| NFs de todos operadores misturados | Filtra por operador logado |
| Botões COBRAR AGORA / ATUALIZAR em cada linha | Removidos — read-only |
| Tempo em horas | Tempo em dias úteis (1 casa decimal) |
| Sem agregação por base | Top 10 piores bases com barra horizontal + média + SLA |
| Aba PENDENTES redundante com PRIORIDADES AI | Removida |

Backend pronto (mig 157). Front só consumir `v_tempo_oc21_oc14_detalhe` filtrando por `responsavel_relacionamento`.
