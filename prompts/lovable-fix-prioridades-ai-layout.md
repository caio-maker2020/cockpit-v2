# Lovable — Fix urgente PRIORIDADES AI: layout consistente com INBOX + dados claros

**Data:** 2026-05-23
**Escopo:** apenas frontend, **CORREÇÃO** da aba PRIORIDADES AI. Mantém TODA funcionalidade existente — só ajusta o layout pra ficar idêntico ao da aba INBOX (que está limpo) e expor claramente Cliente / Cidade / Base.

**Backend:** view `v_prioridades_ai` já foi atualizada (mig 155) — agora retorna `cidade_destino`, `uf_destino`, `base_destino`, `empresa_cliente` em todos os cards. Front pode consumir direto.

---

## Problema reportado (Caio 2026-05-23)

1. Cards na aba PRIORIDADES AI mostram `(pin) —` no lugar da base/cidade (não consigo cobrar sem saber o destino)
2. Layout dos cards está **diferente** do da aba INBOX — quebra hierarquia visual + parece outra plataforma
3. Cliente, base e cidade precisam estar **claramente visíveis** em cada card

---

## Schema atualizado da view `v_prioridades_ai`

Campos novos disponíveis em cada row (já populados):

```ts
{
  card_id: string,
  nf: string,
  ctrc: string,
  empresa_cliente: string,       // ← NOME DO CLIENTE (ex: "ASTRA S/A. INDU A.")
  cidade_destino: string,        // ← CIDADE (ex: "CURVELO")
  uf_destino: string,            // ← UF (ex: "MG")
  base_destino: string,          // ← BASE/SIGLA (ex: "CVL" ou "BELO HORIZONTE")
  responsavel_relacionamento: string,  // ex: "DUILIO"
  pagador_nome: string,
  oc_origem: 21 | 13,
  dias_uteis_parados: number,
  coluna_kanban: 'parada' | 'cobrado' | 'escalado' | 'escalado_gerencia_interna' | 'resolvido',
  ia_insight: jsonb | null,
  ult_cobranca: { papel, canal, em } | null,
  ja_cobrou_coordenador: boolean,
  ja_cobrou_gerente_base: boolean,
  ja_cobrou_gerente_rel: boolean,
  // ... outros campos existentes
}
```

---

## Card de PRIORIDADES AI — REDESIGN

**Princípio:** idêntico ao card da aba INBOX (mesma família, mesma respiração, mesma hierarquia). Linha tabular editorial. Sem card-box flutuante exagerado.

```
┌───────────────────────────────────────────────────────────────────────────┐
│  / 01 · OC=21 · DUILIO                                  há 1.2 dias úteis │ ← eyebrow signature
│                                                                            │
│  ASTRA S/A. Indústria e Comércio                                          │ ← display 18px (nome cliente)
│  NF 2296843  CTRC TKS404589-1                                             │ ← mono ink-soft
│                                                                            │
│  📍 Curvelo · MG · base CVL                                                │ ← LOCALIZAÇÃO clara
│  ◐ parada · sem cobrança ainda                                             │ ← status kanban + cobranças
│                                                                            │
│  ┃ ✦ IA: 3.71 dias, OC=21, ASTRA reincidente (2x/90d). Primeiro contato   │ ← pílula IA (se houver)
│  ┃   deve ser feito hoje.                                                 │
│                                                                            │
│  [📞 Coord.]  [📨 Gerente Base]  [🚨 Ger. Relac.]                          │ ← botões cobrança
│                                                                            │
│  ──────────────────────────────────────────────────────────────────────── │ ← hairline divisor
```

### Detalhamento dos elementos

#### Eyebrow signature (linha 1)
```tsx
<div className="flex justify-between items-baseline text-label uppercase tracking-[0.08em] text-ink-mute">
  <span>
    <span className="text-signal">/ {indexNaLista.toString().padStart(2, '0')}</span>
    {' · '}
    <span>OC={card.oc_origem}</span>
    {' · '}
    <span>{card.responsavel_relacionamento}</span>
  </span>
  <span className="font-mono">
    há {card.dias_uteis_parados} {card.dias_uteis_parados === 1 ? 'dia' : 'dias'} útil{card.dias_uteis_parados !== 1 ? 'eis' : ''}
  </span>
</div>
```

Cores do tempo parado:
- ≤ 1 dia → ink-mute (normal)
- 1-3 dias → warning amber
- > 3 dias → signal vermelho (urgente)

#### Nome do cliente (linha 2 — DESTAQUE)
```tsx
<div className="font-display font-semibold text-h6 text-ink mt-1">
  {card.empresa_cliente}
</div>
```

Se `empresa_cliente` for null → mostra `pagador_nome`. Se ambos null → "Cliente não identificado" (cor ink-mute italic).

#### NF / CTRC (linha 3 — mono)
```tsx
<div className="font-mono text-body-lg text-ink-soft tracking-tight mt-0.5">
  NF {card.nf}{card.ctrc && <>  CTRC {card.ctrc}</>}
</div>
```

#### **Localização (linha 4 — sempre presente, NUNCA mostrar "—" sozinho)**

```tsx
<div className="flex items-center gap-2 text-body text-ink mt-3">
  <span className="text-ink-mute">📍</span>
  <span>
    {/* Lógica de fallback robusta */}
    {card.cidade_destino && (
      <span className="font-medium">{card.cidade_destino}</span>
    )}
    {card.cidade_destino && card.uf_destino && <span className="text-ink-mute"> · </span>}
    {card.uf_destino && (
      <span className="text-ink-mute font-mono text-caption">{card.uf_destino}</span>
    )}
    {card.base_destino && (
      <>
        {(card.cidade_destino || card.uf_destino) && <span className="text-ink-mute"> · </span>}
        <span className="text-ink-mute text-caption">base {card.base_destino}</span>
      </>
    )}
    {/* Fallback se NENHUM campo populado */}
    {!card.cidade_destino && !card.uf_destino && !card.base_destino && (
      <span className="text-ink-mute italic text-caption">Destino não identificado</span>
    )}
  </span>
</div>
```

**Resultado esperado:**
- Cidade + UF + Base: `📍 Curvelo · MG · base CVL`
- Só cidade + UF: `📍 Curvelo · MG`
- Só base: `📍 base CVL`
- Nada: `📍 Destino não identificado` (italic, ink-mute — sinal claro de problema)

**Nunca renderize `📍 —` ou pin solto sem texto.**

#### Status kanban (linha 5)
```tsx
<div className="flex items-center gap-2 text-body text-ink-soft mt-1">
  <StatusDot kanban={card.coluna_kanban} />  {/* dot colorido */}
  <span className="capitalize">{labelKanban(card.coluna_kanban)}</span>
  <span className="text-ink-mute">·</span>
  <span className="text-caption text-ink-mute">{labelCobrancas(card)}</span>
</div>
```

Mapping:
```ts
const LABEL_KANBAN = {
  parada: 'parada',
  cobrado: 'cobrado (coord)',
  escalado: 'escalado (gerente base)',
  escalado_gerencia_interna: 'escalado (ger. relac.)',
  resolvido: 'resolvido',
};
const STATUS_DOT_COLOR = {
  parada: 'bg-signal',
  cobrado: 'bg-warning',
  escalado: 'bg-warning',
  escalado_gerencia_interna: 'bg-signal',
  resolvido: 'bg-positive',
};

function labelCobrancas(card) {
  if (card.ja_cobrou_gerente_rel) return 'cobrou ger.relac.';
  if (card.ja_cobrou_gerente_base) return 'cobrou gerente';
  if (card.ja_cobrou_coordenador) return 'cobrou coord.';
  return 'sem cobrança ainda';
}
```

#### Pílula IA (linha 6 — só se houver insight)
```tsx
{card.ia_insight && (
  <div className="mt-3 border-l-[3px] border-signal bg-signal-soft/40 pl-4 py-2 rounded-r">
    <div className="flex items-start gap-2">
      <span className="text-signal mt-0.5">✦</span>
      <p className="text-body text-ink leading-relaxed">
        {card.ia_insight.observacao_priorizador || card.ia_insight.proxima_acao_monitor}
      </p>
    </div>
  </div>
)}
```

#### Botões de cobrança (linha 7)
```tsx
<div className="flex gap-2 mt-3">
  <CobrancaButton papel="coordenador_entrega" card={card} done={card.ja_cobrou_coordenador} />
  <CobrancaButton papel="gerente_base"        card={card} done={card.ja_cobrou_gerente_base} />
  <CobrancaButton papel="gerente_relacionamento" card={card} done={card.ja_cobrou_gerente_rel} />
</div>
```

`CobrancaButton`:
- `done=false`: secondary outline → "Coord." / "Gerente" / "Ger. Relac." (ghost ink)
- `done=true`: ghost com ✓ verde → "✓ Coord." (positive)
- Click: abre modal de cobrança (mantém comportamento atual, não muda)

---

## Layout da PÁGINA PRIORIDADES AI

Header alinhado com aba INBOX:

```
┌───────────────────────────────────────────────────────────────────────────┐
│  / 02 · CARGA EM TRATATIVA                  Última sync: há 12min  ⟳     │ ← eyebrow + sync status
│                                                                            │
│  Prioridades AI                                                            │ ← display h4
│  14 cards parados em oc=21/13 aguardando *cobrança*                       │ ← body-lg italic na palavra
│                                                                            │
│  ─────────────────────────────────────────────────────────────────────── │
│                                                                            │
│  [Todas bases ▾]  [oc=21 · oc=13 · Todas]  [Email · WhatsApp · Todos]    │ ← filtros chip slim
│                                                                            │
│  [coluna parada · coluna cobrado · coluna escalado · coluna resolvido]    │ ← kanban tabs OU lista plana
│                                                                            │
│  [card]                                                                    │
│  ─                                                                         │
│  [card]                                                                    │
│  ─                                                                         │
└───────────────────────────────────────────────────────────────────────────┘
```

**Importante:**
- **Mesma typography da INBOX** — display h4 pro título, body-lg ink-soft pra subline, eyebrow microcaps pro signature
- **Mesmo padding/spacing** da INBOX (top 36px desktop)
- Filtros usam mesmo chip style da INBOX (slim, hairline border, hover ink)
- Cards numerados "/ 01", "/ 02" em mono vermelho (signature Sal)

---

## **NÃO QUEBRAR**

- Toda lógica de cobrança (`disparar-cobranca-escalonada` RPC) preservada — só visual muda
- Filtros funcionam com os mesmos params atuais
- Kanban status reflete o mesmo `coluna_kanban` da view
- Realtime sub continua igual
- Botões de cobrança chamam mesmas funções
- Modal de cobrança continua o mesmo

---

## Resumo do fix

| Onde | O que muda |
|---|---|
| Card de PRIORIDADES AI | Layout reescrito 100% igual ao card da INBOX (eyebrow / display cliente / mono NF / localização clara / status / pílula IA / botões cobrança). Sem card-box flutuante. |
| Localização | Renderiza com fallback robusto: "Cidade · UF · base XXX" — nunca "—" solto |
| Header da página | Display h4 + subline com italic, eyebrow signature, sync status à direita |
| Filtros | Chips slim consistentes com INBOX |
| Tokens visuais | Mesmas variáveis CSS do design system v3 (cream warm, ink, vermelho Sal) — NADA novo |

Cole esse prompt no Lovable e o problema da NF 2296843, NF 1492103, NF 1494315 (todas com pin "—") resolve em 1 deploy. View já está corrigida em prod.
