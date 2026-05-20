# Lovable — Aba PRIORIDADES AI (REESCRITA — kanban visual decente)

**Data:** 2026-05-19 (v2 — refazer com design quality)
**Status:** Backend 100% pronto. Lovable v1 ficou ruim — substituir tudo da aba por este código.

---

## Antes de qualquer coisa: estilo

**Esta aba precisa ser visualmente densa, profissional e consistente com o resto do Cockpit** (que segue `lovable-cockpit-foundation.md` — Inter, paleta neutra, acentos sóbrios).

NÃO faça:
- ❌ Cards grandes e espaçados
- ❌ Múltiplas cores berrantes
- ❌ Emojis decorativos no meio do texto
- ❌ Botões enormes
- ❌ Sombras pesadas

FAÇA:
- ✅ Linhas/cards compactos (altura ~140-160px)
- ✅ Tipografia mono pra NF/CTRC, sans-serif pro resto
- ✅ Paleta: zinc/gray como base; vermelho só pra urgência; verde só pra resolvido; âmbar pra warning
- ✅ Bordas sutis (1px zinc-200/zinc-800)
- ✅ Hover states discretos
- ✅ Espaçamento consistente (gap-2, p-3, p-4 — sem variação aleatória)

---

## Estrutura da página

Componente raiz: `<PrioridadesAi />`

```tsx
function PrioridadesAi() {
  const { data: cards = [], isLoading } = usePrioridadesAi();
  const [filtros, setFiltros] = useState({ base: 'todas', oc: 'todas', canal: 'todos' });
  const [drawerInsights, setDrawerInsights] = useState(false);
  const [cardSelecionado, setCardSelecionado] = useState<CardPrioridade | null>(null);
  
  return (
    <div className="flex flex-col h-full bg-zinc-50 dark:bg-zinc-950">
      <Header onAbrirInsights={() => setDrawerInsights(true)} cards={cards} />
      <Filtros filtros={filtros} onChange={setFiltros} cards={cards} />
      <KanbanBoard 
        cards={cardsFiltrados(cards, filtros)} 
        isLoading={isLoading}
        onAbrirCard={setCardSelecionado}
      />
      {drawerInsights && <DrawerInsightsGlobais onClose={() => setDrawerInsights(false)} />}
      {cardSelecionado && <ModalCardCompleto card={cardSelecionado} onClose={() => setCardSelecionado(null)} />}
    </div>
  );
}
```

---

## Header

```tsx
function Header({ onAbrirInsights, cards }: { onAbrirInsights: () => void; cards: CardPrioridade[] }) {
  const [atualizando, setAtualizando] = useState(false);
  const [progresso, setProgresso] = useState<{ feitos: number; total: number; resumo?: string } | null>(null);
  const queryClient = useQueryClient();

  async function atualizarGeral() {
    if (atualizando) return;
    const cardIds = cards.map((c) => c.card_id);
    if (cardIds.length === 0) {
      toast.info("Sem cards no kanban pra atualizar");
      return;
    }
    setAtualizando(true);
    setProgresso({ feitos: 0, total: cardIds.length });
    
    const BATCH = 5;
    let feitos = 0;
    let atualizadosOk = 0;
    let falhou = 0;
    
    try {
      for (let i = 0; i < cardIds.length; i += BATCH) {
        const batch = cardIds.slice(i, i + BATCH);
        const { data, error } = await supabase.functions.invoke('atualizar-batch-prioridades-ai', {
          body: { card_ids: batch }
        });
        if (error || !data?.ok) {
          falhou += batch.length;
        } else {
          atualizadosOk += (data.resultados ?? []).filter((r: any) => r.status === 'atualizado').length;
          falhou += (data.resultados ?? []).filter((r: any) => r.status === 'falhou').length;
        }
        feitos += batch.length;
        setProgresso({ feitos, total: cardIds.length });
      }
      
      // Reclassifica kanban_status (cards que saíram do critério, etc)
      await supabase.functions.invoke('sync-kanban-status-prioridades', { body: {} });
      
      // Invalida queries pra refresh visual
      queryClient.invalidateQueries({ queryKey: ['v_prioridades_ai'] });
      
      toast.success(
        `${atualizadosOk} cards atualizados${falhou > 0 ? ` · ${falhou} falharam` : ''}.`
      );
    } catch (e: any) {
      toast.error(`Erro: ${e.message ?? e}`);
    } finally {
      setAtualizando(false);
      setTimeout(() => setProgresso(null), 3000);
    }
  }

  return (
    <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
      <div className="flex items-center gap-2">
        <span className="text-amber-500">⭐</span>
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Prioridades AI
        </h1>
        <span className="text-xs text-zinc-500 ml-2">NFs paradas em oc=13/21 que precisam cobrança</span>
      </div>
      <div className="flex items-center gap-2">
        <Button 
          variant="default" 
          size="sm" 
          onClick={atualizarGeral}
          disabled={atualizando}
          title="Força leitura SSW de TODOS os cards do kanban (~30s pra 12 cards)"
        >
          {atualizando ? (
            <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> {progresso?.feitos}/{progresso?.total}</>
          ) : (
            <><RefreshCw className="w-4 h-4 mr-1" /> Atualizar geral</>
          )}
        </Button>
        <Button variant="outline" size="sm" onClick={onAbrirInsights}>
          <Sparkles className="w-4 h-4 mr-1" /> Insights Globais
        </Button>
      </div>
    </div>
  );
}
```

---

## Filtros (linha única, compacta)

```tsx
function Filtros({ filtros, onChange, cards }) {
  const basesUnicas = useMemo(() => 
    [...new Set(cards.map(c => c.base).filter(Boolean))].sort(), [cards]);
  
  return (
    <div className="flex items-center gap-2 px-6 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-sm">
      <span className="text-zinc-500 text-xs">Filtros:</span>
      
      <Select value={filtros.base} onValueChange={(v) => onChange({...filtros, base: v})}>
        <SelectTrigger className="h-7 w-32 text-xs"><SelectValue placeholder="Base" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="todas">Todas bases</SelectItem>
          {basesUnicas.map(b => <SelectItem key={b} value={b}>{b}</SelectItem>)}
        </SelectContent>
      </Select>
      
      <ToggleGroup type="single" value={filtros.oc} onValueChange={(v) => onChange({...filtros, oc: v || 'todas'})} className="h-7">
        <ToggleGroupItem value="todas" className="h-7 px-2 text-xs">Todas</ToggleGroupItem>
        <ToggleGroupItem value="13" className="h-7 px-2 text-xs">oc=13</ToggleGroupItem>
        <ToggleGroupItem value="21" className="h-7 px-2 text-xs">oc=21</ToggleGroupItem>
      </ToggleGroup>
      
      <div className="ml-auto text-xs text-zinc-500">
        {cards.length} cards · {cards.filter(c => !c.dentro_sla).length} fora SLA
      </div>
    </div>
  );
}
```

---

## Kanban — 4 colunas

```tsx
const COLUNAS = [
  { id: 'parada',    titulo: 'Carga Parada',         cor: 'border-zinc-300',  accent: 'bg-zinc-100 dark:bg-zinc-800' },
  { id: 'cobrado',   titulo: 'Cobrado',              cor: 'border-blue-300',  accent: 'bg-blue-50 dark:bg-blue-950/30' },
  { id: 'escalado',  titulo: 'Escalado p/ Gerência', cor: 'border-amber-300', accent: 'bg-amber-50 dark:bg-amber-950/30' },
  { id: 'resolvido', titulo: 'Resolvido',            cor: 'border-emerald-300', accent: 'bg-emerald-50 dark:bg-emerald-950/30' },
];

function KanbanBoard({ cards, isLoading, onAbrirCard }) {
  return (
    <div className="flex-1 overflow-x-auto p-4">
      <div className="grid grid-cols-4 gap-3 min-w-[1200px] h-full">
        {COLUNAS.map(col => {
          const cardsCol = cards.filter(c => c.coluna_kanban === col.id)
            .sort((a, b) => {
              const ra = a.ia_insight?.rank_priorizador ?? 999;
              const rb = b.ia_insight?.rank_priorizador ?? 999;
              if (ra !== rb) return ra - rb;
              return (b.dias_uteis_parados ?? 0) - (a.dias_uteis_parados ?? 0);
            });
          
          return (
            <div key={col.id} className={cn("flex flex-col rounded-lg border", col.cor, "bg-white dark:bg-zinc-900")}>
              <div className={cn("px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between rounded-t-lg", col.accent)}>
                <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{col.titulo}</h3>
                <span className="text-xs font-mono bg-white dark:bg-zinc-900 px-2 py-0.5 rounded border border-zinc-200 dark:border-zinc-700">
                  {cardsCol.length}
                </span>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-2">
                {isLoading && Array.from({length: 3}).map((_, i) => <CardSkeleton key={i} />)}
                {!isLoading && cardsCol.length === 0 && (
                  <div className="text-center text-xs text-zinc-400 py-8">Vazio</div>
                )}
                {cardsCol.map(card => (
                  <CardKanban key={card.card_id} card={card} onAbrir={() => onAbrirCard(card)} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

---

## Card do kanban (DENSO — peça-chave do design)

```tsx
function CardKanban({ card, onAbrir }) {
  const topIA = card.ia_insight?.rank_priorizador === 1;
  const insight = card.ia_insight?.observacao_priorizador ?? card.ia_insight?.proxima_acao_monitor;
  const corBorda = card.dias_uteis_parados > 7 ? 'border-red-300 dark:border-red-800' 
                 : card.dias_uteis_parados > 3 ? 'border-amber-300 dark:border-amber-800'
                 : 'border-zinc-200 dark:border-zinc-700';
  
  return (
    <div 
      onClick={onAbrir}
      className={cn(
        "group relative bg-white dark:bg-zinc-900 rounded-md border cursor-pointer",
        "hover:border-zinc-400 dark:hover:border-zinc-600 hover:shadow-sm transition-all",
        corBorda,
        "p-3 space-y-1.5"
      )}
    >
      {/* Header: NF + badge IA */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {topIA && <span className="text-amber-500 text-sm leading-none" title="Top IA">⭐</span>}
          <span className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
            NF {card.nf}
          </span>
        </div>
        <span className={cn(
          "text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0",
          card.oc_origem === 21 
            ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
            : "bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300"
        )}>
          oc={card.oc_origem}
        </span>
      </div>
      
      {/* CTRC + tipo_cte (se houver) */}
      {(card.ctrc || card.tipo_cte) && (
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 truncate">
          {card.ctrc && <span className="font-mono">{card.ctrc}</span>}
          {card.tipo_cte && (
            <span className={cn(
              "px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wide shrink-0",
              card.tipo_cte === 'NORMAL'
                ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
                : "bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300"
            )}>
              {card.tipo_cte}
            </span>
          )}
        </div>
      )}
      
      {/* Meta: base + dias */}
      <div className="flex items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1 text-zinc-600 dark:text-zinc-400">
          <MapPin className="w-3 h-3" />
          {card.base ?? '—'}
        </span>
        <span className="text-zinc-300 dark:text-zinc-700">·</span>
        <span className={cn(
          "tabular-nums",
          card.dias_uteis_parados > 7 ? "text-red-600 dark:text-red-400 font-semibold"
          : card.dias_uteis_parados > 3 ? "text-amber-600 dark:text-amber-400"
          : "text-zinc-600 dark:text-zinc-400"
        )}>
          {card.dias_uteis_parados?.toFixed(1) ?? '0'} dú parado
        </span>
      </div>
      
      {/* Cliente */}
      <div className="text-xs text-zinc-700 dark:text-zinc-300 truncate" title={card.pagador_nome ?? ''}>
        {card.pagador_nome ?? '—'}
      </div>
      
      {/* Insight IA (se houver) */}
      {insight && (
        <div className="flex gap-1.5 pt-1 border-t border-zinc-100 dark:border-zinc-800">
          <Sparkles className="w-3 h-3 text-zinc-400 shrink-0 mt-0.5" />
          <p className="text-[11px] text-zinc-600 dark:text-zinc-400 line-clamp-2 leading-snug">
            {insight}
          </p>
        </div>
      )}
      
      {/* Última cobrança (se houver) */}
      {card.ult_cobranca && (
        <div className="text-[10px] text-zinc-500 italic">
          ✓ {humanizarPapel(card.ult_cobranca.papel)} · {card.ult_cobranca.canal} · {timeAgo(card.ult_cobranca.disparado_em)}
        </div>
      )}
      
      {/* Botões inline (compactos) — só na coluna 'parada' e 'cobrado' */}
      {(card.coluna_kanban === 'parada' || card.coluna_kanban === 'cobrado') && (
        <div className="flex gap-1 pt-1.5">
          <BotaoCobranca 
            label="Gerente" 
            ja={card.ja_cobrou_gerente_base}
            onClick={(e) => { e.stopPropagation(); abrirModalCobranca(card, 'gerente_base'); }}
          />
          <BotaoCobranca 
            label="Coord." 
            ja={card.ja_cobrou_coordenador}
            onClick={(e) => { e.stopPropagation(); abrirModalCobranca(card, 'coordenador_entrega'); }}
          />
          <BotaoCobranca 
            label="Ger.Rel." 
            ja={card.ja_cobrou_gerente_rel}
            onClick={(e) => { e.stopPropagation(); abrirModalCobranca(card, 'gerente_relacionamento'); }}
          />
        </div>
      )}
    </div>
  );
}

function BotaoCobranca({ label, ja, onClick }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex-1 text-[10px] py-1 px-1.5 rounded font-medium transition-colors",
        ja 
          ? "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"
          : "bg-zinc-50 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700"
      )}
      title={ja ? `Já cobrou ${label}` : `Cobrar ${label}`}
    >
      {ja && '✓ '}{label}
    </button>
  );
}
```

---

## Modal completo do card (click no card body)

Sheet/Dialog grande lateral, 600px largura. Conteúdo:

```tsx
function ModalCardCompleto({ card, onClose }) {
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[600px] sm:max-w-[600px] overflow-y-auto p-0">
        {/* Header com glass effect sutil */}
        <div className="sticky top-0 bg-white/95 dark:bg-zinc-900/95 backdrop-blur border-b border-zinc-200 dark:border-zinc-800 px-6 py-4 z-10">
          <div className="flex items-center gap-2 mb-1">
            {card.ia_insight?.rank_priorizador === 1 && <span className="text-amber-500">⭐</span>}
            <h2 className="font-mono font-semibold text-base">NF {card.nf}</h2>
            <span className="text-xs px-1.5 py-0.5 rounded font-mono bg-blue-100 dark:bg-blue-900/40 text-blue-700">oc={card.oc_origem}</span>
          </div>
          <div className="text-xs text-zinc-500 font-mono">{card.ctrc ?? ''}</div>
        </div>
        
        {/* Body em seções enxutas */}
        <div className="p-6 space-y-5">
          {/* Identificação */}
          <Section titulo="Identificação">
            <DefList itens={[
              { label: 'Cliente', valor: card.pagador_nome },
              { label: 'Base', valor: card.base },
              { label: 'Tipo CT-e', valor: card.tipo_cte },
              { label: 'Responsável', valor: card.responsavel_relacionamento },
              { label: 'Dias úteis parados', valor: card.dias_uteis_parados?.toFixed(1) },
              { label: 'Última oc', valor: `${card.oc_origem} (${card.oc_origem === 21 ? 'reentrega' : 'mudança endereço'})` },
              { label: 'Coluna kanban', valor: card.coluna_kanban },
            ]} />
          </Section>
          
          {/* Análise IA (priorizador) */}
          {card.ia_insight?.observacao_priorizador && (
            <Section titulo="💡 Análise IA — Priorizador" subtle>
              <p className="text-sm text-zinc-700 dark:text-zinc-300">{card.ia_insight.observacao_priorizador}</p>
              <p className="text-[11px] text-zinc-400 mt-1">Rank #{card.ia_insight.rank_priorizador} · Sonnet 4.6</p>
            </Section>
          )}
          
          {/* Veredito Monitor */}
          {card.ia_insight?.veredito_monitor && (
            <Section titulo="🔍 Veredito Monitor" subtle>
              <Badge variant={vereditoToVariant(card.ia_insight.veredito_monitor)}>
                {card.ia_insight.veredito_monitor}
              </Badge>
              <p className="text-sm text-zinc-700 dark:text-zinc-300 mt-2">{card.ia_insight.proxima_acao_monitor}</p>
            </Section>
          )}
          
          {/* Cobranças */}
          <Section titulo="Cobrar">
            <div className="grid grid-cols-1 gap-2">
              <BotaoCobrancaModal card={card} papel="gerente_base"            label="📤 Gerente Base"            />
              <BotaoCobrancaModal card={card} papel="coordenador_entrega"     label="📞 Coordenador de Entrega"  />
              <BotaoCobrancaModal card={card} papel="gerente_relacionamento"  label="🚨 Gerente de Relacionamento" />
            </div>
          </Section>
          
          {/* Utilitários SSW */}
          <Section titulo="Utilitários SSW">
            <UtilitariosSswSection card={card} />
          </Section>
          
          {/* Histórico SSW (visualizador da coluna cards.historico_ssw) */}
          <HistoricoSswSection cardId={card.card_id} />
          
          {/* Timeline cobranças */}
          <TimelineCobrancas cardId={card.card_id} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

`BotaoCobrancaModal` abre 2º modal pequeno com canal selector (email/whatsapp) + textarea editável.

---

## Utilitários SSW + Histórico SSW (componentes do modal)

**Importante:** os botões "Forçar atualização SSW" e "Trazer histórico SSW" atualizam a coluna `cards.historico_ssw` no banco. Mas o front precisa **MOSTRAR** o resultado. O `<HistoricoSswSection>` faz isso — abre uma timeline da `cards.historico_ssw` sempre que aberto.

```tsx
function UtilitariosSswSection({ card }) {
  const [carregandoForcar, setCarregandoForcar] = useState(false);
  const [carregandoHist, setCarregandoHist] = useState(false);
  const queryClient = useQueryClient();
  
  const forcarAtualizar = async () => {
    setCarregandoForcar(true);
    const { data, error } = await supabase.functions.invoke('atualizar-card-via-portal-ssw', {
      body: { card_id: card.card_id }
    });
    setCarregandoForcar(false);
    if (data?.ok) {
      toast.success(`Atualizado: ${data.decisao}${data.oc_portal ? ` (oc=${data.oc_portal})` : ''}`);
      queryClient.invalidateQueries({ queryKey: ['v_prioridades_ai'] });
      queryClient.invalidateQueries({ queryKey: ['card-historico-ssw', card.card_id] });
    } else if (data?.no_action) {
      toast.info(data.motivo);
    } else {
      toast.error(data?.error ?? error?.message ?? 'Falha');
    }
  };
  
  const trazerHistorico = async () => {
    setCarregandoHist(true);
    const { data, error } = await supabase.functions.invoke('puxar-historico-ssw-card', {
      body: { card_id: card.card_id }
    });
    setCarregandoHist(false);
    if (data?.ok) {
      toast.success(`Histórico atualizado (${data.total_ocorrencias} ocorrências)`);
      queryClient.invalidateQueries({ queryKey: ['card-historico-ssw', card.card_id] });
    } else {
      toast.error(data?.error ?? error?.message ?? 'Falha');
    }
  };
  
  return (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" onClick={forcarAtualizar} disabled={carregandoForcar}>
        {carregandoForcar 
          ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Atualizando…</>
          : <><RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Forçar atualização</>}
      </Button>
      <Button variant="outline" size="sm" onClick={trazerHistorico} disabled={carregandoHist}>
        {carregandoHist
          ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Puxando…</>
          : <><History className="w-3.5 h-3.5 mr-1.5" /> Trazer histórico SSW</>}
      </Button>
    </div>
  );
}

function HistoricoSswSection({ cardId }) {
  const { data: historico = [], isLoading } = useQuery({
    queryKey: ['card-historico-ssw', cardId],
    queryFn: async () => {
      const { data } = await supabase
        .from('cards')
        .select('historico_ssw, historico_ssw_atualizado_em')
        .eq('id', cardId)
        .maybeSingle();
      return data;
    },
  });
  
  const ocs = (historico?.historico_ssw ?? []) as Array<{
    codigo: number; data: string; filial?: string; usuario?: string;
    descricao?: string; instrucao?: string; tem_foto?: boolean;
  }>;
  
  return (
    <Section titulo={`Histórico SSW${ocs.length > 0 ? ` (${ocs.length})` : ''}`}>
      {isLoading && <div className="text-xs text-zinc-400">Carregando…</div>}
      {!isLoading && ocs.length === 0 && (
        <div className="text-xs text-zinc-400 italic">
          Histórico vazio. Clica em "Trazer histórico SSW" pra puxar.
        </div>
      )}
      {ocs.length > 0 && (
        <>
          {historico?.historico_ssw_atualizado_em && (
            <div className="text-[10px] text-zinc-400 mb-2">
              Atualizado há {timeAgo(historico.historico_ssw_atualizado_em)}
            </div>
          )}
          <div className="border-l-2 border-zinc-200 dark:border-zinc-800 pl-3 space-y-2">
            {ocs.slice(0, 20).map((oc, i) => (
              <div key={i} className="text-xs relative">
                <span className="absolute -left-[15px] top-1 w-2 h-2 rounded-full bg-zinc-300 dark:bg-zinc-700 border-2 border-white dark:border-zinc-900" />
                <div className="flex items-baseline justify-between gap-2 mb-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono font-semibold text-zinc-800 dark:text-zinc-200">
                      oc={oc.codigo}
                    </span>
                    {oc.tem_foto && (
                      <span className="text-[9px] bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 px-1 rounded">
                        📷 foto
                      </span>
                    )}
                  </div>
                  <span className="text-zinc-400 font-mono text-[10px]">{oc.data}</span>
                </div>
                {oc.descricao && (
                  <div className="text-zinc-700 dark:text-zinc-300 leading-snug">{oc.descricao}</div>
                )}
                {oc.instrucao && oc.instrucao !== oc.descricao && (
                  <div className="text-zinc-500 italic mt-0.5 leading-snug">"{oc.instrucao}"</div>
                )}
                {(oc.filial || oc.usuario) && (
                  <div className="text-[10px] text-zinc-400 mt-0.5">
                    {oc.filial}{oc.filial && oc.usuario ? ' · ' : ''}{oc.usuario}
                  </div>
                )}
              </div>
            ))}
            {ocs.length > 20 && (
              <div className="text-[10px] text-zinc-400 italic">
                + {ocs.length - 20} ocorrências mais antigas (clique pra expandir — TODO)
              </div>
            )}
          </div>
        </>
      )}
    </Section>
  );
}
```

**Pontos críticos do HistoricoSswSection:**
- Lê **direto da coluna `cards.historico_ssw`** (jsonb) — não chama edge function
- `useQuery` com chave `['card-historico-ssw', cardId]` permite invalidate quando o botão "Trazer histórico SSW" termina
- Timeline visual com bullet points + data + descrição + foto badge
- Mostra primeiras 20 ocorrências (paginação futura se precisar)

---

## Modal de cobrança (canal + texto IA editável)

```tsx
function ModalCobranca({ card, papel, onClose, onEnviar }) {
  const [canal, setCanal] = useState<'email'|'whatsapp'>('email');
  const [texto, setTexto] = useState('');
  const [assunto, setAssunto] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [enviando, setEnviando] = useState(false);
  const [contato, setContato] = useState<{nome?: string, destino?: string} | null>(null);
  
  // Gera texto IA ao abrir / trocar canal
  useEffect(() => {
    (async () => {
      setCarregando(true);
      const { data } = await supabase.functions.invoke('sugerir-cobranca-ai', {
        body: { card_id: card.card_id, papel, canal }
      });
      if (data?.ok) {
        setTexto(data.texto);
        setAssunto(data.assunto ?? '');
        setContato({ nome: data.contato_nome, destino: data.contato_destino });
      }
      setCarregando(false);
    })();
  }, [canal]);
  
  const enviar = async () => {
    setEnviando(true);
    const { data } = await supabase.functions.invoke('disparar-cobranca-escalonada', {
      body: { card_id: card.card_id, papel, canal, texto_final: texto, assunto_final: assunto }
    });
    setEnviando(false);
    if (data?.ok) {
      toast.success(`Cobrança enviada via ${canal}. Card movido para "${data.status_kanban_novo}".`);
      onEnviar();
      onClose();
    } else if (data?.error === 'sem_contato') {
      toast.error(`Sem contato cadastrado pra ${humanizarPapel(papel)} ${data.base ? `da base ${data.base}` : ''}. Cadastre em CADASTROS → Escalonamento.`);
    } else {
      toast.error(data?.erro ?? data?.error ?? 'Falha ao enviar');
    }
  };
  
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            Cobrar {humanizarPapel(papel)}
            <span className="text-xs text-zinc-500 font-mono">· NF {card.nf}</span>
          </DialogTitle>
        </DialogHeader>
        
        {/* Canal selector */}
        <div className="flex items-center gap-2 py-2">
          <span className="text-sm text-zinc-500">Canal:</span>
          <ToggleGroup type="single" value={canal} onValueChange={(v) => v && setCanal(v as any)}>
            <ToggleGroupItem value="email" className="text-xs">📧 Email</ToggleGroupItem>
            <ToggleGroupItem value="whatsapp" className="text-xs">📱 WhatsApp</ToggleGroupItem>
          </ToggleGroup>
        </div>
        
        {/* Destinatário */}
        {contato && (
          <div className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md px-3 py-2 text-xs">
            <div className="text-zinc-500">Destinatário</div>
            <div className="font-medium text-zinc-800 dark:text-zinc-200">
              {contato.nome} · {contato.destino}
            </div>
          </div>
        )}
        
        {/* Assunto (só email) */}
        {canal === 'email' && (
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">Assunto</label>
            <Input value={assunto} onChange={(e) => setAssunto(e.target.value)} className="text-sm" />
          </div>
        )}
        
        {/* Texto */}
        <div>
          <label className="text-xs text-zinc-500 mb-1 block flex items-center gap-1">
            Mensagem 
            {carregando && <Loader2 className="w-3 h-3 animate-spin" />}
            {!carregando && <span className="text-zinc-400">· gerado por Sonnet 4.6 — edite se quiser</span>}
          </label>
          <Textarea 
            value={texto} 
            onChange={(e) => setTexto(e.target.value)}
            disabled={carregando}
            className="text-sm min-h-[200px] font-normal"
          />
        </div>
        
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={enviando}>Cancelar</Button>
          <Button onClick={enviar} disabled={carregando || enviando || !texto.trim()}>
            {enviando ? <><Loader2 className="w-3 h-3 mr-2 animate-spin" /> Enviando…</> : 'Enviar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

---

## Drawer "Insights Globais" (análise agregada Sonnet 4.6)

```tsx
function DrawerInsightsGlobais({ onClose }) {
  const [data, setData] = useState<any>(null);
  const [carregando, setCarregando] = useState(true);
  
  const carregar = async () => {
    setCarregando(true);
    const { data: r } = await supabase.functions.invoke('agente-insights-globais-ai', { body: {} });
    setData(r);
    setCarregando(false);
  };
  
  useEffect(() => { carregar(); }, []);
  
  if (carregando || !data) {
    return (
      <Sheet open onOpenChange={onClose}>
        <SheetContent className="w-[640px] sm:max-w-[640px]">
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Loader2 className="w-6 h-6 animate-spin mx-auto text-zinc-400" />
              <p className="text-sm text-zinc-500 mt-2">Sonnet 4.6 analisando carteira…</p>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    );
  }
  
  const a = data.analise;
  
  return (
    <Sheet open onOpenChange={onClose}>
      <SheetContent className="w-[640px] sm:max-w-[640px] overflow-y-auto p-0">
        <div className="sticky top-0 bg-white/95 dark:bg-zinc-900/95 backdrop-blur border-b border-zinc-200 dark:border-zinc-800 px-6 py-4 z-10">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-amber-500" />
            <h2 className="font-semibold text-base">Insights Globais — {data.operador}</h2>
          </div>
          <div className="text-xs text-zinc-500 mt-1">
            {data.total_cards} cards analisados · Sonnet 4.6 · há {timeAgo(data.gerado_em)}
          </div>
        </div>
        
        <div className="p-6 space-y-6">
          {/* Resumo */}
          <Section titulo="Resumo">
            <p className="text-sm text-zinc-700 dark:text-zinc-300 leading-relaxed">{a.resumo}</p>
          </Section>
          
          {/* Hotspots */}
          {a.hotspots?.length > 0 && (
            <Section titulo={`Hotspots (${a.hotspots.length})`}>
              <div className="space-y-2">
                {a.hotspots.map((h, i) => (
                  <div key={i} className="border border-zinc-200 dark:border-zinc-800 rounded-md p-3 bg-zinc-50 dark:bg-zinc-900/50">
                    <div className="flex items-baseline justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">{h.tipo}</Badge>
                        <span className="font-medium text-sm">{h.nome}</span>
                      </div>
                      <div className="text-xs text-zinc-500 font-mono">
                        {h.cards} cards · {h.media_dias_parados?.toFixed(1)}d
                      </div>
                    </div>
                    <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-snug">{h.observacao}</p>
                  </div>
                ))}
              </div>
            </Section>
          )}
          
          {/* Padrões */}
          {a.padroes?.length > 0 && (
            <Section titulo="Padrões identificados">
              <ul className="space-y-1">
                {a.padroes.map((p, i) => (
                  <li key={i} className="text-sm text-zinc-700 dark:text-zinc-300 flex gap-2">
                    <span className="text-zinc-400 shrink-0">→</span>
                    <span className="leading-snug">{p}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          
          {/* Causas Prováveis */}
          {a.causas_provaveis?.length > 0 && (
            <Section titulo="Causas prováveis">
              <ul className="space-y-1">
                {a.causas_provaveis.map((c, i) => {
                  const eHipotese = c.startsWith('[HIPÓTESE]');
                  return (
                    <li key={i} className={cn(
                      "text-sm flex gap-2 leading-snug",
                      eHipotese ? "text-zinc-500 italic" : "text-zinc-700 dark:text-zinc-300"
                    )}>
                      <span className="text-zinc-400 shrink-0">·</span>
                      <span>{c}</span>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}
          
          {/* Recomendações */}
          {a.recomendacoes?.length > 0 && (
            <Section titulo="Recomendações priorizadas">
              <div className="space-y-2">
                {[...a.recomendacoes].sort((x,y) => x.prioridade - y.prioridade).map((r, i) => (
                  <div key={i} className={cn(
                    "border rounded-md p-3",
                    r.prioridade === 1 ? "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30"
                    : r.prioridade === 2 ? "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30"
                    : "border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50"
                  )}>
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className="text-xs font-mono font-bold">{r.prioridade}.</span>
                      <span className="text-sm font-medium">{r.acao}</span>
                    </div>
                    <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-snug ml-5">{r.motivo}</p>
                  </div>
                ))}
              </div>
            </Section>
          )}
          
          <div className="pt-2">
            <Button variant="outline" size="sm" onClick={carregar} className="w-full">
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Re-analisar agora
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

---

## Helpers reusáveis

```tsx
function Section({ titulo, children, subtle = false }) {
  return (
    <section>
      <h3 className={cn(
        "text-[11px] font-semibold uppercase tracking-wider mb-2",
        subtle ? "text-zinc-400" : "text-zinc-500"
      )}>{titulo}</h3>
      {children}
    </section>
  );
}

function DefList({ itens }) {
  return (
    <dl className="grid grid-cols-[140px_1fr] gap-y-1 text-sm">
      {itens.filter(i => i.valor != null && i.valor !== '').map((i, idx) => (
        <Fragment key={idx}>
          <dt className="text-zinc-500">{i.label}</dt>
          <dd className="text-zinc-800 dark:text-zinc-200">{i.valor}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function humanizarPapel(p: string) {
  return p === 'gerente_base' ? 'Gerente Base'
    : p === 'coordenador_entrega' ? 'Coordenador de Entrega'
    : 'Gerente de Relacionamento';
}

function vereditoToVariant(v: string) {
  return v === 'efetiva' ? 'default'
    : v === 'parcial' ? 'secondary'
    : v === 'sem_resposta' ? 'destructive'
    : 'outline';
}

function timeAgo(iso: string): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
```

---

## Realtime

```tsx
useEffect(() => {
  const channel = supabase
    .channel('prioridades-kanban')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'cards' },
        () => queryClient.invalidateQueries({ queryKey: ['v_prioridades_ai'] }))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'cobrancas_disparadas' },
        () => queryClient.invalidateQueries({ queryKey: ['v_prioridades_ai'] }))
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}, []);
```

---

## Backend (não precisa mexer — só consumir)

| Endpoint | Quando |
|---|---|
| `v_prioridades_ai` (table_view) | Lista todos cards (RLS escopa) |
| `sugerir-cobranca-ai` | Modal cobrança abre → preview texto IA |
| `disparar-cobranca-escalonada` | Modal envia → audita + transita kanban |
| `atualizar-card-via-portal-ssw` | Botão "Forçar atualização SSW" |
| `puxar-historico-ssw-card` | Botão "Trazer histórico SSW" |
| `agente-insights-globais-ai` | Drawer Insights Globais |

---

## Critério de aceite visual

1. **Cards densos** (~140-160px altura) — não 300px+ como estava
2. **Paleta neutra** (zinc/gray base), urgência em vermelho só quando >7 dias úteis
3. **Tipografia mono** pra NF/CTRC; sans-serif pro resto
4. **Bordas sutis** (1px), hover discreto
5. **Espaçamento consistente** (gap-2, p-3) — sem variação aleatória
6. **Sem emojis decorativos** no meio do texto (só ⭐ pra Top IA e ícones lucide nos botões)
7. **Modal lateral (Sheet) 600px** pra detalhe — não popup full-screen
8. **Drawer 640px** pra Insights — análise agregada bonita

Esta é a v2. Substitui completamente o que estava antes.
