# Lovable — Renomear INBOX + nova aba EXTRAVIOS (kanban D1–D5 + detalhe do card)

**Data:** 2026-06-17 (v2 — card abre painel de detalhe, igual Tratativas) ·
**Status:** Backend 100% pronto/deployado (view `v_extravios_kanban`, estado
`EXTRAVIO_MONITORADO`, RPCs `aprovar_e_executar`/`preview_email_todo`, edges
`responder-email-cliente` / `puxar-historico-ssw-card` / `atualizar-card-via-portal-ssw`).
FASE 1 = visual + 3 ações funcionais. Teste só no Duilio.

Cole o código. Mesmo estilo das abas PRIORIDADES AI / Tratativas (Inter, zinc,
mono pra NF/CTRC, cards densos, Sheet lateral 600px pro detalhe).

---

## 1. Renomear a 1ª aba + excluir os extravios dela

Sidebar: **"Inbox" → "Tratativas de Relacionamento"**. E o filtro dessa aba DEVE
excluir `EXTRAVIO_MONITORADO` (senão extravio vaza pro INBOX):

```ts
// onde lista os cards da aba de tratativas:
.not('state', 'in', '("RESOLVIDO","CANCELADO","EXTRAVIO_MONITORADO")')
```

## 2. Sidebar — novo item abaixo de "Tratativas de Relacionamento"
```tsx
{ id: 'extravios', label: 'Extravios', icon: PackageX, route: '/extravios' }
```

---

## 3. Página `<Extravios />` (kanban) — clicar no card abre o detalhe

```tsx
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect, useMemo, Fragment } from 'react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { PackageX, MapPin, Loader2, Mail, Send, FileWarning, RefreshCw, History, Calendar } from 'lucide-react';

type CardExtravio = {
  card_id: string; nf: string; ctrc: string | null;
  base_destino: string | null; empresa_cliente: string | null; pagador_nome: string | null;
  remetente: string | null; destinatario: string | null;
  oc_extravio: number; instrucao: string | null; qtde_volumes: number | null;
  data_lancamento: string | null; dias_uteis: number | null;
  coluna_kanban: 'D1' | 'D2' | 'D3' | 'D4' | 'D5';
};

const COLUNAS = [
  { id: 'D1', titulo: 'D1 · 1 dia útil',    accent: 'bg-zinc-100 dark:bg-zinc-800',       dot: 'bg-zinc-400' },
  { id: 'D2', titulo: 'D2 · 2 dias úteis',  accent: 'bg-sky-50 dark:bg-sky-950/30',       dot: 'bg-sky-400' },
  { id: 'D3', titulo: 'D3 · 3 dias úteis',  accent: 'bg-amber-50 dark:bg-amber-950/30',   dot: 'bg-amber-400' },
  { id: 'D4', titulo: 'D4 · 4 dias úteis',  accent: 'bg-orange-50 dark:bg-orange-950/30', dot: 'bg-orange-500' },
  { id: 'D5', titulo: 'D5 · 5+ dias úteis', accent: 'bg-red-50 dark:bg-red-950/30',       dot: 'bg-red-500' },
] as const;

function useExtravios() {
  return useQuery({
    queryKey: ['v_extravios_kanban'],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_extravios_kanban').select('*')
        .order('dias_uteis', { ascending: false });
      if (error) throw error;
      return (data ?? []) as CardExtravio[];
    },
    refetchInterval: 60_000,
  });
}

export default function Extravios() {
  const { data: cards = [], isLoading } = useExtravios();
  const queryClient = useQueryClient();
  const [cardSel, setCardSel] = useState<CardExtravio | null>(null);

  useEffect(() => {
    const ch = supabase.channel('extravios-kanban')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cards' },
        () => queryClient.invalidateQueries({ queryKey: ['v_extravios_kanban'] }))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [queryClient]);

  const urgentes = useMemo(() => cards.filter((c) => (c.dias_uteis ?? 0) >= 5).length, [cards]);

  return (
    <div className="flex flex-col h-full bg-zinc-50 dark:bg-zinc-950">
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="flex items-center gap-2">
          <PackageX className="w-5 h-5 text-orange-500" />
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Extravios</h1>
          <span className="text-xs text-zinc-500 ml-2">NFs dos seus clientes em extravio (oc 6/9/16, sob Perdas) — por dias úteis sem localização</span>
        </div>
        <div className="text-xs text-zinc-500">
          {cards.length} em extravio{urgentes > 0 && <> · <span className="text-red-600 dark:text-red-400 font-medium">{urgentes} há 5+ dias</span></>}
        </div>
      </div>

      <div className="flex-1 overflow-x-auto p-4">
        <div className="grid grid-cols-5 gap-3 min-w-[1280px] h-full">
          {COLUNAS.map((col) => {
            const cardsCol = cards.filter((c) => c.coluna_kanban === col.id);
            return (
              <div key={col.id} className="flex flex-col rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
                <div className={cn('px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between rounded-t-lg', col.accent)}>
                  <div className="flex items-center gap-2">
                    <span className={cn('w-2 h-2 rounded-full', col.dot)} />
                    <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{col.titulo}</h3>
                  </div>
                  <span className="text-xs font-mono bg-white dark:bg-zinc-900 px-2 py-0.5 rounded border border-zinc-200 dark:border-zinc-700">{cardsCol.length}</span>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                  {isLoading && Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-24 rounded-md bg-zinc-100 dark:bg-zinc-800 animate-pulse" />)}
                  {!isLoading && cardsCol.length === 0 && <div className="text-center text-xs text-zinc-400 py-8">Vazio</div>}
                  {cardsCol.map((card) => <CardExtravioItem key={card.card_id} card={card} onClick={() => setCardSel(card)} />)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {cardSel && (
        <ModalExtravioDetalhe
          card={cardSel}
          onClose={() => setCardSel(null)}
          onMudou={() => queryClient.invalidateQueries({ queryKey: ['v_extravios_kanban'] })}
        />
      )}
    </div>
  );
}
```

## 4. Card do kanban (denso, clicável — abre o detalhe)

```tsx
function CardExtravioItem({ card, onClick }: { card: CardExtravio; onClick: () => void }) {
  const urgente = (card.dias_uteis ?? 0) >= 5;
  return (
    <div onClick={onClick}
      className={cn('group bg-white dark:bg-zinc-900 rounded-md border p-3 space-y-1.5 cursor-pointer hover:border-zinc-400 dark:hover:border-zinc-600 hover:shadow-sm transition-all',
        urgente ? 'border-red-300 dark:border-red-800' : 'border-zinc-200 dark:border-zinc-700')}>
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">NF {card.nf}</span>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300">oc={card.oc_extravio}</span>
      </div>
      {card.ctrc && <div className="font-mono text-[11px] text-zinc-500 truncate">{card.ctrc}</div>}
      <div className="flex items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1 text-zinc-600 dark:text-zinc-400"><MapPin className="w-3 h-3" />{card.base_destino ?? '—'}</span>
        <span className="text-zinc-300 dark:text-zinc-700">·</span>
        <span className={cn('tabular-nums', urgente ? 'text-red-600 dark:text-red-400 font-semibold' : 'text-zinc-600 dark:text-zinc-400')}>{(card.dias_uteis ?? 0).toFixed(1)} dú</span>
      </div>
      <div className="text-xs text-zinc-700 dark:text-zinc-300 truncate" title={card.pagador_nome ?? ''}>{card.pagador_nome ?? card.empresa_cliente ?? '—'}</div>
      {card.instrucao && <div className="text-[11px] text-zinc-500 italic line-clamp-2 leading-snug border-t border-zinc-100 dark:border-zinc-800 pt-1">"{card.instrucao}"</div>}
    </div>
  );
}
```

## 5. Detalhe do card (Sheet 600px) — MESMO padrão da aba Tratativas

Identificação + **última ocorrência** + 3 ações ao lado + **Utilitários SSW
(atualizar em tempo real + puxar histórico)** + timeline do Histórico SSW.

```tsx
function fmtData(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function timeAgo(iso?: string | null): string {
  if (!iso) return '';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m}min`; const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`; return `${Math.floor(h / 24)}d`;
}
function Section({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (<section><h3 className="text-[11px] font-semibold uppercase tracking-wider mb-2 text-zinc-500">{titulo}</h3>{children}</section>);
}
function DefList({ itens }: { itens: { label: string; valor: any }[] }) {
  return (<dl className="grid grid-cols-[150px_1fr] gap-y-1.5 text-sm">
    {itens.filter((i) => i.valor != null && i.valor !== '').map((i, idx) => (
      <Fragment key={idx}><dt className="text-zinc-500">{i.label}</dt><dd className="text-zinc-800 dark:text-zinc-200">{i.valor}</dd></Fragment>
    ))}</dl>);
}

function ModalExtravioDetalhe({ card, onClose, onMudou }: {
  card: CardExtravio; onClose: () => void; onMudou: () => void;
}) {
  const [acao, setAcao] = useState<'email_54' | 'email_so' | 'oc_49' | null>(null);
  const urgente = (card.dias_uteis ?? 0) >= 5;

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[600px] sm:max-w-[600px] overflow-y-auto p-0">
        {/* Header */}
        <div className="sticky top-0 bg-white/95 dark:bg-zinc-900/95 backdrop-blur border-b border-zinc-200 dark:border-zinc-800 px-6 py-4 z-10">
          <div className="flex items-center gap-2 mb-1">
            <PackageX className="w-4 h-4 text-orange-500" />
            <h2 className="font-mono font-semibold text-base">NF {card.nf}</h2>
            <span className="text-xs px-1.5 py-0.5 rounded font-mono bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300">oc={card.oc_extravio}</span>
            <span className={cn('ml-auto text-xs px-2 py-0.5 rounded font-medium', urgente ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300')}>{card.coluna_kanban} · {(card.dias_uteis ?? 0).toFixed(1)} dú</span>
          </div>
          {card.ctrc && <div className="text-xs text-zinc-500 font-mono">{card.ctrc}</div>}
        </div>

        <div className="p-6 space-y-5">
          {/* Identificação + última ocorrência */}
          <Section titulo="Identificação">
            <DefList itens={[
              { label: 'Cliente', valor: card.pagador_nome ?? card.empresa_cliente },
              { label: 'Remetente', valor: card.remetente },
              { label: 'Destinatário', valor: card.destinatario },
              { label: 'Base destino', valor: card.base_destino },
              { label: 'Volumes (NF)', valor: card.qtde_volumes },
              { label: 'Última ocorrência', valor: <span className="inline-flex items-center gap-1.5"><Calendar className="w-3.5 h-3.5 text-zinc-400" />{fmtData(card.data_lancamento)} · {(card.dias_uteis ?? 0).toFixed(1)} dias úteis</span> },
            ]} />
            {card.instrucao && (
              <div className="mt-2 text-sm text-zinc-600 dark:text-zinc-400 italic bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md p-2">"{card.instrucao}"</div>
            )}
          </Section>

          {/* Ações (ao lado, como na aba Tratativas) */}
          <Section titulo="Ações">
            <div className="grid grid-cols-1 gap-2">
              <BotaoAcaoDetalhe icon={Mail} titulo="Notificar cliente + lançar oc 54"
                desc="Envia e-mail (seguir parcial ou devolver) e lança a 54 → vai pra Tratativas / Aguardando Cliente"
                onClick={() => setAcao('email_54')} />
              <BotaoAcaoDetalhe icon={Send} titulo="Apenas notificar por e-mail"
                desc="Só envia o e-mail ao cliente, sem lançar ocorrência. Card continua em Extravios."
                onClick={() => setAcao('email_so')} />
              <BotaoAcaoDetalhe icon={FileWarning} titulo='Lançar oc 49 — "PRAZO DE PERDAS EXPIRADO"'
                desc="Lança a 49 no SSW → vai pra Tratativas / Aguardando Você com as sugestões automáticas."
                onClick={() => setAcao('oc_49')} />
            </div>
          </Section>

          {/* Utilitários SSW — atualizar em tempo real + puxar histórico */}
          <Section titulo="Utilitários SSW">
            <UtilitariosSswSection cardId={card.card_id} onMudou={onMudou} />
          </Section>

          {/* Histórico SSW (timeline da coluna cards.historico_ssw) */}
          <HistoricoSswSection cardId={card.card_id} />
        </div>

        {acao && (
          <ModalAcaoExtravio card={card} tipo={acao}
            onClose={() => setAcao(null)}
            onFeito={() => { setAcao(null); onMudou(); onClose(); }} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function BotaoAcaoDetalhe({ icon: Icon, titulo, desc, onClick }: { icon: any; titulo: string; desc: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="text-left rounded-md border border-zinc-200 dark:border-zinc-800 hover:border-zinc-400 dark:hover:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 p-3 transition-colors">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200"><Icon className="w-4 h-4 text-zinc-500" />{titulo}</div>
      <p className="text-xs text-zinc-500 mt-1 leading-snug">{desc}</p>
    </button>
  );
}
```

## 6. Utilitários SSW + Histórico SSW (iguais aos da aba PRIORIDADES)

```tsx
function UtilitariosSswSection({ cardId, onMudou }: { cardId: string; onMudou: () => void }) {
  const [forcando, setForcando] = useState(false);
  const [puxando, setPuxando] = useState(false);
  const queryClient = useQueryClient();

  async function forcarAtualizar() {
    setForcando(true);
    const { data, error } = await supabase.functions.invoke('atualizar-card-via-portal-ssw', { body: { card_id: cardId } });
    setForcando(false);
    if (data?.ok) {
      toast.success(`Atualizado: ${data.decisao ?? 'ok'}${data.oc_portal ? ` (oc=${data.oc_portal})` : ''}`);
      queryClient.invalidateQueries({ queryKey: ['v_extravios_kanban'] });
      queryClient.invalidateQueries({ queryKey: ['card-historico-ssw', cardId] });
      onMudou();
    } else if (data?.no_action) { toast.info(data.motivo ?? 'Sem mudança'); }
    else { toast.error(data?.error ?? error?.message ?? 'Falha'); }
  }

  async function puxarHistorico() {
    setPuxando(true);
    const { data, error } = await supabase.functions.invoke('puxar-historico-ssw-card', { body: { card_id: cardId } });
    setPuxando(false);
    if (data?.ok) {
      toast.success(`Histórico atualizado (${data.total_ocorrencias ?? '?'} ocorrências)`);
      queryClient.invalidateQueries({ queryKey: ['card-historico-ssw', cardId] });
    } else { toast.error(data?.error ?? error?.message ?? 'Falha'); }
  }

  return (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" onClick={forcarAtualizar} disabled={forcando}>
        {forcando ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Atualizando…</> : <><RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Atualizar NF em tempo real</>}
      </Button>
      <Button variant="outline" size="sm" onClick={puxarHistorico} disabled={puxando}>
        {puxando ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Puxando…</> : <><History className="w-3.5 h-3.5 mr-1.5" /> Puxar histórico da NF</>}
      </Button>
    </div>
  );
}

function HistoricoSswSection({ cardId }: { cardId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['card-historico-ssw', cardId],
    queryFn: async () => {
      const { data } = await supabase.from('cards').select('historico_ssw, historico_ssw_atualizado_em').eq('id', cardId).maybeSingle();
      return data;
    },
  });
  const ocs = (data?.historico_ssw ?? []) as Array<{ codigo: number; data: string; filial?: string; usuario?: string; descricao?: string; instrucao?: string; tem_foto?: boolean }>;
  return (
    <Section titulo={`Histórico SSW${ocs.length ? ` (${ocs.length})` : ''}`}>
      {isLoading && <div className="text-xs text-zinc-400">Carregando…</div>}
      {!isLoading && ocs.length === 0 && <div className="text-xs text-zinc-400 italic">Histórico vazio. Clica em "Puxar histórico da NF".</div>}
      {ocs.length > 0 && (
        <>
          {data?.historico_ssw_atualizado_em && <div className="text-[10px] text-zinc-400 mb-2">Atualizado há {timeAgo(data.historico_ssw_atualizado_em)}</div>}
          <div className="border-l-2 border-zinc-200 dark:border-zinc-800 pl-3 space-y-2">
            {ocs.slice(0, 20).map((oc, i) => (
              <div key={i} className="text-xs relative">
                <span className="absolute -left-[15px] top-1 w-2 h-2 rounded-full bg-zinc-300 dark:bg-zinc-700 border-2 border-white dark:border-zinc-900" />
                <div className="flex items-baseline justify-between gap-2 mb-0.5">
                  <span className="font-mono font-semibold text-zinc-800 dark:text-zinc-200">oc={oc.codigo}{oc.tem_foto && <span className="ml-1 text-[9px] bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 px-1 rounded">foto</span>}</span>
                  <span className="text-zinc-400 font-mono text-[10px]">{oc.data}</span>
                </div>
                {oc.descricao && <div className="text-zinc-700 dark:text-zinc-300 leading-snug">{oc.descricao}</div>}
                {oc.instrucao && oc.instrucao !== oc.descricao && <div className="text-zinc-500 italic mt-0.5 leading-snug">"{oc.instrucao}"</div>}
                {(oc.filial || oc.usuario) && <div className="text-[10px] text-zinc-400 mt-0.5">{oc.filial}{oc.filial && oc.usuario ? ' · ' : ''}{oc.usuario}</div>}
              </div>
            ))}
          </div>
        </>
      )}
    </Section>
  );
}
```

## 7. Modal de confirmação das 3 ações (preview de e-mail editável)

```tsx
const ACAO_TO_META: Record<string, string> = { email_54: 'email_mais_54', email_so: 'email_sem_oc', oc_49: 'lancar_49' };

function ModalAcaoExtravio({ card, tipo, onClose, onFeito }: {
  card: CardExtravio; tipo: 'email_54' | 'email_so' | 'oc_49'; onClose: () => void; onFeito: () => void;
}) {
  const [todoId, setTodoId] = useState<string | null>(null);
  const [assunto, setAssunto] = useState('');
  const [texto, setTexto] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [enviando, setEnviando] = useState(false);
  const ehEmail = tipo === 'email_54' || tipo === 'email_so';

  useEffect(() => {
    (async () => {
      setCarregando(true);
      const { data: todos } = await supabase.from('todos').select('id, proposta_payload, status').eq('card_id', card.card_id);
      const todo = (todos ?? []).find((t: any) => t.proposta_payload?.meta?.acao === ACAO_TO_META[tipo] && t.status === 'pendente');
      if (!todo) { toast.error('Proposta não encontrada.'); onClose(); return; }
      setTodoId(todo.id);
      if (ehEmail) {
        const { data: pv } = await supabase.rpc('preview_email_todo', { p_todo_id: todo.id });
        const prev = Array.isArray(pv) ? pv[0] : pv;
        setAssunto(prev?.assunto ?? `Sal Express — NF ${card.nf}`);
        setTexto(prev?.corpo ?? prev?.texto ?? '');
      }
      setCarregando(false);
    })();
  }, [card.card_id, tipo]);

  async function confirmar() {
    if (!todoId) return;
    setEnviando(true);
    try {
      if (tipo === 'email_54') {
        const { data, error } = await supabase.rpc('aprovar_e_executar', { p_todo_id: todoId, p_extras: { texto_email_customizado: texto, assunto_customizado: assunto } });
        if (error || data?.ok === false) throw new Error(error?.message ?? data?.error ?? 'Falha');
        toast.success('E-mail enviado + oc 54 lançada. Card movido para Tratativas de Relacionamento.');
      } else if (tipo === 'oc_49') {
        const { data, error } = await supabase.rpc('aprovar_e_executar', { p_todo_id: todoId });
        if (error || data?.ok === false) throw new Error(error?.message ?? data?.error ?? 'Falha');
        toast.success('oc 49 lançada (PRAZO DE PERDAS EXPIRADO). Card movido para Tratativas.');
      } else {
        const { data, error } = await supabase.functions.invoke('responder-email-cliente', { body: { card_id: card.card_id, texto } });
        if (error || !data?.ok) throw new Error(error?.message ?? data?.error ?? 'Falha');
        await supabase.from('todos').update({ status: 'executado' }).eq('id', todoId);
        toast.success('E-mail enviado ao cliente (sem lançar ocorrência).');
      }
      onFeito();
    } catch (e: any) { toast.error(`Erro: ${e.message ?? e}`); }
    finally { setEnviando(false); }
  }

  const titulo = tipo === 'email_54' ? 'Notificar cliente + lançar oc 54' : tipo === 'email_so' ? 'Notificar cliente (só e-mail)' : 'Lançar oc 49 — PRAZO DE PERDAS EXPIRADO';

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle className="flex items-center gap-2 text-base">{titulo}<span className="text-xs text-zinc-500 font-mono">· NF {card.nf}</span></DialogTitle></DialogHeader>
        {carregando && <div className="flex items-center justify-center py-10 text-zinc-400"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Carregando…</div>}
        {!carregando && tipo === 'oc_49' && (
          <div className="text-sm text-zinc-700 dark:text-zinc-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-md p-3">
            Vai lançar a <b>oc 49</b> no SSW com a instrução <b>"PRAZO DE PERDAS EXPIRADO"</b>. O card sai dos Extravios e vai para <b>Tratativas de Relacionamento</b> (Aguardando você), já com as sugestões.
          </div>
        )}
        {!carregando && ehEmail && (
          <>
            <div><label className="text-xs text-zinc-500 mb-1 block">Assunto</label><Input value={assunto} onChange={(e) => setAssunto(e.target.value)} className="text-sm" /></div>
            <div><label className="text-xs text-zinc-500 mb-1 block">Mensagem ao cliente — edite se quiser</label><Textarea value={texto} onChange={(e) => setTexto(e.target.value)} className="text-sm min-h-[220px]" /></div>
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={enviando}>Cancelar</Button>
          <Button onClick={confirmar} disabled={carregando || enviando}>{enviando ? <><Loader2 className="w-3 h-3 mr-2 animate-spin" /> Processando…</> : tipo === 'oc_49' ? 'Lançar oc 49' : 'Enviar e-mail'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

---

## Contrato backend (pronto)
| Recurso | Uso |
|---|---|
| view `v_extravios_kanban` | cards de extravio do operador (RLS), `coluna_kanban` D1..D5, `data_lancamento` (última oc), `dias_uteis`, `instrucao`, `qtde_volumes` |
| `todos` (3/card) | `proposta_payload.meta.acao` = `email_mais_54` / `email_sem_oc` / `lancar_49` |
| RPC `preview_email_todo(p_todo_id)` | assunto+corpo do e-mail (qtd já preenchida) |
| RPC `aprovar_e_executar(p_todo_id,p_extras)` | E-mail+54 e oc 49 → executor lança e move o card |
| edge `responder-email-cliente` `{card_id,texto}` | Só e-mail (sem oc) |
| edge `atualizar-card-via-portal-ssw` `{card_id}` | "Atualizar NF em tempo real" |
| edge `puxar-historico-ssw-card` `{card_id}` | "Puxar histórico da NF" |

**Movimentação automática:** ao lançar 54/49, o backend tira o card de
`EXTRAVIO_MONITORADO` → some dos Extravios e aparece em Tratativas (realtime
atualiza os dois). "Atualizar NF em tempo real" relê o SSW e, se a oc já avançou
(localizado/49), o card também migra.

## Aceite visual
1. Card do kanban abre **Sheet lateral 600px** (mesmo padrão da aba Tratativas).
2. Detalhe tem **Identificação + Última ocorrência (data + dias úteis)**, **Ações**
   ao lado, **Utilitários SSW** (atualizar tempo real + puxar histórico) e
   **timeline do Histórico SSW**.
3. Paleta/tipografia consistentes com PRIORIDADES/Tratativas.
```
