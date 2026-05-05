# Cockpit Sal Express — Redesign completo (UI + Kanban v2 + Painel Resposta)

> Cole esse prompt INTEIRO no Lovable. Substitui os prompts anteriores
> (`lovable-kanban-v2.md` e `lovable-painel-resposta.md`). Backend já está
> pronto — esse documento é puro frontend.

---

## 1. Direção criativa: "Cockpit ferroviário modernista"

Pegamos a estética de **painel de estação ferroviária moderna** (tipografia
railway, hierarquia rigorosa de dados, ribbons/placas como sinalização) e
combinamos com o **calor de papel jornal** (off-white quente, serif editorial,
microcopy humana). Cada card é uma "passagem" que precisa ser despachada.

**Princípios não-negociáveis:**

- **Vermelho Sal Express é tinta de assinatura, não inundação.** Domina via
  pequenos pontos cirúrgicos (header, badges críticos, stripes em cards
  urgentes), nunca como background grande.
- **Off-white quente** (`#FAF7F2`), nunca branco frio. Plataforma é usada o
  dia inteiro — fundo precisa ser confortável.
- **Hierarquia tipográfica tripla**: serif editorial pra conteúdo humano
  (mensagens), sans geométrica pra UI, mono pra dados (NF, OC, timestamps).
- **Densidade respirada.** Bastante info por tela (operação real), mas com
  arquitetura clara — não tudo amontoado nem tudo afastado.
- **Movimento com propósito.** Animação sinaliza estado (pulse = atenção,
  stagger = chegada de dados, contador = mudança), não é enfeite.

**Anti-padrões proibidos:**

- ❌ Inter, Roboto, Arial, system-ui
- ❌ Gradientes purple-to-pink
- ❌ Glassmorphism, blur backgrounds
- ❌ Soft shadows pastel (`shadow-md` genérico do Tailwind)
- ❌ Border-radius grande genérico em todos os cards
- ❌ Emojis decorativos no UI principal (só em microcopy específica)
- ❌ Skeleton loaders retangulares cinza padrão

---

## 2. Setup técnico

### 2.1 Fontes (Google Fonts)

Adiciona no `index.html` ou no head principal:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Geist:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```

### 2.2 CSS Variables (cole no `index.css` ou tema global)

```css
:root {
  /* Cores Sal Express */
  --sal-red: #C8102E;
  --sal-red-deep: #8B0000;
  --sal-red-tint: #FCEAED;

  /* Neutros quentes (papel jornal) */
  --paper: #FAF7F2;
  --paper-deep: #F2EDE4;
  --ink: #1A1816;
  --ink-soft: #4A4A47;
  --rule: #D6D2CB;
  --rule-strong: #8E887E;

  /* Status */
  --warn: #F4B400;
  --warn-tint: #FFF7DC;
  --good: #2A8C51;
  --good-tint: #E5F3EA;
  --crit: var(--sal-red);
  --info: #1E5F94;

  /* Tipografia */
  --font-display: 'Fraunces', 'Times New Roman', serif;
  --font-ui: 'Geist', -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', 'Courier New', monospace;

  /* Espaçamento ferroviário (rhythm 4px) */
  --gap-1: 4px;
  --gap-2: 8px;
  --gap-3: 12px;
  --gap-4: 16px;
  --gap-6: 24px;
  --gap-8: 32px;
  --gap-12: 48px;

  /* Sombras chapadas (não fofas) */
  --shadow-flat: 4px 4px 0 var(--ink);
  --shadow-flat-sm: 2px 2px 0 var(--ink);
  --shadow-press: 1px 1px 0 var(--ink);
}

html, body {
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-ui);
  font-feature-settings: 'ss01', 'cv01';
  -webkit-font-smoothing: antialiased;
}

/* Scrollbar custom: fina, vermelha, não invasiva */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: var(--paper-deep); }
::-webkit-scrollbar-thumb { background: var(--rule-strong); border: 2px solid var(--paper-deep); }
::-webkit-scrollbar-thumb:hover { background: var(--sal-red); }

/* Seleção de texto colorida */
::selection { background: var(--sal-red); color: var(--paper); }

/* Numerais tabulares onde fizer sentido */
.tabular { font-variant-numeric: tabular-nums; }

/* Subtle paper texture (opcional, sutilíssima) */
body::before {
  content: '';
  position: fixed; inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.04 0'/%3E%3C/filter%3E%3Crect width='100' height='100' filter='url(%23n)'/%3E%3C/svg%3E");
  pointer-events: none;
  z-index: 1;
  mix-blend-mode: multiply;
  opacity: 0.5;
}
```

### 2.3 Tailwind config (extend)

```js
// tailwind.config.js — extend
theme: {
  extend: {
    colors: {
      sal: { DEFAULT: '#C8102E', deep: '#8B0000', tint: '#FCEAED' },
      paper: { DEFAULT: '#FAF7F2', deep: '#F2EDE4' },
      ink: { DEFAULT: '#1A1816', soft: '#4A4A47' },
      rule: { DEFAULT: '#D6D2CB', strong: '#8E887E' },
      warn: { DEFAULT: '#F4B400', tint: '#FFF7DC' },
      good: { DEFAULT: '#2A8C51', tint: '#E5F3EA' },
    },
    fontFamily: {
      display: ['Fraunces', 'serif'],
      ui: ['Geist', 'sans-serif'],
      mono: ['JetBrains Mono', 'monospace'],
    },
    boxShadow: {
      flat: '4px 4px 0 #1A1816',
      'flat-sm': '2px 2px 0 #1A1816',
      press: '1px 1px 0 #1A1816',
    },
    keyframes: {
      pulseDot: {
        '0%, 100%': { opacity: '1', transform: 'scale(1)' },
        '50%': { opacity: '0.6', transform: 'scale(1.4)' },
      },
      ticker: {
        '0%': { transform: 'translateY(100%)', opacity: '0' },
        '100%': { transform: 'translateY(0)', opacity: '1' },
      },
      stagger: {
        '0%': { opacity: '0', transform: 'translateY(8px)' },
        '100%': { opacity: '1', transform: 'translateY(0)' },
      },
      analogTick: {
        '0%, 100%': { transform: 'rotate(0deg)' },
        '50%': { transform: 'rotate(180deg)' },
      },
    },
    animation: {
      'pulse-dot': 'pulseDot 2s ease-in-out infinite',
      'ticker': 'ticker 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)',
      'stagger': 'stagger 0.4s cubic-bezier(0.2, 0.8, 0.2, 1) both',
      'analog-tick': 'analogTick 1.2s linear infinite',
    },
  },
}
```

---

## 3. Layout global

### 3.1 Top bar (header)

Largura total, altura ~60px, fundo `--ink`, info densa em mono. Estética de
painel ferroviário.

```jsx
<header className="bg-ink text-paper border-b-2 border-ink relative z-10">
  <div className="flex items-center h-15 px-6">
    {/* Logo: tipografia editorial, NÃO imagem */}
    <div className="flex items-baseline gap-2">
      <span className="font-display text-xl font-700 tracking-tight">Cockpit</span>
      <span className="font-mono text-[10px] uppercase tracking-widest text-paper/60">
        Sal Express · Relacionamento
      </span>
    </div>

    {/* Centro: clock ao vivo + status sync */}
    <div className="ml-auto flex items-center gap-6 font-mono text-xs uppercase tracking-wider">
      <span className="flex items-center gap-2">
        <span className="w-1.5 h-1.5 bg-good rounded-full animate-pulse-dot"></span>
        <span className="text-paper/60">SYNC</span>
        <span className="text-paper">há {minutosDesdeUltimoSync}min</span>
      </span>
      <span className="text-paper/40">|</span>
      <span className="tabular text-paper">{horaAtual}</span>
    </div>

    {/* Operador */}
    <div className="ml-6 flex items-center gap-3 pl-6 border-l border-paper/20">
      <span className="font-display italic text-sm">{nomeOperador}</span>
      <button className="text-[10px] uppercase tracking-widest text-paper/60 hover:text-sal">
        Sair
      </button>
    </div>
  </div>

  {/* Linha de tensão vermelha embaixo do header */}
  <div className="h-[2px] bg-sal"></div>
</header>
```

### 3.2 Saudação do dia (linha abaixo do header)

```jsx
<div className="bg-paper-deep px-6 py-3 border-b border-rule font-display italic text-ink-soft text-sm">
  {saudacao}, {primeiroNome}.{' '}
  <span className="font-ui not-italic font-500 text-ink">
    {totalParaFazer} cards aguardando ação.
  </span>
  {totalParaFazer === 0 && (
    <span className="font-mono text-good text-xs ml-2">
      ✦ TUDO EM DIA
    </span>
  )}
</div>
```

`saudacao` muda por hora: "Bom dia" / "Boa tarde" / "Boa noite". Microcopy
varia se zero cards: "Coluna vazia, momento de café." / "Tudo em dia ✦".

---

## 4. Kanban — 6 colunas

### 4.1 Estrutura do board

```jsx
<main className="flex gap-3 px-4 pt-4 pb-8 overflow-x-auto h-[calc(100vh-110px)]">
  <KanbanColumn variant="todo"     label="PARA FAZER"                count={contagens.toFazer} cards={cards.toFazer} />
  <KanbanColumn variant="critical" label="AGUARDANDO VALIDAÇÃO HUMANA" count={contagens.validacao} cards={cards.validacao} />
  <KanbanColumn variant="waiting"  label="AGUARDANDO CLIENTE"       count={contagens.cliente} cards={cards.cliente} />
  <KanbanColumn variant="executed" label="AÇÃO EXECUTADA"           count={contagens.executada} cards={cards.executada} />
  <KanbanColumn variant="auto"     label="AÇÃO AUTÔNOMA"            count={contagens.autonoma} cards={cards.autonoma} />
  <KanbanColumn variant="alert"    label="TRATATIVA PENDENTE"       count={contagens.tratativa} cards={cards.tratativa} />
</main>
```

### 4.2 Filtros das colunas (mantém do Kanban v2)

```ts
// PARA FAZER
.from("cards").select("*, todos!todos_card_id_fkey(id,status,proposta_payload)")
  .in("state", ["AGUARDANDO_AGENTE","AGUARDANDO_CONTEXTO","AGUARDANDO_VINCULACAO","EM_TRIAGEM"])
  .is("aprovacao_modo", null)
  .eq("lock_aguardando_validacao", false)

// AGUARDANDO VALIDAÇÃO HUMANA
.eq("state", "AGUARDANDO_VALIDACAO_HUMANA")

// AGUARDANDO CLIENTE
.eq("state", "AGUARDANDO_CLIENTE")
.eq("lock_aguardando_validacao", false)

// AÇÃO EXECUTADA
.eq("aprovacao_modo", "humana")
.not("state", "in", "(CANCELADO,TRANSFERIDO,RESOLVIDO)")

// AÇÃO AUTÔNOMA
.eq("aprovacao_modo", "autonoma")
.not("state", "in", "(CANCELADO,TRANSFERIDO,RESOLVIDO)")

// TRATATIVA PENDENTE
.eq("state", "TRATATIVA_PENDENTE")
```

### 4.3 Componente `KanbanColumn`

Cada coluna é uma **placa de estação** (ribbon horizontal) seguida de uma
pilha de cards. Sem scroll dentro da coluna em primeira instância — deixa o
board scrollar vertical se precisar.

```jsx
function KanbanColumn({ variant, label, count, cards }) {
  const variantStyles = {
    todo:     'bg-paper-deep border-ink',
    critical: 'bg-sal-tint border-sal',
    waiting:  'bg-warn-tint border-warn',
    executed: 'bg-good-tint border-good',
    auto:     'bg-ink text-paper border-ink',
    alert:    'bg-sal text-paper border-sal-deep',
  }[variant];

  return (
    <section className="flex-1 min-w-[300px] flex flex-col gap-3">
      {/* Placa estação */}
      <header className={`relative px-3 py-2 border-2 ${variantStyles} shadow-flat-sm`}>
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="font-mono text-[11px] font-600 uppercase tracking-[0.18em]">
            {label}
          </h2>
          <span className="font-mono text-lg font-700 tabular">
            {count.toString().padStart(2, '0')}
          </span>
        </div>
        {/* Faixa diagonal decorativa */}
        <div className="absolute -bottom-[2px] right-3 h-[2px] w-8 bg-current opacity-40"></div>
      </header>

      {/* Empty state */}
      {cards.length === 0 ? (
        <EmptyState variant={variant} />
      ) : (
        <div className="flex flex-col gap-2">
          {cards.map((card, i) => (
            <CardKanban
              key={card.id}
              card={card}
              variant={variant}
              style={{ animationDelay: `${i * 30}ms` }}
              className="animate-stagger"
            />
          ))}
        </div>
      )}
    </section>
  );
}
```

### 4.4 `EmptyState`

Não usa "Nenhum card encontrado" genérico. Microcopy específica + glifo
desenhado.

```jsx
function EmptyState({ variant }) {
  const messages = {
    todo:     { glyph: '✦', text: 'Tudo em dia. Hora de respirar.' },
    critical: { glyph: '○', text: 'Sem decisões pendentes agora.' },
    waiting:  { glyph: '⊙', text: 'Sem aguardar resposta de cliente.' },
    executed: { glyph: '◇', text: 'Nenhuma ação executada hoje ainda.' },
    auto:     { glyph: '◆', text: 'Agente sem ações autônomas no momento.' },
    alert:    { glyph: '⚠', text: 'Sem tratativas pendentes ✦' },
  };
  const { glyph, text } = messages[variant];
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 border border-dashed border-rule">
      <span className="font-display text-4xl text-ink-soft mb-3">{glyph}</span>
      <p className="font-display italic text-sm text-ink-soft text-center">{text}</p>
    </div>
  );
}
```

---

## 5. Card no Kanban

Cada card é uma **passagem ferroviária**: borda dura, cantos retos (não
pill), tipografia híbrida (mono pra NF, serif pra contexto), sombra chapada.

```jsx
function CardKanban({ card, variant, ...props }) {
  const isUrgent = card.risco === 'alto';
  const isLocked = card.lock_aguardando_validacao;
  const isAutonomo = card.aprovacao_modo === 'autonoma';
  const isHumano = card.aprovacao_modo === 'humana';

  return (
    <article
      className={`
        relative bg-paper border-2 border-ink shadow-flat-sm
        hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-press
        active:shadow-none active:translate-x-[2px] active:translate-y-[2px]
        transition-[transform,box-shadow] duration-100 cursor-pointer group
        ${isUrgent ? 'border-l-[6px] border-l-sal' : ''}
      `}
      onClick={() => abrirCard(card.id)}
      {...props}
    >
      {/* Top strip: NF + tags */}
      <header className="flex items-center justify-between px-3 py-1.5 bg-paper-deep border-b border-rule">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">NF</span>
          <span className="font-mono text-sm font-600 tabular text-ink">
            {card.nf || '———'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {isLocked && <LockBadge />}
          {isAutonomo && <RibbonTag>AUTO</RibbonTag>}
          {isHumano && <RibbonTag variant="muted">HUMANO</RibbonTag>}
          {isUrgent && (
            <span className="w-2 h-2 rounded-full bg-sal animate-pulse-dot" title="Risco alto" />
          )}
        </div>
      </header>

      {/* Corpo */}
      <div className="px-3 py-2.5">
        <p className="font-display text-[15px] leading-snug text-ink line-clamp-2">
          {card.empresa_cliente || card.nome_cliente || 'Cliente sem identificação'}
        </p>
        {card.cod_ultima_ocorrencia && (
          <div className="mt-1.5 flex items-baseline gap-1.5 text-xs">
            <span className="font-mono text-ink-soft">OC</span>
            <span className="font-mono font-600 tabular">{card.cod_ultima_ocorrencia}</span>
            <span className="font-display italic text-ink-soft truncate">
              {card.descricao_ocorrencia}
            </span>
          </div>
        )}
      </div>

      {/* Footer: tempo + canal */}
      <footer className="flex items-center justify-between px-3 py-1.5 border-t border-rule bg-paper-deep">
        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-soft">
          <CanalIcon canal={card.canal_origem} />
          <TempoRelativo from={card.created_at} />
        </span>
        {card.assigned_operator_id && (
          <span className="font-display italic text-[11px] text-ink-soft">
            {card.operador_nome}
          </span>
        )}
      </footer>
    </article>
  );
}
```

### 5.1 `RibbonTag` (cantos cortados estilo bilhete)

```jsx
function RibbonTag({ children, variant = 'auto' }) {
  const styles = variant === 'auto'
    ? 'bg-ink text-paper'
    : 'bg-paper text-ink-soft border border-ink-soft';
  return (
    <span
      className={`relative font-mono text-[9px] font-600 uppercase tracking-wider px-1.5 py-0.5 ${styles}`}
      style={{
        clipPath: 'polygon(4px 0, 100% 0, calc(100% - 4px) 100%, 0 100%)',
      }}
    >
      {children}
    </span>
  );
}
```

### 5.2 `LockBadge`

```jsx
function LockBadge() {
  return (
    <span className="inline-flex items-center justify-center w-5 h-5 bg-warn-tint border border-warn">
      <svg className="w-3 h-3 text-warn" viewBox="0 0 16 16" fill="none">
        <rect x="4" y="7" width="8" height="6" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M5.5 7V5a2.5 2.5 0 1 1 5 0v2" stroke="currentColor" strokeWidth="1.5"/>
      </svg>
    </span>
  );
}
```

### 5.3 `TempoRelativo` (atualiza ao vivo)

```jsx
function TempoRelativo({ from }) {
  const [text, setText] = useState(() => formatRelative(from));
  useEffect(() => {
    const id = setInterval(() => setText(formatRelative(from)), 30_000);
    return () => clearInterval(id);
  }, [from]);
  return <span className="tabular">{text}</span>;
}

function formatRelative(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'agora';
  if (diff < 3600) return `há ${Math.floor(diff / 60)}min`;
  if (diff < 86400) return `há ${Math.floor(diff / 3600)}h`;
  return `há ${Math.floor(diff / 86400)}d`;
}
```

### 5.4 `CanalIcon`

```jsx
function CanalIcon({ canal }) {
  const map = { email: '✉', whatsapp: '◉', sistema: '⌧' };
  return <span className="font-mono">{map[canal] || '·'}</span>;
}
```

---

## 6. Detalhe do card aberto

Layout de 2 colunas: à esquerda, sidebar densa com metadata (NF, CTRC,
pagador, operador, etc); à direita, abas (Mensagens / Eventos / Histórico
SSW / **Resposta**).

### 6.1 Header do detalhe

```jsx
<div className="bg-ink text-paper px-6 py-4 border-b-2 border-sal">
  <button onClick={voltar} className="font-mono text-[10px] uppercase tracking-widest text-paper/60 hover:text-sal mb-2">
    ← Voltar
  </button>
  <div className="flex items-baseline justify-between gap-4">
    <div>
      <h1 className="font-display text-2xl font-600 leading-none">
        {card.empresa_cliente || 'Cliente'}
      </h1>
      <p className="font-display italic text-paper/60 mt-1">
        {card.nome_cliente && <span>{card.nome_cliente} · </span>}
        <span className="font-mono not-italic">NF {card.nf}</span>
      </p>
    </div>
    <CardStatePill state={card.state} />
  </div>
</div>
```

### 6.2 `CardStatePill`

Pill grande, fonte mono, cor por state.

```jsx
function CardStatePill({ state }) {
  const map = {
    AGUARDANDO_VALIDACAO_HUMANA: { label: 'Aguardando você', bg: 'bg-sal',  fg: 'text-paper' },
    AGUARDANDO_CLIENTE:          { label: 'Aguardando cliente', bg: 'bg-warn', fg: 'text-ink' },
    AGUARDANDO_AGENTE:           { label: 'Para fazer', bg: 'bg-paper', fg: 'text-ink' },
    EXECUTANDO_ACAO:             { label: 'Em execução', bg: 'bg-good', fg: 'text-paper' },
    TRATATIVA_PENDENTE:          { label: 'Tratativa pendente', bg: 'bg-sal-deep', fg: 'text-paper' },
    TRANSFERIDO:                 { label: 'Transferido', bg: 'bg-ink-soft', fg: 'text-paper' },
    RESOLVIDO:                   { label: 'Resolvido', bg: 'bg-ink', fg: 'text-paper' },
  };
  const s = map[state] || { label: state, bg: 'bg-rule', fg: 'text-ink' };
  return (
    <span className={`${s.bg} ${s.fg} font-mono text-xs font-600 uppercase tracking-widest px-3 py-1.5 border-2 border-ink`}>
      {s.label}
    </span>
  );
}
```

### 6.3 Sidebar metadata (esquerda)

```jsx
<aside className="w-72 bg-paper-deep border-r-2 border-ink p-4 space-y-4 font-mono text-xs">
  <MetadataItem label="NF"            value={card.nf} variant="hero" />
  <MetadataItem label="CTRC"          value={card.ctrc || '—'} />
  <MetadataItem label="Pagador"       value={card.pagador || '—'} />
  <MetadataItem label="Base destino"  value={card.base_destino || '—'} />
  <MetadataItem label="Última oc"     value={card.cod_ultima_ocorrencia ? `${card.cod_ultima_ocorrencia} · ${card.descricao_ocorrencia}` : '—'} multiline />
  <MetadataItem label="Canal"         value={canalFormat(card.canal_origem)} />
  <MetadataItem label="Criado"        value={formatDate(card.created_at)} />

  {/* Operador atribuído */}
  <div className="pt-4 border-t border-rule">
    <span className="text-[10px] uppercase tracking-widest text-ink-soft">Operador</span>
    <div className="mt-1.5 flex items-center gap-2">
      <span className="w-7 h-7 bg-ink text-paper flex items-center justify-center font-display text-sm">
        {operadorNome[0]}
      </span>
      <span className="font-display not-mono text-sm">{operadorNome}</span>
    </div>
  </div>

  {/* Aprovação badge — quando aplicável */}
  {card.aprovacao_modo && <AprovacaoModeBadge modo={card.aprovacao_modo} />}
</aside>

function MetadataItem({ label, value, variant, multiline }) {
  return (
    <div>
      <span className="text-[10px] uppercase tracking-widest text-ink-soft">{label}</span>
      <div className={`mt-0.5 ${variant === 'hero' ? 'font-display not-mono text-2xl font-600 tabular' : 'tabular text-sm'} ${multiline ? 'leading-snug' : 'truncate'}`}>
        {value}
      </div>
    </div>
  );
}

function AprovacaoModeBadge({ modo }) {
  if (modo === 'autonoma') return (
    <div className="bg-ink text-paper p-3 border-2 border-ink">
      <div className="font-mono text-[10px] uppercase tracking-widest text-paper/60 mb-1">Aprovação</div>
      <div className="font-display text-base">🤖 Autônoma</div>
      <p className="font-display italic text-xs text-paper/60 mt-1">
        Agente decidiu sozinho — sem clique humano.
      </p>
    </div>
  );
  return (
    <div className="bg-good-tint p-3 border-2 border-good">
      <div className="font-mono text-[10px] uppercase tracking-widest text-good mb-1">Aprovação</div>
      <div className="font-display text-base text-ink">✋ Humana</div>
    </div>
  );
}
```

### 6.4 Abas

```jsx
<div className="flex gap-0 border-b-2 border-ink">
  {['Mensagens', 'Resposta', 'Eventos', 'Histórico SSW'].map((tab) => (
    <button
      key={tab}
      onClick={() => setAba(tab)}
      className={`
        relative font-mono text-[11px] uppercase tracking-widest px-4 py-2.5 border-r border-rule
        ${aba === tab
          ? 'bg-sal text-paper'
          : 'bg-paper-deep text-ink-soft hover:bg-paper hover:text-ink'}
      `}
    >
      {tab}
      {tab === 'Resposta' && temSugestaoNova && (
        <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-warn rounded-full animate-pulse-dot" />
      )}
    </button>
  ))}
</div>
```

---

## 7. Aba Mensagens (chat editorial)

Bubbles **NÃO arredondadas**. Borda esquerda colorida. Tipografia serif pro
texto do cliente, sans pra resposta interna.

```jsx
<div className="space-y-4 p-6">
  {mensagens.map((m) => (
    <article
      key={m.id}
      className={`
        relative max-w-[80%] p-4 border border-ink shadow-flat-sm
        ${m.canal === 'email'    ? 'bg-paper border-l-[3px] border-l-info' : ''}
        ${m.canal === 'whatsapp' ? 'bg-good-tint border-l-[3px] border-l-good' : ''}
        ${m.actor_type === 'operator' ? 'ml-auto bg-paper-deep border-l-sal' : ''}
      `}
    >
      <header className="flex items-baseline justify-between gap-3 mb-2 pb-2 border-b border-rule">
        <div className="flex items-baseline gap-2">
          <CanalIcon canal={m.canal} />
          <span className="font-mono text-[11px] font-600 truncate max-w-[200px]">
            {m.remetente}
          </span>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft tabular">
          {formatDateTime(m.recebido_em)}
        </span>
      </header>
      <p className="font-display text-[15px] leading-relaxed whitespace-pre-wrap">
        {m.conteudo}
      </p>
    </article>
  ))}
</div>
```

---

## 8. Aba Resposta (NOVO — painel de envio)

Aqui mora o **gerador de resposta IA**. Layout em 2 partes: textarea
editável grande no topo, controles abaixo.

### 8.1 Buscar sugestão atual

```ts
const { data: todoResposta } = await supabase
  .from('todos')
  .select('id, status, proposta_payload, approved_at')
  .eq('card_id', cardId)
  .filter('proposta_payload->>tool', 'eq', 'responder_cliente')
  .order('created_at', { ascending: false })
  .limit(1)
  .maybeSingle();
```

`proposta_payload` shape:
```ts
{
  tool: 'responder_cliente',
  args: { canal, destinatario, subject },
  texto_sugerido: '...',
  confianca: 'alta' | 'media' | 'baixa',
  rationale: '...',
  modelo_usado, versao_prompt, gerado_em, editado_em?
}
```

### 8.2 Layout do painel

```jsx
<div className="p-6 space-y-4">
  {/* Cabeçalho */}
  <div className="flex items-center justify-between gap-3 pb-3 border-b border-rule">
    <div className="flex items-baseline gap-3">
      <h3 className="font-display text-xl font-600">Resposta sugerida</h3>
      {todoResposta?.proposta_payload?.confianca && (
        <ConfiancaPill nivel={todoResposta.proposta_payload.confianca} />
      )}
    </div>
    <div className="flex items-center gap-2">
      <button onClick={regenerar} disabled={regenerando}
        className="font-mono text-[10px] uppercase tracking-wider px-3 py-1.5 border border-ink hover:bg-ink hover:text-paper disabled:opacity-40">
        {regenerando ? <AnalogClock /> : '↻ Regenerar'}
      </button>
    </div>
  </div>

  {/* Toggle canal */}
  <div className="flex gap-0 border border-ink w-fit">
    <button
      className={`font-mono text-[10px] uppercase tracking-wider px-4 py-2 ${canal === 'email' ? 'bg-ink text-paper' : 'hover:bg-paper-deep'}`}
      onClick={() => setCanal('email')}>
      ✉ Email
    </button>
    <button
      disabled
      title="WhatsApp ainda não conectado"
      className="font-mono text-[10px] uppercase tracking-wider px-4 py-2 border-l border-ink opacity-30 cursor-not-allowed">
      ◉ WhatsApp
    </button>
  </div>

  {/* Estado: sem sugestão */}
  {!todoResposta && !regenerando && (
    <EmptyResposta onGerar={regenerar} />
  )}

  {/* Estado: sugestão pronta */}
  {todoResposta && todoResposta.status === 'pendente' && (
    <>
      <textarea
        value={textoEditado}
        onChange={(e) => setTextoEditado(e.target.value)}
        rows={10}
        className="w-full p-4 bg-paper-deep border-2 border-ink font-display text-[15px] leading-relaxed shadow-flat-sm focus:outline-none focus:border-sal focus:shadow-flat resize-none"
        placeholder="Texto da resposta..."
      />

      {/* Metadados da geração */}
      <div className="flex items-baseline justify-between gap-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft">
        <span>
          Gerado por IA · modelo {todoResposta.proposta_payload.modelo_usado} · {formatRelative(todoResposta.proposta_payload.gerado_em)}
        </span>
        {textoEditado !== todoResposta.proposta_payload.texto_sugerido && (
          <span className="text-warn font-600">✎ Editado</span>
        )}
      </div>

      {/* Banner fase preparação */}
      <FlagDesabilitadoBanner />

      {/* Ações */}
      <div className="flex items-center justify-between gap-3 pt-3 border-t border-rule">
        <span className="font-display italic text-sm text-ink-soft">
          De: <span className="font-mono not-italic text-ink">{operadorEmail}</span><br/>
          Para: <span className="font-mono not-italic text-ink">{destinatario}</span>
        </span>
        <button
          onClick={() => enviarResposta(todoResposta.id, textoEditado)}
          disabled={enviando || textoEditado.trim().length < 5}
          className="bg-sal text-paper font-mono text-xs font-600 uppercase tracking-widest px-6 py-3 border-2 border-ink shadow-flat hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-flat-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:opacity-40 disabled:cursor-not-allowed transition-all">
          {enviando ? 'Enviando...' : 'Enviar resposta →'}
        </button>
      </div>
    </>
  )}

  {/* Estado: enviado */}
  {todoResposta && todoResposta.status === 'enviado' && (
    <div className="bg-good-tint border-2 border-good p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-good">Enviado</span>
        <span className="font-mono text-[10px] tabular text-ink-soft">
          {formatDateTime(todoResposta.approved_at)}
        </span>
      </div>
      <p className="font-display text-[15px] leading-relaxed whitespace-pre-wrap text-ink">
        {todoResposta.proposta_payload.texto_final || todoResposta.proposta_payload.texto_sugerido}
      </p>
    </div>
  )}
</div>
```

### 8.3 `ConfiancaPill`

```jsx
function ConfiancaPill({ nivel }) {
  const map = {
    alta:  { label: 'Confiança alta',  bg: 'bg-good-tint border-good text-good' },
    media: { label: 'Confiança média', bg: 'bg-warn-tint border-warn text-ink' },
    baixa: { label: 'Confiança baixa', bg: 'bg-sal-tint border-sal text-sal-deep' },
  };
  const c = map[nivel] || map.media;
  return (
    <span className={`${c.bg} font-mono text-[10px] font-600 uppercase tracking-widest px-2 py-0.5 border`}>
      {c.label}
    </span>
  );
}
```

### 8.4 `AnalogClock` (loading não-genérico)

```jsx
function AnalogClock() {
  return (
    <span className="inline-flex items-center justify-center w-3 h-3 border border-current rounded-full">
      <span className="w-[1px] h-1.5 bg-current origin-bottom animate-analog-tick"></span>
    </span>
  );
}
```

### 8.5 `FlagDesabilitadoBanner`

Detecta via env do front (precisa ter um endpoint público que retorna se
está em fase preparação) OU lê do último card_event:

```jsx
function FlagDesabilitadoBanner() {
  // Pode ser via flag estática no .env do frontend, ou polling no backend
  if (!ENVIO_DESABILITADO_FLAG) return null;
  return (
    <div className="bg-warn-tint border-2 border-warn px-4 py-3 flex items-start gap-3">
      <span className="font-mono text-warn text-lg leading-none">⚠</span>
      <div className="flex-1 font-display italic text-sm text-ink">
        <strong className="font-ui not-italic font-600 text-ink">Modo preparação ativo.</strong>{' '}
        Clicar Enviar registra a intenção mas <em>não envia o email</em>. Caio destrava
        o envio na segunda 2026-05-04.
      </div>
    </div>
  );
}
```

### 8.6 `EmptyResposta`

```jsx
function EmptyResposta({ onGerar }) {
  return (
    <div className="border-2 border-dashed border-rule p-8 flex flex-col items-center text-center">
      <span className="font-display text-3xl text-ink-soft mb-3">✉</span>
      <p className="font-display italic text-ink-soft mb-4">
        Sem sugestão de resposta gerada ainda.
      </p>
      <button
        onClick={onGerar}
        className="font-mono text-[10px] uppercase tracking-wider px-4 py-2 bg-ink text-paper border-2 border-ink shadow-flat-sm hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-press">
        ✎ Gerar agora
      </button>
    </div>
  );
}
```

### 8.7 RPCs do front

```ts
async function regenerar() {
  setRegenerando(true);
  await supabase.functions.invoke('redator', {
    body: { card_id: cardId, force: true },
  });
  await refetchTodoResposta();
  setRegenerando(false);
}

async function enviarResposta(todoId, textoFinal) {
  setEnviando(true);
  const { data, error } = await supabase.rpc('enviar_resposta_cliente', {
    p_todo_id: todoId,
    p_texto_final: textoFinal,
  });
  setEnviando(false);
  if (error) {
    showToast('error', error.message);
    return;
  }
  await refetchTodoResposta();
  await refetchCardEvents();
}
```

---

## 9. Aba Eventos (timeline editorial)

Cada evento é uma "manchete" com ícone, título, timestamp em mono e payload
expandível.

```jsx
const EVENT_RENDER = {
  MensagemAnexada:           { icon: '◐', label: 'Mensagem anexada' },
  RespostaSugerida:          { icon: '✎', label: 'Sugestão de resposta gerada' },
  RespostaEnviadaSolicitada: { icon: '↗', label: 'Envio solicitado' },
  RespostaEnviada:           { icon: '✓', label: 'Resposta enviada', tone: 'good' },
  RespostaEnvioBloqueadoPorFlag: { icon: '◌', label: 'Envio bloqueado (modo preparação)', tone: 'warn' },
  RespostaEnvioFalhou:       { icon: '✕', label: 'Falha no envio', tone: 'crit' },
  AcaoPropostaPeloAgente:    { icon: '◆', label: 'Ação proposta pelo agente' },
  AprovacaoOperador:         { icon: '✋', label: 'Aprovado pelo operador', tone: 'good' },
  AutoAprovacaoPermitida:    { icon: '🤖', label: 'Auto-aprovação' },
  RejeicaoOperador:          { icon: '✕', label: 'Rejeitado pelo operador', tone: 'crit' },
  DevolvidoParaSetor:        { icon: '⤷', label: 'Transferido' },
  RetornoCobrancaCliente:    { icon: '⚠', label: 'Cliente cobrou novamente', tone: 'warn' },
  BastaoCardImportado:       { icon: '↓', label: 'Importado do Bastão' },
  BastaoCardAtualizado:      { icon: '⟳', label: 'Atualizado pelo Bastão' },
  ContextoFaltando:          { icon: '?', label: 'Contexto faltando', tone: 'warn' },
};

<ol className="relative pl-8 space-y-6">
  {/* linha vertical */}
  <span className="absolute left-3 top-2 bottom-2 w-px bg-rule"></span>
  {events.map((e) => {
    const r = EVENT_RENDER[e.event_type] || { icon: '·', label: e.event_type };
    const tone = r.tone || 'neutral';
    const toneStyles = {
      neutral: 'bg-paper border-ink text-ink',
      good:    'bg-good-tint border-good text-good',
      warn:    'bg-warn-tint border-warn text-ink',
      crit:    'bg-sal-tint border-sal text-sal-deep',
    }[tone];

    return (
      <li key={e.id} className="relative">
        <span className={`absolute -left-8 top-0 w-6 h-6 flex items-center justify-center border-2 font-mono text-xs ${toneStyles}`}>
          {r.icon}
        </span>
        <header className="flex items-baseline justify-between gap-3 mb-1">
          <h4 className="font-display text-base font-600 text-ink">{r.label}</h4>
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft tabular">
            {formatDateTime(e.created_at)}
          </span>
        </header>
        {/* Detalhe contextual por event_type — render específico */}
        <EventDetail event={e} />
      </li>
    );
  })}
</ol>
```

---

## 10. Tipos TS atualizados

Quando regenerar `Database` types do Supabase, garantir:

```ts
type CardRow = Database['public']['Tables']['cards']['Row'] & {
  state:
    | 'EM_TRIAGEM' | 'AGUARDANDO_VINCULACAO' | 'AGUARDANDO_AGENTE'
    | 'AGUARDANDO_CONTEXTO' | 'AGUARDANDO_VALIDACAO_HUMANA'
    | 'AGUARDANDO_CLIENTE' | 'EXECUTANDO_ACAO' | 'AGUARDANDO_TERCEIRO'
    | 'TRANSFERIDO' | 'TRATATIVA_PENDENTE' | 'RESOLVIDO'
    | 'CANCELADO' | 'BLOQUEADO_POR_ERRO';
  aprovacao_modo: 'humana' | 'autonoma' | null;
  lock_aguardando_validacao: boolean;
};

type TodoRow = Database['public']['Tables']['todos']['Row'] & {
  status: 'pendente' | 'aprovado' | 'rejeitado' | 'enviando' | 'enviado' | 'falhou' | 'executando' | 'executado';
  auto_approval_rule: string | null;
};
```

---

## 11. Checklist de implementação

- [ ] Adicionar fontes Google Fonts no head
- [ ] Cole CSS variables em `index.css`
- [ ] Estende Tailwind config (cores, fonts, shadows, animações)
- [ ] Refaz Top bar com tipografia editorial
- [ ] Adiciona linha de saudação abaixo do header
- [ ] Refaz `KanbanColumn` com placa-estação header
- [ ] Refaz `CardKanban` (borda dura, ribbons, pulse dot)
- [ ] Adiciona `EmptyState` com glifo + microcopy
- [ ] Refaz Detalhe do card: sidebar metadata + abas com indicador
- [ ] Refaz aba Mensagens (bubbles editoriais)
- [ ] **Adiciona aba Resposta (gerador IA)** — RPCs `redator` + `enviar_resposta_cliente`
- [ ] Refaz aba Eventos (timeline editorial com íconos)
- [ ] Atualiza tipos TS
- [ ] Testa empty states + loading states em cada coluna
- [ ] Valida com cards reais da Larissa (já tem 27+42 no banco)

---

## 12. Microcopy de referência (use exatamente)

- Saudação: `"Bom dia, Larissa." / "Boa tarde, Larissa." / "Boa noite, Larissa."`
- Empty state geral: `"Tudo em dia ✦"`
- Empty resposta: `"Sem sugestão de resposta gerada ainda."`
- Banner preparação: `"Modo preparação ativo. Clicar Enviar registra a intenção mas não envia o email."`
- Cliente cobrou de novo: `"⚠ Cliente cobrou novamente — card retornou pra tratativa"`
- Auto-aprovação: `"🤖 Agente decidiu sozinho — sem clique humano."`
- Risco alto: badge silenciosa, sem texto, só pulsing dot vermelho

---

Pronto. Cole tudo de uma vez no Lovable, regenere, e me manda print pra
gente refinar caso algum elemento fique fora do tom.
