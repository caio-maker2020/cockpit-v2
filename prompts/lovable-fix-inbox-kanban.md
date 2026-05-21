# Lovable — INBOX · kanban editorial (mesma linguagem do PRIORIDADES AI)

**Data:** 2026-05-23
**Escopo:** 100% frontend. Replica a linguagem visual do PRIORIDADES AI na aba INBOX (página principal de operação) — cards editoriais respirados, kanban 5 colunas, hierarquia clara, ação primária contextual. Mantém TODA lógica (queries Supabase, RPCs, realtime, modais).

**Backend:** lê `cards` direto (campos já existentes — `state`, `cod_ultima_ocorrencia`, `empresa_cliente`, `responsavel_relacionamento`, `agent_state`, `cliente_respondeu_em`, `lock_aguardando_validacao`, `last_event_at`, `pagador`, `nf`, `ctrc`, `base_destino`, `ia_sugestao_oc_resposta`, `aviso_alteracao_oc`).

---

## Direção estética

Mesma "Sal Express · Logistics OS" do PRIORIDADES AI:
- Cream warm + ink preto + vermelho Sal como único accent semântico
- Bricolage Grotesque (display + body) + JetBrains Mono (dados técnicos)
- **Cards editoriais respirados**, cliente full width sem truncate
- **Sem cards-box pesados encaixotados** — wrapper sutil bg-elevated + border hairline + radius 6
- **Kanban horizontal** fluindo esquerda → direita conforme estado de tratativa
- CTA primário contextual por estado

A INBOX é o **console de operação diária** — onde Larissa/Duilio passam o dia. Tem que ser óbvio, rápido de escanear, sem ruído visual.

---

## Kanban INBOX — 5 colunas por estado de ação

```
┌────────────────┬────────────────┬────────────────┬────────────────┬────────────────┐
│ AGUARDA VOCÊ   │ CLIENTE RESP.  │ EM AÇÃO        │ AGUARDA CLIENTE│ CONCLUÍDOS HOJE│
│ valide a oc    │ responda agora │ Cockpit lançou │ esperando 54   │ entregue/baixado│
│ vermelho       │ amber          │ ink            │ ink-mute       │ verde positive │
│                │                │                │                │                │
│ ┌──card──┐    │ ┌──card──┐    │ ┌──card──┐    │ ┌──card──┐    │ ┌──card──┐    │
│ │urgente │    │ │ cliente│    │ │executou│    │ │esperando│    │ │entregue│    │
│ └────────┘    │ └────────┘    │ └────────┘    │ └────────┘    │ └────────┘    │
│                │                │                │                │                │
│ ...            │ ...            │                │ ...            │                │
└────────────────┴────────────────┴────────────────┴────────────────┴────────────────┘
                              ▶ fluxo · você decide → ação → cliente → resolvido
```

### Mapeamento de coluna por estado

```ts
function colunaInbox(card): InboxColumn {
  // Concluídos: estados terminais OU ACAO_EXECUTADA confirmada hoje
  if (card.state === 'RESOLVIDO') return 'concluido_hoje';
  if (card.state === 'CANCELADO') return null;  // nem aparece
  if (card.state === 'TRANSFERIDO' && transferidoHoje(card)) return 'concluido_hoje';
  if (card.state === 'TRANSFERIDO') return null;  // some da inbox após o dia

  // Em ação: Cockpit lançou no SSW, aguardando Bastão confirmar
  if (card.state === 'EXECUTANDO_ACAO') return 'em_acao';
  if (card.state === 'ACAO_EXECUTADA') return 'em_acao';

  // Cliente respondeu: voltou pra você decidir oc
  if (card.state === 'AGUARDANDO_CLIENTE' && card.cliente_respondeu_em) return 'cliente_respondeu';

  // Aguardando cliente: notificou via oc=54, esperando email/whatsapp
  if (card.state === 'AGUARDANDO_CLIENTE') return 'aguarda_cliente';

  // Aguarda você: AVH + lock=true (precisa validar proposta IA)
  if (card.state === 'AGUARDANDO_VALIDACAO_HUMANA' && card.lock_aguardando_validacao) return 'aguarda_voce';

  // AGUARDANDO_AGENTE: card sendo processado, não mostra na inbox ainda
  return null;
}
```

### Critérios das colunas

| Coluna             | Filtro                                                                | Cor       | Cobrança |
|--------------------|-----------------------------------------------------------------------|-----------|----------|
| **Aguarda Você**   | `AGUARDANDO_VALIDACAO_HUMANA AND lock=true`                          | signal    | abre detalhe pra validar proposta |
| **Cliente Resp.**  | `AGUARDANDO_CLIENTE AND cliente_respondeu_em IS NOT NULL`            | warning   | abre composer com sugestão IA |
| **Em Ação**        | `EXECUTANDO_ACAO OR ACAO_EXECUTADA`                                  | ink       | sem CTA (esperando) |
| **Aguarda Cliente**| `AGUARDANDO_CLIENTE AND cliente_respondeu_em IS NULL`                | ink-mute  | re-notificar (manual) |
| **Concluídos Hoje**| `RESOLVIDO OR TRANSFERIDO AND last_event_at::date = current_date`    | positive  | sem CTA (read-only) |

---

## `KanbanCard` na INBOX

Mesma estrutura editorial do PRIORIDADES AI, com adaptações pro contexto INBOX:

```tsx
function InboxCard({ card }) {
  const coluna = colunaInbox(card);
  const acao = proximaAcaoInbox(card);

  return (
    <article
      onClick={() => abrirCard(card.id)}
      className="group cursor-pointer p-4 bg-bg-elevated border border-border rounded-md hover:border-ink/30 hover:shadow-sm transition-all"
    >
      {/* Headline cliente — full width, sem truncate */}
      <h3 className="font-display font-semibold text-body-lg text-ink leading-tight">
        {nomeClienteCompleto(card)}
      </h3>

      {/* NF + destino — mono compacto */}
      <p className="font-mono text-caption text-ink-soft tracking-tight mt-2">
        NF {card.nf}
        {card.base_destino && (
          <>
            <br />
            <span className="text-ink font-semibold">{card.base_destino}</span>
            {card.agent_state?.cidade_destino &&
              card.agent_state.cidade_destino.toUpperCase() !== card.base_destino.toUpperCase() && (
              <span className="text-ink-mute"> · {card.agent_state.cidade_destino} {card.agent_state.uf_destino}</span>
            )}
          </>
        )}
      </p>

      {/* Status line — oc + tempo desde último evento + operador */}
      <div className="flex items-center justify-between mt-3 font-mono text-caption">
        <span className={tempoStyle(diasDesdeUltimoEvento(card))}>
          {tempoDesdeUltimoEvento(card)}
        </span>
        <span className="text-ink-mute">oc={card.cod_ultima_ocorrencia}</span>
      </div>

      {/* Sinal IA / aviso (contextual por coluna) */}
      <SinalContextual card={card} coluna={coluna} />

      {/* CTA — abre o card OU ação rápida */}
      <div className="mt-4 pt-3 border-t border-border">
        {acao ? (
          <button
            onClick={(e) => { e.stopPropagation(); acao.onClick(card); }}
            className="group/btn w-full inline-flex items-center justify-center gap-2 bg-ink text-bg hover:bg-signal active:scale-[0.98] px-3 py-2 rounded text-caption font-medium transition-all"
          >
            {acao.label}
            <span className="transition-transform group-hover/btn:translate-x-0.5">→</span>
          </button>
        ) : (
          <p className="text-caption text-ink-mute italic text-center">
            {labelEsperando(coluna)}
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

### Helpers contextuais

```ts
function proximaAcaoInbox(card) {
  const coluna = colunaInbox(card);
  switch (coluna) {
    case 'aguarda_voce':
      return { label: 'Validar proposta IA', onClick: (c) => abrirCard(c.id) };
    case 'cliente_respondeu':
      return { label: 'Responder cliente', onClick: (c) => abrirCardNaTab(c.id, 'resposta') };
    case 'aguarda_cliente':
      return { label: 'Re-notificar', onClick: (c) => abrirCardNaTab(c.id, 'resposta') };
    case 'em_acao':
    case 'concluido_hoje':
    default:
      return null;
  }
}

function labelEsperando(coluna) {
  switch (coluna) {
    case 'em_acao': return 'aguardando confirmação Bastão';
    case 'concluido_hoje': return 'ciclo encerrado';
    default: return '';
  }
}

function tempoDesdeUltimoEvento(card) {
  const ts = new Date(card.last_event_at).getTime();
  const horas = (Date.now() - ts) / (1000 * 60 * 60);
  if (horas < 1) return `${Math.round(horas * 60)}min`;
  if (horas < 24) return `${horas.toFixed(0)}h`;
  const dias = horas / 24;
  return `${dias.toFixed(1)} d`;
}

function diasDesdeUltimoEvento(card) {
  const ts = new Date(card.last_event_at).getTime();
  return (Date.now() - ts) / (1000 * 60 * 60 * 24);
}

const tempoStyle = (d) =>
  d > 2 ? 'text-signal font-semibold'    // >2 dias = urgente
  : d > 0.5 ? 'text-warning font-medium'  // 12-48h = atenção
  : 'text-ink-soft';                       // <12h = normal
```

### `SinalContextual` — uma única "voz" por card

Em vez de ter 3 banners diferentes (proposta IA, aviso alteração oc, IA sugestão resposta), unificar em **um sinal contextual inline** baseado no que importa pra coluna:

```tsx
function SinalContextual({ card, coluna }) {
  // Prioridade 1: aviso de alteração de oc (vermelho urgente)
  if (card.aviso_alteracao_oc?.tipo === 'ia_oc13_autonoma') {
    return (
      <p className="flex items-start gap-1.5 mt-3 text-caption text-signal leading-snug">
        <span className="shrink-0">⚡</span>
        <span>Ação autônoma executada — oc=21 + cancelamento agendado</span>
      </p>
    );
  }
  if (card.aviso_alteracao_oc?.tipo === 'ia_oc13_falhou') {
    return (
      <p className="flex items-start gap-1.5 mt-3 text-caption text-warning leading-snug">
        <span className="shrink-0">⚠</span>
        <span>Agente IA falhou ({card.aviso_alteracao_oc.tentativa}/3) — você decide</span>
      </p>
    );
  }
  if (card.aviso_alteracao_oc?.tipo === 'ia_sugestao_oc13' ||
      card.aviso_alteracao_oc?.tipo === 'ia_sugestao_ocs_padrao') {
    return (
      <p className="flex items-start gap-1.5 mt-3 text-caption text-ink-soft leading-snug">
        <span className="text-signal shrink-0">✦</span>
        <span className="line-clamp-2">
          Recomendado: <span className="text-ink font-medium">oc={card.aviso_alteracao_oc.proposta_destacada}</span>
          {' · '}{card.aviso_alteracao_oc.motivo_extraido?.slice(0, 60)}
        </span>
      </p>
    );
  }

  // Prioridade 2: cliente respondeu com sugestão IA
  if (coluna === 'cliente_respondeu' && card.ia_sugestao_oc_resposta) {
    return (
      <p className="flex items-start gap-1.5 mt-3 text-caption text-ink-soft leading-snug">
        <span className="text-signal shrink-0">✦</span>
        <span className="line-clamp-2">
          IA sugere <span className="text-ink font-medium">oc={card.ia_sugestao_oc_resposta.oc_sugerida}</span>
          {' · '}{firstSentence(card.ia_sugestao_oc_resposta.resumo, 60)}
        </span>
      </p>
    );
  }

  // Prioridade 3: aguarda você sem aviso = só ressalta oc atual
  if (coluna === 'aguarda_voce') {
    return (
      <p className="flex items-start gap-1.5 mt-3 text-caption text-ink-soft leading-snug">
        <span className="text-signal shrink-0">✦</span>
        <span>Proposta IA pronta — clique pra validar</span>
      </p>
    );
  }

  return null;
}
```

Só **um sinal por card**. Acaba com o "frankenstein" de múltiplos banners empilhados.

---

## Layout da página

```tsx
<div className="max-w-[1600px] mx-auto px-6 py-8">
  {/* Eyebrow signature + sync status */}
  <header className="mb-6">
    <div className="flex items-baseline justify-between text-label uppercase tracking-[0.08em] text-ink-mute">
      <span>
        <span className="text-signal">/ 01</span> · Operação · {nomeOperadorLogado}
      </span>
      <span className="font-mono text-caption">Última sync há {syncMin}min · <button>⟳</button></span>
    </div>
    <h1 className="font-display font-semibold text-h4 text-ink mt-2 tracking-tight">
      Inbox
    </h1>
    <p className="font-display text-body-lg text-ink-soft mt-1">
      {totalNaInbox} cards na sua tratativa · <em>{totalAguardaVoce}</em> precisam decisão agora
    </p>
  </header>

  {/* Toolbar: busca + filtros */}
  <div className="flex flex-wrap items-center gap-3 pb-6 border-b border-border mb-6">
    <SearchBar /> {/* Mesmo componente do PRIORIDADES AI — NF/CT-e/cliente/cidade/base */}
    <span className="flex-1" />
    <FiltroDropdown label="Todos canais" options={['Todos', 'Email', 'WhatsApp', 'Bastão']} />
    <FiltroDropdown label="Todas ocs"    options={['Todas', 'oc=10', 'oc=19', 'oc=49', 'oc=54', 'oc=56', '+']} />
  </div>

  {/* Kanban 5 colunas */}
  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
    <KanbanColumn titulo="Aguarda Você"     sublabel="valide a proposta IA"        cards={porColuna.aguarda_voce}        accent="signal"   />
    <KanbanColumn titulo="Cliente Resp."    sublabel="responda agora"              cards={porColuna.cliente_respondeu}    accent="warning"  />
    <KanbanColumn titulo="Em Ação"          sublabel="Cockpit lançou no SSW"       cards={porColuna.em_acao}              accent="ink"      />
    <KanbanColumn titulo="Aguarda Cliente"  sublabel="esperando retorno via 54"    cards={porColuna.aguarda_cliente}      accent="ink-mute" />
    <KanbanColumn titulo="Concluídos Hoje"  sublabel="ciclo encerrado · 24h"       cards={porColuna.concluido_hoje}       accent="positive" />
  </div>
</div>
```

Reusa `KanbanColumn` + `SearchBar` do PRIORIDADES AI (componentes idênticos).

---

## Agrupamento

```ts
const porColuna = cards.reduce((acc, c) => {
  const k = colunaInbox(c);
  if (!k) return acc;
  (acc[k] ??= []).push(c);
  return acc;
}, {
  aguarda_voce: [],
  cliente_respondeu: [],
  em_acao: [],
  aguarda_cliente: [],
  concluido_hoje: [],
});

// Dentro de cada coluna, mais urgente no topo
Object.entries(porColuna).forEach(([k, arr]) => {
  // "aguarda_voce" e "cliente_respondeu" ordenam por last_event_at ASC (mais antigo no topo = mais urgente)
  // demais ordenam por last_event_at DESC (mais recente primeiro)
  const ascOrder = ['aguarda_voce', 'cliente_respondeu'].includes(k);
  arr.sort((a, b) => ascOrder
    ? new Date(a.last_event_at).getTime() - new Date(b.last_event_at).getTime()
    : new Date(b.last_event_at).getTime() - new Date(a.last_event_at).getTime()
  );
});
```

---

## Query Supabase

```ts
const { data: cards } = await supabase
  .from('cards')
  .select(`
    id, nf, ctrc, state,
    cod_ultima_ocorrencia,
    empresa_cliente, pagador,
    responsavel_relacionamento,
    base_destino, agent_state,
    cliente_respondeu_em,
    lock_aguardando_validacao,
    ia_sugestao_oc_resposta,
    aviso_alteracao_oc,
    last_event_at,
    bastao_data_ultima_ocorrencia
  `)
  // RLS já filtra pelo operador logado (carteira)
  .in('state', [
    'AGUARDANDO_VALIDACAO_HUMANA',
    'AGUARDANDO_CLIENTE',
    'EXECUTANDO_ACAO',
    'ACAO_EXECUTADA',
    'TRANSFERIDO',
    'RESOLVIDO',
  ])
  .order('last_event_at', { ascending: false })
  .limit(500);
```

Filtragem por coluna acontece client-side via `colunaInbox(card)`. **Realtime sub** em `cards` mantém kanban vivo.

---

## Responsividade

- **lg (≥1024px):** 5 colunas lado a lado
- **md (768-1023px):** 2 colunas — prioriza AGUARDA VOCÊ + CLIENTE RESPONDEU primeiro
- **sm (<768px):** 1 coluna empilhada

Headers de coluna `sticky top-0` no scroll vertical.

---

## Tokens (do design v3 Sal — reuso)

```
text-h4 / font-display / font-semibold        → título página
text-h6 / font-display / font-semibold        → título coluna (color por accent)
text-body-lg / font-display / font-semibold   → cliente headline
font-mono / text-caption / ink-soft           → NF, destino, status, tempo
text-caption / font-medium                    → CTA primário
text-signal (vermelho Sal)                    → AGUARDA VOCÊ, ✦ IA, aviso urgente
text-warning                                  → CLIENTE RESP. + AGUARDA CLIENTE
text-positive                                 → CONCLUÍDOS HOJE
bg-ink → hover:bg-signal                      → CTA primário
border-border + hover:border-ink/30          → wrapper card
```

---

## **NÃO QUEBRAR**

- Toda navegação atual (`abrirCard(id)` → rota detalhe) preservada
- Realtime sub em `cards` continua igual
- Filtros que existem hoje continuam funcionando — adicionar busca como complemento
- Modal de validação proposta IA continua aberto via "Validar proposta IA →" no card
- Composer de resposta continua aberto via "Responder cliente →"
- RLS, queries, RPCs intactas
- Banner unified (`SinalContextual`) **substitui** os 3+ banners atuais, mas a lógica subjacente (`aviso_alteracao_oc`, `ia_sugestao_oc_resposta`) é a mesma — só apresenta unificado

---

## Comportamento de "linha de produção" na INBOX

1. Operador entra na INBOX → vê 5 colunas. Esquerda vermelha (`AGUARDA VOCÊ · X`) indica fila urgente
2. Card mais antigo (parado há mais tempo aguardando você) no topo da coluna AGUARDA VOCÊ
3. Clica "Validar proposta IA →" → abre detalhe do card → decide → aprova/rejeita
4. Realtime move o card pra **EM AÇÃO** (Cockpit lançou no SSW)
5. Bastão confirma → card move pra **CONCLUÍDOS HOJE** OU some (TRANSFERIDO sem ser hoje)
6. Cliente respondeu → card aparece em **CLIENTE RESPONDEU** com sinal ✦ IA sugerindo oc
7. Operador "Responder cliente →" → abre tab resposta → envia → card move pra EM AÇÃO ou AGUARDA CLIENTE de novo

Fluxo **linear visual**: AGUARDA VOCÊ → EM AÇÃO → AGUARDA CLIENTE → CLIENTE RESPONDEU → EM AÇÃO → ... → CONCLUÍDOS HOJE.

A diferença pro PRIORIDADES AI: aqui o **estado do card é o eixo**, lá era a **escala de cobrança**. Mesmo padrão visual, semântica diferente.

---

## Resumo

| Antes | Depois |
|---|---|
| Lista vertical de cards encaixotados | **Kanban 5 colunas — linha de produção** |
| 3+ banners empilhados por card | **1 `SinalContextual` unificado** |
| Operador escolhe entre múltiplas ações | **1 CTA contextual por coluna** |
| Ordem confusa | **Mais antigo no topo de AGUARDA VOCÊ / CLIENTE RESP.** (urgência) |
| Status visual implícito | **Cor da coluna** indica urgência (vermelho → verde) |
| Cards com peso visual diferente | **Mesma família visual do PRIORIDADES AI** |

Reusa componentes (`KanbanColumn`, `SearchBar`, helpers `tempoStyle`, `nomeClienteCompleto`). Estende com `colunaInbox`, `proximaAcaoInbox`, `SinalContextual`. Zero mudança de backend.
