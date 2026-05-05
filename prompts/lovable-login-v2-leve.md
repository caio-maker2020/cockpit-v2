# Cockpit Sal Express — Tela de login v2 (leve, amistosa, editorial)

> Cole esse prompt INTEIRO no Lovable. **Substitui** o login anterior
> (`lovable-login-final.md` da versão noturna). Mantém todo o sistema de
> auth (AuthContext, ProtectedRoute, TopBar, Saudacao) — só troca a tela
> visual de `/login` e ajusta Tailwind config.

---

## Direção criativa: "Manhã na estação · papel timbrado moderno"

A versão anterior do login era dark mode cinematográfico — pesada e
intimidadora. **Inverte tudo.** Login agora é uma tela LEVE, AMISTOSA e
EDITORIAL — referência: capa de revista de domingo + papel timbrado de
empresa centenária + calma de manhã antes do expediente. Tem que dar
vontade de entrar, não medo.

**Princípios:**

- **Fundo `--paper` claro** (mesmo do app pós-login) — continuidade visual,
  sensação de "você já está em casa"
- **Logo SAL EXPRESS vermelha em destaque** — fundo claro deixa a marca
  ainda mais presente que no fundo escuro
- **Saudação editorial calorosa antes do form** — "Bom dia.", "Boa tarde.",
  "Boa noite." em Fraunces serif italic gigante. Forma de receber a pessoa
  como cliente em hotel boutique, não como funcionário de SaaS
- **Form quase invisível** — sem caixas, sem bordas grossas. Só labels mono
  caps + inputs com underline cinza que vira vermelho no focus
- **Marca d'água editorial discreta** — número GIGANTE do dia atual ("30")
  em opacity 4% no fundo, lembra revista editorial
- **Asterisco vermelho rotaciona MUITO devagar** (15s/giro) — toque charm,
  não chama atenção
- **Sem cursor custom, sem scan line, sem stagger cinematográfico** — só um
  fade-in suave de 0.6s e pronto. Calmo é o ponto

**Por que funciona:**
- Operador abre 30x por dia → tem que ser leve, não dramático
- Light mode + serif = editorial confiável (NYT vibe), não SaaS genérico
- Saudação personalizada por hora cria conexão humana imediata
- Logo vermelha contra paper warm é a coisa mais marcante da tela —
  identidade da empresa em primeiro plano

**Anti-padrões PROIBIDOS:**

- ❌ Gradients
- ❌ Glassmorphism / blur
- ❌ Sombras macias (`shadow-md`, `shadow-lg`)
- ❌ Border-radius grande
- ❌ Inter / Roboto / system-ui
- ❌ "Welcome back!" / "Sign in to continue"
- ❌ Imagem de fundo (foto de cidade, montanha, etc)
- ❌ Cursor custom (deixa o do sistema, mais natural)
- ❌ Animações cinematográficas pesadas (scan line, slide grande, etc)

---

## 1. Asset: logo

Já existe em `public/sal-express-logo.png` (do prompt anterior). Usa o mesmo
arquivo. Vermelho original, **não muda cor**.

```jsx
<img src="/sal-express-logo.png" alt="Sal Express" />
```

---

## 2. CSS variables — REMOVER `--midnight`

Se você adicionou `--midnight` e `--midnight-soft` no CSS pelo prompt
anterior, **REMOVA**. Login v2 usa apenas as cores existentes do app
(`--paper`, `--ink`, `--sal`, etc.). Nenhuma variável nova.

---

## 3. Tailwind config — limpeza + adições mínimas

**Remover** (do prompt v1):
- `colors.midnight` (não usado mais)
- `keyframes.scanLine` e `animation.scan-line`
- `keyframes.loginEntry` e `animation.login-entry` (versão cinematográfica)
- `keyframes.asteriskSpin` (mantém, mas com timing mais lento)

**Adicionar/ajustar**:

```js
theme: {
  extend: {
    keyframes: {
      // ... existentes do redesign principal (pulseDot, ticker, stagger, analogTick) ...
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
      // ... existentes ...
      'asterisk-spin': 'asteriskSpin 18s linear infinite', // bem lento, charm
      'soft-fade':     'softFade 0.6s ease-out both',
    },
  },
}
```

---

## 4. Tela de Login (`LoginPage.tsx`) — versão leve

Substitui completamente o `LoginPage` da versão anterior.

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

      {/* Conteúdo principal — flex centralizado */}
      <main className="relative z-10 min-h-screen flex flex-col items-center justify-center px-6 py-24">

        {/* Logo SAL EXPRESS — protagonista vermelha */}
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

        {/* Saudação calorosa — coração da tela */}
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
          <FormField
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            placeholder="seu@salexpress.com.br"
            autoFocus
          />
          <FormField
            label="Senha"
            type="password"
            value={senha}
            onChange={setSenha}
            placeholder="••••••••"
          />

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
            <span className="inline-block transition-transform duration-200 group-hover:translate-x-1">
              →
            </span>
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

      {/* Asterisco rotacionando — canto inferior direito, charm sutil */}
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

---

## 5. Componente `FormField` — leve, só underline

Substitui o `FormField` da versão anterior. Mantém o efeito do underline
vermelho que cresce no focus, mas sem a barra grossa branca contra fundo
escuro. Tudo bem mais sutil, fundo claro.

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
      {/* Underline vermelho que cresce no focus / quando tem valor */}
      <div
        className={`absolute left-0 bottom-0 h-[1px] bg-sal transition-all duration-300 ease-out ${
          focused || value ? 'w-full' : 'w-0'
        }`}
      />
    </div>
  );
}
```

---

## 6. REMOVER componente `CustomCursor`

Se você criou o componente `CustomCursor` (crosshair vermelho) na versão
anterior, **deleta o arquivo e remove qualquer import**. Login v2 usa o
cursor padrão do sistema — mais natural, mais amistoso, menos "interface
de estação espacial".

---

## 7. O que NÃO mudar (mantém igual ao prompt anterior)

Tudo que está abaixo já existe e **não precisa mexer**:

- `AuthContext.tsx` (provider + `useAuth`)
- `ProtectedRoute.tsx`
- Roteamento (`<Route path="/login" ...>` + `<Route path="/*" element={<ProtectedRoute>...}>`)
- `TopBar.tsx` (com sync indicator real via RPC)
- Saudação personalizada pós-login no Kanban
- Botão Sair
- RLS por papel (Caio gestor / Larissa operador)

---

## 8. Credenciais (sem mudanças)

| Usuário | Email | Senha |
|---|---|---|
| **Caio** | `caio@salexpress.com.br` | (sua atual) |
| **Larissa** | `relacionamento.farmaceutico@salexpress.com.br` | (passar via canal seguro) |

---

## 9. Checklist v2

- [ ] Remover `--midnight`/`--midnight-soft` do `index.css` se foram adicionadas
- [ ] Remover `colors.midnight`, `keyframes.scanLine`, `keyframes.loginEntry` do Tailwind config
- [ ] Adicionar `keyframes.softFade` + `animation.soft-fade` no Tailwind
- [ ] Ajustar `animation.asterisk-spin` pra `18s` (mais lento)
- [ ] Substituir `LoginPage.tsx` pelo código v2
- [ ] Substituir `FormField` pelo código v2 (sem caret vermelho contra fundo escuro, sem cursor-text inline)
- [ ] **DELETAR** `CustomCursor.tsx` e qualquer import dele
- [ ] Confirmar que `<Route path="/login">` continua apontando pro `LoginPage`
- [ ] Testar com fundo paper claro: visualmente leve, logo vermelha em destaque
- [ ] Testar saudação muda com a hora (mock alterando hora do sistema, ou só testar visual)
- [ ] Testar erro de login (mensagem com border vermelho à esquerda)
- [ ] Confirmar que cursor é padrão do sistema (NÃO crosshair)
- [ ] Confirmar marca d'água do dia ("30") aparece sutil no fundo

---

## Resultado esperado

Operador abre `/login` → tela paper claro warm → header sutil mostra dia da
semana + hora atual + ponto verde "sistema online" → logo SAL EXPRESS
aparece em vermelho no centro com fade suave → divisor vermelho fino →
"Cockpit" em itálico calmo → grande "Bom dia." italic + microcopy "Bom
trabalho hoje." → form discreto com underlines que ganham vermelho no
focus → botão "Entrar →" preto que fica vermelho no hover → footer
editorial → asterisco vermelho gira muito devagar no canto.

Sensação: **abrir o jornal de domingo. Calmo. Familiar. Convida a entrar.**
Não "fazer login num sistema corporativo".

A logo vermelha contra fundo paper é a coisa mais marcante da tela — a
marca da empresa em primeiro plano, sem competição.
