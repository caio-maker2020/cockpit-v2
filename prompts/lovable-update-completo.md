# Cockpit Sal Express — Update Lovable (login leve + card validação compacto)

> Cole esse prompt INTEIRO no Lovable. **Substitui** os prompts
> `lovable-login-final.md` e `lovable-voltar-para-to-do.md` anteriores.
> Faz 2 mudanças visuais no app, sem tocar em backend, RLS, ou outras telas.
>
> **Mudanças**:
> 1. **Tela de login** — refeita em direção "manhã editorial" (era dark mode antes)
> 2. **Card AGUARDANDO VALIDAÇÃO HUMANA** — versão compacta com 3 botões universais

---

# PARTE 1 — Tela de login v2 (leve, amistosa, editorial)

## Direção criativa: "Manhã na estação · papel timbrado moderno"

A versão anterior do login era dark mode cinematográfico — pesada e
intimidadora. **Inverte tudo.** Login agora é uma tela LEVE, AMISTOSA e
EDITORIAL — referência: capa de revista de domingo + papel timbrado de
empresa centenária + calma de manhã antes do expediente. Tem que dar
vontade de entrar, não medo.

**Princípios:**

- **Fundo `--paper` claro** (mesmo do app pós-login) — continuidade visual
- **Logo SAL EXPRESS vermelha em destaque** — fundo claro deixa a marca presente
- **Saudação editorial calorosa antes do form** — "Bom dia.", "Boa tarde.",
  "Boa noite." em Fraunces serif italic
- **Form quase invisível** — sem caixas, só underlines cinza que viram vermelho no focus
- **Marca d'água editorial** — número do dia ("30") gigante no fundo em opacity 4%
- **Asterisco vermelho rotaciona muito devagar** (18s/giro) — charm sutil
- **Sem cursor custom, sem scan line, sem stagger cinematográfico**

**Anti-padrões PROIBIDOS:**

- ❌ Gradients · Glassmorphism / blur · Sombras macias (`shadow-md`)
- ❌ Border-radius grande · Inter / Roboto / system-ui
- ❌ "Welcome back!" / "Sign in to continue"
- ❌ Imagem de fundo · Cursor custom · Animações cinematográficas pesadas

## 1.1. Asset

`public/sal-express-logo.png` (já existe). Vermelho original, **não muda cor**.

## 1.2. CSS variables — REMOVER `--midnight`

Se `--midnight` e `--midnight-soft` foram adicionadas pelo prompt anterior, **REMOVA**.
Login v2 usa só as cores do app (`--paper`, `--ink`, `--sal`).

## 1.3. Tailwind config

**Remover** (do prompt v1):
- `colors.midnight`
- `keyframes.scanLine` e `animation.scan-line`
- `keyframes.loginEntry` e `animation.login-entry` (versão cinematográfica)

**Adicionar/ajustar**:

```js
theme: {
  extend: {
    keyframes: {
      // ... existentes (pulseDot, ticker, stagger, analogTick) ...
      asteriskSpin: {
        '0%':   { transform: 'rotate(0deg)' },
        '100%': { transform: 'rotate(360deg)' },
      },
      softFade: {
        '0%':   { opacity: '0', transform: 'translateY(8px)' },
        '100%': { opacity: '1', transform: 'translateY(0)' },
      },
    },
    animation: {
      'asterisk-spin': 'asteriskSpin 18s linear infinite',
      'soft-fade':     'softFade 0.6s ease-out both',
    },
  },
}
```

## 1.4. `LoginPage.tsx` — versão leve

Substitui completamente o `LoginPage` da versão dark anterior.

```tsx
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const navigate = useNavigate();

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErro(null);
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password: senha,
    });
    setLoading(false);
    if (error) {
      setErro('Email ou senha incorretos.');
      return;
    }
    navigate('/');
  }

  const hora = now.getHours();
  const saudacao =
    hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';

  const horaFmt = now.toLocaleTimeString('pt-BR', { hour12: false }).slice(0, 5);
  const dia = String(now.getDate()).padStart(2, '0');
  const mesNome = now.toLocaleDateString('pt-BR', { month: 'short' })
    .replace('.', '').toUpperCase();
  const diaSemana = now.toLocaleDateString('pt-BR', { weekday: 'long' })
    .toUpperCase();

  return (
    <div className="relative min-h-screen bg-paper text-ink overflow-hidden">
      {/* Marca d'água editorial — número do dia gigante no fundo */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex items-center justify-end pr-[5vw] select-none"
      >
        <span className="font-display font-700 text-ink/[0.04] leading-none tracking-tighter"
              style={{ fontSize: 'clamp(20rem, 45vw, 50rem)' }}>
          {dia}
        </span>
      </div>

      {/* Header editorial: data + sistema online */}
      <header className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 lg:px-12 py-5 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-soft">
        <span className="flex items-baseline gap-2">
          <span>{diaSemana}</span>
          <span className="text-ink/30">·</span>
          <span>{dia} {mesNome}</span>
        </span>
        <span className="flex items-baseline gap-2">
          <span className="w-1.5 h-1.5 bg-good rounded-full inline-block animate-pulse-dot translate-y-[1px]" />
          <span>Sistema online</span>
          <span className="text-ink/30">·</span>
          <span className="tabular text-ink">{horaFmt}</span>
        </span>
      </header>

      <main className="relative z-10 min-h-screen flex flex-col items-center justify-center px-6 py-24">
        {/* Logo SAL EXPRESS */}
        <div className="animate-soft-fade" style={{ animationDelay: '0.05s' }}>
          <img
            src="/sal-express-logo.png"
            alt="Sal Express"
            className="h-20 md:h-24 w-auto select-none"
            draggable={false}
          />
        </div>

        {/* Divisor vermelho fino */}
        <div
          className="h-[2px] w-10 bg-sal mt-7 mb-7 animate-soft-fade"
          style={{ animationDelay: '0.2s' }}
        />

        {/* Wordmark Cockpit + subtítulo */}
        <div
          className="text-center animate-soft-fade"
          style={{ animationDelay: '0.3s' }}
        >
          <div className="font-display italic text-4xl md:text-5xl font-500 leading-none text-ink">
            Cockpit
          </div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-soft mt-3">
            Relacionamento · Operação MG-ES
          </div>
        </div>

        {/* Saudação calorosa */}
        <div
          className="text-center mt-14 mb-8 animate-soft-fade"
          style={{ animationDelay: '0.45s' }}
        >
          <h1 className="font-display italic text-3xl md:text-4xl font-500 text-ink">
            {saudacao}.
          </h1>
          <p className="font-display italic text-base text-ink-soft mt-2">
            Bom trabalho hoje.
          </p>
        </div>

        {/* Form */}
        <form
          onSubmit={handleLogin}
          className="w-full max-w-xs space-y-7 animate-soft-fade"
          style={{ animationDelay: '0.6s' }}
        >
          <FormField label="Email" type="email" value={email} onChange={setEmail}
            placeholder="seu@salexpress.com.br" autoFocus />
          <FormField label="Senha" type="password" value={senha} onChange={setSenha}
            placeholder="••••••••" />

          {erro && (
            <div className="border-l-2 border-sal pl-3 py-1 font-mono text-[11px] text-sal animate-soft-fade">
              {erro}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !email || !senha}
            className="group w-full flex items-center justify-center gap-2 mt-2 py-3 font-mono text-xs font-600 uppercase tracking-[0.25em] bg-ink text-paper hover:bg-sal transition-colors duration-200 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-ink"
          >
            {loading ? 'Entrando' : 'Entrar'}
            <span className="inline-block transition-transform duration-200 group-hover:translate-x-1">→</span>
          </button>
        </form>

        {/* Footer editorial */}
        <footer
          className="mt-20 text-center animate-soft-fade"
          style={{ animationDelay: '0.8s' }}
        >
          <p className="font-display italic text-sm text-ink-soft">
            Acesso restrito · operadores e gestão
          </p>
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink/30 mt-2">
            Sal Express · {now.getFullYear()} · v0.4
          </p>
        </footer>
      </main>

      {/* Asterisco rotacionando — canto inferior direito */}
      <div
        aria-hidden="true"
        className="absolute bottom-6 right-6 z-20 font-mono text-sal text-2xl animate-asterisk-spin opacity-60 select-none"
      >
        ✱
      </div>
    </div>
  );
}
```

## 1.5. `FormField` — leve, só underline

```tsx
function FormField({
  label, type, value, onChange, placeholder, autoFocus,
}: {
  label: string;
  type: 'email' | 'password';
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [focused, setFocused] = useState(false);

  return (
    <div className="relative">
      <label className="font-mono text-[10px] uppercase tracking-[0.25em] text-ink-soft block mb-2">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        autoFocus={autoFocus}
        autoComplete={type === 'email' ? 'username' : 'current-password'}
        placeholder={placeholder}
        className="w-full bg-transparent border-0 border-b border-ink/15 pb-2 pt-1 font-mono text-base text-ink placeholder-ink/25 focus:outline-none focus:border-ink/0 tabular"
        style={{ caretColor: 'var(--sal-red, #C8102E)' }}
      />
      <div
        className={`absolute left-0 bottom-0 h-[1px] bg-sal transition-all duration-300 ease-out ${
          focused || value ? 'w-full' : 'w-0'
        }`}
      />
    </div>
  );
}
```

## 1.6. **DELETAR** `CustomCursor`

Se você criou o `CustomCursor.tsx` (crosshair vermelho) na versão dark, **deleta o arquivo e remove qualquer import**. Login v2 usa cursor padrão.

---

# PARTE 2 — Card AGUARDANDO VALIDAÇÃO HUMANA v2 (compacto, 3 botões universais)

## Contexto

Hoje os cards dessa aba estão pesados (sombras grossas, caixas decorativas,
detalhes técnicos sempre visíveis, botões grandes). Precisa ficar **escaneável
em 1 segundo**, principalmente quando a fila tiver 10+ propostas.

Além disso, qualquer card nessa aba deve ter **3 ações universais** (não só
oc=20):

1. **Aprovar e Executar** → IA dispara a ação (lançar oc no SSW, enviar email, etc)
2. **Voltar p/ To-Do** → destrava lock, manda card pra PARA FAZER, **mantém todo pendente** pra aprovação posterior. Rede de segurança em fase de teste.
3. **Rejeitar** → cancela proposta, card vai pro state coerente com a oc atual.

A RPC `voltar_para_to_do(p_todo_id, p_motivo)` já está pronta no backend.

## 2.1. Lógica — 3 botões em TODOS os cards

```tsx
// Aplicar em TODOS os cards na aba AGUARDANDO_VALIDACAO_HUMANA
// Remover qualquer condicional por cod_ultima_ocorrencia que tenha sido feita antes.

<div className="flex items-center gap-1.5">
  <button
    onClick={() => handleAprovar(todo.id)}
    disabled={loading === todo.id}
    title="Executa a ação proposta automaticamente"
    className="flex-1 bg-sal text-paper font-mono text-[10px] font-600 uppercase tracking-wider px-3 py-1.5 hover:bg-ink transition-colors disabled:opacity-40"
  >
    {loading === todo.id ? '...' : 'Aprovar →'}
  </button>

  <button
    onClick={() => handleVoltar(todo.id)}
    disabled={loading === todo.id}
    title="Destrava o card e volta pra aba PARA FAZER. Mantém a proposta disponível pra aprovação posterior."
    className="flex-1 bg-paper text-ink font-mono text-[10px] font-600 uppercase tracking-wider px-3 py-1.5 border border-ink/30 hover:border-ink transition-colors disabled:opacity-40"
  >
    ← Voltar
  </button>

  <button
    onClick={() => handleRejeitar(todo.id)}
    disabled={loading === todo.id}
    title="Cancela a proposta. Card sai do lock pro estado coerente com a oc atual."
    className="px-2 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink/50 hover:text-sal transition-colors disabled:opacity-40"
  >
    Rejeitar
  </button>
</div>
```

**Hierarquia visual** (de mais peso pra menos):

1. **Aprovar →** — vermelho Sal sólido. Ação primária e mais usada.
2. **← Voltar** — outline cinza claro. Saída de emergência sempre presente.
3. **Rejeitar** — só texto, sem borda. Ação rara e definitiva.

## 2.2. Handlers

```tsx
async function handleAprovar(todoId: string) {
  setLoading(todoId);
  const { error } = await supabase.rpc('aprovar_e_executar', { p_todo_id: todoId });
  setLoading(null);
  if (error) { toast.error(error.message); return; }
  toast.success('Aprovado. Executando...');
  queryClient.invalidateQueries(['cards']);
}

async function handleVoltar(todoId: string) {
  setLoading(todoId);
  const { error } = await supabase.rpc('voltar_para_to_do', {
    p_todo_id: todoId,
    p_motivo: null,
  });
  setLoading(null);
  if (error) { toast.error(error.message); return; }
  toast.success('Voltou pra "Para Fazer".');
  queryClient.invalidateQueries(['cards']);
}

async function handleRejeitar(todoId: string) {
  const motivo = window.prompt('Motivo da rejeição (mín 3 chars):');
  if (!motivo || motivo.trim().length < 3) {
    toast.error('Motivo precisa ter ao menos 3 caracteres');
    return;
  }
  setLoading(todoId);
  const { error } = await supabase.rpc('rejeitar_acao', {
    p_todo_id: todoId,
    p_motivo: motivo.trim(),
  });
  setLoading(null);
  if (error) { toast.error(error.message); return; }
  toast.success('Rejeitado.');
  queryClient.invalidateQueries(['cards']);
}
```

## 2.3. Componente do card — versão leve

Substitui o componente atual da aba AGUARDANDO_VALIDACAO_HUMANA.

```tsx
function CardValidacaoHumana({ card, todo }: Props) {
  const [showDetails, setShowDetails] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);

  const proposta = todo.proposta_payload;
  const acao = proposta?.args?.codigo_ssw
    ? `Lançar oc ${proposta.args.codigo_ssw} no SSW`
    : todo.descricao;

  return (
    <div className="bg-paper border border-ink/15 p-4 hover:border-ink/40 transition-colors">

      {/* Header: NF · cliente · oc — 1 linha discreta */}
      <div className="flex items-baseline gap-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft mb-3">
        <span className="text-ink font-600">NF {card.nf}</span>
        <span className="text-ink/30">·</span>
        <span className="truncate">{card.empresa_cliente ?? '—'}</span>
        <span className="text-ink/30">·</span>
        <span>oc {card.cod_ultima_ocorrencia ?? '—'}</span>
      </div>

      {/* Proposta IA — 1 linha clara em destaque editorial */}
      <div className="font-display text-base text-ink leading-tight mb-4">
        {acao}
      </div>

      {/* 3 botões compactos */}
      <div className="flex items-center gap-1.5">
        <button onClick={() => handleAprovar(todo.id)} disabled={loading === todo.id}
          className="flex-1 bg-sal text-paper font-mono text-[10px] font-600 uppercase tracking-wider px-3 py-1.5 hover:bg-ink transition-colors disabled:opacity-40">
          {loading === todo.id ? '...' : 'Aprovar →'}
        </button>
        <button onClick={() => handleVoltar(todo.id)} disabled={loading === todo.id}
          className="flex-1 bg-paper text-ink font-mono text-[10px] font-600 uppercase tracking-wider px-3 py-1.5 border border-ink/30 hover:border-ink transition-colors disabled:opacity-40">
          ← Voltar
        </button>
        <button onClick={() => handleRejeitar(todo.id)} disabled={loading === todo.id}
          className="px-2 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink/50 hover:text-sal transition-colors disabled:opacity-40">
          Rejeitar
        </button>
      </div>

      {/* Detalhes técnicos — collapsed por default */}
      <button
        onClick={() => setShowDetails(!showDetails)}
        className="mt-3 font-mono text-[9px] uppercase tracking-wider text-ink/40 hover:text-ink transition-colors"
      >
        {showDetails ? '▾ ocultar detalhes' : '▸ detalhes técnicos'}
      </button>

      {showDetails && (
        <div className="mt-2 pt-2 border-t border-ink/10 font-mono text-[10px] text-ink-soft space-y-0.5">
          {proposta?.rationale && (
            <div><span className="text-ink/40">motivo:</span> {proposta.rationale}</div>
          )}
          {proposta?.args?.chave_cte && (
            <div><span className="text-ink/40">chave_cte:</span> {proposta.args.chave_cte}</div>
          )}
          {card.responsavel_relacionamento && (
            <div><span className="text-ink/40">operador:</span> {card.responsavel_relacionamento}</div>
          )}
          {card.bastao_synced_at && (
            <div><span className="text-ink/40">sync:</span> {new Date(card.bastao_synced_at).toLocaleString('pt-BR')}</div>
          )}
        </div>
      )}
    </div>
  );
}
```

## 2.4. Mudanças visuais — resumo

| Antes (pesado) | Depois (leve) |
|---|---|
| Bordas `border-2 border-ink` + `shadow-flat` | `border border-ink/15`, sem sombra |
| Header com badges grandes | 1 linha mono discreta |
| Proposta em caixa decorativa | 1 linha em serif Fraunces |
| Rationale + payload sempre visíveis | Collapsed atrás de "▸ detalhes técnicos" |
| Botões `px-6 py-3` (grandes) | Botões `px-3 py-1.5` (compactos) |

**Resultado**: card 50% mais curto na vertical, escaneável em 1 segundo.

---

# O que NÃO mudar

Tudo que está abaixo já existe e **não precisa mexer**:

- `AuthContext.tsx` (provider + `useAuth`)
- `ProtectedRoute.tsx`
- Roteamento (`<Route path="/login">` + `<Route path="/*">` com ProtectedRoute)
- `TopBar.tsx` (com sync indicator real via RPC `minutos_desde_ultimo_sync_bastao`)
- Saudação personalizada pós-login no Kanban
- Botão Sair
- RLS por papel (Caio gestor / Larissa operador)
- Lógica do Kanban + filtros + outras abas

---

# Credenciais (sem mudanças)

| Usuário | Email | Senha |
|---|---|---|
| Caio | `caio@salexpress.com.br` | sua atual |
| Larissa | `relacionamento.farmaceutico@salexpress.com.br` | passar via canal seguro |

---

# Checklist consolidado

**Login v2:**

- [ ] Remover `--midnight`/`--midnight-soft` do CSS se foram adicionadas
- [ ] Remover `colors.midnight`, `keyframes.scanLine`, `keyframes.loginEntry` do Tailwind config
- [ ] Adicionar `keyframes.softFade` + `animation.soft-fade` + `animation.asterisk-spin: 18s`
- [ ] Substituir `LoginPage.tsx` pelo código v2
- [ ] Substituir `FormField` pelo código v2
- [ ] **DELETAR** `CustomCursor.tsx` e qualquer import dele
- [ ] Validar visual: paper claro, logo vermelha em destaque, asterisco rotaciona devagar

**Card validação humana:**

- [ ] **Remover** condicional por `cod_ultima_ocorrencia=20` (se foi feita antes). 3 botões agora em TODOS os cards.
- [ ] Implementar `handleAprovar`, `handleVoltar`, `handleRejeitar` (códigos acima)
- [ ] Refatorar componente do card pra versão compacta
- [ ] Detalhes técnicos collapsed por default
- [ ] Header em 1 linha: NF · cliente · oc
- [ ] Proposta em 1 linha (font-display, sem caixa)
- [ ] 3 botões compactos (`px-3 py-1.5`)
- [ ] Testar fluxo: Aprovar / Voltar / Rejeitar — todos invalidam Kanban

---

# Resultado esperado

**Login**: paper claro warm → logo SAL EXPRESS vermelha aparece com fade
suave → divisor vermelho fino → "Cockpit" italic → "Bom dia." + "Bom
trabalho hoje." → form discreto → botão Entrar preto vira vermelho no
hover. Sensação: jornal de domingo, calmo, convida.

**Card validação**: NF · cliente · oc em 1 linha mono. Proposta em 1
linha serif. 3 botões compactos. Detalhes a 1 clique. Larissa bate o
olho e em 1 segundo decide: aprova, volta pro to-do, ou rejeita.
