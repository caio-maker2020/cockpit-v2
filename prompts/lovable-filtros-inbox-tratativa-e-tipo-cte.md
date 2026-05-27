# Lovable — Filtros novos na aba INBOX: tipo de tratativa + tipo de CT-e

**Data:** 2026-05-27
**Backend:** zero mudança. Os 2 filtros são puro frontend usando colunas que já existem em `cards`:
- `cod_ultima_ocorrencia` (integer)
- `tipo_cte` (text — valores: NORMAL, DEVOLUCAO, REVERSA, REDESPACHO RECEPCAO, SUBCONTRATO RECEPCAO, CORTESIA, NULL)

---

## Filtro 1 — Tipo de tratativa

Agrupa as ocorrências por contexto operacional. Dropdown/segmented control no topo da INBOX:

| Opção | Ocorrências incluídas |
|---|---|
| **Todas** (default) | Sem filtro |
| **Notificação de tratativa** | `cod_ultima_ocorrencia IN (10, 11, 19, 35)` — ocs onde a tratativa típica é **notificar o cliente** com evidência (recusa, endereço, falta de volume, recusa parcial) |
| **Desenvolver tratativa** | `cod_ultima_ocorrencia NOT IN (10, 11, 19, 35)` — ocs que precisam de **trabalho interno antes** (oc=49 tratativa relacionamento, oc=20 extravio localizado, oc=26 comprovantes incompletos, oc=43, oc=8, etc) |

**Implementação:**

```tsx
const [filtroTratativa, setFiltroTratativa] = useState<"todas" | "notificacao" | "desenvolver">("todas");

const OCS_NOTIFICACAO_TRATATIVA = [10, 11, 19, 35];

// Constrói query
let query = supabase
  .from("cards")
  .select("...")
  .eq("state", "AGUARDANDO_VALIDACAO_HUMANA")
  .eq("lock_aguardando_validacao", true)
  .order("bastao_data_ultima_ocorrencia", { ascending: true, nullsFirst: false })
  .order("created_at", { ascending: true });

if (filtroTratativa === "notificacao") {
  query = query.in("cod_ultima_ocorrencia", OCS_NOTIFICACAO_TRATATIVA);
} else if (filtroTratativa === "desenvolver") {
  query = query.not("cod_ultima_ocorrencia", "in", `(${OCS_NOTIFICACAO_TRATATIVA.join(",")})`);
}
```

**UI:**

```tsx
<div className="flex gap-2 items-center">
  <span className="text-caption text-ink-mute font-mono">Tipo de tratativa:</span>
  {[
    { id: "todas", label: "Todas" },
    { id: "notificacao", label: "Notificação de tratativa" },
    { id: "desenvolver", label: "Desenvolver tratativa" },
  ].map((opt) => (
    <button
      key={opt.id}
      onClick={() => setFiltroTratativa(opt.id as typeof filtroTratativa)}
      className={cn(
        "px-3 py-1 text-caption font-mono rounded border transition-colors",
        filtroTratativa === opt.id
          ? "bg-ink text-bg border-ink"
          : "bg-bg text-ink-mute border-ink-mute/30 hover:border-ink"
      )}
    >
      {opt.label}
    </button>
  ))}
</div>
```

---

## Filtro 2 — Tipo de CT-e

Dropdown com 3 opções principais + "Todos":

| Opção | Filtro SQL |
|---|---|
| **Todos** (default) | sem filtro |
| **Normal** | `tipo_cte = 'NORMAL'` |
| **Devolução** | `tipo_cte = 'DEVOLUCAO'` |
| **Reversa** | `tipo_cte = 'REVERSA'` |

**Implementação:**

```tsx
const [filtroTipoCte, setFiltroTipoCte] = useState<"todos" | "NORMAL" | "DEVOLUCAO" | "REVERSA">("todos");

if (filtroTipoCte !== "todos") {
  query = query.eq("tipo_cte", filtroTipoCte);
}
```

**UI:**

```tsx
<label className="flex items-center gap-2">
  <span className="text-caption text-ink-mute font-mono">Tipo de CT-e:</span>
  <select
    value={filtroTipoCte}
    onChange={(e) => setFiltroTipoCte(e.target.value as typeof filtroTipoCte)}
    className="text-caption font-mono bg-bg border border-ink-mute/30 rounded px-2 py-1"
  >
    <option value="todos">Todos</option>
    <option value="NORMAL">Normal</option>
    <option value="DEVOLUCAO">Devolução</option>
    <option value="REVERSA">Reversa</option>
  </select>
</label>
```

---

## Composição dos filtros

Os 2 filtros se combinam (AND lógico). Ex:
- "Notificação de tratativa" + "Devolução" → cards com `cod_ultima_ocorrencia IN (10,11,19,35) AND tipo_cte='DEVOLUCAO'`

Aplicar AMBOS na mesma query. React Query key precisa incluir os 2 filtros pra re-fetch quando mudar:

```tsx
const { data: cards } = useQuery({
  queryKey: ["inbox-cards", filtroTratativa, filtroTipoCte],
  queryFn: async () => { /* query acima */ },
  staleTime: 60_000,
});
```

---

## Contador por filtro (opcional)

Mostrar quantidade ao lado de cada chip do filtro de tratativa:

```tsx
{[
  { id: "todas", label: "Todas", count: cards?.length ?? 0 },
  { id: "notificacao", label: "Notificação de tratativa", count: cards?.filter(c => OCS_NOTIFICACAO_TRATATIVA.includes(c.cod_ultima_ocorrencia)).length ?? 0 },
  { id: "desenvolver", label: "Desenvolver tratativa", count: cards?.filter(c => !OCS_NOTIFICACAO_TRATATIVA.includes(c.cod_ultima_ocorrencia)).length ?? 0 },
].map(opt => (
  <button>{opt.label} <span className="opacity-60">· {opt.count}</span></button>
))}
```

(Cuidado: contador deve usar lista SEM filtro de tratativa aplicado — pode ser feito carregando duas queries ou contando do cache localmente.)

---

## Posição na tela

Topo da aba INBOX, **acima da lista de cards e abaixo do título "AGUARDANDO VOCÊ"**:

```
┌─ AGUARDANDO VOCÊ ──────────────────────────────────────────┐
│                                                              │
│  Tipo de tratativa: [Todas] [Notificação] [Desenvolver]    │
│  Tipo de CT-e: [Todos ▾]                                    │
│                                                              │
│  ─────────────────────────────────────────────────────────  │
│                                                              │
│  [card NF 868362 oc=10 — 27/04]                             │
│  [card NF 836244 oc=10 — 27/04]                             │
│  ...                                                         │
└──────────────────────────────────────────────────────────────┘
```

Manter ordenação `bastao_data_ultima_ocorrencia ASC` (mais antigo primeiro) que já foi pedida no prompt anterior.

---

## Validação

1. Filtro "Notificação de tratativa" → só aparecem cards oc=10/11/19/35
2. Filtro "Desenvolver tratativa" → aparece tudo menos 10/11/19/35 (incluindo 49, 20, 26, 43, 8, etc)
3. Filtro "Devolução" → só cards `tipo_cte=DEVOLUCAO`
4. Filtros combinados → AND (ex: notificação + reversa)
5. Resetar pra "Todas" + "Todos" → lista completa volta

Cola no Lovable.
