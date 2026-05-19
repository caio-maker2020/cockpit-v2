# Lovable — Aba PRIORIDADES AI (kanban de cobrança escalonada)

**Data:** 2026-05-19
**Backend:** 100% pronto e deployado. Migrations 123-129. 5 edge functions + 3 crons (Sonnet 4.6).

## O que essa aba é

Centro de cobrança escalonada de NFs paradas em **oc=13 ou oc=21**. Substitui a aba "Pendências" antiga (Tela 4 do `lovable-cockpit-foundation.md`) com um **kanban 4 colunas** + 2 agentes IA trabalhando ao fundo.

**Visão final:** Duilio e Larissa abrem essa aba → veem cards parados ordenados pela IA → clicam o botão de cobrança → IA gera texto → operador edita → envia via Email (Gmail OAuth) OU WhatsApp (Evolution). Audit completo + 2º agente IA monitora SSW e classifica efetividade.

## Localização

Sidebar esquerda. Substitui a aba "**Pendências**" existente (mesmo slot — acima de AUDITORIA). Renomear pra "**Prioridades AI**" (com ícone ⭐ ou 🎯).

## Backend disponível

### View principal
```ts
const { data: cards } = await supabase
  .from('v_prioridades_ai')
  .select('*');
```

Colunas relevantes:
- `card_id` (uuid)
- `nf`, `ctrc`, `base`, `pagador_nome`, `empresa_cliente`
- `responsavel_relacionamento` (nome do operador)
- `oc_origem` (13 OU 21)
- `dias_uteis_parados`, `horas_paradas`, `minutos_paradas`
- `dentro_sla` (bool — SLA = 1 dia útil)
- `coluna_kanban` ('parada' | 'cobrado' | 'escalado' | 'resolvido' | NULL)
- `ia_insight` (jsonb — Priorizador OR Monitor):
  ```json
  {
    "tipo": "priorizador" | "monitor",
    "rank_priorizador": 1,
    "observacao_priorizador": "Cooperativa já atrasou 3× em 60d",
    "veredito_monitor": "efetiva" | "parcial" | "sem_resposta" | "sair_kanban",
    "proxima_acao_monitor": "Escalar pra coordenador",
    "analisado_em": "2026-05-19T..."
  }
  ```
- `ult_cobranca` (jsonb): `{ papel, canal, disparado_em }` ou null
- `ja_cobrou_gerente_base`, `ja_cobrou_coordenador`, `ja_cobrou_gerente_rel` (bool)

RLS já escopa por operador (Duilio só vê os dele; gestor vê tudo).

### Edge functions

| Endpoint | Quando chamar |
|---|---|
| `sugerir-cobranca-ai` | Quando operador abre modal de cobrança — gera texto IA |
| `disparar-cobranca-escalonada` | Quando operador clica "Enviar" no modal — envia + audita |
| `atualizar-card-via-tracking` | Botão "🔄 Forçar atualização SSW" do modal |
| `puxar-historico-ssw-card` | Botão "📋 Trazer histórico SSW" do modal |

### Realtime

Inscrever channel em `cards` filtrado pelos card_ids da view, escutando UPDATE de `prioridades_kanban_status`. Quando muda, mover card pra outra coluna sem refresh.

```ts
const channel = supabase
  .channel('prioridades-kanban')
  .on('postgres_changes',
    { event: 'UPDATE', schema: 'public', table: 'cards',
      filter: `id=in.(${cardIds.join(',')})` },
    (payload) => {
      // re-fetch a view ou atualizar local state
    }
  )
  .subscribe();
```

## Layout

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  ⭐ PRIORIDADES AI                                  [🔄 Refresh] [💡 Insights Globais]│
│  Filtros: [Base ▾] [Oc ▾ 13|21|todas] [Canal preferido ▾ email|whats|todos]          │
│                                                                                       │
│  Carga Parada (24)    │ Cobrado (8)         │ Escalado (3)         │ Resolvido (15)  │
│  ─────────────────────│─────────────────────│──────────────────────│─────────────────│
│  ┌────────────────┐   │ ┌────────────────┐  │ ┌────────────────┐   │ ┌────────────┐  │
│  │⭐ NF 750587    │   │ │ NF 1080742     │  │ │ NF 568107      │   │ │ NF 920161  │  │
│  │📍VGA · 13 dú   │   │ │📍MCU · 6 dú    │  │ │📍POA · 9 dú    │   │ │oc=14 ✓     │  │
│  │Última: oc=21   │   │ │Última: oc=21   │  │ │Última: oc=13   │   │ │Resolveu    │  │
│  │💡 Cooperativa  │   │ │💡 Gerente já   │  │ │💡 Sem resp 48h │   │ │14h após    │  │
│  │  3× em 60d     │   │ │ cobrado WA 2d  │  │ │ escalar agora  │   │ │cobrança    │  │
│  │                │   │ │                │  │ │                │   │ │            │  │
│  │[📤 Gerente]    │   │ │[📞 Coord.]     │  │ │[🚨 Ger.Rel.]   │   │ │(arquivado) │  │
│  │[📞 Coord.]     │   │ │[🚨 Ger.Rel.]   │  │ │[📤 Re-cobrar]  │   │ └────────────┘  │
│  │[🚨 Ger.Rel.]   │   │ │                │  │ │                │   │                 │
│  │[⋯]             │   │ │[⋯]             │  │ │[⋯]             │   │                 │
│  └────────────────┘   │ └────────────────┘  │ └────────────────┘   │                 │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## Comportamento

### Distribuição por coluna

```ts
const colunas = {
  parada:    cards.filter(c => c.coluna_kanban === 'parada'),
  cobrado:   cards.filter(c => c.coluna_kanban === 'cobrado'),
  escalado:  cards.filter(c => c.coluna_kanban === 'escalado'),
  resolvido: cards.filter(c => c.coluna_kanban === 'resolvido'),
};
```

### Ordenação dentro da coluna

1º critério: `ia_insight.rank_priorizador` ASC (1 = mais prioritário; tipo='priorizador')
2º critério: `dias_uteis_parados` DESC

Card com `rank_priorizador === 1` ganha badge ⭐ "Top IA".

### Card resumido (coluna)

```tsx
<div className="card">
  {topIA && <span className="badge-top-ia">⭐</span>}
  <div className="header">
    <span className="nf">NF {card.nf}</span>
    {card.ctrc && <span className="ctrc">· {card.ctrc}</span>}
  </div>
  <div className="meta">
    📍 {card.base} · {card.dias_uteis_parados.toFixed(1)} dú
  </div>
  <div className="oc-origem">Última: oc={card.oc_origem}</div>
  {card.ia_insight && (
    <div className="insight">
      💡 {card.ia_insight.observacao_priorizador ?? card.ia_insight.proxima_acao_monitor}
    </div>
  )}
  {card.ult_cobranca && (
    <div className="ult-cobranca">
      Última: {humanizarPapel(card.ult_cobranca.papel)} via {card.ult_cobranca.canal} · {timeAgo(card.ult_cobranca.disparado_em)}
    </div>
  )}
  <div className="botoes">
    <Button disabled={card.ja_cobrou_gerente_base} onClick={()=>abrirModal(card,'gerente_base')}>📤 Gerente</Button>
    <Button disabled={card.ja_cobrou_coordenador} onClick={()=>abrirModal(card,'coordenador_entrega')}>📞 Coord.</Button>
    <Button disabled={card.ja_cobrou_gerente_rel} onClick={()=>abrirModal(card,'gerente_relacionamento')}>🚨 Ger.Rel.</Button>
  </div>
  <Button variant="ghost" onClick={()=>abrirCardCompleto(card)}>⋯ Ver tudo</Button>
</div>
```

### Modal completo do card (Click "⋯ Ver tudo" ou no card body)

```
┌──────────────────────────────────────────────────────────────┐
│  ⭐ NF 750587 · CTRC PDV373487-1 · 📍VGA                     │
│  ────────────────────────────────────────────────────────────│
│  Cliente: COOPERATIVA AGRO PECUARIA · 13 dú parados          │
│  Última oc: 21 (reentrega solicitada)                        │
│  Responsável: Larissa                                         │
│                                                               │
│  ┌─ Análise IA (Priorizador) ───────────────────────────┐    │
│  │ 💡 Rank #1 — "Cooperativa já atrasou 3× em 60d.      │    │
│  │    Padrão recorrente. Escalar logo se gerente não    │    │
│  │    responder em 24h."                                │    │
│  │ Analisado 14:32 · Sonnet 4.6                         │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  ┌─ Cobrar (3 opções) ──────────────────────────────────┐    │
│  │ [📤 Gerente Base       ]  Canal: ◉ Email ◯ WhatsApp │    │
│  │ [📞 Coord. Entrega ✓ 2d]  Canal: ◯ Email ◉ WhatsApp │    │
│  │ [🚨 Gerente Relac.     ]  Canal: ◉ Email ◯ WhatsApp │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  ┌─ Utilitários SSW ────────────────────────────────────┐    │
│  │ [🔄 Forçar atualização SSW]                          │    │
│  │ [📋 Trazer histórico SSW]                            │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  ┌─ Timeline cobranças ─────────────────────────────────┐    │
│  │ 16/05 10:23 · Gerente Base (Ana) · WhatsApp · ✅     │    │
│  │   "Bom dia, NF 750587 está parada há 11 dias..."     │    │
│  │ 18/05 14:45 · Gerente Base (Ana) · Email · ✅        │    │
│  │   "Re-envio: NF 750587 sem retorno..."               │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  ┌─ Veredito Monitor (Sonnet 4.6) ──────────────────────┐    │
│  │ ⚠ Sem resposta — Ana já foi cobrada 2× sem efeito.   │    │
│  │ Sugestão: Escalar pra Coordenador via WhatsApp.      │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  [Fechar]                                    [Abrir card →]  │
└──────────────────────────────────────────────────────────────┘
```

### Modal de cobrança (Click em "📤 Gerente Base" ou outro)

```tsx
async function abrirCobranca(cardId: string, papel: string, canal: 'email'|'whatsapp') {
  setLoading(true);
  const { data } = await supabase.functions.invoke('sugerir-cobranca-ai', {
    body: { card_id: cardId, papel, canal }
  });
  setLoading(false);
  
  // Modal mostra:
  // - Destinatário: data.contato_nome + data.contato_destino (email ou tel)
  // - Assunto (só email): editável
  // - Texto: editável (textarea grande)
  // - [Cancelar] [Enviar]
}

async function enviar(cardId, papel, canal, textoEditado, assuntoEditado) {
  const { data, error } = await supabase.functions.invoke('disparar-cobranca-escalonada', {
    body: {
      card_id: cardId,
      papel,
      canal,
      texto_final: textoEditado,
      assunto_final: assuntoEditado,
    }
  });
  
  if (data?.ok) {
    toast.success(`Cobrança enviada via ${canal}. Card move pra "${data.status_kanban_novo}".`);
    // Realtime já vai mover o card
  } else if (data?.error === 'sem_contato') {
    toast.error(`Sem contato cadastrado pra ${humanizarPapel(papel)} da base ${data.base}. Cadastre em CADASTROS → Escalonamento.`);
  } else {
    toast.error(`Falha: ${data?.erro ?? error?.message}`);
  }
}
```

**Anti-clique-duplo:** botão trava 30s após primeiro clique de envio.

### Filtros no topo

- **Base ▾** — multi-select de bases (`distinct cards.base_destino` ou só as que estão na view)
- **Oc ▾** — chips: `Todas | oc=13 | oc=21`
- **Canal preferido ▾** — `Todos | Email | WhatsApp` (filtra cards baseados no canal da última cobrança)

### Painel "💡 Insights Globais" (drawer lateral, opcional)

Botão no header abre drawer:
- Lista das observações do Priorizador agregadas pro operador autenticado
- "Você tem 3 NFs da Cooperativa Agro paradas — padrão recorrente. Considere ligar pra gerente da base VGA"
- Última atualização do Priorizador

Query:
```sql
SELECT DISTINCT ON (cnpj_pagador)
  pagador_nome, count(*) OVER (PARTITION BY cnpj_pagador) AS n_cards,
  observacao_priorizador
FROM v_prioridades_ai
WHERE coluna_kanban = 'parada'
ORDER BY cnpj_pagador, dias_uteis_parados DESC;
```

### Coluna "Resolvido" — cards arquivados (housekeeping)

Cards com `coluna_kanban='resolvido'` são auto-removidos após 30 dias (cron `sync-kanban-status-prioridades` faz). Front mostra com badge "✓ Resolveu em Xh após cobrança" + visual mais leve (opacity 0.7).

### Sub-tabs futuras (placeholder visual, MVP NÃO ativa)

- ✓ **Carga Parada** (ativo) — kanban completo
- ❌ **Histórico** (placeholder — em breve) — análise temporal de cobranças

## Realtime + atualização

```ts
useEffect(() => {
  const channel = supabase
    .channel('prioridades-kanban')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'cards' },
      () => queryClient.invalidateQueries(['v_prioridades_ai'])
    )
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'cobrancas_disparadas' },
      () => queryClient.invalidateQueries(['v_prioridades_ai'])
    )
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'analises_prioridades_ai' },
      () => queryClient.invalidateQueries(['v_prioridades_ai'])
    )
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}, []);
```

## Crons funcionando ao fundo (não precisa mexer)

| Cron | Schedule | O que faz |
|---|---|---|
| `sync-kanban-status-prioridades-daily` | 03h UTC | Bootstrap: cards novos em oc=13/21 → status='parada'. Housekeeping: 'resolvido' >30d → NULL |
| `agente-priorizador-ai-2x` | 11h e 17h UTC | Sonnet 4.6 ranqueia cards por operador + gera observação |
| `agente-monitor-efetividade-ai-4x` | 01h, 09h, 15h, 20h UTC | Sonnet 4.6 monitora cobranças últimas 7d, classifica efetividade, transiciona kanban |

## Critério de aceite

1. Aba "Prioridades AI" substitui "Pendências" na sidebar
2. Kanban com 4 colunas + contadores corretos por status
3. Cards ordenados por `rank_priorizador` (Top IA com ⭐) ASC, fallback `dias_uteis_parados` DESC
4. Click no card abre modal completo com 3 botões cobrança + utilitários SSW + timeline + análises IA
5. Modal de cobrança gera texto via `sugerir-cobranca-ai`, permite editar, envia via `disparar-cobranca-escalonada`
6. Toast feedback (sucesso/falha/sem_contato)
7. Realtime move cards entre colunas sem F5
8. Filtros (Base, Oc, Canal) funcionam
9. Painel "Insights Globais" drawer mostra observações agregadas
10. Coluna Resolvido tem visual diferenciado + auto-arquiva após 30d

## Não-objetivos do MVP

- Drag-and-drop manual entre colunas (transições só via cobrança ou Monitor IA)
- Edição de análise IA do front (re-roda via cron 6-12h ou botão "Re-analisar" futuro)
- Cobrança autônoma sem clique (fase 2)
- Sub-tab Histórico (placeholder)
