# Lovable — Fix PRIORIDADES AI: cards minimalistas + dados claros

**Data:** 2026-05-23
**Escopo:** apenas frontend. Cards minimalistas (densos, leves, fluidos) seguindo design v3 Sal. Sem card-box pesado. Sem botões grandes. Sem múltiplas pílulas decorativas.

**Backend:** view `v_prioridades_ai` já retorna `cidade_destino` + `uf_destino` + `base_destino` + `empresa_cliente` (mig 155 em prod). Front só precisa consumir.

---

## Problema

Cards atuais estão grandes e robustos. Quero **linha tabular editorial enxuta** (estilo Linear / Notion / inbox Gmail) — todo cliente, NF, destino, status, IA e botões cabem em **3 linhas curtas**.

---

## Card minimalista — alvo final

```
─────────────────────────────────────────────────────────────────────────────
 ASTRA S/A. Indústria                       Curvelo · MG · CVL    1.2 dú · oc=21
 NF 2296843 · TKS404589-1                                    DUILIO
 ✦ Reincidente 2x/90d — primeiro contato hoje                [Coord] [Ger] [Rel]
─────────────────────────────────────────────────────────────────────────────
```

**Densidade alvo:** ~88px de altura por card (3 linhas + padding 16px topo/baixo).

### Linha 1 — cliente + destino + tempo/oc

```tsx
<div className="flex items-baseline justify-between gap-4">
  {/* Esquerda: nome cliente */}
  <h3 className="font-display font-semibold text-h6 text-ink truncate">
    {card.empresa_cliente || card.pagador_nome || (
      <span className="italic text-ink-mute">Cliente não identificado</span>
    )}
  </h3>

  {/* Direita: destino + tempo/oc (mono, ink-mute) */}
  <div className="flex items-baseline gap-3 text-caption font-mono text-ink-mute shrink-0">
    <LocalizacaoCompacta card={card} />
    <span>·</span>
    <span className={tempoColor(card.dias_uteis_parados)}>
      {formatDias(card.dias_uteis_parados)}
    </span>
    <span>·</span>
    <span className="text-ink">oc={card.oc_origem}</span>
  </div>
</div>
```

**`LocalizacaoCompacta`** — **BASE em destaque**, cidade/UF como complemento secundário:

```tsx
function LocalizacaoCompacta({ card }) {
  const base = card.base_destino;
  const cidade = card.cidade_destino;
  const uf = card.uf_destino;

  if (!base && !cidade && !uf) {
    return <span className="italic">destino n/d</span>;
  }

  // Dedup: se cidade == base (caso "BELO HORIZONTE"), mostra só uma vez
  const cidadeUf = [cidade, uf].filter(Boolean).join(' ');
  const cidadeIgualBase = base && cidade && cidade.toUpperCase() === base.toUpperCase();

  return (
    <span>
      {base && (
        <span className="font-semibold text-ink">{base}</span>
      )}
      {base && cidadeUf && !cidadeIgualBase && (
        <span className="text-ink-mute"> · </span>
      )}
      {!cidadeIgualBase && cidadeUf && (
        <span className="text-ink-mute">{cidadeUf}</span>
      )}
      {cidadeIgualBase && uf && (
        <span className="text-ink-mute"> · {uf}</span>
      )}
      {/* Se só tem cidade/UF sem base */}
      {!base && cidadeUf && (
        <span className="text-ink">{cidadeUf}</span>
      )}
    </span>
  );
}
```

**Resultado visual:**
- Tem tudo: `**CVL** · Curvelo MG` (base em negrito, resto cinza)
- Cidade = base: `**BELO HORIZONTE** · MG`
- Só base: `**CVL**`
- Só cidade+UF (sem base): `Curvelo MG` (cinza neutro)
- Nada: `destino n/d` (italic ink-mute)

A base sempre aparece em **font-semibold ink** quando disponível. Cidade e UF acompanham como contexto cinza.

**`tempoColor`**:
```ts
const tempoColor = (d: number) =>
  d > 3 ? 'text-signal font-semibold'    // urgente
  : d > 1 ? 'text-warning'                // atenção
  : 'text-ink-mute';                       // normal
```

**`formatDias`**:
```ts
const formatDias = (d: number) =>
  `${d.toFixed(1)} d${d === 1 ? 'ia' : 'ias'} úte${d === 1 ? 'il' : 'is'}`.replace('.0 ', ' ');
// 1.2 → "1.2 dias úteis", 1 → "1 dia útil"
```

### Linha 2 — NF/CTRC + operador

```tsx
<div className="flex items-baseline justify-between gap-4 mt-0.5">
  <p className="font-mono text-caption text-ink-soft tracking-tight truncate">
    NF {card.nf}{card.ctrc && <> · {card.ctrc}</>}
  </p>
  <p className="font-mono text-caption uppercase tracking-[0.06em] text-ink-mute shrink-0">
    {card.responsavel_relacionamento}
  </p>
</div>
```

### Linha 3 — IA (se houver) + botões inline

**Só renderiza se houver insight OU se precisar mostrar status de cobrança.** Se ambos vazios, omitir essa linha (card fica com 2 linhas só — mais minimalista ainda).

```tsx
<div className="flex items-center justify-between gap-4 mt-2">
  {/* Esquerda: insight IA OU status sutil */}
  <p className="text-caption text-ink-soft truncate min-w-0">
    {card.ia_insight ? (
      <>
        <span className="text-signal mr-1.5">✦</span>
        <span>{shortInsight(card.ia_insight)}</span>
      </>
    ) : (
      <span className="text-ink-mute">{labelCobrancas(card)}</span>
    )}
  </p>

  {/* Direita: botões cobrança ghost slim inline */}
  <div className="flex gap-1 shrink-0">
    <ChipBtn label="Coord" done={card.ja_cobrou_coordenador} onClick={() => abrirCobranca('coordenador_entrega', card)} />
    <ChipBtn label="Ger"   done={card.ja_cobrou_gerente_base} onClick={() => abrirCobranca('gerente_base', card)} />
    <ChipBtn label="Rel"   done={card.ja_cobrou_gerente_rel} onClick={() => abrirCobranca('gerente_relacionamento', card)} />
  </div>
</div>
```

**`shortInsight`** — pega só primeira frase, max 80 chars:
```ts
const shortInsight = (insight: any): string => {
  const raw = insight?.observacao_priorizador || insight?.proxima_acao_monitor || '';
  const firstSentence = raw.split(/[\.\n]/)[0]?.trim() || '';
  return firstSentence.length > 80 ? firstSentence.slice(0, 77) + '…' : firstSentence;
};
```

**`ChipBtn`** (botão ghost compacto):
```tsx
function ChipBtn({ label, done, onClick }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "text-caption font-medium px-2.5 py-1 rounded transition-colors",
        done
          ? "text-positive bg-positive-soft/50 cursor-default"
          : "text-ink-soft hover:text-ink hover:bg-bg-subtle"
      )}
    >
      {done && <span className="mr-1">✓</span>}
      {label}
    </button>
  );
}
```

**`labelCobrancas`**:
```ts
const labelCobrancas = (card) => {
  if (card.ja_cobrou_gerente_rel) return 'cobrou ger.relac.';
  if (card.ja_cobrou_gerente_base) return 'cobrou gerente';
  if (card.ja_cobrou_coordenador) return 'cobrou coord.';
  return 'sem cobrança';
};
```

---

## Wrapper do card — invisível, denso

```tsx
<article
  onClick={() => abrirCard(card.card_id)}
  className="group cursor-pointer px-5 py-4 border-b border-border hover:bg-bg-subtle transition-colors"
>
  {/* 3 linhas acima */}
</article>
```

**Detalhes do wrapper:**
- **Sem card-box flutuante** (sem border, sem radius, sem shadow). Só padding + hairline-bottom.
- Hover: `bg-bg-subtle` 150ms.
- Click no card = abre detalhe. Click no chip de cobrança = stop propagation + abre modal cobrança (mantém comportamento atual da plataforma).
- Cursor pointer no card todo.
- **Sem `/01`, `/02` numerados** — tira ruído visual. A urgência já vem pela cor do tempo (vermelho quando >3d) e pelo ordering (mais parados no topo).

---

## Layout da página

Header enxuto, igual padrão das outras abas:

```
┌────────────────────────────────────────────────────────────────────────┐
│  / 02 · CARGA EM TRATATIVA          Última sync há 12min · ⟳          │
│  Prioridades AI                                                         │
│  14 cards parados aguardando *cobrança*                                 │
│                                                                          │
│  [Todas bases ▾]  [Todas · oc=21 · oc=13]  [Todos · Email · WhatsApp]   │
│                                                                          │
│  ── card ──                                                              │
│  ── card ──                                                              │
│  ── card ──                                                              │
└────────────────────────────────────────────────────────────────────────┘
```

- Eyebrow signature "/ 02 · CARGA EM TRATATIVA" mono signal vermelho + ink-mute
- Sync status à direita do eyebrow (mono caption)
- Título display h4
- Subline body-lg ink-soft, **italic em "cobrança"**
- Filtros chips slim — `bg-ink text-bg` no ativo, ghost no inativo. Padding 6/12, radius 4.
- Lista flat (sem colunas kanban visíveis na primeira vista). Pra ver por coluna, o filtro "Todas" pode virar dropdown `[parada · cobrado · escalado · resolvido · Todos]`.

---

## Comparação visual antes / depois

**Antes (atual — robusto demais):**
- 7 linhas verticais por card
- Pílula IA com border-left destacado e bg colorido
- 3 botões grandes inline
- Card-box com border + radius + padding generoso
- ~200px altura por card

**Depois (alvo minimalista):**
- 2-3 linhas só
- IA aparece inline com ✦ vermelho + primeira frase
- Botões cobrança como chips slim (ghost) à direita
- Sem card-box: padding + hairline divisor
- ~88px altura por card
- Densidade ~2,3x maior na tela

---

## Tokens visuais — usar EXATAMENTE os do design v3

```
text-h6 / font-display / font-semibold   → nome cliente
font-mono / text-caption / ink-soft      → NF, CTRC, destino, tempo
text-caption / uppercase / tracking      → operador, eyebrows
text-signal (vermelho Sal)               → ✦ IA, eyebrow signature, tempo urgente
border-border + hover:bg-bg-subtle       → linha + hover
```

Nada novo. Tudo lê das CSS variables do v3.

---

## **NÃO QUEBRAR**

- Lógica de cobrança (`disparar-cobranca-escalonada` RPC) preservada — só visual dos botões muda
- Filtros funcionam com mesmos params
- Kanban status (`coluna_kanban`) continua na view e pode ser exposto via filtro dropdown
- Realtime sub continua igual
- Click no card abre detalhe (rota atual)

---

## Resumo

| Antes | Depois |
|---|---|
| Card-box border+radius+shadow | Hairline-bottom só, sem box |
| ~200px altura | ~88px altura |
| 7 linhas | 2-3 linhas |
| Pílula IA com bg + border | Inline ✦ + primeira frase |
| 3 botões inline grandes | 3 chips ghost slim |
| Numbering "/01", "/02" em cada card | Removido — urgência vem pela cor do tempo |
| Mostra "📍 —" quando vazio | Renderiza "Cidade · UF · CVL" com fallback "destino n/d" italic |

Densidade 2,3x maior, leitura 4x mais rápida, design 100% alinhado com o resto da plataforma Sal v3.
