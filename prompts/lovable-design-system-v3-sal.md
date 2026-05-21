# Lovable — Cockpit Design System 3.0 ("Sal Express · Logistics OS")

**Data:** 2026-05-23
**Substitui:** `lovable-design-system-v2.md` (versão anterior era editorial-serif neutro; essa é alinhada 100% à identidade visual da Sal Express).
**Escopo:** 100% visual. **NADA de mudança funcional, schema ou query.** Mantém todos os comportamentos, eventos, RPCs, RLS, edges, banners IA, modais, atalhos. Não toca em Supabase. Não toca em nenhum `onClick` / `useEffect` / hook.

**Mantra:** *é uma plataforma 100% Sal Express.* Quem bater o olho identifica imediatamente que é da Sal — não plataforma genérica de terceiros. Tipografia grotesca em bold, vermelho Sal como signal, preto cheio em momentos de impacto, cream warm como base. Pegada operacional + tech + autoridade de marca consolidada.

---

## 0. Referência visual canônica

Direção 100% baseada no site institucional `https://salexpress.com.br/` (PDF anexo "Sal Express — Movimento" enviado pelo Caio em 2026-05-23). **Antes de escrever qualquer CSS, abra o PDF e observe:**

- Tipografia: sans grotesca **bold/extrabold** com **itálico** dramático pra ênfase (ex: "*Move ES.*", "*caminhão.*", "*malha, transferência e tempo.*")
- Paleta: cream off-white quente como base + preto puro nos blocos de stats + **vermelho Sal saturado** (`#E11D2A` ou similar) como ÚNICO accent
- Eyebrow microcaps: "MANIFESTO · 02—07" / "STACK · 03/07" / "CLIENTE · 06/07" — sempre com numeração de seção e mono
- Cards "/ 01", "/ 02" etc com label categoria mono à direita (`AI/ML`, `API`, `SECOPS`, `OPS`...)
- Tipografia decorativa GIGANTE translúcida no fundo (ex: "MOV" cinza muito claro como background-art)
- Botões pretos com seta `→`
- Stats gigantes em fundo preto (`87.413`, `2.840.233`, `521.94`)

Essa é a linguagem. O Cockpit é **a versão operacional dessa marca** — mesma família visual, ajustada pra densidade de console interno.

---

## 1. Identidade da marca dentro do produto

### 1.1 Logo Sal Express

Substituir qualquer logo genérico atual por **a marca Sal Express oficial** (mesma do site institucional):

```
Sal·Express
```

- Tipografia: sans bold com ponto vermelho `•` como separador entre "Sal" e "Express"
- Implementação no Lovable: usar SVG inline ou request `https://salexpress.com.br/logo.svg` (ou Caio fornece o asset). Se Lovable não conseguir baixar, recriar com:

```tsx
<div className="flex items-center gap-0 font-display font-bold text-h6 leading-none">
  <span className="text-ink">Sal</span>
  <span className="text-signal mx-[0.08em] text-h4 leading-none">·</span>
  <span className="text-ink">Express</span>
</div>
```

- Tamanho default no header: 18px (logo top bar). Em login: 28px.
- Subtag opcional no header (apenas na top bar do Cockpit, micro size): `font-mono uppercase text-[10px] tracking-[0.2em] text-ink-mute` → "OPERACIONAL · COCKPIT"

A presença da marca Sal **tem que estar visível em pelo menos 3 superfícies da UI**: top bar (sempre), tela de login, e rodapé minimal de cada página principal. Empty states também ganham um glyph Sal discreto pra reforçar pertencimento.

### 1.2 Marcador "OS" / pegada de plataforma interna

Onde fizer sentido (rodapés, login), adicionar microcaps `v2026.05 · LOGISTICS OS` — espelha o footer do site institucional ("V2026.04 · LOGISTICS OS"). Reforça que esse Cockpit é **infraestrutura interna da Sal**, não SaaS terceiro.

---

## 2. Tokens de design

### 2.1 Fontes

Usar **Bricolage Grotesque** (variable, free no Google Fonts — tem display+body+italic em uma família, é a alma do visual do site Sal) + **JetBrains Mono** pra dados técnicos.

```html
<!-- index.html <head> -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300;12..96,400;12..96,500;12..96,600;12..96,700;12..96,800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```

CSS variables:

```css
:root {
  /* Bricolage Grotesque cobre display + body — pega o italic e o weight extra como hierarquia.
     É variable: ajustar opsz dependendo do tamanho usado. */
  --font-display: "Bricolage Grotesque", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-body: "Bricolage Grotesque", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono", "SF Mono", Menlo, monospace;
}
```

Uso:
- `font-display` weight 700-800, **itálico** pra ênfase (ex: status "RESOLVIDO", verbos de ação) — mesma vibe de "*Move ES.*"
- `font-display` weight 500 → títulos de seção, cliente do card, etc
- `font-body` weight 400 → texto de UI, parágrafos de email, descrição
- `font-mono` weight 400-500 → NF, CTRC, chaves, IDs, datas técnicas, eyebrows numéricos ("/01", "STACK · 03/07")

### 2.2 Paleta — **identidade Sal Express**

```css
:root {
  /* Superfícies — cream warm Sal */
  --bg: #F5F1EA;                /* off-white cream — base (matches site Sal) */
  --bg-elevated: #FFFFFF;       /* surfaces principais (cards de detalhe, modais) */
  --bg-subtle: #EEEAE0;         /* hover, surfaces secundárias */
  --bg-muted: #E5E0D3;          /* divisores grossos, code blocks */

  /* Tinta */
  --ink: #0A0A0B;               /* preto puro Sal */
  --ink-soft: #3A3833;          /* texto secundário */
  --ink-mute: #7A766E;          /* labels, captions, placeholders */
  --ink-disabled: #BDB9B0;

  /* Bordas */
  --border: #DDD7C9;            /* divisores leves, mais quente que neutro */
  --border-strong: #C5BEAE;     /* botões secundários */
  --border-focus: #0A0A0B;      /* focus ring */

  /* SIGNAL = vermelho Sal (único accent semântico forte) */
  --signal: #E11D2A;            /* vermelho Sal saturado — accent primário/marca */
  --signal-soft: #FDE9EB;       /* bg sutil pra eyebrows/chips signal */
  --signal-strong: #B81522;     /* hover, pressed states */

  /* AI = mantém o vermelho Sal — IA é parte intrínseca da marca, não secundária */
  /* Pra diferenciar visualmente um banner IA de uma ação primária, usamos a MESMA cor
     mas com TRATAMENTO distinto: borda esquerda 3px + bg-subtle. Não outra cor. */
  --ai: var(--signal);
  --ai-soft: var(--signal-soft);
  --ai-strong: var(--signal-strong);

  /* Estados semânticos secundários — quietos, neutros */
  --positive: #166534;          /* verde resolvido */
  --positive-soft: #E2F1E5;

  --warning: #B45309;           /* amber pra alertas neutros */
  --warning-soft: #FBF1DA;

  --negative: #991B1B;          /* vermelho mais escuro pra "destructive" — não confundir com signal */
  --negative-soft: #F8E4E4;

  --ring: #0A0A0B33;
  --selection: #FDE9EB;
}

/* Dark mode opcional (data-theme="dark" no html) */
[data-theme="dark"] {
  --bg: #0A0A0B;
  --bg-elevated: #14141A;
  --bg-subtle: #1B1B22;
  --bg-muted: #23232B;
  --ink: #F5F1EA;
  --ink-soft: #BFB9AA;
  --ink-mute: #7A766E;
  --ink-disabled: #3A3833;
  --border: #1F1F26;
  --border-strong: #2D2D36;
  --signal: #FF4555;            /* vermelho mais brilhante no dark */
  --signal-soft: #3B1014;
  --signal-strong: #FF6873;
  --ai: var(--signal);
  --ai-soft: var(--signal-soft);
  --ai-strong: var(--signal-strong);
  --positive: #4ADE80;
  --positive-soft: #14301D;
  --warning: #F59E0B;
  --warning-soft: #3B2A0E;
  --negative: #F87171;
  --negative-soft: #3B1717;
}
```

**Regra de uso do vermelho Sal:** vermelho é a marca. Use com PRECISÃO. Aparece em:
- Logo (ponto separador)
- Eyebrows de seção/contagem ("CARGA EM TRATATIVA", "/ 04")
- Status crítico ("EM ATRASO", "REPORTADO")
- Banner IA (apenas border-left + sparkle ✦ — NÃO encher de vermelho)
- Botão primário (filled preto, hover vermelho) OU ações destacadas
- Microacents (números de seção "/01", contagem ao vivo)

**Nunca** use vermelho em block solid de bg em mais de 1 superfície por viewport. Vermelho é pontuação, não pintura.

### 2.3 Tailwind config

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
      lg: "0 12px 32px -8px rgb(10 10 11 / 0.12), 0 0 0 1px var(--border)",
      focus: "0 0 0 3px var(--ring), 0 0 0 1px var(--border-focus)",
    },
    fontSize: {
      "micro": ["10px", { lineHeight: "1.3", letterSpacing: "0.1em" }],
      "label": ["11px", { lineHeight: "1.4", letterSpacing: "0.08em" }],
      "caption": ["12px", { lineHeight: "1.45" }],
      "body": ["14px", { lineHeight: "1.55" }],
      "body-lg": ["15px", { lineHeight: "1.6" }],
      "lead": ["17px", { lineHeight: "1.55" }],
      "h6": ["18px", { lineHeight: "1.3", letterSpacing: "-0.01em" }],
      "h5": ["22px", { lineHeight: "1.2", letterSpacing: "-0.015em" }],
      "h4": ["28px", { lineHeight: "1.1", letterSpacing: "-0.02em" }],
      "h3": ["36px", { lineHeight: "1.05", letterSpacing: "-0.025em" }],
      "h2": ["48px", { lineHeight: "1.0", letterSpacing: "-0.03em" }],
      "h1": ["64px", { lineHeight: "0.95", letterSpacing: "-0.035em" }],
    },
  },
},
```

### 2.4 Espaço, raios, sombras

- **Raio:** 5-6px default. Cards 8px. Modais 12px. **Botão pretão hero (estilo site Sal)** pode usar 8-10px pra dar peso. Chips 4-5px.
- **Sombras:** hairline default. Sombras suaves apenas em modais/dropdowns flutuantes.
- **Grid:** baseline 4px. Padding card 20-24px. Gap seções 32-40px. Container max-width `min(1280px, 95vw)`.

---

## 3. Tipografia em uso (regras de aplicação)

| Onde | Família | Peso | Tamanho | Tratamento |
|---|---|---|---|---|
| Logo "Sal·Express" header | display | 700 | 18px | ponto vermelho weight 800, leading-none |
| Eyebrow seção ("CARGA EM TRATATIVA · 24") | mono | 500 | label (11px) | uppercase, tracking 0.08em, ink-mute |
| Number stamp seção ("/ 04") | mono | 500 | caption (12px) | signal (vermelho) — assinatura visual Sal |
| Header de página ("Pendências AI") | display | 700 | h4 (28px) | tracking -0.02em |
| **Ênfase italic** ("*sua validação*") | display | 700 | em contexto | font-style italic — sinatura Sal |
| Empresa cliente no card | display | 600 | h6 (18px) | |
| NF, CTRC, chaves | mono | 500 | body-lg (15px) | tracking -0.01em |
| Texto de email/conteúdo | body | 400 | body-lg (15px) | max-width 680px, ink |
| Labels de formulário | mono | 500 | label (11px) | uppercase, tracking 0.08em, ink-mute |
| Botão primário | body | 600 | body (14px) | tracking 0 |
| Botões/links ghost | body | 500 | caption (12px) | tracking 0.02em |
| Timestamps ("há 2h") | body | 400 | caption (12px) | ink-mute |
| Confiança IA "85%" | mono | 500 | label | |
| Numero decorativo empty state | display | 700 | 140px | opacity 0.06 |

**Uso de italic** (dos pontos mais marcantes da marca Sal): em momentos editoriais — texto de ênfase, status decisivo, verbo de ação. Ex:
- "Aguardando *sua validação*" (italic na palavra-chave)
- Status "*RESOLVIDO*" / "*EM ATRASO*" no chip de estado (italic 600)
- Empty state: "Sem pendências *agora*."

Não abuse. 1-2 italics por bloco no máximo.

---

## 4. Layout shell

```
┌─────────────────────────────────────────────────────────────────────┐
│ Sal·Express  OPERACIONAL · COCKPIT                                  │ ← top bar 60px, border-bottom hairline
│              PENDÊNCIAS  AÇÃO EXECUTADA  AUDITORIA  INDICADORES  ⌄  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│ / 01 · CARGA EM TRATATIVA                                            │ ← mono signal + label
│                                                                       │
│ Pendências AI                                                        │ ← display h4 ink
│ 24 cards aguardando *sua* validação                                  │ ← body-lg ink-soft, italic na palavra
│                                                                       │
│ ─────────────────────────────────────────────────────────────────── │
│                                                                       │
│ [filtros chip-style]                                                  │
│                                                                       │
│ [lista]                                                              │
└─────────────────────────────────────────────────────────────────────┘
```

- **Top bar:** background `--bg`, border-bottom hairline. Logo Sal à esquerda + subtag mono "OPERACIONAL · COCKPIT" abaixo. Nav central (font-body 14 weight 500). Avatar+dropdown direita.
- **Nav link ativo:** sem underline. Dot vermelho `--signal` 4px à esquerda do label.
- **Eyebrow:** assinatura "/ NN · CATEGORIA" — número em vermelho `--signal`, categoria em mono ink-mute. **Esse é o "verso" da marca Sal dentro do produto.** Aparece no topo de cada page heading.
- **Page title:** display 28px, margin-bottom 4px.
- **Subline:** body-lg ink-soft. Quando houver ênfase, **usar italic** numa palavra (sinatura Sal).
- **Padding:** top 36px desktop, 24px mobile.

---

## 5. Lista de cards (Pendências, Auditoria, ACAO_EXECUTADA, Cliente Respondeu)

**Estilo:** linha tabular editorial — sem card-box. Hairline-bottom entre items. **Espaço pra respirar** (padding-y 20-24px).

```
┌──────────────────────────────────────────────────────────────────────┐
│ / 01    OC=19 · FALTA DE VOLUMES · LARISSA            há 5 dias      │
│                                                                       │
│ Cooperativa Agroindustrial Catarinense                              │ ← display h6 ink
│ NF 29262 · CTRC AMB220680-3                                         │ ← mono ink-soft
│                                                                       │
│ ◐ Aguardando você · base AMB · risco alto                            │
│                                                                       │
│ ┃ ✦ Agente sugere oc=56 — Operação revisa antes                     │ ← pílula IA border-left vermelho
│                                                                       │
│ ─────────────────────────────────────────────────────────────────── │ ← hairline
```

- **Item:** padding 20/0. Hover: bg → `--bg-subtle` (150ms ease).
- **Numbering "/ 01":** mono caption signal `--signal` weight 500 (assinatura Sal). Conta dentro da lista visível.
- **Eyebrow line:** "/ NN  OC=XX · DESC · OPERADOR" tudo mono label ink-mute, separado por `·`. Timestamp à direita.
- **Display cliente:** font-display weight 600, h6 (18px), ink.
- **NF/CTRC:** font-mono body-lg ink-soft, tracking-tight.
- **Stats line:** dot semântico (cor por status) + body 14 + bullets `·`.
- **Pílula IA:** **border-left 3px `--signal` (vermelho Sal)**, background `--signal-soft` (rosa muito sutil), padding 10/14, radius 4. Ícone `✦` cor `--signal` antes do texto. font-body 13 ink. **Aparece apenas se** card tem análise IA populada.

Click no item → vai pro detalhe (mesma rota atual, **não toca em routing**).

**Filtros:** chips slim no topo. Ativo: `bg-ink text-bg`. Inativo: `border border-border-strong text-ink-soft hover:text-ink`. Radius 4. Padding 6/12. font-body 12 weight 500.

---

## 6. Card aberto (detalhe) — header + tabs

```
┌─────────────────────────────────────────────────────────────────────┐
│ ←  Voltar pra lista                                                  │ ← link micro
│                                                                       │
│ / 04 · PENDÊNCIA · OC=19 · LARISSA                                   │ ← eyebrow signature
│                                                                       │
│ Cooperativa Agroindustrial Catarinense                               │ ← display h4 (28px)
│ NF 29262 · CTRC AMB220680-3 · base AMB                              │ ← mono ink-soft
│                                                                       │
│ ◐ Aguardando *você* há 5 dias                                       │ ← body-lg, italic em "você"
│                                                                       │
│ ─────────────────────────────────────────────────────────────────── │
│                                                                       │
│ [AI Banner — se aplicável]                                           │
│                                                                       │
│ ─────────────────────────────────────────────────────────────────── │
│                                                                       │
│ Mensagens   Propostas   Histórico SSW   Eventos                     │ ← tabs minimal
│ ▔▔▔▔▔▔▔▔                                                              │ ← underline 2px ink na ativa
│                                                                       │
│ [conteúdo]                                                            │
└─────────────────────────────────────────────────────────────────────┘
```

- **Voltar:** "← Voltar pra lista" font-body 12 weight 500 ink-mute. Hover ink.
- **Eyebrow signature** "/ NN · ...": sempre presente. Numeração local (posição na lista atual ou na fila).
- **Display heading:** display 28px weight 700. Linha 2 mono.
- **Status line:** italic na palavra chave + dot semântico colorido.
- **Tabs:** font-body 13 weight 500. Inativo ink-mute. Ativo ink + underline 2px sólido `--ink` pseudo-element. Hover ink-soft. Gap 32px. Border-bottom hairline na linha.

---

## 7. Banners IA (componente unificado)

Padronizar TODOS os banners IA atuais (oc=13 autônomo, ocs padrão, validar evidência, sugestão genérica) num componente único `<AiBanner>` com 5 variantes. Aparência alinhada à marca Sal.

```
┌─────────────────────────────────────────────────────────────────────┐
│ ┃ ✦ AGENTE OPERACIONAL · RECOMENDAÇÃO                  85% confiança│ ← eyebrow mono label
│ ┃                                                                    │
│ ┃ Lançar *oc=56*                                                    │ ← display h5 (22px), italic na oc
│ ┃ Operação revisa antes                                              │
│ ┃                                                                    │
│ ┃ Evidência incompleta — oc=19 sem ressalva manuscrita identificando│
│ ┃ volumes faltantes. Operação precisa revisar antes de notificar    │ ← body-lg ink-soft, max-width 680
│ ┃ o cliente.                                                         │
│ ┃                                                                    │
│ ┃ Foto: sem ressalva · GPS: n/a · Modelo: claude-sonnet-4-6         │ ← chips mono inline
│ ┃                                                                    │
│ ┃ [⌐ IA errou]                          [Aprovar oc=56 sugerida →] │
└─────────────────────────────────────────────────────────────────────┘
```

- **Border-left:** 3px sólida `--signal` (vermelho Sal).
- **Background:** `--signal-soft` muito sutil (suggestion/autonomous) OU `--bg-subtle` (analyzing/failed).
- **Padding:** 24px.
- **Radius:** 8px.
- **Ícone:** `✦` (sparkle) inline antes da eyebrow. Cor `--signal`.
- **Eyebrow:** mono label uppercase tracking 0.08em ink-mute. Confiança à direita, mono.
- **Title:** display h5 (22px) weight 700. **Italic** na palavra-chave (ex: "*oc=56*").
- **Description:** body-lg, max-width 680px.
- **Métricas:** chips mono 12px inline com bullets `·`. Cor ink-soft.
- **Botão "IA errou":** ghost ink-soft com ícone outline + label. Hover ink + bg `--bg-subtle`.
- **Botão primário:** bg `--ink` text `--bg`, padding 12/24, radius 6, com seta `→`. Hover bg `--signal` (vermelho — momento de marca). Active scale 0.98.

**Variantes:**
- **suggestion** (default): "AGENTE OPERACIONAL · RECOMENDAÇÃO"
- **autonomous**: "AÇÃO AUTÔNOMA · EXECUTADA" — sem botão primário, só ícone ✓ inline. Background `--bg-subtle`.
- **analyzing**: "AGENTE ANALISANDO · TENTATIVA X/3" — 3 dots pulsando ao lado do título. Background `--bg-subtle`.
- **failed**: "AGENTE FALHOU · {categoria}" — botão "Tentar novamente" se aplicável.
- **warning**: "ATENÇÃO · EVIDÊNCIA INCOMPLETA" (cor warning amber pra distinguir de signal).

**Microinteração de entrada:**
```css
@keyframes ai-banner-in {
  0% { opacity: 0; transform: translateY(8px); }
  100% { opacity: 1; transform: translateY(0); }
}
.ai-banner { animation: ai-banner-in 320ms cubic-bezier(0.16, 1, 0.3, 1); }
```

**Microinteração "analyzing":**
```css
@keyframes ai-pulse {
  0%, 100% { opacity: 0.25; }
  50% { opacity: 1; }
}
.ai-pulse-dot { animation: ai-pulse 1.4s ease-in-out infinite; background: var(--signal); width: 6px; height: 6px; border-radius: 9999px; }
.ai-pulse-dot:nth-child(2) { animation-delay: 0.2s; }
.ai-pulse-dot:nth-child(3) { animation-delay: 0.4s; }
```

---

## 8. **EMAILS — refatoração visual Gmail-like (parte crítica)**

Refazer **completamente** a apresentação de emails. Hoje está embolada e difícil de ler. Vamos pra **simulação Gmail-style** — clean, fluido, fácil de escanear.

### 8.1 Tab "Mensagens" do card — vista geral

Cada email = **card individual** colapsado por default (exceto o mais recente, que abre auto). Click no header expande o corpo.

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                       │
│ Conversa · 3 mensagens                              ⟳ Atualizar      │ ← label uppercase
│ ─────────────────────────────────────────────────────────────────── │
│                                                                       │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ (LS) Larissa Souza                                  21·05 14:32 │ │ ← header sempre visível
│ │      Re: Falta de volumes NF 29262                              │ │
│ │      Pra logistica@coop.com.br                                  │ │
│ │      ─ ─ ─ (clique pra expandir / collapse) ─ ─ ─               │ │ ← preview se colapsado
│ └──────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ (LO) Logística Cooperativa            21·05 16:48  ● não lida   │ │
│ │      Re: Re: Falta de volumes NF 29262                          │ │
│ │      Pra larissa@salexpress.com.br                              │ │
│ │                                                                  │ │
│ │      [Bom dia Larissa, conferimos aqui e realmente faltou 1    ]│ │ ← corpo expandido
│ │      [caixa do pedido. Pode prosseguir com a abertura de RPA  ]│ │
│ │      [conforme combinado.                                     ]│ │
│ │      [                                                        ]│ │
│ │      [Att, Bruno · Logística                                 ]│ │
│ │                                                                  │ │
│ │      ⎙ 1 anexo · romaneio_29262.pdf · 142 KB                    │ │
│ │                                                                  │ │
│ │      [Responder]  [Encaminhar]  ⋯                              │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│ ┌─ Composer (sticky bottom, colapsado) ──────────────────────────┐ │
│ │ ▾ Responder pra Logística Cooperativa                          │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

**Detalhes do header de cada email (sempre visível):**

```
┌─────────────────────────────────────────────────────────────────────┐
│ ┌──┐                                                                  │
│ │LS│  Larissa Souza  larissa@salexpress.com.br      21·05 14:32     │ ← linha 1
│ └──┘                                                                  │
│       Re: Falta de volumes NF 29262                                  │ ← linha 2 (subject)
│       Pra logistica@coop.com.br  ▾ (2 cc)                            │ ← linha 3
└─────────────────────────────────────────────────────────────────────┘
```

- **Avatar circle:** 36px diâmetro. Background depende do remetente:
  - Operadora Sal (Larissa, Duilio): bg `--signal-soft`, text `--signal`, border hairline (assinatura — destacar **nossa** equipe)
  - Cliente: bg `--bg-subtle`, text `--ink-soft`, border hairline
  - Iniciais 2 chars, font-body 13 weight 600, uppercase
- **Linha 1 (de):** Nome bold (body weight 600 ink) + 8px gap + email mono 12px ink-mute. Timestamp à direita: font-mono caption ink-mute, format "21·05 14:32" (com bullet entre data, igual ao histórico SSW).
- **Linha 2 (subject):** body-lg ink, weight 500. Se "não lida": dot `--signal` 6px à esquerda do subject + bg ligeiramente `--signal-soft` no header (1-2% opacity).
- **Linha 3 (Pra/Cc):** label mono uppercase "PRA" + endereço mono ink-soft. Cc dropdown expansível ("▾ 2 cc") — click expande lista vertical.

**Estado colapsado:**
- Mostra apenas header + preview 1-linha em ink-mute (primeiras ~80 chars do corpo). Click expande.

**Estado expandido:**
- Header completo + corpo (max-width 680px, body-lg, line-height 1.65, ink, padding-y 16px)
- Anexos como chips inline depois do corpo (ver 8.4)
- Actions inline: "Responder", "Encaminhar", "⋯ Mais" (ghost buttons 12px ink-soft, opacity 0.6 → 1 no hover)

**Linha vertical conectora entre emails:** 1px sólida `--border` rodando do final de uma msg até o início da próxima, do lado esquerdo (alinhada com o avatar). Não muito proeminente — só pista visual de "isso é uma thread".

**Não lida:** dot `--signal` 6px à esquerda do subject + label "● não lida" no header direito do email.

### 8.2 Composer (responder cliente) — Gmail-style sticky

**Sticky bottom**. Estado colapsado = barra slim. Estado expandido = composer completo até 60vh.

**Colapsado:**

```
┌─────────────────────────────────────────────────────────────────────┐
│ ▾  Responder pra Logística Cooperativa                              │
└─────────────────────────────────────────────────────────────────────┘
```

- Background `--bg-elevated`, border hairline-top, padding 14/20, sticky bottom. Click expande.

**Expandido:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  Responder                                       [⌄ Recolher] [✕]   │
│  ─────────────────────────────────────────────────────────────────── │
│                                                                       │
│  PRA       logistica@coop.com.br                                     │ ← campos slim
│  CC        compras@coop.com.br ✕   +adicionar                       │
│  ASSUNTO   Re: Falta de volumes NF 29262                             │
│  TEMPLATE  Falta de volume ▾                                         │
│                                                                       │
│  ─────────────────────────────────────────────────────────────────── │
│                                                                       │
│  ✦ Texto sugerido pelo agente — você pode editar livremente          │ ← micro eyebrow se IA
│                                                                       │
│  Boa tarde,                                                          │
│                                                                       │
│  Recebemos sua confirmação sobre a falta de 1 volume na NF 29262... │ ← textarea autosize
│                                                                       │
│  ─────────────────────────────────────────────────────────────────── │
│                                                                       │
│  ⎙ Anexar                            [Cancelar]  [Enviar →]          │
└─────────────────────────────────────────────────────────────────────┘
```

**Detalhes:**

- **Wrapper:** `bg-bg-elevated`, `shadow-lg`, `radius-xl` (12px) **só nos cantos superiores** (border-top-left/right). Border-bottom flush com edge. Position sticky bottom 0. Padding 24px.
- **Campos:** layout flex row. Label esquerda 80px width: **font-mono label uppercase 11px ink-mute tracking 0.08em**. Input flex-1 sem border full, com border-bottom hairline. Focus → border-bottom 2px `--ink`. Sem bg.
- **Chips de Cc:** font-mono 12px, bg `--bg-subtle`, padding 4/8, radius 4, com `✕` ink-mute. Hover do `✕`: ink. Click remove.
- **Botão "+adicionar":** ghost ink-soft com plus icon. Hover ink + bg `--bg-subtle`.
- **Template dropdown:** ghost button com chevron, dropdown abre lista. Default pré-selecionado se `template_email_sugerido` IA. Mudança aciona repopulação do textarea (com confirm overlay se já editado).
- **Eyebrow IA:** **só aparece se** corpo vem da IA (campo `corpo_email_sugerido` IA). Mono micro 10px tracking 0.1em ink-mute com ✦ vermelho. Texto: "✦ Texto sugerido pelo agente — você pode editar livremente". Quando operador começa a editar (qualquer keystroke), eyebrow muda pra "Texto editado por você" (sem ✦).
- **Textarea:** font-body 15px line-height 1.65, sem border, autosize (min 200px, max 50vh), placeholder ink-mute. Pre-preenchido com `corpo_email_sugerido` se IA tem sugestão. Highlight `--signal-soft` muito sutil (3% opacity) que fade out em 2s pós-render (sinal "IA escreveu isso pra você").
- **Anexo:** ghost button "⎙ Anexar" abre input file. Anexos colocados ficam como chips logo abaixo do textarea (mesmo estilo dos chips de Cc, com tamanho do arquivo em mono).
- **Botões footer:**
  - "Cancelar": ghost ink-soft. Confirma com modal se há rascunho.
  - "Enviar →": **primary ink filled, hover signal vermelho** (momento de marca). 12/24 padding, radius 6, font-body 14 weight 600, seta `→`. Anti-clique-duplo: trava 30s pós-click + spinner inline.
- **Atalhos:** Cmd/Ctrl+Enter envia. Esc colapsa (com confirm se rascunho).

**Toda funcionalidade existente (`responder-email-cliente` RPC, `mensagem_origem_id`, `cc`, `anexos_ids`) preservada — só o visual muda.**

### 8.3 Quando IA pré-popula (visual signal)

- Corpo textarea aberto com `corpo_email_sugerido` IA.
- Highlight `--signal-soft` 3% no bg do textarea, anima fade out em 2000ms linear.
- Eyebrow micro com ✦ vermelho acima do textarea.
- Quando operador edita: eyebrow muda. Conta como decisão informada.

### 8.4 Anexos — chip style

```
⎙  romaneio_29262.pdf   142 KB   ↓
```

- Chip retangular, radius 4, border hairline, padding 8/12.
- Ícone `⎙` cor ink-mute.
- Nome do arquivo: font-body 13 ink, truncate em 40 chars.
- Tamanho: font-mono 11px ink-mute.
- Botão `↓` (download): ghost ink-soft → ink no hover.
- Anexos do operador (sendo enviados): bg `--signal-soft` border `--signal` opacity 30% — sinal Sal.
- Anexos inbound (do cliente): bg `--bg-subtle`.

---

## 9. Propostas (tab "Propostas")

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                       │
│ Propostas pendentes  / 4                                             │ ← label + numbering signal
│ ─────────────────────────────────────────────────────────────────── │
│                                                                       │
│ ┌───────────────────────────────────────────────────────────────┐  │
│ │ ┃ ✦ RECOMENDADO IA                              85% confiança │  │ ← border-left signal
│ │ ┃                                                              │  │
│ │ ┃ Lançar *oc=56*                                              │  │ ← display h6 italic
│ │ ┃ Falta info operacional — Operação revisa antes de cliente   │  │
│ │ ┃                                                              │  │
│ │ ┃                                  [Aprovar →]  [⋯ Mais]      │  │
│ └───────────────────────────────────────────────────────────────┘  │
│                                                                       │
│ ┌─ Proposta 2 (normal) ───────────────────────────────────────────┐  │
│ │ Lançar oc=54 + email                                            │  │
│ │ Notificar pagador — FALTA_DE_VOLUME                             │  │
│ │                                                                 │  │
│ │                                     [Aprovar →]  [⋯ Mais]      │  │
│ └─────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

- **Box:** border hairline, radius 6, padding 20, bg `--bg-elevated`.
- **Destacada IA:** border-left 3px `--signal`, eyebrow "✦ RECOMENDADO IA" mono label signal + confiança mono direita.
- **Title:** display h6 weight 600. Italic na oc (ex: "*oc=56*").
- **Description:** body ink-soft.
- **Botão "Aprovar →":** primary ink, com seta. Hover `--signal`.
- **Botão "⋯ Mais":** ghost dropdown.

---

## 10. Histórico SSW + Eventos (timelines)

Timeline vertical com marcador semântico.

```
●  21·05·26  16:35   oc=01 ENTREGUE
│   silvadao @ APM
│   Comprovante registrado · SEFAZ-MG · GPS (2.102m)
│   [Ver foto]
│
●  21·05·26  10:27   oc=19 ENTREGA COM FALTA DE VOLUMES
│   joao.don @ APM
│   Comprovante anexado · 12/05/26 19:06
│   [Ver foto]  [Reportar erro]
│
```

- **Marker:** dot 8px. Ocorrências importantes (oc=01/14): `--positive`. Default: `--ink`. Erros (reportados): `--signal`.
- **Linha vertical:** 1px `--border` entre items.
- **Data:** mono 12px ink-mute, format `21·05·26  16:35` (bullets em vez de barras — assinatura Sal).
- **OC:** font-mono weight 500 ink, ex "oc=01" + space + descrição body ink.
- **User/filial:** body 13 ink-mute, "user @ FILIAL".
- **Instrução:** body 13 ink-soft truncada. Click "Ver mais" expande.
- **Actions inline:** ghost buttons 12px.

**Eventos** segue mesma estrutura. Cor do dot por `actor_type`:
- agent → `--signal` (vermelho — momentos de IA agem)
- operator → `--ink`
- system → `--ink-mute`

Texto `event_type` em mono weight 500. Payload em `<details>` expansível JSON.

---

## 11. Status chips (estados do card)

```tsx
<StatusChip state={card.state} />
```

```
┌─────────────────────────┐
│ ◐ AGUARDANDO VOCÊ       │  ← label uppercase tracking 0.08em
└─────────────────────────┘
```

Cor por estado:
- `AGUARDANDO_AGENTE` → ink-mute (neutro)
- `AGUARDANDO_VALIDACAO_HUMANA` → signal (vermelho Sal — momento de ação humana)
- `AGUARDANDO_CLIENTE` → warning
- `EXECUTANDO_ACAO` → signal com pulse no dot
- `ACAO_EXECUTADA` → positive
- `TRANSFERIDO` → ink-mute italic ("*transferido*")
- `RESOLVIDO` → positive italic ("*resolvido*")
- `CANCELADO` → negative

Style:
- bg `--{color}-soft` muito sutil
- text `--{color}`
- border hairline `--{color}` 30% opacity
- dot 6px à esquerda
- padding 4/10, radius 4, font-mono label 10px

**Italics em "RESOLVIDO" / "TRANSFERIDO":** assinatura Sal.

---

## 12. Botões

**Primary (ações principais):**
```
bg-ink text-bg
hover:bg-signal           ← hover muda pra vermelho (momento de marca)
active:scale-[0.98]
padding 12/24, radius 6, font-body 14 weight 600
shadow-none, transition 150ms ease
seta → no final quando aplicável
```

**Secondary:**
```
bg-transparent border border-border-strong text-ink
hover:bg-bg-subtle hover:border-ink
padding 12/24, radius 6, font-body 14 weight 500
```

**Ghost:**
```
bg-transparent text-ink-soft
hover:text-ink hover:bg-bg-subtle
padding 6/12, radius 4, font-body 12 weight 500
```

**Destructive:** primary vermelho `--negative` (vermelho mais escuro, não o signal).

**Loading:** spinner inline 14px + "Enviando…". Cursor wait.

---

## 13. Modais

- **Backdrop:** `bg-ink/40 backdrop-blur-sm`.
- **Modal:** `max-w-[560px]`, `bg-bg-elevated`, `shadow-lg`, `radius-xl` (12px), padding 32.
- **Header:** display 22px weight 700 + close button canto sup direito.
- **Body:** body-lg.
- **Footer:** flex-end, gap 12px, primary + secondary.

Modal "IA errou" (oc=13/ocs padrão): aplicar esse template visual sem alterar campos/RPC. Botão envio primary preto → vermelho hover.

---

## 14. Microinterações

| Onde | Animação | Duração | Easing |
|---|---|---|---|
| Page load | stagger fade+slide-up 8px nos 3 primeiros blocos | 280ms | cubic-bezier(0.16, 1, 0.3, 1) |
| Card row hover | bg-subtle | 150ms | ease |
| Email expand/collapse | height 0 → auto + opacity | 240ms | cubic-bezier(0.16, 1, 0.3, 1) |
| Composer expand | height + slide | 260ms | cubic-bezier(0.16, 1, 0.3, 1) |
| Botão press | scale 0.98 | 80ms | ease-out |
| AI banner appear | fade + slide 8px | 320ms | cubic-bezier(0.16, 1, 0.3, 1) |
| Analyzing dots | opacity 0.25 → 1 alternado | 1.4s | ease-in-out infinite |
| Modal open | backdrop fade + scale 0.96→1 | 200ms | ease-out |
| Tab switch | underline slide (Framer `layoutId`) | 220ms | spring(stiffness:400, damping:30) |
| Highlight IA text | bg signal-soft fade out → transparent | 2000ms (delay 100) | linear |
| Logo hover | ponto vermelho pulse opacity 1 → 0.6 → 1 | 600ms | ease-in-out |

NÃO usar: bounce, elastic, scale >1.05, sombras coloridas (glow vermelho atrai mais que ajuda), parallax.

---

## 15. Empty states (signature Sal)

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                       │
│                            ✦                                          │
│                                                                       │
│                          /00                                          │ ← mono signal 80px opacity 0.3
│                                                                       │
│                  Sem pendências *agora*.                              │ ← display h5 italic
│              O agente está monitorando 24 cards em background.        │ ← body ink-mute
│                                                                       │
│                          Sal·Express                                  │ ← logo discreto opacity 0.4
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

- Numero "/00" mono signal opacity 0.3 80px — assinatura visual Sal.
- Frase com **italic** na palavra-chave.
- Logo Sal discreto no rodapé do empty state — reforça que é nossa plataforma.

---

## 16. Login screen

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                       │
│ Sal·Express                                          v2026.05 · OS    │ ← top bar slim
│                                                                       │
│                                                                       │
│            ╔══════════════════════════════════════════╗               │
│            ║                                          ║               │
│            ║  / 01 · OPERACIONAL                      ║               │ ← signature mono signal
│            ║                                          ║               │
│            ║  Acesso *Cockpit*                        ║               │ ← display h3 italic
│            ║  Time de Relacionamento · Sal Express    ║               │ ← body ink-soft
│            ║                                          ║               │
│            ║  ────────────────────────────────────    ║               │
│            ║                                          ║               │
│            ║  EMAIL                                   ║               │ ← mono label
│            ║  [   larissa@salexpress.com.br   ]       ║               │
│            ║                                          ║               │
│            ║  SENHA                                   ║               │
│            ║  [   ••••••••••••••••           ]       ║               │
│            ║                                          ║               │
│            ║  [ Entrar  →                    ]        ║               │ ← primary full-width
│            ║                                          ║               │
│            ║  Esqueci senha                           ║               │
│            ║                                          ║               │
│            ╚══════════════════════════════════════════╝               │
│                                                                       │
│  ┌─ background art ─────────────────────────────────────────────┐   │
│  │                                                                │   │
│  │  COCKPIT                                                       │   │ ← display weight 800 200px
│  │                                                                │   │   opacity 0.04 bottom-left
│  └────────────────────────────────────────────────────────────────┘   │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

- **2 colunas desktop:** esquerda 55% com background art (tipografia gigante decorativa), direita 45% com form max-width 380px centrado vertical.
- **Mobile:** 1 coluna, form centrado.
- **Background art:** texto "COCKPIT" em display weight 800 200px, ink opacity 0.04, posicionado bottom-left absoluto. Decorativo, evocando os títulos gigantes do site Sal.
- **Form box:** sem border-box visível — apenas vazio centrado.
- **Fundo:** `--bg` puro.
- **Logo Sal:** top bar discreto. Texto "v2026.05 · OS" mono microcap à direita.

---

## 17. Acessibilidade

- **Contraste:** ink-on-bg = 17:1 (AAA). ink-soft 9:1 (AAA). ink-mute 5:1 (AA large).
- **Focus visível:** `:focus-visible` aplica `shadow-focus` em elementos interativos.
- **Keyboard nav:** tabs com Tab/Arrow. Modal Esc. Composer Cmd/Ctrl+Enter envia. Tab nav em email thread navega entre emails.
- **Reduced motion:** `@media (prefers-reduced-motion: reduce)` desativa animações exceto opacity.
- **Screen reader:** `aria-label` em ícone-only buttons. `aria-live="polite"` no banner analyzing. `role="article"` em cada email da thread.
- **Tipografia:** nunca abaixo 12px. Body default 14-15px.

---

## 18. **GUARDA-CHUVA — o que NÃO mexer**

- ✅ Nenhuma query Supabase. `.from()`, `.rpc()`, `.functions.invoke()` permanecem.
- ✅ Nenhum nome de campo (`analise_padrao_status`, `aviso_alteracao_oc`, etc).
- ✅ Nenhuma rota.
- ✅ Nenhum prop atual dos componentes (`card.id`, `card.nf`, etc).
- ✅ Realtime channels. Subscriptions. RLS.
- ✅ `onClick`, `onSubmit`, hooks — preservados 100%.
- ✅ Auth flow. Sessão. Refresh tokens.
- ✅ Validações de form.
- ✅ Toasts: mantém integração, só re-estiliza visualmente.

---

## 19. Plano de execução

1. **Tokens primeiro.** `tailwind.config.ts` + `src/index.css` (variables). `<head>` Google Fonts (Bricolage + JetBrains Mono).
2. **Logo Sal Express.** Componente `<SalLogo />` em `src/components/SalLogo.tsx`.
3. **Atomic components.** `Button` (3 variantes), `StatusChip`, `Avatar`, `AiBanner`, `Tabs`, `Field`, `EmptyState`, `EmailMessage`, `EmailComposer`, `Chip`.
4. **Shell.** Top bar com logo + nav + avatar.
5. **Lista de cards** (refatora todas as listas — Pendências, Auditoria, ACAO_EXECUTADA, Cliente Respondeu).
6. **Card aberto.** Header + tabs.
7. **Tab Mensagens** com novo `EmailMessage` (header expansível Gmail-style) + `EmailComposer` (sticky bottom).
8. **Tab Propostas, Histórico SSW, Eventos** com timelines/lists.
9. **Empty states, login, modais.**
10. **Microinterações** (Framer Motion onde fizer sentido).
11. **QA visual.** Cada banner/modal/botão renderiza, sem perder estado, sem perder ação. Especialmente: AiBanner unificado precisa cobrir TODOS os banners IA atuais (oc=13 autônomo, ocs padrão, validar evidência, sugestão genérica).

Se alguma tela específica não estiver coberta, **mantém o comportamento atual e aplica apenas os tokens novos** (cores + fonts + radius + spacing).

---

## 20. Resumo do que muda

| Onde | O que muda |
|---|---|
| **Tokens globais** | Bricolage Grotesque + JetBrains Mono. Cream warm + ink preto + vermelho Sal (`#E11D2A`). Hairline shadows. |
| **Identidade** | Logo Sal·Express em todas surfaces (top bar, login, footer, empty state). Marca consolidada. |
| **Numbering Sal** | "/ 01", "/ 02" mono vermelho como assinatura visual em listas, propostas, eyebrows. |
| **Italic emphasis** | Palavra-chave em italic display em títulos, status, frases ("*sua* validação", "*RESOLVIDO*", "*oc=56*"). |
| **Shell** | Top bar slim com logo Sal + subtag OS + nav minimal. |
| **Lista de cards** | Linha tabular editorial sem card-box. Hairline divisors. Eyebrow signature "/ NN · OC · OPERADOR". |
| **Card aberto** | Header 3 linhas (eyebrow / display / mono) + tabs minimal com underline ink. |
| **Banners IA** | Componente único `<AiBanner>` 5 variantes — border-left vermelho Sal + ✦ + display italic title. |
| **Emails (Gmail-style)** | Cada email = card colapsável com header completo (avatar circle, de/para mono, timestamp, subject); corpo max-width 680px; anexos chip-style; **composer sticky bottom** com campos slim + highlight IA + sem-border textarea; Cmd+Enter envia. |
| **Propostas** | Rows com hairline border; destaque IA via border-left vermelho + ✦ + italic. |
| **Histórico SSW + Eventos** | Timeline vertical, dots semânticos, datas `DD·MM·AA  HH:MM`. |
| **Status chips** | Label uppercase, dot semântico, italic em estados finais. |
| **Botões** | 3 variantes. Primary preto → hover vermelho Sal (momento de marca). |
| **Modais** | Backdrop blur + radius 12 + display headers. |
| **Login** | Logo Sal top bar + background art "COCKPIT" gigante 200px decorativo. |
| **Empty states** | "/00" mono vermelho + frase italic + logo Sal discreto rodapé. |

**Nada de funcional muda.** Cada `onClick`, cada `useEffect`, cada hook, cada query Supabase preservada. Lovable só troca JSX/CSS/tokens. Se detectar que componente atual faz algo crítico, **preserva 100% da lógica e só substitui a apresentação visual**.

A plataforma deve sair olhando como **Sal·Express · Logistics OS** — não como SaaS terceiro, não como dashboard genérico. Quem bate o olho identifica imediatamente que é o cockpit interno da Sal.
