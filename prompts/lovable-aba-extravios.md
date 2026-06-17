# Lovable — Renomear INBOX + nova aba EXTRAVIOS (kanban D1–D5)

**Data:** 2026-06-17 · **Status:** Backend 100% pronto e deployado (view `v_extravios_kanban`,
estado `EXTRAVIO_MONITORADO`, RPCs `aprovar_e_executar` / `preview_email_todo`,
edge `responder-email-cliente`). FASE 1 = visual + 3 ações funcionais. Teste só no Duilio.

Cole o código abaixo. Segue o mesmo estilo da aba PRIORIDADES AI (Inter, paleta
zinc, mono pra NF/CTRC, cards densos ~150px, bordas 1px, sem emoji decorativo).

---

## 1. Renomear a 1ª aba + excluir os extravios dela

Na sidebar, **"Inbox" → "Tratativas de Relacionamento"**.

E **CRÍTICO**: o filtro da aba de tratativas deve **excluir** o estado novo
`EXTRAVIO_MONITORADO` (senão os cards de extravio vazam pra cá). Onde hoje é:

```ts
// ANTES
.not('state', 'in', '("RESOLVIDO","CANCELADO")')
// DEPOIS
.not('state', 'in', '("RESOLVIDO","CANCELADO","EXTRAVIO_MONITORADO")')
```

(Qualquer query/filtro que lista os cards da aba de tratativas precisa do mesmo
`EXTRAVIO_MONITORADO` adicionado à exclusão.)

---

## 2. Novo item na sidebar (logo abaixo de "Tratativas de Relacionamento")

```tsx
{ id: 'extravios', label: 'Extravios', icon: PackageX, route: '/extravios' }
```

---

## 3. Página `<Extravios />` — kanban D1..D5

```tsx
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { PackageX, MapPin, Loader2, Mail, Send, FileWarning, RefreshCw } from 'lucide-react';

type CardExtravio = {
  card_id: string;
  nf: string;
  ctrc: string | null;
  base_destino: string | null;
  empresa_cliente: string | null;
  pagador_nome: string | null;
  remetente: string | null;
  destinatario: string | null;
  oc_extravio: number;          // 6 | 9 | 16
  instrucao: string | null;
  qtde_volumes: number | null;
  data_lancamento: string | null;
  dias_uteis: number | null;
  coluna_kanban: 'D1' | 'D2' | 'D3' | 'D4' | 'D5';
};

// D1 (recente) → D5 (5+ dias úteis, urgente). Severidade cresce com os dias.
const COLUNAS = [
  { id: 'D1', titulo: 'D1 · 1 dia útil',     accent: 'bg-zinc-100 dark:bg-zinc-800',          dot: 'bg-zinc-400' },
  { id: 'D2', titulo: 'D2 · 2 dias úteis',   accent: 'bg-sky-50 dark:bg-sky-950/30',          dot: 'bg-sky-400' },
  { id: 'D3', titulo: 'D3 · 3 dias úteis',   accent: 'bg-amber-50 dark:bg-amber-950/30',      dot: 'bg-amber-400' },
  { id: 'D4', titulo: 'D4 · 4 dias úteis',   accent: 'bg-orange-50 dark:bg-orange-950/30',    dot: 'bg-orange-500' },
  { id: 'D5', titulo: 'D5 · 5+ dias úteis',  accent: 'bg-red-50 dark:bg-red-950/30',          dot: 'bg-red-500' },
] as const;

function useExtravios() {
  return useQuery({
    queryKey: ['v_extravios_kanban'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_extravios_kanban')
        .select('*')
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
  const [acao, setAcao] = useState<{ card: CardExtravio; tipo: 'email_54' | 'email_so' | 'oc_49' } | null>(null);

  // Realtime: card mudou de estado (saiu pra Tratativas, localizado, etc) → refetch
  useEffect(() => {
    const ch = supabase
      .channel('extravios-kanban')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cards' },
        () => queryClient.invalidateQueries({ queryKey: ['v_extravios_kanban'] }))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [queryClient]);

  const totalFalta = useMemo(
    () => cards.filter((c) => (c.dias_uteis ?? 0) >= 5).length, [cards]);

  return (
    <div className="flex flex-col h-full bg-zinc-50 dark:bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="flex items-center gap-2">
          <PackageX className="w-5 h-5 text-orange-500" />
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Extravios</h1>
          <span className="text-xs text-zinc-500 ml-2">
            NFs dos seus clientes em extravio (oc 6/9/16, sob Perdas) — por dias úteis sem localização
          </span>
        </div>
        <div className="text-xs text-zinc-500">
          {cards.length} em extravio{totalFalta > 0 && <> · <span className="text-red-600 dark:text-red-400 font-medium">{totalFalta} há 5+ dias</span></>}
        </div>
      </div>

      {/* Kanban */}
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
                  <span className="text-xs font-mono bg-white dark:bg-zinc-900 px-2 py-0.5 rounded border border-zinc-200 dark:border-zinc-700">
                    {cardsCol.length}
                  </span>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                  {isLoading && Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="h-28 rounded-md bg-zinc-100 dark:bg-zinc-800 animate-pulse" />
                  ))}
                  {!isLoading && cardsCol.length === 0 && (
                    <div className="text-center text-xs text-zinc-400 py-8">Vazio</div>
                  )}
                  {cardsCol.map((card) => (
                    <CardExtravioItem key={card.card_id} card={card} onAcao={(tipo) => setAcao({ card, tipo })} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {acao && (
        <ModalAcaoExtravio
          card={acao.card}
          tipo={acao.tipo}
          onClose={() => setAcao(null)}
          onFeito={() => { setAcao(null); queryClient.invalidateQueries({ queryKey: ['v_extravios_kanban'] }); }}
        />
      )}
    </div>
  );
}
```

---

## 4. Card do kanban (denso) + 3 ações

```tsx
function CardExtravioItem({ card, onAcao }: {
  card: CardExtravio;
  onAcao: (tipo: 'email_54' | 'email_so' | 'oc_49') => void;
}) {
  const urgente = (card.dias_uteis ?? 0) >= 5;
  return (
    <div className={cn(
      'group bg-white dark:bg-zinc-900 rounded-md border p-3 space-y-1.5',
      urgente ? 'border-red-300 dark:border-red-800' : 'border-zinc-200 dark:border-zinc-700',
    )}>
      {/* NF + oc */}
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">NF {card.nf}</span>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300">
          oc={card.oc_extravio}
        </span>
      </div>

      {/* CTRC */}
      {card.ctrc && <div className="font-mono text-[11px] text-zinc-500 truncate">{card.ctrc}</div>}

      {/* Meta: base + dias úteis */}
      <div className="flex items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1 text-zinc-600 dark:text-zinc-400">
          <MapPin className="w-3 h-3" />{card.base_destino ?? '—'}
        </span>
        <span className="text-zinc-300 dark:text-zinc-700">·</span>
        <span className={cn('tabular-nums', urgente ? 'text-red-600 dark:text-red-400 font-semibold' : 'text-zinc-600 dark:text-zinc-400')}>
          {(card.dias_uteis ?? 0).toFixed(1)} dú
        </span>
      </div>

      {/* Cliente */}
      <div className="text-xs text-zinc-700 dark:text-zinc-300 truncate" title={card.pagador_nome ?? ''}>
        {card.pagador_nome ?? card.empresa_cliente ?? '—'}
      </div>

      {/* Instrução / volumes faltantes */}
      {card.instrucao && (
        <div className="text-[11px] text-zinc-500 italic line-clamp-2 leading-snug border-t border-zinc-100 dark:border-zinc-800 pt-1">
          "{card.instrucao}"
        </div>
      )}

      {/* 3 ações */}
      <div className="grid grid-cols-3 gap-1 pt-1.5">
        <BotaoAcao label="E-mail+54" title="Notificar cliente + lançar oc 54 (aguardar retorno)" icon={Mail} onClick={() => onAcao('email_54')} />
        <BotaoAcao label="Só e-mail" title="Apenas notificar o cliente, sem lançar ocorrência" icon={Send} onClick={() => onAcao('email_so')} />
        <BotaoAcao label="oc 49" title='Lançar oc 49 "PRAZO DE PERDAS EXPIRADO"' icon={FileWarning} onClick={() => onAcao('oc_49')} />
      </div>
    </div>
  );
}

function BotaoAcao({ label, title, icon: Icon, onClick }: {
  label: string; title: string; icon: any; onClick: () => void;
}) {
  return (
    <button onClick={onClick} title={title}
      className="flex items-center justify-center gap-1 text-[10px] py-1 px-1 rounded font-medium bg-zinc-50 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors">
      <Icon className="w-3 h-3 shrink-0" />{label}
    </button>
  );
}
```

---

## 5. Modal das 3 ações (carrega o `todo` certo + preview de e-mail)

Cada card de extravio já tem **3 `todos` pré-criados** pelo backend (um por ação),
discriminados por `proposta_payload.meta.acao` ∈ `email_mais_54` | `email_sem_oc` | `lancar_49`.

```tsx
const ACAO_TO_META: Record<string, string> = {
  email_54: 'email_mais_54',
  email_so: 'email_sem_oc',
  oc_49: 'lancar_49',
};

function ModalAcaoExtravio({ card, tipo, onClose, onFeito }: {
  card: CardExtravio;
  tipo: 'email_54' | 'email_so' | 'oc_49';
  onClose: () => void;
  onFeito: () => void;
}) {
  const [todoId, setTodoId] = useState<string | null>(null);
  const [assunto, setAssunto] = useState('');
  const [texto, setTexto] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [enviando, setEnviando] = useState(false);
  const ehEmail = tipo === 'email_54' || tipo === 'email_so';

  // Carrega o todo da ação + (se e-mail) o preview renderizado
  useEffect(() => {
    (async () => {
      setCarregando(true);
      const { data: todos } = await supabase
        .from('todos')
        .select('id, proposta_payload, status')
        .eq('card_id', card.card_id);
      const metaAlvo = ACAO_TO_META[tipo];
      const todo = (todos ?? []).find(
        (t: any) => t.proposta_payload?.meta?.acao === metaAlvo && t.status === 'pendente');
      if (!todo) { toast.error('Proposta não encontrada para esta ação.'); onClose(); return; }
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
        // aprova + executa: envia e-mail e lança oc 54 → card vai pra Tratativas/Aguardando Cliente
        const { data, error } = await supabase.rpc('aprovar_e_executar', {
          p_todo_id: todoId,
          p_extras: { texto_email_customizado: texto, assunto_customizado: assunto },
        });
        if (error || (data && data.ok === false)) throw new Error(error?.message ?? data?.error ?? 'Falha');
        toast.success('E-mail enviado + oc 54 lançada. Card movido para Tratativas de Relacionamento.');
      } else if (tipo === 'oc_49') {
        const { data, error } = await supabase.rpc('aprovar_e_executar', { p_todo_id: todoId });
        if (error || (data && data.ok === false)) throw new Error(error?.message ?? data?.error ?? 'Falha');
        toast.success('oc 49 (PRAZO DE PERDAS EXPIRADO) lançada. Card movido para Tratativas de Relacionamento.');
      } else {
        // só e-mail: envia pela thread do card, sem oc. Card permanece em Extravios.
        const { data, error } = await supabase.functions.invoke('responder-email-cliente', {
          body: { card_id: card.card_id, texto },
        });
        if (error || !data?.ok) throw new Error(error?.message ?? data?.error ?? 'Falha');
        // marca o todo como executado (afordância de UI; não dispara executor)
        await supabase.from('todos').update({ status: 'executado' }).eq('id', todoId);
        toast.success('E-mail enviado ao cliente (sem lançar ocorrência).');
      }
      onFeito();
    } catch (e: any) {
      toast.error(`Erro: ${e.message ?? e}`);
    } finally {
      setEnviando(false);
    }
  }

  const titulo = tipo === 'email_54' ? 'Notificar cliente + lançar oc 54'
    : tipo === 'email_so' ? 'Notificar cliente (só e-mail)'
    : 'Lançar oc 49 — PRAZO DE PERDAS EXPIRADO';

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            {titulo}<span className="text-xs text-zinc-500 font-mono">· NF {card.nf}</span>
          </DialogTitle>
        </DialogHeader>

        {carregando && (
          <div className="flex items-center justify-center py-10 text-zinc-400">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Carregando…
          </div>
        )}

        {!carregando && tipo === 'oc_49' && (
          <div className="text-sm text-zinc-700 dark:text-zinc-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-md p-3">
            Vai lançar a <b>oc 49</b> no SSW com a instrução <b>"PRAZO DE PERDAS EXPIRADO"</b>.
            O card sai dos Extravios e vai para <b>Tratativas de Relacionamento</b> (Aguardando você),
            já com as sugestões automáticas.
          </div>
        )}

        {!carregando && ehEmail && (
          <>
            <div>
              <label className="text-xs text-zinc-500 mb-1 block">Assunto</label>
              <Input value={assunto} onChange={(e) => setAssunto(e.target.value)} className="text-sm" />
            </div>
            <div>
              <label className="text-xs text-zinc-500 mb-1 block">Mensagem ao cliente — edite se quiser</label>
              <Textarea value={texto} onChange={(e) => setTexto(e.target.value)} className="text-sm min-h-[220px]" />
            </div>
            {tipo === 'email_54' && (
              <p className="text-[11px] text-zinc-500">
                Ao enviar, lança oc 54 e move o card para <b>Aguardando Cliente</b> em Tratativas.
              </p>
            )}
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={enviando}>Cancelar</Button>
          <Button onClick={confirmar} disabled={carregando || enviando}>
            {enviando ? <><Loader2 className="w-3 h-3 mr-2 animate-spin" /> Processando…</>
              : tipo === 'oc_49' ? 'Lançar oc 49' : 'Enviar e-mail'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

---

## Notas de contrato (backend já pronto)

| Recurso | Uso |
|---|---|
| view `v_extravios_kanban` | lista os cards de extravio do operador (RLS escopa → Duilio só vê os dele); `coluna_kanban` = D1..D5 por dias úteis |
| `todos` (3 por card) | `proposta_payload.meta.acao` = `email_mais_54` / `email_sem_oc` / `lancar_49` |
| RPC `preview_email_todo(p_todo_id)` | renderiza assunto+corpo do e-mail (já com qtd de volumes) |
| RPC `aprovar_e_executar(p_todo_id, p_extras)` | ações **E-mail+54** e **oc 49** → executor lança no SSW e move o card |
| edge `responder-email-cliente` `{card_id, texto}` | ação **Só e-mail** → envia sem oc, card permanece em Extravios |

**Movimentação automática:** ao lançar 54/49, o backend move o card de
`EXTRAVIO_MONITORADO` para o fluxo de relacionamento — ele some dos Extravios e
aparece em Tratativas (Aguardando Cliente p/ 54, Aguardando Você p/ 49). O
realtime já atualiza os dois kanbans.

## Critério de aceite visual
1. 5 colunas D1→D5, severidade crescente (zinc → vermelho).
2. Cards densos (~150px), mono pra NF/CTRC, instrução em itálico truncada.
3. 3 botões compactos por card com ícone lucide.
4. Modais shadcn (Dialog) com preview de e-mail editável.
5. Consistente com a aba PRIORIDADES AI (mesma paleta/tipografia).
