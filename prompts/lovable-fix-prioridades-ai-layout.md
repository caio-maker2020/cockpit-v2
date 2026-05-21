# Lovable — PRIORIDADES AI · redesign editorial

**Data:** 2026-05-23
**Escopo:** 100% frontend. Refator do card e da página. Mantém TODA lógica (queries, RPCs, realtime, modais de cobrança).

**Backend:** view `v_prioridades_ai` retorna `empresa_cliente`, `cidade_destino`, `uf_destino`, `base_destino`, `responsavel_relacionamento`, `dias_uteis_parados`, `oc_origem`, `ia_insight`, `ja_cobrou_*`, `cobrancas_ciclo_atual_total`, `cobrancas_ciclos_anteriores_total`.

---

## Direção estética

Linha tabular **editorial-respirada**. Não é tabela compactada (densa demais) nem card-box flutuante (robusto demais). Pensar em **artigo de NYT mobile** ou **issue do Linear**: cliente como headline, metadados em deck refinado, ação primária destacada à direita.

**Princípios:**
- Cliente é o **headline** — sempre completo, sem truncate horizontal nunca. Se for longo, ocupa 2 linhas — não corta.
- Hierarquia rígida: 1 headline → 1 deck (mono caption) → 1 status line → 1 IA line opcional → 1 CTA.
- Ação primária = **PRÓXIMA cobrança da escala** (coord → gerente → relac.). UMA decisão clara, não 3 botões iguais.
- Outras ações ficam como links discretos (caso operador queira pular).
- Cor do tempo escala urgência. Não tem chip de status separado — a UI inteira reage.

---

## Card final

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                               │
│   ASTRA S/A. INDÚSTRIA E COMÉRCIO                                            │ ← cliente headline FULL WIDTH
│                                                                               │
│   NF 2296843 · TKS404589-1 · IPATINGA · Guanhães MG                          │ ← deck mono ink-soft
│                                                                               │
│   1.2 dias úteis parado    oc=21    DUILIO                                   │ ← status line caption
│                                                                               │
│   ✦  Reincidente 2x/90d — começar pelo coordenador hoje                      │ ← IA insight (se houver)
│                                                                               │
│                                          ┌───────────────────────────────┐  │
│                                          │  Cobrar coordenador     →     │  │ ← CTA primário ink filled
│                                          └───────────────────────────────┘  │
│                                                gerente   ·   ger.relac.     │ ← alt links ghost
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                  ← hairline divisor →
```

**Altura típica:** ~150px (4-5 linhas com respiração). Trade-off consciente: prefere clareza/produtividade vs densidade extrema. Cards densos demais confundem em decisão de cobrança.

### Detalhamento

#### Headline — cliente (linha 1)

```tsx
<h2 className="font-display font-semibold text-h5 text-ink leading-tight">
  {nomeClienteCompleto(card)}
</h2>
```

**`nomeClienteCompleto`** — sem truncate, sem `text-overflow`. Se >50 chars, wraps em 2 linhas:

```ts
const nomeClienteCompleto = (card) => {
  const nome = card.empresa_cliente?.trim() || card.pagador_nome?.trim();
  if (!nome) return <span className="italic text-ink-mute">Cliente não identificado</span>;
  return nome;
};
```

Sem `truncate`, sem `whitespace-nowrap`. Deixa o flex/grid quebrar naturalmente.

#### Deck — NF + CTRC + destino (linha 2)

```tsx
<p className="font-mono text-caption text-ink-soft tracking-tight mt-1.5">
  NF {card.nf}
  {card.ctrc && <> · {card.ctrc}</>}
  {' · '}
  <Localizacao card={card} />
</p>
```

**`Localizacao`** — base em destaque + cidade/UF complemento. Sem ícone. Sem "destino n/d" visível em deck (se falta tudo, omitir essa parte do deck):

```tsx
function Localizacao({ card }) {
  const base = card.base_destino;
  const cidade = card.cidade_destino;
  const uf = card.uf_destino;

  if (!base && !cidade && !uf) {
    return <span className="italic text-ink-mute">destino n/d</span>;
  }

  const cidadeUf = [cidade, uf].filter(Boolean).join(' ');
  const cidadeIgualBase = base && cidade && cidade.toUpperCase() === base.toUpperCase();

  return (
    <>
      {base && <span className="text-ink font-semibold">{base}</span>}
      {base && cidadeUf && !cidadeIgualBase && <> · </>}
      {!cidadeIgualBase && cidadeUf && <span>{cidadeUf}</span>}
      {cidadeIgualBase && uf && <> · {uf}</>}
      {!base && cidadeUf && <span>{cidadeUf}</span>}
    </>
  );
}
```

#### Status line — tempo + oc + operador (linha 3)

```tsx
<div className="flex items-center gap-6 mt-3 text-body">
  <span className={cn("font-mono", tempoStyle(card.dias_uteis_parados))}>
    {formatDias(card.dias_uteis_parados)} parado
  </span>
  <span className="font-mono text-ink-mute">oc={card.oc_origem}</span>
  <span className="font-mono uppercase tracking-[0.06em] text-caption text-ink-mute">
    {card.responsavel_relacionamento}
  </span>
</div>
```

```ts
const tempoStyle = (d: number) =>
  d > 3 ? 'text-signal font-semibold'    // urgente
  : d > 1 ? 'text-warning font-medium'    // atenção
  : 'text-ink-soft';                       // normal

const formatDias = (d: number) => {
  if (d < 1) return `${(d * 24).toFixed(0)}h`;          // <1d mostra em horas
  const r = d.toFixed(1).replace(/\.0$/, '');
  return `${r} dia${d >= 2 ? 's' : ''} útei${d >= 2 ? 's' : 'l'}`;
};
```

#### IA insight (linha 4 — opcional)

Só renderiza se `card.ia_insight` tem conteúdo OU se há contexto de ciclo anterior pra mostrar.

```tsx
{(card.ia_insight || card.cobrancas_ciclos_anteriores_total > 0) && (
  <p className="flex items-start gap-2.5 mt-3 text-body text-ink-soft leading-relaxed">
    <span className="text-signal text-h6 leading-none mt-0.5">✦</span>
    <span>
      {insightTexto(card)}
    </span>
  </p>
)}
```

```ts
function insightTexto(card) {
  // Prioridade: insight IA > contexto de ciclo anterior > nada
  if (card.ia_insight) {
    const raw = card.ia_insight.observacao_priorizador || card.ia_insight.proxima_acao_monitor || '';
    return firstSentence(raw, 120);
  }
  if (card.cobrancas_ciclos_anteriores_total > 0) {
    const c = card.cobrancas_ciclos_anteriores_total;
    return `Reincidente — ${c} cobrança${c > 1 ? 's' : ''} no ciclo anterior. Ciclo novo aberto, começar de novo.`;
  }
  return null;
}

const firstSentence = (txt: string, max: number) => {
  const f = txt.split(/[\.\n]/)[0]?.trim() || '';
  return f.length > max ? f.slice(0, max - 1) + '…' : f;
};
```

#### CTA — próxima cobrança da escala (linha 5)

```tsx
<div className="flex items-center justify-end gap-4 mt-4">
  {proximaAcao(card) ? (
    <>
      {/* Links alternativos à esquerda (escolha não-padrão) */}
      <div className="flex items-center gap-3 text-caption">
        {alternativas(card).map(alt => (
          <button
            key={alt.papel}
            onClick={(e) => { e.stopPropagation(); abrirCobranca(alt.papel, card); }}
            className="text-ink-mute hover:text-ink hover:underline underline-offset-4 transition-colors"
          >
            {alt.label}
          </button>
        )).reduce((acc, el, i, arr) => {
          acc.push(el);
          if (i < arr.length - 1) acc.push(<span key={`s${i}`} className="text-ink-mute">·</span>);
          return acc;
        }, [])}
      </div>

      {/* CTA primário à direita */}
      <button
        onClick={(e) => { e.stopPropagation(); abrirCobranca(proximaAcao(card).papel, card); }}
        className="group inline-flex items-center gap-2 bg-ink text-bg hover:bg-signal active:scale-[0.98] px-4 py-2 rounded-md text-body font-medium transition-all"
      >
        Cobrar {proximaAcao(card).label}
        <span className="transition-transform group-hover:translate-x-0.5">→</span>
      </button>
    </>
  ) : (
    <p className="text-caption text-ink-mute italic">
      Todas as escaladas já foram cobradas neste ciclo
    </p>
  )}
</div>
```

#### Lógica da próxima ação (escala determinística)

```ts
function proximaAcao(card) {
  if (card.ja_cobrou_gerente_rel) return null;  // topo da escala já cobrado
  if (card.ja_cobrou_gerente_base) return { papel: 'gerente_relacionamento', label: 'gerente de relacionamento' };
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
  // Mostra alternativas que NÃO são a próxima sugerida E que ainda não foram cobradas
  return todas.filter(alt => {
    if (alt.papel === proxima.papel) return false;
    if (alt.papel === 'coordenador_entrega' && card.ja_cobrou_coordenador) return false;
    if (alt.papel === 'gerente_base' && card.ja_cobrou_gerente_base) return false;
    if (alt.papel === 'gerente_relacionamento' && card.ja_cobrou_gerente_rel) return false;
    return true;
  });
}
```

**Visual da CTA:**
- Card "parada" (sem cobrança): `[Cobrar coordenador →]` + alts: `gerente · ger.relac.`
- Card "cobrado": `[Cobrar gerente da base →]` + alts: `ger.relac.` (coord já feito, ocultado)
- Card "escalado": `[Cobrar gerente de relacionamento →]` + alts: vazio
- Card "escalado_gerencia_interna": "Todas as escaladas já foram cobradas neste ciclo" (italic ink-mute)

---

## Wrapper do card

```tsx
<article
  onClick={() => abrirCard(card.card_id)}
  className="group cursor-pointer px-8 py-6 border-b border-border hover:bg-bg-subtle/60 transition-colors"
>
  {/* 5 blocos acima */}
</article>
```

**Detalhes:**
- Padding generoso (32px horizontal, 24px vertical) — respiração editorial.
- Border-bottom hairline. Sem box, sem shadow, sem radius no card.
- Hover: bg-subtle/60 (sutil, 150ms ease).
- Click no card: abre detalhe. Click no CTA / alts: `stopPropagation` + modal cobrança.

---

## Layout da página

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│  / 02 · CARGA EM TRATATIVA          Última sync há 12min · ⟳              │
│                                                                            │
│  Prioridades AI                                                            │
│  14 cards parados aguardando *cobrança*                                    │
│                                                                            │
│  ─────────────────────────────────────────────────────────────────────    │
│                                                                            │
│  [Todas bases ▾]   [oc=21 · oc=13 · Todas]   [parada · cobrado · esc...]   │
│                                                                            │
│  ── card respirado ──                                                      │
│  ── card respirado ──                                                      │
│  ── card respirado ──                                                      │
│                                                                            │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Container:** max-w-[1100px] mx-auto px-6
- **Filtros:** chips ghost slim, `bg-ink text-bg` ativo, `text-ink-soft hover:text-ink` inativo
- **Cards:** sem container interno — vão direto na coluna, hairline divisor entre

---

## Tokens (do design v3)

```
text-h5 / font-display / font-semibold         → cliente headline
font-mono / text-caption / ink-soft            → deck (NF, CTRC, destino)
font-mono / text-body / cor por tempoStyle()   → dias úteis
text-signal (vermelho Sal)                     → ✦ IA, urgente, hover primary
bg-ink → hover:bg-signal                       → CTA primário
border-border + hover:bg-bg-subtle/60          → divisor + hover sutil
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

## Resumo do redesign

| Antes (poluído) | Depois (editorial) |
|---|---|
| Cliente truncado | **Cliente full width, sem truncate (wraps se preciso)** |
| 3 botões cobrança iguais | **1 CTA primário (próxima escala) + 2 alts ghost** |
| Status em 5 lugares | 1 linha tabular limpa |
| IA em pílula box | inline ✦ + 1 frase |
| Layout simétrico confuso | Hierarquia editorial: headline → deck → meta → IA → CTA |
| Frankenstein visual | Editorial respirado, ~150px altura mas LIMPO |

A próxima ação fica **obviamente** clara — operador não decide entre 3 botões, decide se aceita a sugestão ou pula pra outra escala.
