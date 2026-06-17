# Lovable — Renomear INBOX + aba EXTRAVIOS (kanban D1–D5) REUSANDO o detalhe de Tratativas

**Data:** 2026-06-17 (v3 — card abre o MESMO detalhe da aba Tratativas) ·
**Status:** Backend pronto/deployado.

**Princípio (importante):** o card de extravio é um `card` normal com `todos`
(propostas). Então o detalhe dele deve **reusar EXATAMENTE o mesmo componente de
detalhe que a aba "Tratativas de Relacionamento" já usa** — com as propostas
coloridas, preview de e-mail/template, botões Aprovar/Rejeitar, compositor de
e-mail nativo e o Histórico SSW. NÃO construir painel custom (foi o erro da v2:
ficou sem cor, sem preview de e-mail e com histórico incompleto).

---

## 1. Renomear a 1ª aba + excluir os extravios dela

Sidebar: **"Inbox" → "Tratativas de Relacionamento"**. O filtro dessa aba DEVE
excluir `EXTRAVIO_MONITORADO`:

```ts
.not('state', 'in', '("RESOLVIDO","CANCELADO","EXTRAVIO_MONITORADO")')
```

## 2. Sidebar — novo item abaixo de "Tratativas de Relacionamento"
```tsx
{ id: 'extravios', label: 'Extravios', icon: PackageX, route: '/extravios' }
```

---

## 3. Página `<Extravios />` — só o kanban; clicar abre o detalhe de Tratativas

A página de Extravios é APENAS a visualização em kanban D1..D5. Ao clicar num
card, **abra o mesmo componente de detalhe do card que a aba Tratativas usa**
(o `<CardDetail cardId=... />` / `<CardDrawer>` / Sheet de detalhe que já existe),
passando o `card_id`. Esse componente já tem tudo (propostas com preview de
e-mail, cores, Aprovar/Rejeitar, compositor de e-mail, Histórico SSW). Reuse-o.

```tsx
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { PackageX, MapPin } from 'lucide-react';
// ⬇️ IMPORTE O DETALHE DE CARD QUE A ABA TRATATIVAS JÁ USA (mesmo componente!)
import { CardDetailSheet } from '@/features/tratativas/CardDetailSheet'; // ajuste o caminho real

type CardExtravio = {
  card_id: string; nf: string; ctrc: string | null;
  base_destino: string | null; empresa_cliente: string | null; pagador_nome: string | null;
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
  const [cardIdSel, setCardIdSel] = useState<string | null>(null);

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
                  {cardsCol.map((card) => <CardExtravioItem key={card.card_id} card={card} onClick={() => setCardIdSel(card.card_id)} />)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ⬇️ MESMO componente de detalhe da aba Tratativas. Ele carrega o card +
          propostas (todos) + preview de e-mail + Histórico SSW + cores/layout.
          Ajuste o nome/props pro componente real do seu projeto. */}
      {cardIdSel && (
        <CardDetailSheet
          cardId={cardIdSel}
          open
          onOpenChange={(o) => { if (!o) { setCardIdSel(null); queryClient.invalidateQueries({ queryKey: ['v_extravios_kanban'] }); } }}
        />
      )}
    </div>
  );
}

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

---

## 4. O detalhe (REUSAR o de Tratativas) — por que isso resolve tudo

O componente de detalhe que a aba Tratativas já usa renderiza, lendo só o
`card_id`:

- **Propostas/ações coloridas** com **preview do e-mail + template** (via
  `preview_email_todo`) e **Aprovar/Rejeitar** — os cards de extravio têm 2
  propostas prontas: **"E-mail + oc 54"** (template EXTRAVIO_PARCIAL/TOTAL) e
  **"oc 49 — PRAZO DE PERDAS EXPIRADO"**. Vão aparecer iguais às de relacionamento.
- **Compositor de e-mail nativo** ("responder ao cliente") — é o **"só e-mail"**
  (notifica sem lançar oc), idêntico ao de relacionamento.
- **Histórico SSW** completo (timeline) + botões **"Atualizar em tempo real"**
  (`atualizar-card-via-portal-ssw`) e **"Puxar histórico"** (`puxar-historico-ssw-card`).
  Para extravio o `historico_ssw` começa vazio — clicar em **Puxar histórico**
  popula a timeline.
- Mesma **paleta/tipografia/cores** — porque é o mesmo componente.

Se o detalhe de Tratativas hoje NÃO mostra a seção de **Histórico SSW com os
botões Atualizar/Puxar** (eles existem na aba PRIORIDADES AI —
`UtilitariosSswSection` + `HistoricoSswSection` em `lovable-aba-prioridades-ai.md`),
**inclua essa seção no detalhe** para que apareça tanto em Extravios quanto em
Tratativas. É a mesma fonte (`cards.historico_ssw`).

**Movimentação automática:** ao Aprovar "E-mail + 54" ou "oc 49", o backend lança
no SSW e tira o card de `EXTRAVIO_MONITORADO` → ele some dos Extravios e aparece
em Tratativas (54 → Aguardando Cliente; 49 → Aguardando Você, já com sugestões).
O realtime atualiza os dois kanbans.

---

## Contrato backend (pronto)
| Recurso | Uso |
|---|---|
| view `v_extravios_kanban` | cards de extravio do operador (RLS); `coluna_kanban` D1..D5, `data_lancamento`, `dias_uteis`, `instrucao`, `qtde_volumes` |
| `todos` (2/card) | propostas `email_mais_54` e `lancar_49` (renderizam no detalhe com preview de e-mail) |
| `preview_email_todo` / `aprovar_e_executar` | preview + aprovar (igual relacionamento) |
| `responder-email-cliente` | compositor de e-mail nativo (= "só e-mail") |
| `atualizar-card-via-portal-ssw` / `puxar-historico-ssw-card` | atualizar tempo real / puxar histórico |

## Aceite
1. Clicar no card de extravio abre **o mesmo detalhe da aba Tratativas** (mesmas
   cores, mesmas opções de envio com preview de e-mail/template).
2. Histórico SSW aparece completo abaixo (após "Puxar histórico").
3. Aprovar 54/49 move o card pra Tratativas automaticamente.
```
