# Lovable — PRIORIDADES AI · kanban editorial (linha de produção)

**Data:** 2026-05-23
**Escopo:** 100% frontend. Visão de kanban horizontal: 5 colunas fluindo esquerda → direita (parada → cobrado → escalado → escalado gerência → resolvido), como linha de produção. Mantém toda lógica (queries, RPCs, realtime, modais).

**Backend:** view `v_prioridades_ai` retorna `empresa_cliente`, `cidade_destino`, `uf_destino`, `base_destino`, `responsavel_relacionamento`, `dias_uteis_parados`, `oc_origem`, `coluna_kanban`, `ia_insight`, `ja_cobrou_*`, `cobrancas_ciclo_atual_total`, `cobrancas_ciclos_anteriores_total`.

---

## Direção estética

**Kanban como linha de produção.** Cliente entra na esquerda (`parada` — urgente, sem cobrança ainda) e progride pra direita conforme a escala de cobrança avança. Termina em `resolvido` (entregue/baixado). O operador "lê" a linha como uma esteira: o que está mais à esquerda é o que pede atenção AGORA.

**Princípios:**
- 5 colunas verticais lado a lado em desktop, fluindo da urgência → conclusão
- Cards editoriais respirados dentro de cada coluna (cliente em destaque, sem truncate)
- Cobrança como **próxima ação determinística** (1 CTA primário + alts ghost)
- Header de coluna com cor semântica (signal vermelho na esquerda → positive verde na direita)
- Tipografia Bricolage display + JetBrains mono + tokens v3 Sal

---

## Layout da página

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│  / 02 · CARGA EM TRATATIVA                              Última sync há 12min · ⟳       │
│                                                                                          │
│  Prioridades AI                                                                          │
│  14 cards parados aguardando *cobrança*                                                  │
│                                                                                          │
│  ──────────────────────────────────────────────────────────────────────────────────     │
│  [Todas bases ▾]   [oc=21 · oc=13 · Todas]                                              │
│                                                                                          │
├────────────────┬────────────────┬────────────────┬────────────────┬────────────────┤
│ PARADA · 6     │ COBRADO · 4    │ ESCALADO · 2   │ ESC. GER. · 1  │ RESOLVIDO · 2  │
│ sem cobrança   │ coordenador    │ gerente base   │ ger. relac.    │ entregue       │
│                │                │                │                │                │
│ ┌──card──┐    │ ┌──card──┐    │                │                │ ┌──card──┐    │
│ │        │    │ │        │    │                │                │ │        │    │
│ └────────┘    │ └────────┘    │                │                │ └────────┘    │
│                │                │                │                │                │
│ ┌──card──┐    │ ┌──card──┐    │ ┌──card──┐    │ ┌──card──┐    │ ┌──card──┐    │
│ │        │    │ │        │    │ │        │    │ │        │    │ │        │    │
│ └────────┘    │ └────────┘    │ └────────┘    │ └────────┘    │ └────────┘    │
│                │                │                │                │                │
│ ...            │ ...            │                │                │                │
└────────────────┴────────────────┴────────────────┴────────────────┴────────────────┘
                              ▶ fluxo de produção · urgente → finalizando
```

### Estrutura

```tsx
<div className="max-w-[1600px] mx-auto px-6 py-8">
  {/* Eyebrow signature + sync status */}
  <header className="mb-6">
    <div className="flex items-baseline justify-between text-label uppercase tracking-[0.08em] text-ink-mute">
      <span>
        <span className="text-signal">/ 02</span> · Carga em tratativa
      </span>
      <span className="font-mono text-caption">Última sync há {syncMinutos}min · <button>⟳</button></span>
    </div>
    <h1 className="font-display font-semibold text-h4 text-ink mt-2 tracking-tight">
      Prioridades AI
    </h1>
    <p className="font-display text-body-lg text-ink-soft mt-1">
      {totalCards} cards parados aguardando <em>cobrança</em>
    </p>
  </header>

  {/* Toolbar: busca + filtros */}
  <div className="flex flex-wrap items-center gap-3 pb-6 border-b border-border mb-6">
    <SearchBar />
    <span className="flex-1" />
    <FiltroDropdown label="Todas bases" />
    <FiltroChips options={['Todas', 'oc=21', 'oc=13']} />
  </div>

  {/* Kanban 5 colunas */}
  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
    <KanbanColumn titulo="Parada"             sublabel="sem cobrança ainda"   cards={porColuna.parada}                     accent="signal"   />
    <KanbanColumn titulo="Cobrado"            sublabel="coordenador"           cards={porColuna.cobrado}                    accent="warning"  />
    <KanbanColumn titulo="Escalado"           sublabel="gerente da base"       cards={porColuna.escalado}                   accent="warning"  />
    <KanbanColumn titulo="Esc. Gerência"      sublabel="ger. relacionamento"   cards={porColuna.escalado_gerencia_interna}  accent="ink"      />
    <KanbanColumn titulo="Resolvido"          sublabel="entregue / baixado"    cards={porColuna.resolvido}                  accent="positive" />
  </div>
</div>
```

---

## `SearchBar` — pesquisa por NF, CT-e ou cliente

Campo de busca slim na toolbar. Filtra os cards do kanban em tempo real (client-side, sobre os dados já carregados — sem nova query).

```tsx
function SearchBar() {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Atalho ⌘K / Ctrl+K foca no campo
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === 'Escape' && document.activeElement === inputRef.current) {
        setQuery('');
        inputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="relative flex items-center">
      <span className="absolute left-3 text-ink-mute pointer-events-none">⌕</span>
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Buscar NF, CT-e ou cliente"
        className="w-72 pl-9 pr-16 py-2 bg-bg-elevated border border-border rounded-md font-body text-body text-ink placeholder:text-ink-mute focus:outline-none focus:border-ink transition-colors"
      />
      <kbd className="absolute right-3 font-mono text-[10px] text-ink-mute bg-bg-subtle px-1.5 py-0.5 rounded border border-border pointer-events-none">⌘K</kbd>
    </div>
  );
}
```

### Lógica de filtro

```ts
const [searchQuery, setSearchQuery] = useState('');

const cardsFiltrados = useMemo(() => {
  if (!searchQuery.trim()) return data;
  const q = searchQuery.trim().toLowerCase();
  return data.filter(c => {
    return (
      c.nf?.toLowerCase().includes(q) ||
      c.ctrc?.toLowerCase().includes(q) ||
      c.empresa_cliente?.toLowerCase().includes(q) ||
      c.pagador_nome?.toLowerCase().includes(q) ||
      c.cidade_destino?.toLowerCase().includes(q) ||
      c.base_destino?.toLowerCase().includes(q)
    );
  });
}, [data, searchQuery]);

// `porColuna` recalcula a partir de cardsFiltrados (não data)
const porColuna = cardsFiltrados.reduce(/* ... */);
```

### Comportamento

- **Search vazio:** mostra todos os cards (5 colunas com contagens totais)
- **Search com termo:** filtra em **todas** as colunas simultaneamente (mantém visão de progresso). Coluna que ficou vazia mostra "vazia" cinza.
- **Match em:** `nf`, `ctrc`, `empresa_cliente`, `pagador_nome`, `cidade_destino`, `base_destino` — case-insensitive
- **Atalho `⌘K` / `Ctrl+K`** foca no campo (mostrado no `<kbd>` à direita)
- **Esc** limpa busca e tira foco
- **Sem botão "buscar"** — filtragem ao digitar (debounce 150ms opcional pra >500 cards)

### Visual quando há busca ativa

Adicionar contador discreto após o número de cards na header de cada coluna:

```tsx
<span className="font-mono text-caption text-ink-mute">
  · {cards.length}
  {searchQuery && <span className="text-signal"> de {totalDaColunaOriginal}</span>}
</span>
```

Ex: `PARADA · 2 de 6` (quando busca filtrou 4 cards fora).

---

## `KanbanColumn`

```tsx
function KanbanColumn({ titulo, sublabel, cards, accent }) {
  const accentClass = {
    signal: 'text-signal',
    warning: 'text-warning',
    ink: 'text-ink',
    positive: 'text-positive',
  }[accent];

  return (
    <section className="flex flex-col">
      <header className="sticky top-0 bg-bg pb-3 mb-3 border-b border-border z-10">
        <div className="flex items-baseline gap-2">
          <h2 className={cn("font-display font-semibold text-h6", accentClass)}>
            {titulo}
          </h2>
          <span className="font-mono text-caption text-ink-mute">· {cards.length}</span>
        </div>
        <p className="text-caption text-ink-mute mt-0.5">{sublabel}</p>
      </header>

      <div className="flex flex-col gap-2">
        {cards.length === 0 ? (
          <p className="text-caption text-ink-mute italic py-6 text-center">vazia</p>
        ) : (
          cards.map(card => <KanbanCard key={card.card_id} card={card} />)
        )}
      </div>
    </section>
  );
}
```

Header com sublabel **diferente** do nome da coluna (info redundante elegante). Numbering compacto. Sticky no scroll vertical.

---

## `KanbanCard` — card editorial adaptado pra coluna

```tsx
function KanbanCard({ card }) {
  return (
    <article
      onClick={() => abrirCard(card.card_id)}
      className="group cursor-pointer p-4 bg-bg-elevated border border-border rounded-md hover:border-ink/30 hover:shadow-sm transition-all"
    >
      {/* Headline cliente — SEM TRUNCATE, wraps se preciso */}
      <h3 className="font-display font-semibold text-body-lg text-ink leading-tight">
        {nomeClienteCompleto(card)}
      </h3>

      {/* NF + destino — mono compacto, 2 linhas */}
      <p className="font-mono text-caption text-ink-soft tracking-tight mt-2">
        NF {card.nf}
        {card.base_destino && (
          <>
            <br />
            <span className="text-ink font-semibold">{card.base_destino}</span>
            {card.cidade_destino && card.cidade_destino.toUpperCase() !== card.base_destino.toUpperCase() && (
              <span className="text-ink-mute"> · {card.cidade_destino} {card.uf_destino}</span>
            )}
          </>
        )}
      </p>

      {/* Status line — compacta */}
      <div className="flex items-center justify-between mt-3 font-mono text-caption">
        <span className={tempoStyle(card.dias_uteis_parados)}>
          {formatDias(card.dias_uteis_parados)}
        </span>
        <span className="text-ink-mute">oc={card.oc_origem}</span>
      </div>

      {/* IA insight ou histórico de ciclos anteriores */}
      {(card.ia_insight || card.cobrancas_ciclos_anteriores_total > 0) && (
        <p className="flex items-start gap-1.5 mt-3 text-caption text-ink-soft leading-snug">
          <span className="text-signal shrink-0">✦</span>
          <span className="line-clamp-2">{insightTexto(card)}</span>
        </p>
      )}

      {/* CTA — próxima ação OU estado final */}
      <div className="mt-4 pt-3 border-t border-border">
        {proximaAcao(card) ? (
          <div className="flex flex-col gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); abrirCobranca(proximaAcao(card).papel, card); }}
              className="group/btn w-full inline-flex items-center justify-center gap-2 bg-ink text-bg hover:bg-signal active:scale-[0.98] px-3 py-2 rounded text-caption font-medium transition-all"
            >
              Cobrar {proximaAcao(card).label}
              <span className="transition-transform group-hover/btn:translate-x-0.5">→</span>
            </button>
            {alternativas(card).length > 0 && (
              <div className="flex items-center justify-center gap-2 text-[11px]">
                {alternativas(card).map((alt, i) => (
                  <span key={alt.papel}>
                    {i > 0 && <span className="text-ink-mute mx-1.5">·</span>}
                    <button
                      onClick={(e) => { e.stopPropagation(); abrirCobranca(alt.papel, card); }}
                      className="text-ink-mute hover:text-ink hover:underline underline-offset-4 transition-colors"
                    >
                      {alt.label}
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="text-caption text-ink-mute italic text-center">
            escala completa
          </p>
        )}
      </div>

      {/* Operador no rodapé */}
      <p className="font-mono uppercase tracking-[0.06em] text-[10px] text-ink-mute mt-3 text-right">
        {card.responsavel_relacionamento}
      </p>
    </article>
  );
}
```

### Helpers (sem alteração das definições anteriores)

```ts
function nomeClienteCompleto(card) {
  const nome = card.empresa_cliente?.trim() || card.pagador_nome?.trim();
  if (!nome) return 'Cliente não identificado';
  return nome;
}

function proximaAcao(card) {
  if (card.coluna_kanban === 'resolvido') return null;
  if (card.ja_cobrou_gerente_rel) return null;
  if (card.ja_cobrou_gerente_base) return { papel: 'gerente_relacionamento', label: 'ger. relacionamento' };
  if (card.ja_cobrou_coordenador) return { papel: 'gerente_base', label: 'gerente da base' };
  return { papel: 'coordenador_entrega', label: 'coordenador' };
}

function alternativas(card) {
  const proxima = proximaAcao(card);
  if (!proxima) return [];
  const todas = [
    { papel: 'coordenador_entrega', label: 'coord' },
    { papel: 'gerente_base', label: 'gerente' },
    { papel: 'gerente_relacionamento', label: 'ger.relac.' },
  ];
  return todas.filter(alt => {
    if (alt.papel === proxima.papel) return false;
    if (alt.papel === 'coordenador_entrega' && card.ja_cobrou_coordenador) return false;
    if (alt.papel === 'gerente_base' && card.ja_cobrou_gerente_base) return false;
    if (alt.papel === 'gerente_relacionamento' && card.ja_cobrou_gerente_rel) return false;
    return true;
  });
}

const tempoStyle = (d) =>
  d > 3 ? 'text-signal font-semibold'
  : d > 1 ? 'text-warning font-medium'
  : 'text-ink-soft';

const formatDias = (d) => {
  if (d < 1) return `${Math.round(d * 24)}h`;
  const r = d.toFixed(1).replace(/\.0$/, '');
  return `${r} d${d >= 2 ? 'ias' : 'ia'} útei${d >= 2 ? 's' : 'l'}`;
};

function insightTexto(card) {
  if (card.ia_insight) {
    const raw = card.ia_insight.observacao_priorizador || card.ia_insight.proxima_acao_monitor || '';
    return firstSentence(raw, 120);
  }
  if (card.cobrancas_ciclos_anteriores_total > 0) {
    const c = card.cobrancas_ciclos_anteriores_total;
    return `Reincidente — ${c} cobrança${c > 1 ? 's' : ''} no ciclo anterior. Ciclo novo aberto.`;
  }
  return null;
}

const firstSentence = (txt, max) => {
  const f = txt.split(/[\.\n]/)[0]?.trim() || '';
  return f.length > max ? f.slice(0, max - 1) + '…' : f;
};
```

---

## Agrupamento

```ts
const porColuna = data.reduce((acc, c) => {
  const k = c.coluna_kanban || 'parada';
  (acc[k] ??= []).push(c);
  return acc;
}, {
  parada: [],
  cobrado: [],
  escalado: [],
  escalado_gerencia_interna: [],
  resolvido: [],
});

// Dentro de cada coluna, mais urgente no topo (mais dias parados)
Object.values(porColuna).forEach(arr =>
  arr.sort((a, b) => b.dias_uteis_parados - a.dias_uteis_parados)
);
```

---

## Responsividade

- **lg (≥1024px):** 5 colunas lado a lado (kanban completo)
- **md (768-1023px):** 2 colunas — primeiras 2 prioridades visíveis, scroll vertical
- **sm (<768px):** 1 coluna — empilha verticalmente PARADA → COBRADO → ESCALADO → ESC. GERÊNCIA → RESOLVIDO

Headers de coluna `sticky top-0` pra navegação clara no scroll vertical.

---

## Tokens (do design v3 Sal)

```
text-h4 / font-display / font-semibold        → título página
text-h6 / font-display / font-semibold        → título coluna (color por accent)
text-body-lg / font-display / font-semibold   → cliente headline
font-mono / text-caption / ink-soft           → deck (NF, destino, status)
text-caption / font-medium                    → CTA primário
text-signal (vermelho Sal)                    → coluna PARADA, ✦ IA, hover CTA
text-warning                                  → colunas COBRADO + ESCALADO
text-positive                                 → coluna RESOLVIDO
bg-ink → hover:bg-signal                      → CTA primário (preto → vermelho)
border-border + hover:border-ink/30          → wrapper card
```

---

## **NÃO QUEBRAR**

- `disparar-cobranca-escalonada` RPC continua sendo chamada via `abrirCobranca(papel, card)`
- Modal de cobrança atual continua o mesmo
- Filtros funcionam com os mesmos params
- Realtime sub continua igual
- Click no card abre detalhe (rota atual)
- Lógica `proximaAcao` é puramente derivada — não chama backend

---

## Comportamento de "linha de produção"

1. **Operador entra na aba** → vê 5 colunas. Esquerda destaca em vermelho (PARADA · X) — onde precisa começar.
2. **Card mais urgente** (mais dias parados) sempre no topo da coluna PARADA.
3. **Clica "Cobrar coordenador →"** no card mais urgente → modal abre, operador valida → cobrança gravada.
4. **Cron de 30min OU realtime** atualiza view → card automaticamente migra pra coluna COBRADO (Realtime push, sem refresh).
5. Próxima vez que o operador olha, vê o card na coluna seguinte. Visualiza o **progresso da esteira**.
6. **Card em RESOLVIDO** (mais à direita) = entregue/baixado, ciclo fechado. Visível por X dias até housekeeping limpar (30d).

Esse fluxo dá ao operador **uma única decisão por interação**: "qual o próximo passo desse card?". A escala determinística (coord → gerente → relac.) carrega ele do lado esquerdo pro direito naturalmente.

---

## Resumo

| Antes | Depois |
|---|---|
| Lista vertical de cards | **Kanban 5 colunas horizontal — linha de produção** |
| Status confuso entre cards | **Cor semântica da coluna**: PARADA vermelho → RESOLVIDO verde |
| Operador decide qual card cobrar | **Ordenação por urgência no topo de cada coluna** + Realtime |
| Sem visão de fluxo | **Fluxo visual esquerda → direita** = progresso da cobrança |

Card editorial mantido (cliente full width, próxima ação destacada, alts ghost, ✦ IA inline). Apenas o container vira kanban.
