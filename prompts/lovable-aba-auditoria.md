# Lovable — Aba AUDITORIA (snapshots de ações autônomas, read-only)

## Contexto

O Cockpit já tem 4 abas no menu principal:
- **INBOX** (mensagens)
- **PENDENCIAS** (kanban de cards ativos)
- **AUDITORIA** (existe vazia ou em planejamento — agora vamos popular)
- **CONFIGURACOES**

Caio acabou de implementar **ação autônoma**: cards com oc=10/11/35 sem foto SSW disparam oc=56 sozinhos. **O card primário continua movimentando normalmente** nas regras (TRANSFERIDO → AGUARDANDO_AGENTE → etc) e aparece no PENDENCIAS conforme o state.

**Para auditar a eficiência da automação**, no momento que dispara a ação autônoma, é criado um **SNAPSHOT congelado** numa tabela paralela `cards_auditoria`. A aba AUDITORIA mostra esses snapshots — visão imutável do estado no momento da decisão autônoma.

## Schema novo (já aplicado)

Tabela `cards_auditoria`:

```sql
id uuid PK
card_id_original uuid → cards.id  -- referência pro card vivo (info atual se quiser comparar)
motivo text                        -- ex: 'oc56_autonoma_sem_evidencia'
added_at timestamptz               -- quando foi pra auditoria
nf, ctrc, empresa_cliente, cod_ultima_ocorrencia, state_no_snapshot, cnpj_pagador
card_snapshot jsonb                -- cópia completa do card no momento
todos_snapshot jsonb               -- array com todos os todos no momento
events_snapshot jsonb              -- array com todos os card_events no momento
```

## O que implementar

### 1. Aba AUDITORIA — listagem

Query Supabase:
```ts
const { data, count } = await supabase
  .from('cards_auditoria')
  .select(`
    id, card_id_original, motivo, added_at,
    nf, empresa_cliente, cod_ultima_ocorrencia, state_no_snapshot
  `, { count: 'exact' })
  .order('added_at', { ascending: false })
  .limit(200);
```

Renderizar como **lista** (não kanban — é histórico). Cada item:
- NF + cliente
- Badge laranja "AUTÔNOMA" + motivo legível (ex: "Sem evidência na oc 35")
- State no momento do snapshot (ex: AGUARDANDO_AGENTE) + (opcional) state atual do card_id_original
- Quando entrou em auditoria (`added_at` formatado relativo: "há 2h")
- Botão "Ver snapshot →" abre painel lateral

### 2. Painel de snapshot — modo read-only

Ao clicar "Ver snapshot →", abre painel que renderiza dados do `card_snapshot`, `todos_snapshot`, `events_snapshot`. Reusa componente atual de detalhe de card mas alimentado pelos snapshots, **NÃO pelo card vivo**.

Mostrar:
- Header: "Snapshot AUDITORIA — {nf} — capturado em {added_at}"
- Badge fixo "MODO AUDITORIA — somente leitura"
- Banner explicativo: "Esta é uma cópia congelada do card no momento da ação autônoma. O card original (cards.id={card_id_original}) continua ativo no Cockpit conforme as regras."
- Dados do card (do `card_snapshot`)
- Timeline de events (do `events_snapshot`) — focar nos eventos `AcaoAutonomaSemEvidencia`, `SnapshotAuditoriaCriado`, `AcaoExecutada`
- Lista de todos (do `todos_snapshot`)

**Todos os botões de ação desabilitados/escondidos** — é cópia, não tem como agir.

Opcionalmente, link "Ver card atual →" que abre o card vivo (`cards.id = card_id_original`) na aba PENDENCIAS — útil pra comparar snapshot vs estado atual.

### 3. Filtros opcionais

- Por motivo: dropdown com valores distintos de `motivo`
- Por período: 24h / 7 dias / 30 dias / tudo
- Por state no snapshot

### 4. Métrica no topo (importante pro Caio acompanhar eficiência)

```
┌─────────────────────────────────────┐
│ Últimas 24h                         │
│ 12 cards em auditoria autônoma      │
│   • 8 sem evidência (oc=10/11/35)   │
└─────────────────────────────────────┘
```

Query:
```ts
const { count } = await supabase
  .from('cards_auditoria')
  .select('*', { count: 'exact', head: true })
  .gte('added_at', new Date(Date.now() - 24*60*60*1000).toISOString());
```

### 5. PENDENCIAS NÃO precisa filtro

O card primário continua aparecendo no PENDENCIAS conforme as regras normais (state=TRANSFERIDO some, state=AGUARDANDO_AGENTE aparece, etc). **Não filtrar nada por causa de auditoria** — a auditoria é uma cópia paralela, não interfere no fluxo principal.

---

## Layout esperado (ASCII)

```
┌─ AUDITORIA ───────────────────────────────────────────┐
│                                                         │
│ ┌──────────────────────────────────┐                   │
│ │ Últimas 24h                       │                   │
│ │ 12 snapshots em auditoria         │                   │
│ │   • 8 sem evidência               │                   │
│ └──────────────────────────────────┘                   │
│                                                         │
│ Filtros: [Motivo ▼] [Período ▼] [State ▼]            │
│                                                         │
│ ┌─────────────────────────────────────────────┐       │
│ │ NF 350898 — COM.CIRURGI.                    │       │
│ │ 🟠 AUTÔNOMA — Sem evidência na oc 35        │       │
│ │ State no snapshot: AGUARDANDO_AGENTE        │       │
│ │ Há 3h                       [Ver snapshot →]│       │
│ └─────────────────────────────────────────────┘       │
│                                                         │
│ ┌─────────────────────────────────────────────┐       │
│ │ NF 422476 — RIO CLARENSE                    │       │
│ │ 🟠 AUTÔNOMA — Sem evidência na oc 10        │       │
│ │ State no snapshot: AGUARDANDO_AGENTE        │       │
│ │ Há 1h                       [Ver snapshot →]│       │
│ └─────────────────────────────────────────────┘       │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

Painel snapshot (ao clicar):

```
┌─ Snapshot AUDITORIA — NF 350898 — capturado em 06/05 09:51 ┐
│ [MODO AUDITORIA — SOMENTE LEITURA]                          │
│                                                              │
│ ℹ️  Cópia congelada. Card original (id=…b0d4) continua      │
│    ativo no Cockpit. [Ver card atual →]                     │
│                                                              │
│ Cliente: COM.CIRURGI.                                       │
│ State no snapshot: AGUARDANDO_AGENTE                         │
│ oc origem: 35 (recusa parcial sem evidência)                 │
│ Motivo auditoria: oc56_autonoma_sem_evidencia                │
│                                                              │
│ TIMELINE (do events_snapshot)                                │
│ ─────────                                                    │
│ • BastaoCardImportado — 06/05 09:50                         │
│ • ChaveCteResolvida — 06/05 09:51                           │
│ • AcaoAutonomaSemEvidencia — 06/05 09:51                    │
│ • SnapshotAuditoriaCriado — 06/05 09:51                     │
│                                                              │
│ TO-DOS (do todos_snapshot)                                   │
│ ──────                                                       │
│ • pendente  Lançar oc 56 (autônomo)                          │
│                                                              │
│ [todos botões desabilitados/escondidos]                      │
└──────────────────────────────────────────────────────────────┘
```

---

## Resumo

1. Aba AUDITORIA lê de `cards_auditoria` (não de `cards`).
2. Cada linha = snapshot congelado. Painel renderiza dados dos campos `card_snapshot/todos_snapshot/events_snapshot`.
3. Card primário (cards.id = card_id_original) **continua normal no PENDENCIAS** — não filtrar.
4. Botão opcional "Ver card atual" abre o card vivo no PENDENCIAS pra comparar.
5. Sem mudança de schema — backend já aplicou migrations 058/059.
