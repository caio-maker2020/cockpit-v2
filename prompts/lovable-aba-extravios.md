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

## 2b. Botão "Atualizar todas" no topo da aba (NOVO 2026-06-18)

No cabeçalho da aba Extravios, ao lado do título/contador, coloque um botão
**"↻ Atualizar todas"** que força o refresh (via SSW) de todos os cards de
extravio do operador e roteia os que mudaram de oc.

Backend (pronto):
- **RPC `extravios_atualizar_status()`** (sem args; usa o JWT) → retorna
  `{ bloqueado: bool, segundos_restantes: int, liberado_em: ISO, motivo }`.
  Chame ao montar a aba e a cada ~30s pra habilitar/desabilitar o botão e
  mostrar countdown. `motivo`: `sync_bastao` (bloqueado 20min após o sync do
  Bastão) ou `clique_operador` (bloqueado 10min após o último clique).
- **Edge `atualizar-extravios-todas`** (POST, com o JWT do usuário no
  Authorization) → processa em lotes e retorna
  `{ bloqueado, processados, deferidos, erros, proximo_liberado_em }`. Se
  `bloqueado: true` (corrida), mostre o countdown; senão, ao terminar, refetch do
  kanban.

Comportamento do botão:
- **Bloqueado** (`status.bloqueado`): desabilitado, texto
  `"Liberado em {mm:ss}"` usando `segundos_restantes` (decrementar no client).
  Tooltip explicando o motivo (ex.: "Atualizado pelo Bastão há pouco" /
  "Você atualizou há pouco").
- **Liberado:** habilitado. Ao clicar → estado "Atualizando…" (spinner) →
  `supabase.functions.invoke('atualizar-extravios-todas')` (manda o JWT
  automaticamente) → ao responder, refetch da view + toast
  `"{processados} atualizados"` (e, se `deferidos>0`, "+{deferidos} no próximo
  ciclo"). Em seguida o botão entra em cooldown de 10min (rechame o status).

```tsx
function BotaoAtualizarTodas({ onDone }: { onDone: () => void }) {
  const [status, setStatus] = useState<{ bloqueado: boolean; segundos_restantes: number; motivo: string | null } | null>(null);
  const [rodando, setRodando] = useState(false);

  const carregarStatus = async () => {
    const { data } = await supabase.rpc('extravios_atualizar_status');
    setStatus(data as any);
  };
  useEffect(() => { carregarStatus(); const t = setInterval(carregarStatus, 30_000); return () => clearInterval(t); }, []);
  // countdown local
  useEffect(() => {
    if (!status?.bloqueado) return;
    const t = setInterval(() => setStatus((s) => s && s.segundos_restantes > 0 ? { ...s, segundos_restantes: s.segundos_restantes - 1, bloqueado: s.segundos_restantes - 1 > 0 } : s), 1000);
    return () => clearInterval(t);
  }, [status?.bloqueado]);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const tip = status?.motivo === 'sync_bastao' ? 'Atualizado pelo Bastão há pouco' : status?.motivo === 'clique_operador' ? 'Você atualizou há pouco' : '';

  const clicar = async () => {
    setRodando(true);
    try {
      const { data } = await supabase.functions.invoke('atualizar-extravios-todas');
      const d = data as any;
      if (d?.bloqueado) { await carregarStatus(); return; }
      onDone(); // refetch do kanban
    } finally { setRodando(false); await carregarStatus(); }
  };

  const bloqueado = !!status?.bloqueado || rodando;
  return (
    <button onClick={clicar} disabled={bloqueado} title={tip}
      className={cn('inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md border transition-colors',
        bloqueado ? 'border-zinc-200 text-zinc-400 cursor-not-allowed dark:border-zinc-700' : 'border-zinc-300 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800')}>
      <RefreshCw className={cn('w-3.5 h-3.5', rodando && 'animate-spin')} />
      {rodando ? 'Atualizando…' : status?.bloqueado ? `Liberado em ${fmt(status.segundos_restantes)}` : 'Atualizar todas'}
    </button>
  );
}
```

Coloque `<BotaoAtualizarTodas onDone={() => queryClient.invalidateQueries({ queryKey: ['extravios'] })} />`
no header da aba. Importe `RefreshCw` de `lucide-react`.

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
        <span className={cn('tabular-nums', urgente ? 'text-red-600 dark:text-red-400 font-semibold' : 'text-zinc-600 dark:text-zinc-400')}>{card.dias_uteis ?? 1} {(card.dias_uteis ?? 1) === 1 ? 'dia útil' : 'dias úteis'}</span>
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
`card_id`. Cada card de extravio tem **4 propostas (`todos`) prontas** — todas
aprovadas pelo MESMO fluxo `aprovar_e_executar`:

- **"oc 49 — PRAZO DE PERDAS EXPIRADO"** (`meta.acao=lancar_49`) — lança a 49 no
  SSW SEMPRE com a instrução "PRAZO DE PERDAS EXPIRADO". **Sem e-mail.**
- **"Notificar cliente por e-mail (sem oc)"** (`meta.acao=email_sem_oc`) — abre o
  **editor de e-mail com template editável** (preview_email_todo). Ao aprovar,
  envia o e-mail e **NÃO lança oc** (executor trata `extras.skip_oc`); o card
  permanece em Extravios.
- **"Notificar cliente + oc 54"** (`meta.acao=email_mais_54`) — editor de e-mail
  com template editável; ao aprovar, envia + lança 54 → card vai pra Tratativas.
- **"oc 55 — autorizar seguir entrega / entrega parcial"** (`meta.acao=lancar_55`)
  — lança a 55 no SSW. **Sem e-mail.** (NOVO 2026-06-18)

As 2 de e-mail têm `template_id` + `email_destino` (cliente cadastrado) +
`meta.tinha_intencao_email=true` → renderizam com o **mesmo editor/preview de
e-mail das de relacionamento** (botão ABRIR), template editável, qtd de volumes
já preenchida (vem do `card.aviso_alteracao_oc`). É exatamente o print de
relacionamento.

### ⚠️ Regra crítica — propostas de SÓ-OC (49 e 55) NÃO abrem editor de e-mail
As propostas `lancar_49` e `lancar_55` têm **`meta.tinha_intencao_email === false`**
(e `meta.modo === 'sem_email'`). Para essas, ao clicar em **Aprovar**, chame
`aprovar_e_executar(p_todo_id)` **direto, SEM abrir o modal de e-mail** — mesmo o
`tool` sendo `lancar_oc_e_enviar_email`. Ou seja: **a decisão de abrir o editor de
e-mail é por `meta.tinha_intencao_email === true`, NUNCA pelo nome do tool.**
(Hoje a oc 49 está abrindo o editor indevidamente — oc 49 é só uma ocorrência que
passa o card pro Relacionamento, não manda e-mail nenhum.)

### Enxugar o editor de e-mail QUANDO a proposta é de extravio
As propostas de extravio têm `proposta_payload.meta.origem === 'extravio_cockpit'`.
Quando o editor de e-mail abrir para uma proposta com esse `origem`, ajuste:
- **Destinatários** (+ adicionar manual): **manter**.
- **Template** (dropdown): **manter**.
- **"Validar evidência antes de enviar"**: **REMOVER** (esconder). Extravio não
  tem evidência em sistema; sempre enviar com `validar_evidencia=false`. Deixar o
  checkbox só geraria erro/atrito (operador teria que desmarcar toda vez).
- **Assunto**: **manter** editável e já sugerido.
- **"Enviar como novo e-mail (não seguir o histórico anterior da tratativa)"**:
  **manter, com o padrão DESmarcado** (= continuar a conversa anterior se já
  existir tratativa dessa NF). ⚠️ A semântica é: **desmarcado** = o e-mail entra
  na thread existente da NF (é isso que "aproveita" uma tratativa já aberta);
  **marcado** = ignora o histórico e começa thread nova. Para um extravio recém-
  criado normalmente não há thread anterior, então o padrão desmarcado já manda
  e-mail novo; mas se a NF já tiver tratativa, desmarcado mantém o contexto.
- **Texto do e-mail**: **manter** editável (já puxa o template correto).
- **Rodapé "Como funciona: ao confirmar, lança a oc... {link_evidencia}..."**:
  **REMOVER** para extravio (não se aplica).
- **Anexos**: **manter**.

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

**Movimentação automática:** ao Aprovar "E-mail + 54", "oc 49" ou "oc 55", o
backend lança no SSW e tira o card de `EXTRAVIO_MONITORADO` → ele some dos
Extravios e aparece em Tratativas (54 → Aguardando Cliente; 49 → Aguardando Você,
já com sugestões; 55 segue o fluxo da regra). O realtime atualiza os dois kanbans.

**Botão "Atualizar em tempo real" / "Forçar atualização" no card de extravio
(NOVO 2026-06-18):** já chama `atualizar-card-via-portal-ssw`, que agora aceita
cards em `EXTRAVIO_MONITORADO`. Se o operador clicar e a última oc do SSW **já
não for mais de extravio** (ex.: o Perdas lançou 49/20/54 e o Bastão ainda não
sincronizou), o card é roteado na hora: oc de relacionamento → Tratativas
(Aguardando Você); oc de outro setor/finalizadora → TRANSFERIDO/RESOLVIDO; se
ainda é extravio (6/9/16) → permanece em Extravios. **Mantenha esse botão visível
no detalhe do card de extravio** — é o que resolve o delay do Bastão.

---

## Contrato backend (pronto)
| Recurso | Uso |
|---|---|
| view `v_extravios_kanban` | cards de extravio do operador (RLS); `coluna_kanban` D1..D5, `data_lancamento`, `dias_uteis` (**INTEIRO** — número exato de dias úteis, mín. 1), `instrucao`, `qtde_volumes` |
| `todos` (4/card) | propostas `lancar_49`, `email_sem_oc`, `email_mais_54`, `lancar_55` (renderizam no detalhe; só as 2 de e-mail abrem o editor — ver regra `meta.tinha_intencao_email`) |
| `preview_email_todo` / `aprovar_e_executar` | preview + aprovar — todas as ações usam isso (igual relacionamento) |
| `atualizar-card-via-portal-ssw` / `puxar-historico-ssw-card` | atualizar tempo real (roteia extravio→fluxo normal se a oc mudou) / puxar histórico |

## Aceite
1. Clicar no card de extravio abre **o mesmo detalhe da aba Tratativas** (mesmas
   cores, mesmas opções de envio com preview de e-mail/template).
2. Histórico SSW aparece completo abaixo (após "Puxar histórico").
3. Aprovar 54/49 move o card pra Tratativas automaticamente.
```
