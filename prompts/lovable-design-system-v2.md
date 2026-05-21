# Lovable — Cockpit Design System 2.0 ("Operational Intelligence")

**Data:** 2026-05-23
**Escopo:** 100% visual. **NADA de mudança funcional, schema ou query.** Refator de UI/UX que aplica uma identidade visual nova e reorganiza a hierarquia/disposição dos elementos — em especial os emails. Mantém todos os comportamentos, eventos, RPCs, RLS, edges, banners de feedback IA, modais, atalhos. Não remove nem renomeia campo. Não mexe em endpoint. Não toca em Supabase.

**Mantra:** *cada pixel intencional, zero adorno gratuito.* Refinamento editorial + autoridade de terminal de inteligência operacional.

---

## 1. Direção estética

**Persona visual:** um terminal de inteligência operacional pra uma transportadora moderna. Lê como um **editorial de business intelligence** — não como um SaaS genérico. Confiança, precisão, calma. A "pegada tech" entra nos detalhes: dados em monoespaçada, microcaps tracking, sinalização de agente IA discreta mas inegavelmente presente.

**O que NÃO ser:**
- Sem gradientes roxo→pink. Sem glow neon. Sem "AI-generated SaaS aesthetic".
- Sem Inter, Roboto, Arial, Open Sans. Sem Material design clichê.
- Sem cards com sombra exagerada. Sem cantos super-arredondados.
- Sem dashboards com 8 widgets coloridos competindo.

**O que ser:**
- Off-white quente como base, ink quase-preto como tinta. Borders 1px finas. Espaço.
- Tipografia editorial: serifa moderna pra display + sans geométrica refinada pra body + mono pra dados.
- Cor de marca **só** em momentos de sinal (estado, ação primária, marcador de IA). O resto é cinza/ink. Como Anthropic, como Linear, como o relatório anual da Apple.
- Microinterações precisas (150-220ms ease) que reforçam a intenção, nunca distraem.

---

## 2. Tokens de design (Tailwind config + CSS variables)

Adicionar/atualizar `tailwind.config.ts` e o CSS global. Substituir tokens atuais — **não criar paralelo**, pra não dobrar o sistema.

### 2.1 Fontes

Adicionar no `index.html` (`<head>`) — Google Fonts:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Geist:wght@300;400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
```

CSS variables:

```css
:root {
  --font-display: "Fraunces", "Tiempos Headline", Georgia, serif;
  --font-body: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: "Geist Mono", "JetBrains Mono", "SF Mono", Menlo, monospace;
}
```

Uso:
- `font-display` → títulos de seção, NF em página de detalhe, números grandes, empty states decorativos. Serifa moderna, weight 500, **opsz** variable (deixar autoescala).
- `font-body` → tudo de UI: labels, parágrafos, botões, navegação.
- `font-mono` → NF, CTRC, chave_cte, IDs, datas técnicas, números de protocolo SSW. Letra-espaçamento ligeiramente apertado (`tracking-tight`).

### 2.2 Paleta

```css
:root {
  /* Superfícies */
  --bg: #FAFAF7;                /* off-white quente — base */
  --bg-elevated: #FFFFFF;       /* cards, modais, surface principal */
  --bg-subtle: #F4F2EC;         /* hover state, surfaces secundárias */
  --bg-muted: #ECEAE2;          /* divisores grossos, code blocks */

  /* Tinta */
  --ink: #0A0A0B;               /* texto principal, ícones primários */
  --ink-soft: #44423D;          /* texto secundário */
  --ink-mute: #8B8780;          /* labels, captions, placeholders */
  --ink-disabled: #C2BFB7;

  /* Bordas */
  --border: #E8E5DE;            /* divisores leves */
  --border-strong: #D4D0C7;     /* botões secundários, dropdowns */
  --border-focus: #0A0A0B;      /* focus ring com offset */

  /* Sinais semânticos */
  --signal: #0F4C5C;            /* azul-petróleo — accent primário/marca */
  --signal-soft: #E5EEF1;
  --signal-strong: #0A3640;

  --ai: #B45309;                /* amber editorial — IA / sugestão IA */
  --ai-soft: #FBF1DA;
  --ai-strong: #8C3F07;

  --positive: #166534;
  --positive-soft: #E2F1E5;

  --warning: #B45309;
  --warning-soft: #FBF1DA;

  --negative: #991B1B;
  --negative-soft: #F8E4E4;

  /* Foco / seleção */
  --ring: #0A0A0B33;
  --selection: #D9E5DE;
}

/* Dark mode opcional (data-theme="dark" no html) */
[data-theme="dark"] {
  --bg: #0A0A0B;
  --bg-elevated: #14141A;
  --bg-subtle: #1B1B22;
  --bg-muted: #23232B;
  --ink: #F4F2EC;
  --ink-soft: #B8B4AA;
  --ink-mute: #6E6A60;
  --ink-disabled: #3A3833;
  --border: #1F1F26;
  --border-strong: #2D2D36;
  --signal: #5BB5C6;
  --signal-soft: #133840;
  --ai: #F59E0B;
  --ai-soft: #3B2A0E;
  --positive: #4ADE80;
  --positive-soft: #14301D;
  --warning: #F59E0B;
  --warning-soft: #3B2A0E;
  --negative: #F87171;
  --negative-soft: #3B1717;
}
```

Mapeamento no `tailwind.config.ts`:

```ts
theme: {
  extend: {
    fontFamily: {
      display: ["var(--font-display)"],
      body: ["var(--font-body)"],
      mono: ["var(--font-mono)"],
    },
    colors: {
      bg: "var(--bg)",
      "bg-elevated": "var(--bg-elevated)",
      "bg-subtle": "var(--bg-subtle)",
      "bg-muted": "var(--bg-muted)",
      ink: "var(--ink)",
      "ink-soft": "var(--ink-soft)",
      "ink-mute": "var(--ink-mute)",
      "ink-disabled": "var(--ink-disabled)",
      border: "var(--border)",
      "border-strong": "var(--border-strong)",
      signal: "var(--signal)",
      "signal-soft": "var(--signal-soft)",
      "signal-strong": "var(--signal-strong)",
      ai: "var(--ai)",
      "ai-soft": "var(--ai-soft)",
      "ai-strong": "var(--ai-strong)",
      positive: "var(--positive)",
      "positive-soft": "var(--positive-soft)",
      warning: "var(--warning)",
      "warning-soft": "var(--warning-soft)",
      negative: "var(--negative)",
      "negative-soft": "var(--negative-soft)",
    },
    borderRadius: {
      none: "0",
      sm: "3px",
      DEFAULT: "5px",
      md: "6px",
      lg: "8px",
      xl: "12px",
      full: "9999px",
    },
    boxShadow: {
      none: "none",
      hairline: "0 0 0 1px var(--border)",
      "hairline-strong": "0 0 0 1px var(--border-strong)",
      sm: "0 1px 2px rgb(10 10 11 / 0.04)",
      md: "0 4px 12px -2px rgb(10 10 11 / 0.06), 0 0 0 1px var(--border)",
      focus: "0 0 0 3px var(--ring), 0 0 0 1px var(--border-focus)",
    },
    spacing: {
      // base 4px; nada de números arbitrários
    },
    fontSize: {
      // Editorial scale
      "micro": ["10px", { lineHeight: "1.3", letterSpacing: "0.08em" }],
      "label": ["11px", { lineHeight: "1.4", letterSpacing: "0.06em" }],
      "caption": ["12px", { lineHeight: "1.45" }],
      "body": ["14px", { lineHeight: "1.55" }],
      "body-lg": ["15px", { lineHeight: "1.6" }],
      "lead": ["17px", { lineHeight: "1.55" }],
      "h6": ["18px", { lineHeight: "1.4", letterSpacing: "-0.005em" }],
      "h5": ["22px", { lineHeight: "1.3", letterSpacing: "-0.01em" }],
      "h4": ["28px", { lineHeight: "1.2", letterSpacing: "-0.015em" }],
      "h3": ["34px", { lineHeight: "1.15", letterSpacing: "-0.02em" }],
      "h2": ["44px", { lineHeight: "1.1", letterSpacing: "-0.025em" }],
      "h1": ["56px", { lineHeight: "1.05", letterSpacing: "-0.03em" }],
    },
  },
},
```

### 2.3 Raio + sombras + grid

- **Raio padrão:** 5-6px. Cards 8px. Modais 12px. Chips 4px. Avatars/dots full. NUNCA mais que 12px.
- **Sombras:** prefira **hairline** (`shadow-hairline`) em vez de sombra suave em 90% dos casos. Sombra suave **só** em modais flutuantes e dropdowns.
- **Grid:** baseline 4px. Padding interno de card 20px (mobile 16px). Gap entre seções 32px. Container max-width: `min(1280px, 95vw)`.

---

## 3. Tipografia em uso (regras de aplicação)

| Onde | Família | Peso | Tamanho | Tratamento |
|---|---|---|---|---|
| Logotipo "COCKPIT" no header | display | 500 | 18px | All caps, tracking 0.18em |
| Headers de página ("Pendências AI") | display | 500 | h4 (28px) | tracking -0.015em |
| Subheader/eyebrow ("CARREGAMENTO ATIVO") | body | 500 | label (11px) | uppercase, tracking 0.08em, ink-mute |
| Empresa cliente no card | display | 500 | h6 (18px) | itálico optativo se >20 chars |
| NF, CTRC, chaves | mono | 500 | body-lg (15px) | tracking -0.01em |
| Texto de email/conteúdo | body | 400 | body-lg (15px) | max-width 680px |
| Labels de formulário | body | 500 | label (11px) | uppercase, tracking 0.06em, ink-mute |
| Botão primário | body | 500 | body (14px) | tracking 0 |
| Botões/links secundários | body | 500 | caption (12px) | tracking 0.02em |
| Timestamps relativos ("há 2h") | body | 400 | caption (12px) | ink-mute |
| Confiança IA "85%" | mono | 500 | label | tracking-tight |
| Numero decorativo empty state | display | 400 | 120px | opsz 144, opacity 0.08 |

---

## 4. Logotipo e elemento de marca

Substituir o logo atual (se for genérico) por uma marca textual + glyph minimalista:

```
   ◣
COCKPIT
```

O glyph é um quadrado preenchido inclinado (`◣` ou um SVG `<rect>` rotacionado 45° com gradiente diagonal sutil de `--signal` pro `--ink`). Acima do texto, alinhado à esquerda. Texto all caps `font-display` weight 500, tracking 0.18em. Hover: glyph rotaciona +90deg em 400ms.

Quando aparece sob "Sal Express" (em rodapés, login screen): `font-mono` 11px, ink-mute, tracking 0.2em, "POWERED BY SAL EXPRESS · OPERACIONAL · 2026".

---

## 5. Layout shell (App)

Substituir o shell atual mantendo todos os links/rotas existentes.

```
┌─────────────────────────────────────────────────────────────────────┐
│  ◣ COCKPIT     PENDÊNCIAS   AÇÃO EXECUTADA   AUDITORIA   ··· [LARISSA ▾] │  ← Top bar 56px, border-bottom hairline
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ▸ Eyebrow: "Centro operacional · 24 cards ativos · sincronizado às 14:32" │
│                                                                       │
│  ▸ H4 display: "Pendências AI"                                       │
│  ▸ Subline: "Cards aguardando sua validação"                          │
│                                                                       │
│  [ filtros como pílulas slim ]                                       │
│                                                                       │
│  ┌─ Lista (column tabular density) ────────────────────────────────┐ │
│  │ ...                                                              │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

- **Top bar:** background `--bg`, border-bottom hairline. Logotipo à esquerda. Nav central (links texto, font-body 14, weight 500). Avatar+dropdown à direita.
- **Nav link ativo:** sem underline. Pequeno dot (`--signal`) à esquerda do label, 4px diâmetro.
- **Nav link hover:** ink-soft → ink, sem decoração.
- **Eyebrow:** label style (11px uppercase tracking 0.08em ink-mute) com bullet separators.
- **Page title:** display 28px, margin-bottom 4px. Subline body-lg ink-soft.
- **Padding:** top 32px desktop, 24px mobile.

---

## 6. Lista de cards (Pendências, Auditoria, etc.)

**Antes:** provavelmente cards-bloco com sombra/raio grande.
**Depois:** **lista tabular editorial** — mais informação por scroll, hierarquia clara.

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                       │
│ ▸ Eyebrow micro: "OC=19 · FALTA DE VOLUMES · LARISSA"                 │
│                                                                       │
│ Cooperativa Agroindustrial Catarinense                               │ ← display, 18px
│ NF 29262  CTRC AMB220680-3                                           │ ← mono, ink-soft
│                                                                       │
│ ◐ Aguardando você há 5 dias · base AMB · risco alto                  │ ← body small, com dot/bullet
│                                                                       │
│ ┌─ pílula IA (se houver sugestão) ─────────────────────────────┐    │
│ │ ✦ Agente sugere oc=56 — operação revisa antes                │    │
│ └────────────────────────────────────────────────────────────────┘    │
│                                                                       │
│ ─────────────────────────────────────────────────────────────────── │ ← divisor hairline
```

- **Item:** sem card-box. Hairline-bottom divisor entre items. Padding-y 20px. Hover: bg muda pra `--bg-subtle` (150ms).
- **Eyebrow:** label style. Mostra contexto (oc, tipo, operador).
- **Display cliente:** `font-display` 18px. **Itálico** se a empresa tem >20 caracteres OU se está em status "atenção".
- **NF/CTRC:** mono ink-soft.
- **Stats line:** dot colorido (`--warning` se >3 dias, `--positive` se <1 dia, etc) + body 14 + bullets `·`.
- **Pílula IA:** background `--ai-soft`, border-left 2px `--ai`, padding 8/12, radius 4. Ícone `✦` (sparkle outline) cor `--ai`. Texto body 13. **Aparece apenas se** `analise_padrao_resultado` ou `analise_oc13_resultado` populado.

Click no item → vai pro detalhe do card (mesma rota atual).

**Filtros:** pílulas slim no topo da lista. Estado ativo bg `--ink`, text `--bg`. Inativo: border `--border-strong`, text `--ink-soft`. Radius 4. Padding 6/12. font-body 12 weight 500.

---

## 7. Card aberto (detalhe)

A página de detalhe é a mais densa. Layout em 3 zonas:

```
┌─────────────────────────────────────────────────────────────────────┐
│  ← Voltar pra lista                                                  │  ← link micro, breadcrumb-style
│                                                                       │
│  Eyebrow: "PENDÊNCIA · OC=19 · LARISSA"                              │
│                                                                       │
│  Cooperativa Agroindustrial Catarinense                              │  ← display 28px (h4)
│  NF 29262 · CTRC AMB220680-3 · base AMB                              │  ← mono ink-soft
│                                                                       │
│  ◐ Aguardando você há 5 dias                                          │
│                                                                       │
│  ─────────────────────────────────────────────────────────────────── │
│                                                                       │
│  [Banner IA — quando aplicável (ver seção 8)]                        │
│                                                                       │
│  ─────────────────────────────────────────────────────────────────── │
│                                                                       │
│  ╔ TABS HEADER ═══════════════════════════════════════════════════╗ │
│  ║  Mensagens · Propostas · Histórico SSW · Eventos ║              ║ │
│  ╚═══════════════════════════════════════════════════════════════╝ │
│                                                                       │
│  [Conteúdo da tab ativa]                                              │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

- **Voltar:** "← Voltar" font-body 12 weight 500 ink-mute. Hover ink. 8px gap entre seta e texto.
- **Eyebrow + título + meta:** mesma hierarquia da lista, ampliada.
- **Tabs:** font-body 13 weight 500. Inativo ink-mute. Ativo ink + underline 2px sólido `--ink` (pseudo-element). Hover ink-soft. Gap 28px entre tabs. Border-bottom hairline na linha da tab.
- **Conteúdo:** padding-top 24px.

---

## 8. Banners IA (padrão visual unificado)

Atualmente temos múltiplos banners IA pulverizados (oc=13 autônoma, ocs padrão, validar evidência, etc). Padronizar em **um único componente** com 5 variantes. **Sem perder semântica de nenhum.**

```tsx
<AiBanner
  variant="suggestion" | "autonomous" | "analyzing" | "failed" | "warning"
  title={string}
  description={string}
  metrics={Array<{ label: string, value: string }>}  // opcional
  primaryAction={{ label, onClick }}  // opcional
  secondaryAction={{ label, onClick }}  // opcional ("IA errou")
  rawResultado={analise_padrao_resultado | analise_oc13_resultado}  // pra modal feedback
/>
```

Layout do componente:

```
┌─────────────────────────────────────────────────────────────────────┐
│ ┃ ✦  AGENTE OPERACIONAL · RECOMENDAÇÃO                              │  ← label 11px tracking 0.08em
│ ┃                                                                    │
│ ┃ Lançar oc=56 — Operação revisa antes                              │  ← display 22px (h5)
│ ┃                                                                    │
│ ┃ Evidência incompleta — oc=19 sem ressalva manuscrita identificando│  ← body-lg ink-soft, max-width 680
│ ┃ volumes faltantes. Operação precisa revisar antes de notificar    │
│ ┃ o cliente.                                                         │
│ ┃                                                                    │
│ ┃ ┌─ Métricas (chips inline mono) ─────────────────────────┐        │
│ ┃ │ Confiança 85%  ·  Foto: sem ressalva  ·  GPS n/a       │        │
│ ┃ └────────────────────────────────────────────────────────┘        │
│ ┃                                                                    │
│ ┃ [⌐ IA errou]                              [Aprovar oc=56 sugerida]│
└─────────────────────────────────────────────────────────────────────┘
```

- **Border-left:** 3px sólida da cor do variant (signal pra suggestion, ai pra autonomous etc).
- **Background:** `--ai-soft` (suggestion/autonomous) ou `--bg-subtle` (analyzing/failed).
- **Padding:** 24px.
- **Radius:** 6px.
- **Ícone:** `✦` (sparkle) inline antes da eyebrow. Cor do variant.
- **Sem shadow.**
- **Title:** display 22 weight 500.
- **Description:** body-lg, max-width 680px pra legibilidade.
- **Métricas:** chips inline mono 12px com bullets `·` entre. Cor ink-soft.
- **Botão "IA errou":** ghost com ícone (lucide `X` ou `MessageSquareWarning`) + label "IA errou" + chevron. Cor ink-soft. Hover ink + bg muito sutil.
- **Botão primário:** ink filled. Direita.

Variantes:
- **suggestion** (cor signal): "Agente operacional · Recomendação"
- **autonomous** (cor ai): "Ação autônoma · Executada" — mostra ✓ ao invés de botão primário
- **analyzing** (cor signal-soft): "Agente analisando · X/3" — 3 dots animados (shimmer pulse 1.2s ease)
- **failed** (cor warning): "Agente falhou · Categoria" — botão "Tentar de novo" se aplicável
- **warning** (cor warning): "Atenção · Evidência incompleta" — pra casos como `evidencia_status='banner_amarelo'`

**Microinteração de entrada:**
```css
@keyframes ai-banner-in {
  0% { opacity: 0; transform: translateY(6px); }
  100% { opacity: 1; transform: translateY(0); }
}
.ai-banner { animation: ai-banner-in 280ms cubic-bezier(0.16, 1, 0.3, 1); }
```

**Microinteração "analyzing":**
```css
@keyframes ai-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}
.ai-pulse-dot { animation: ai-pulse 1.4s ease-in-out infinite; }
.ai-pulse-dot:nth-child(2) { animation-delay: 0.2s; }
.ai-pulse-dot:nth-child(3) { animation-delay: 0.4s; }
```

---

## 9. **EMAILS — refatoração visual completa**

Essa é a parte que o usuário pediu explicitamente pra ficar "mais parecido com email real". Reorganizar de cima a baixo. Inspiração: Gmail, Front, Hey.

### 9.1 Tab "Mensagens" do card

Substituir layout atual por **thread vertical estilo Gmail** + **composer inline pinned no rodapé**.

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                       │
│  3 mensagens nesta tratativa                                         │ ← label uppercase + counter
│  ─────────────────────────────────────────────────────────────────── │
│                                                                       │
│  ┌─ Mensagem 1 (operadora enviou — primeiro contato) ──────────────┐│
│  │                                                                   ││
│  │ (AS)  Larissa Souza  <larissa@salexpress.com.br>      há 5 dias  ││
│  │       Re: Falta de volumes NF 29262                              ││
│  │       Pra: logistica@cooperativa.com.br  ▾ (3 cc)                ││
│  │                                                                   ││
│  │       Prezados, identificamos uma divergência na entrega da NF   ││
│  │       29262 — o destinatário registrou falta de volumes...       ││
│  │                                                                   ││
│  │       ⎙ 1 anexo · nota_chrono.pdf (245 KB)                       ││
│  │                                                                   ││
│  │       [Ver completo]  [Responder]  [Encaminhar]                  ││
│  └───────────────────────────────────────────────────────────────────┘│
│                                                                       │
│  │ (linha vertical 1px ink-mute opacity 0.2 — conecta msgs)          │
│                                                                       │
│  ┌─ Mensagem 2 (cliente respondeu) ──────────────────────────────────┐│
│  │ (LO)  Logística Cooperativa <logistica@coop.com.br>   há 2 dias   ││
│  │       Re: Re: Falta de volumes NF 29262          ⏵ não lida 🔵    ││
│  │       Pra: larissa@salexpress.com.br                              ││
│  │                                                                   ││
│  │       Bom dia Larissa, conferimos aqui e realmente faltou 1...   ││
│  │       [...]                                                       ││
│  └───────────────────────────────────────────────────────────────────┘│
│                                                                       │
│  [Mensagem 3 — atual sendo composta — inline]                         │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

**Detalhes:**

- **Avatar circle:** 32px diâmetro. Background `--bg-subtle`, border hairline. Iniciais font-body 13 weight 500 ink. Operadora: bg `--signal-soft` text `--signal`. Cliente: bg `--bg-subtle` text `--ink-soft`.
- **Linha 1 do header:** Nome bold (body weight 500 ink) + email mono ink-mute small + timestamp à direita ink-mute.
- **Linha 2 (subject):** body-lg ink. Quando "não lida": dot `--signal` 6px à esquerda do subject.
- **Linha 3 (Pra/Cc):** label-style "Pra:" ink-mute + endereço ink-soft. Cc dropdown expansível ("▾ 3 cc") — click expande lista.
- **Corpo:** body-lg, max-width 680px, line-height 1.6, ink. Padding 20px. Preview de 3 linhas truncadas; click "Ver completo" expande.
- **Anexos:** chip com ícone `⎙` (paperclip), nome arquivo, tamanho. Click baixa.
- **Actions:** "Ver completo", "Responder", "Encaminhar" — ghost buttons 12px ink-soft. Aparecem no hover ou sempre? **Sempre visíveis**, mas opacity 0.5 até hover.
- **Linha vertical conectora:** 1px solid ink-mute opacity 0.15, position absolute esquerda, do final de uma msg até o início da próxima. Marcação visual de thread.
- **Não lida:** dot `--signal` 6px + bg do header dela `--signal-soft` muito sutil (4%).

### 9.2 Composer (responder cliente)

Em vez de modal: **composer inline expansivo no rodapé da tab Mensagens**. Quando colapsado, mostra só uma barra "Responder pra {remetente}". Quando aberto, expande pra ocupar 50vh.

```
┌─────────────────────────────────────────────────────────────────────┐
│  ▼ Responder pra Logística Cooperativa                               │ ← barra fixa, click expande
└─────────────────────────────────────────────────────────────────────┘

Expandido:

┌─────────────────────────────────────────────────────────────────────┐
│  Responder                                          [Recolher  ⌄]    │
│  ─────────────────────────────────────────────────────────────────── │
│                                                                       │
│  Pra      logistica@cooperativa.com.br                               │ ← campos slim, label esq
│  Cc       compras@cooperativa.com.br ✕  + adicionar                 │ ← chips ✕ pra remover
│  Assunto  Re: Falta de volumes NF 29262                              │
│  Template Falta de volume ▾                                          │ ← dropdown discreto
│                                                                       │
│  ─────────────────────────────────────────────────────────────────── │
│                                                                       │
│  Boa tarde,                                                          │
│                                                                       │
│  Recebemos sua confirmação sobre a falta de 1 volume na NF 29262...  │
│                                                                       │
│  [textarea autosize, max 50vh, min 200px]                            │
│                                                                       │
│  ─────────────────────────────────────────────────────────────────── │
│                                                                       │
│  ⎙ Anexar arquivo                            [Cancelar]  [Enviar →]  │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

**Detalhes:**

- **Barra colapsada:** background `--bg-subtle`, padding 14/20, radius 6, border hairline. Ícone chevron-down + texto "Responder pra {nome}".
- **Expandido:** background `--bg-elevated`, shadow-md, radius 8. Position sticky bottom 0.
- **Campos:** layout flexbox row. Label 60px width font-label uppercase 11px ink-mute tracking 0.06em. Input flex-1 border-bottom hairline (sem border full), bg transparent, focus → border-bottom 2px ink.
- **Chips de email Cc:** bg `--bg-subtle`, padding 4/8, radius 4, font-mono 12px ink + `✕` ink-mute hover ink. Click no `✕` remove. Botão "+ adicionar" ghost com plus icon.
- **Template dropdown:** ghost button com chevron, dropdown abre lista de templates ativos. Default pré-selecionado se `template_email_sugerido` IA existe. Mudança aciona repopulação do textarea (com confirm overlay se já editado).
- **Corpo textarea:** font-body 15px line-height 1.6, sem border, autosize, placeholder ink-mute. Pre-preenchido com `corpo_email_sugerido` da IA (se houver) — texto inserido com leve highlight `--ai-soft` que fade out em 2s (sinal visual "IA escreveu isso pra você").
- **Anexo:** botão ghost com ícone paperclip, abre input file. Anexos colocados ficam como chips abaixo do textarea.
- **Botão "Cancelar":** ghost ink-soft.
- **Botão "Enviar":** primary ink filled, com ícone `→`.
- **Anti-clique-duplo:** botão "Enviar" trava 30s pós-click + spinner inline (já é regra de backend — manter visual).

**Toda funcionalidade existente (`responder-email-cliente` RPC, `mensagem_origem_id`, `cc`, `anexos_ids`) é preservada — só muda visual.**

### 9.3 Quando a IA pré-popula

Visual de "texto gerado por IA":
- Quando o composer abre e tem `corpo_email_sugerido` IA, o textarea já vem com texto.
- O texto vem com background `--ai-soft` muito sutil (3% opacity). Após 2 segundos, fade out gradual pro normal (`--bg-elevated`).
- Eyebrow micro acima do textarea: "✦ Texto sugerido pelo agente — você pode editar livremente"
- Se operador editar, eyebrow muda pra "Texto editado por você"

---

## 10. Propostas (todos) — tab "Propostas"

Lista de cards-row. Não cards-box.

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                       │
│  Propostas pendentes (4)                                             │ ← label + counter
│  ─────────────────────────────────────────────────────────────────── │
│                                                                       │
│  ┌─ Proposta 1 (destacada IA) ───────────────────────────────────┐  │
│  │ ✦ Recomendado IA                                                │  │ ← micro label, cor ai
│  │                                                                 │  │
│  │ Lançar oc=56                                                    │  │ ← body-lg ink weight 500
│  │ Falta info operacional — Operação revisa antes de cliente       │  │ ← body ink-soft
│  │                                                                 │  │
│  │                                            [Aprovar]  [⋯ Mais] │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌─ Proposta 2 ──────────────────────────────────────────────────┐  │
│  │ Lançar oc=54 + email                                            │  │
│  │ Notificar pagador — FALTA_DE_VOLUME                             │  │
│  │                                            [Aprovar]  [⋯ Mais] │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ...                                                                  │
└─────────────────────────────────────────────────────────────────────┘
```

- **Box:** border hairline, radius 6, padding 20, bg `--bg-elevated`.
- **Destacada IA:** border-left 3px `--ai`, eyebrow "✦ Recomendado IA" cor `--ai`.
- **Botão "Aprovar":** primary ink, padding 8/16. Hover signal-strong.
- **Botão "⋯ Mais":** ghost, dropdown com "Ver detalhes", "Editar antes de aprovar", "Cancelar proposta".

---

## 11. Tab "Histórico SSW"

Timeline vertical de ocorrências. Cada item:

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                       │
│  Histórico SSW                          Atualizado há 12min · ⟳ Atualizar │
│  ─────────────────────────────────────────────────────────────────── │
│                                                                       │
│  ●  21·05·26  16:35   oc=01 ENTREGUE                                 │
│  │   silvadao @ APM                                                  │
│  │   Comprovante registrado · SEFAZ-MG · GPS (2.102m)                │
│  │   [Ver foto]                                                      │
│  │                                                                    │
│  ●  21·05·26  10:27   oc=19 ENTREGA COM FALTA DE VOLUMES             │
│  │   joao.don @ APM                                                  │
│  │   Comprovante anexado · 12/05/26 19:06                            │
│  │   [Ver foto]  [Reportar erro ⌐]                                   │
│  │                                                                    │
│  ●  ...                                                              │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

- **Marker:** dot 8px `--ink` (se importante: oc=01/14/etc cor `--positive`).
- **Linha vertical:** 1px ink-mute opacity 0.2 entre items.
- **Data:** mono 12px ink-mute. Formato `21·05·26  16:35` (bullets em vez de barras).
- **OC:** mono weight 500 ink, ex "oc=01" + space + descrição body ink.
- **Usuário/filial:** body 13 ink-mute, format "user @ FILIAL".
- **Instrução:** body 13 ink-soft truncada. Click "Ver mais" expande.
- **Actions inline:** ghost buttons pequenos.

---

## 12. Tab "Eventos" (card_events timeline)

Mesma estrutura do histórico SSW, com:
- Cor do dot por `actor_type`: agent (`--ai`), operator (`--signal`), system (`--ink-mute`).
- Texto `event_type` em mono weight 500.
- Payload em `<details>` expansível, formatado JSON com syntax highlighting (use `react-syntax-highlighter` se já estiver instalado; senão CSS simples com `--ink-soft` pra keys + `--signal-strong` pra strings).

---

## 13. Chips de estado (status)

Estados do card: `AGUARDANDO_AGENTE`, `AGUARDANDO_VALIDACAO_HUMANA`, `AGUARDANDO_CLIENTE`, etc.

```tsx
<StatusChip state={card.state} />
```

```
┌─────────────────────┐
│ ◐ AGUARDANDO VOCÊ   │  ← label style, uppercase, tracking 0.08em
└─────────────────────┘
```

Cor por estado (apply tone):
- `AGUARDANDO_AGENTE` → ink-mute (neutro)
- `AGUARDANDO_VALIDACAO_HUMANA` → signal
- `AGUARDANDO_CLIENTE` → warning
- `EXECUTANDO_ACAO` → signal (com animação pulse no dot)
- `ACAO_EXECUTADA` → positive
- `TRANSFERIDO` → ink-mute itálico
- `RESOLVIDO` → positive
- `CANCELADO` → negative

Style:
- Background `--{color}-soft` (super sutil)
- Text `--{color}`
- Border hairline `--{color}` opacity 30%
- Dot 6px à esquerda
- Padding 4/10, radius 4, font label 10px

---

## 14. Botões

3 variantes:

**Primary** (ações principais — Aprovar, Enviar, Salvar):
```
bg-ink text-bg hover:bg-ink-soft active:scale-[0.98]
padding 10/20, radius 6, font-body 13 weight 500
shadow-none, transition 150ms ease
```

**Secondary** (ações alternativas):
```
bg-transparent border border-border-strong text-ink hover:bg-bg-subtle
padding 10/20, radius 6, font-body 13 weight 500
```

**Ghost** (ações terciárias, inline):
```
bg-transparent text-ink-soft hover:text-ink hover:bg-bg-subtle
padding 6/12, radius 4, font-body 12 weight 500
```

**Destructive**: usa cor `--negative`, padrão primary mas vermelho.

**Loading state**: spinner `<svg>` 14px inline + label "Enviando…". Cursor wait. Disabled.

---

## 15. Modais

- **Background backdrop:** `bg-ink/40 backdrop-blur-sm`.
- **Modal box:** `max-w-[560px]`, `bg-bg-elevated`, `shadow-md`, `radius-xl` (12px), `padding-32`.
- **Header:** display 22px (h5) + close button no canto superior direito.
- **Body:** body-lg.
- **Footer actions:** flex-end, gap 12px, primary + secondary.

Modal "IA errou" (já existe no banner-oc13/ocs-padrao): aplicar esse template visual sem mudar campos/RPC.

---

## 16. Microinterações chave (resumo)

| Onde | Animação | Duração | Easing |
|---|---|---|---|
| Page load | Stagger fade-in + slide-up 8px nos 3 primeiros blocos | 240ms | cubic-bezier(0.16, 1, 0.3, 1) |
| Card row hover | bg-subtle | 150ms | ease |
| Botão press | scale 0.98 | 80ms | ease-out |
| AI banner appear | fade + slide up 6px | 280ms | cubic-bezier(0.16, 1, 0.3, 1) |
| "Analyzing" dots | opacity 0.3 → 1 alternado | 1.4s | ease-in-out infinite |
| Modal open | backdrop fade + modal scale 0.96 → 1 | 200ms | ease-out |
| Composer expand | height 0 → auto | 240ms | cubic-bezier(0.16, 1, 0.3, 1) |
| Tab switch | underline slide (Framer Motion `layoutId`) | 220ms | spring |
| Highlight IA text | bg ai-soft fade out → transparent | 2000ms (delay 100) | linear |

NÃO usar: bounce excessivo, easing elastic, scale ampliando >1.05, sombras coloridas, glow.

---

## 17. Empty states

Quando não há cards/mensagens/eventos:

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                       │
│                          ✦                                            │
│                                                                       │
│                        00                                             │ ← display 120px opacity 0.08
│                                                                       │
│              Sem pendências pra você no momento                       │ ← body-lg ink-soft
│              O agente está monitorando 24 cards em background         │ ← caption ink-mute
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

Numero decorativo gigante serif itálico opacity baixa = elegância. Texto secundário tranquilizador.

---

## 18. Login screen

Antes provavelmente form genérico Supabase Auth. Refazer:

```
┌──────────────────────────────────────────────┐
│ ◣ COCKPIT                                    │ ← canto superior esquerdo
│                                              │
│                                              │
│   Acesso operacional                         │ ← display 28px
│   Sal Express · 2026                         │ ← mono 12px ink-mute tracking 0.2em
│                                              │
│   ─────────────────────────────────────      │
│                                              │
│   EMAIL                                      │ ← label
│   [   larissa@salexpress.com.br    ]         │
│                                              │
│   SENHA                                      │
│   [   ••••••••••••••••              ]         │
│                                              │
│   [ Entrar →                       ]         │ ← primary full-width
│                                              │
│   Esqueci senha                              │ ← ghost link
│                                              │
└──────────────────────────────────────────────┘
```

- **Layout:** 2 colunas em desktop. Esquerda 60%: ilustração tipográfica grande ("COCKPIT" em display 200px ink, opacidade 0.04, posicionado bottom-left, decorativo). Direita 40%: form max-width 360px centrado.
- **Mobile:** 1 coluna, form centrado.
- **Fundo:** `--bg` puro.

---

## 19. Acessibilidade

- **Contraste:** ink-on-bg = 16.4:1 (AAA). ink-soft-on-bg = 8.2:1 (AAA). ink-mute-on-bg = 4.6:1 (AA large).
- **Focus visível:** `:focus-visible` aplica `shadow-focus` em todos elementos interativos.
- **Keyboard nav:** tabs respondem a Tab/Arrow keys. Modal fecha com Esc. Composer envia com Cmd/Ctrl+Enter.
- **Reduced motion:** `@media (prefers-reduced-motion: reduce)` desativa todas animações exceto opacity.
- **Screen reader:** `aria-label` em ícone-only buttons. `aria-live="polite"` no banner "analyzing".
- **Tipografia:** never below 12px na UI. Body 14-15px default.

---

## 20. **GUARDA-CHUVA — o que NÃO mexer**

Não tocar, não renomear, não remover:

- ✅ Nenhuma query Supabase. Nenhum `.from()`, `.rpc()`, `.functions.invoke()`.
- ✅ Nenhum nome de campo (`analise_padrao_status`, `aviso_alteracao_oc`, etc).
- ✅ Nenhuma rota.
- ✅ Nenhum prop dos componentes existentes que liga a backend (`card.id`, `card.nf`, etc).
- ✅ Realtime channels. Subscriptions. Filtros RLS.
- ✅ Botões com side-effect: a função `onClick` permanece a mesma; só o visual muda.
- ✅ Auth flow (Supabase Auth). Sessão. Refresh tokens.
- ✅ Validações de form (zod schemas, etc).
- ✅ Toasts (Sonner ou similar): mantém integração, só re-estiliza pra alinhar com a paleta.

---

## 21. Plano de execução pro Lovable

1. **Tokens primeiro.** Atualizar `tailwind.config.ts` + `src/index.css` (CSS variables). Adicionar `@import` de Google Fonts no `<head>`.
2. **Atomic components.** Criar/atualizar: `Button`, `Chip`, `StatusChip`, `Avatar`, `AiBanner`, `Tabs`, `Field`, `EmptyState`, `Card` (row), `Toolbar`.
3. **Refatorar shell.** Top bar + container + page header.
4. **Refatorar lista de cards** (Pendências, Auditoria, ACAO_EXECUTADA, Cliente Respondeu — todas usam a mesma row).
5. **Refatorar card aberto** (header + tabs).
6. **Tab Mensagens** com novo layout email + composer inline.
7. **Tab Propostas, Histórico SSW, Eventos** com timelines/lists.
8. **Empty states, login, modais.**
9. **Microinterações.**
10. **QA visual.** Confirmar que cada banner/modal/botão existente está renderizando — sem perder estado, sem perder ação.

Se alguma tela específica não estiver coberta neste prompt, **mantém o comportamento atual e aplica apenas os tokens novos (cores + fonts + radius + spacing)**.

---

## 22. Resumo do que muda

| Onde | O que muda |
|---|---|
| Tokens globais | Fontes Fraunces+Geist+Geist Mono, paleta off-white/ink/petróleo/amber, raio 6px, sombras hairline, tipografia editorial scale |
| Shell | Top bar slim com glyph + nav minimal, eyebrow microcaps + display heading |
| Lista de cards | Linha tabular editorial (sem card-box), divisores hairline, hover bg-subtle |
| Card aberto | Header em 3 linhas (eyebrow / display / meta) + tabs minimalistas + zonas claras |
| Banners IA | Componente único `<AiBanner>` com 5 variantes — refinado, ícone ✦, microinteração pulse |
| **Emails (tab Mensagens)** | **Thread vertical estilo Gmail + composer inline expansivo + indicação visual de texto IA-gerado** |
| Propostas | Rows com borda, destaque IA via border-left + eyebrow ✦ |
| Histórico SSW + Eventos | Timeline vertical com dots semânticos |
| Status chips | Label uppercase tracking, dot semântico, padrão único |
| Botões | 3 variantes (primary ink, secondary outline, ghost) |
| Modais | Backdrop blur + radius 12 + sem decorations |
| Login | Layout 60/40 com display gigante decorativo |
| Empty states | Numero serif gigante + texto refinado |

**Nada de funcional muda. Nenhum campo no Supabase. Nenhum endpoint. Nenhuma regra de RLS. Cada `onClick`, cada `useEffect`, cada hook permanece intacto — só estilos, classes, hierarquia e composição mudam.**

Se Lovable detectar que um componente atual está fazendo algo crítico (ex: chamando uma RPC ou ouvindo Realtime), **preserva 100% a lógica e só substitui o JSX/estilos**.
