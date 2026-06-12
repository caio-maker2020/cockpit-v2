# Lovable — Filtro de código de ocorrência na INBOX (multi-select)

**Data:** 2026-05-29
**Backend:** zero mudança. Filtra `cards.cod_ultima_ocorrencia` (integer).

## Objetivo

Operador escolhe **uma ou mais** ocorrências e vê só os cards delas na INBOX. Ex: marca `49` → só cards com `cod_ultima_ocorrencia=49`. Marca `49 + 10` → cards de qualquer uma das duas. Sem nada marcado = todas (default).

Compatível e combinável com os filtros já existentes (Tipo de tratativa, Tipo de CT-e — ver `lovable-filtros-inbox-tratativa-e-tipo-cte.md`). Os filtros se aplicam em sequência (AND).

## UI — dropdown multi-select com chips

Posição: na mesma linha dos filtros existentes, à direita do "Tipo de CT-e".

```
┌──────────────────────────────────────────────────────────────────┐
│ Tipo de tratativa: [Todas] [Notificação] [Desenvolver]           │
│ Tipo de CT-e:      [Todos] [Normal] [Devolução] [Reversa]        │
│ Ocorrência:        [Todas ▾]                                     │
└──────────────────────────────────────────────────────────────────┘
```

Clica no dropdown:

```
┌─ Ocorrência ───────────────────────────────┐
│ [🔎 Buscar por código ou descrição...]     │
│ ──────────────────────────────────────────  │
│ ☐ 8  — RETORNO EM TRÂNSITO                  │
│ ☑ 10 — RECUSA TOTAL DA ENTREGA              │
│ ☐ 11 — PROBLEMAS COM ENDEREÇO               │
│ ☐ 13 — ENTREGA IMPOSSIBILITADA              │
│ ☐ 19 — ENTREGA C/ FALTA DE VOLUMES          │
│ ☐ 20 — EXTRAVIO LOCALIZADO                  │
│ ☐ 26 — COMPROVANTES INCOMPLETOS             │
│ ☐ 35 — ENTREGA C/ RECUSA PARCIAL            │
│ ☐ 43 — ...                                  │
│ ☑ 49 — TRATATIVA RELACIONAMENTO             │
│ ☐ 54 — AGUARDANDO RETORNO CLIENTE           │
│ ☐ ... (resto)                               │
│ ──────────────────────────────────────────  │
│  [Limpar]                  [Aplicar (2)]    │
└─────────────────────────────────────────────┘
```

Depois de aplicar com 2 marcadas (ex: 10 + 49):

```
Ocorrência: [10 ✕]  [49 ✕]  [+ Adicionar ▾]
```

Clica no `✕` da pílula → remove só aquela oc. Clica no `+ Adicionar` → reabre o dropdown.

## Implementação

### State

```tsx
const [filtroOcs, setFiltroOcs] = useState<number[]>(() => {
  // Persiste por operador no localStorage
  const saved = localStorage.getItem("cockpit:inbox:filtro_ocs");
  try { return saved ? JSON.parse(saved) : []; } catch { return []; }
});

useEffect(() => {
  localStorage.setItem("cockpit:inbox:filtro_ocs", JSON.stringify(filtroOcs));
}, [filtroOcs]);
```

### Query

Combina com os outros filtros já existentes:

```tsx
let query = supabase
  .from("cards")
  .select("...")
  .eq("state", "AGUARDANDO_VALIDACAO_HUMANA")
  .eq("lock_aguardando_validacao", true)
  .order("bastao_data_ultima_ocorrencia", { ascending: true, nullsFirst: false })
  .order("created_at", { ascending: true });

// Filtros existentes (tipo_tratativa, tipo_cte) — mantém

// NOVO — filtro por código de oc (multi)
if (filtroOcs.length > 0) {
  query = query.in("cod_ultima_ocorrencia", filtroOcs);
}
```

### Lista de ocorrências disponíveis

Mostra **dinamicamente** só os códigos que têm cards na INBOX atual (antes de aplicar o filtro de oc, mas depois dos outros filtros). Evita o operador marcar oc que não tem nada e ficar com lista vazia.

```tsx
// Hook próprio, lê do mesmo cache do react-query
const { data: ocsDisponiveis } = useQuery({
  queryKey: ['inbox-ocs-disponiveis', filtroTratativa, filtroTipoCte],
  queryFn: async () => {
    let q = supabase
      .from("cards")
      .select("cod_ultima_ocorrencia")
      .eq("state", "AGUARDANDO_VALIDACAO_HUMANA")
      .eq("lock_aguardando_validacao", true)
      .not("cod_ultima_ocorrencia", "is", null);
    // aplica os outros filtros aqui (tratativa, tipo_cte) — não o de oc!
    const { data } = await q;
    if (!data) return [];
    const codigos = Array.from(new Set(data.map((c) => c.cod_ultima_ocorrencia as number)));
    return codigos.sort((a, b) => a - b);
  },
  staleTime: 30_000,
});
```

### Labels das ocorrências

Pra mostrar "10 — RECUSA TOTAL DA ENTREGA" usa a tabela `ocorrencias_dexpara` (já existe). Cache local:

```tsx
const { data: ocLabels } = useQuery({
  queryKey: ['oc-labels'],
  queryFn: async () => {
    const { data } = await supabase
      .from("ocorrencias_dexpara")
      .select("codigo_ssw, descricao")
      .eq("ativo", true);
    if (!data) return {};
    const map: Record<number, string> = {};
    for (const row of data) {
      map[row.codigo_ssw as number] = row.descricao as string;
    }
    return map;
  },
  staleTime: 5 * 60_000,
});

function labelOc(codigo: number): string {
  return ocLabels?.[codigo] ?? `oc=${codigo}`;
}
```

Se `ocorrencias_dexpara` não tem campo `descricao` legível, hardcoda um dicionário mínimo:

```tsx
const OC_DESCRICOES: Record<number, string> = {
  8: "RETORNO EM TRÂNSITO",
  10: "RECUSA TOTAL DA ENTREGA",
  11: "PROBLEMAS COM ENDEREÇO",
  13: "ENTREGA IMPOSSIBILITADA",
  19: "ENTREGA C/ FALTA DE VOLUMES",
  20: "EXTRAVIO LOCALIZADO",
  26: "COMPROVANTES INCOMPLETOS",
  35: "ENTREGA C/ RECUSA PARCIAL",
  43: "REENTREGA NÃO REALIZADA",
  44: "RETORNO DE CARGA",
  49: "TRATATIVA RELACIONAMENTO",
  54: "AGUARDANDO RETORNO CLIENTE",
  56: "FALTA INFORMAÇÃO",
};
```

### Componente do dropdown

```tsx
function FiltroOcorrenciasDropdown({
  ocsDisponiveis,
  selecionadas,
  onChange,
}: {
  ocsDisponiveis: number[];
  selecionadas: number[];
  onChange: (next: number[]) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState("");
  const [pendentes, setPendentes] = useState(selecionadas);

  useEffect(() => { if (aberto) setPendentes(selecionadas); }, [aberto, selecionadas]);

  const filtradas = ocsDisponiveis.filter((c) => {
    if (!busca) return true;
    const desc = labelOc(c).toLowerCase();
    return String(c).includes(busca) || desc.includes(busca.toLowerCase());
  });

  const toggle = (codigo: number) => {
    setPendentes((p) => p.includes(codigo) ? p.filter((c) => c !== codigo) : [...p, codigo].sort((a, b) => a - b));
  };

  return (
    <div className="relative">
      <button
        onClick={() => setAberto((v) => !v)}
        className="px-3 py-1 text-caption font-mono rounded border bg-bg text-ink-mute border-ink-mute/30 hover:border-ink"
      >
        {selecionadas.length === 0 ? "Todas ▾" : `${selecionadas.length} selecionada${selecionadas.length > 1 ? "s" : ""} ▾`}
      </button>

      {aberto && (
        <div className="absolute top-full right-0 mt-1 w-80 max-h-96 overflow-auto bg-bg border border-ink-mute/30 rounded shadow-lg z-50 p-2">
          <input
            type="text"
            placeholder="🔎 Buscar por código ou descrição..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            className="w-full px-2 py-1 text-caption border border-ink-mute/30 rounded mb-2"
            autoFocus
          />
          <div className="max-h-60 overflow-auto">
            {filtradas.length === 0 ? (
              <p className="text-caption text-ink-mute italic px-2 py-3 text-center">Sem ocorrências disponíveis</p>
            ) : (
              filtradas.map((codigo) => (
                <label
                  key={codigo}
                  className="flex items-center gap-2 px-2 py-1 hover:bg-ink-mute/10 cursor-pointer text-caption font-mono"
                >
                  <input
                    type="checkbox"
                    checked={pendentes.includes(codigo)}
                    onChange={() => toggle(codigo)}
                  />
                  <span className="font-semibold text-ink">{codigo}</span>
                  <span className="text-ink-mute truncate">— {labelOc(codigo)}</span>
                </label>
              ))
            )}
          </div>
          <div className="flex justify-between items-center mt-2 pt-2 border-t border-ink-mute/20">
            <button
              onClick={() => setPendentes([])}
              className="text-caption text-ink-mute hover:text-ink underline decoration-dotted"
            >
              Limpar
            </button>
            <button
              onClick={() => { onChange(pendentes); setAberto(false); setBusca(""); }}
              className="px-3 py-1 text-caption font-mono bg-ink text-bg rounded hover:bg-signal"
            >
              Aplicar ({pendentes.length})
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

### Chips das selecionadas

```tsx
{filtroOcs.length > 0 && (
  <div className="flex gap-1 items-center flex-wrap">
    {filtroOcs.map((codigo) => (
      <span
        key={codigo}
        className="inline-flex items-center gap-1 px-2 py-0.5 text-caption font-mono bg-ink-mute/10 border border-ink-mute/30 rounded"
        title={labelOc(codigo)}
      >
        {codigo}
        <button
          onClick={() => setFiltroOcs((p) => p.filter((c) => c !== codigo))}
          className="text-ink-mute hover:text-rose-700"
          aria-label={`Remover oc=${codigo}`}
        >
          ✕
        </button>
      </span>
    ))}
  </div>
)}
```

### Linha completa na barra de filtros

```tsx
<div className="flex flex-wrap gap-3 items-center text-caption font-mono">
  {/* ... filtros existentes ... */}

  <span className="text-ink-mute">Ocorrência:</span>
  <FiltroOcorrenciasDropdown
    ocsDisponiveis={ocsDisponiveis ?? []}
    selecionadas={filtroOcs}
    onChange={setFiltroOcs}
  />
  {filtroOcs.length > 0 && (
    <div className="flex gap-1 items-center flex-wrap">
      {/* chips — código acima */}
    </div>
  )}
</div>
```

### Contagem

Atualizar contador da INBOX pra refletir a lista filtrada: `INBOX (12 de 87)` quando algum filtro está ativo. Quando vazio (zero cards após filtro), mostrar:

```
Nenhum card com as ocorrências selecionadas (10, 49). [Limpar filtros]
```

## Validação

1. Sem nada selecionado: INBOX mostra todos os cards (comportamento atual).
2. Marca **oc=49** → só cards com `cod_ultima_ocorrencia=49`.
3. Marca **oc=49 + oc=10** → cards de qualquer uma das duas.
4. Combina com "Tipo de tratativa = Notificação" → só 10/11/19/35 selecionáveis no dropdown (ocsDisponiveis já filtra). Se operador marcar oc=49 antes de mudar filtro, chip fica ativo mas vazio — mostra mensagem "Nenhum card com as ocorrências selecionadas".
5. Operador recarrega a página → seleções persistem (localStorage).
6. Operador clica `✕` numa pílula → remove só aquela; demais continuam ativas.
7. Dropdown busca: digitar "recus" filtra pra `RECUSA TOTAL` (10) e `RECUSA PARCIAL` (35).

## Resumo

| Antes | Depois |
|---|---|
| Operador vê todos os cards da INBOX sem distinguir oc | Pode focar em ocs específicas (ex: bater todas as 49 do dia primeiro) |
| Sem persistência | localStorage mantém escolha entre sessões |
| Filtros isolados | Combina com Tipo de tratativa + Tipo de CT-e (AND) |

Cola no Lovable.
