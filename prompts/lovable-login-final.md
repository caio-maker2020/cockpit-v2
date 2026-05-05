# Cockpit Sal Express — Tela de login + Auth (prompt único)

> Cole esse prompt INTEIRO no Lovable. Substitui o `lovable-auth-login.md`
> anterior — versão final com identidade visual completa + correção do
> indicador de sync.

---

## Direção criativa: "Estação noturna · cinematic boot"

A tela de login é o **único momento dark mode** do sistema. Depois que o
operador entra, a app vira light (off-white quente, papel jornal). O login
marca a **transição entre fora e dentro do cockpit** — vibe centro de
controle ferroviário noturno, calmo mas alerta.

**Princípios:**
- Fundo quase-preto profundo (`#0A0908`) — mais escuro que o `--ink` do
  app, dá mais drama e foco
- **Logo SAL EXPRESS em vermelho original** como protagonista da tela
- Formulário pequeno e discreto — não compete com a logo
- Movimento sutil: scan line vermelho passa uma vez a cada 6s, cursor
  custom crosshair, indicador online pulsando, asterisco rotacionando lento
- Tipografia editorial GIGANTE pra "Cockpit" (Fraunces serif) que
  contrasta com mono caps embaixo
- Stagger animation no boot: logo → divider → título → form → footer em
  1.2s cinematográficos

**Sobre a logo:** mantém VERMELHO ORIGINAL. É a identidade da empresa,
mudar diminuiria. Em fundo escuro fica ainda mais marcante (vermelho
saturado contra ink).

**Anti-padrões PROIBIDOS:**
- ❌ Gradients (qualquer cor)
- ❌ Glassmorphism / blur backgrounds
- ❌ Sombras pastel macias (`shadow-md` etc.)
- ❌ Border-radius grande em inputs/botões
- ❌ Inter / Roboto / system-ui
- ❌ Genérico "Welcome back" / "Sign in to continue your journey"
- ❌ Background imagery genérico (cidade noturna, gradiente cyan, etc.)

---

## 1. Asset: subir o logo

**Caio precisa subir manualmente** o arquivo da logo SAL EXPRESS no
Lovable como asset estático:

- Caminho: `public/sal-express-logo.png` (ou `.svg`)
- Vermelho `#C8102E` original — não mexer
- Resolução: pelo menos 1200px de largura

Referência no JSX:
```jsx
<img src="/sal-express-logo.png" alt="Sal Express" />
```

---

## 2. CSS variables adicionais (cole no `index.css`)

Junta com as do redesign principal. Adiciona apenas o `--midnight`:

```css
:root {
  /* ... cores existentes do redesign principal ... */
  --midnight: #0A0908;       /* fundo do login — quase-preto profundo */
  --midnight-soft: #14110F;  /* elementos dentro do login */
}
```

---

## 3. Tailwind config (extend) — adições

Junte com o config do redesign principal:

```js
theme: {
  extend: {
    colors: {
      // ... cores existentes do redesign ...
      midnight: { DEFAULT: '#0A0908', soft: '#14110F' },
    },
    keyframes: {
      // ... existentes (pulseDot, ticker, stagger, analogTick) ...
      scanLine: {
        '0%':   { transform: 'translateY(-100%)', opacity: '0' },
        '8%':   { opacity: '0.6' },
        '50%':  { opacity: '0.6' },
        '92%':  { opacity: '0.6' },
        '100%': { transform: 'translateY(100vh)', opacity: '0' },
      },
      loginEntry: {
        '0%':   { opacity: '0', transform: 'translateY(12px) scale(0.97)' },
        '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
      },
      asteriskSpin: {
        '0%':   { transform: 'rotate(0deg)' },
        '100%': { transform: 'rotate(360deg)' },
      },
    },
    animation: {
      // ... existentes ...
      'scan-line':     'scanLine 6s ease-in-out infinite',
      'login-entry':   'loginEntry 0.7s cubic-bezier(0.2, 0.8, 0.2, 1) both',
      'asterisk-spin': 'asteriskSpin 12s linear infinite',
    },
  },
}
```

---

## 4. Tela de Login (`LoginPage.tsx`)

Cria como componente principal da rota `/login`.

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

  // Clock ao vivo no canto
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

  const horaFormatada = now.toLocaleTimeString('pt-BR', { hour12: false });

  return (
    <div className="relative min-h-screen bg-midnight text-paper overflow-hidden cursor-none">
      {/* Custom cursor crosshair vermelho */}
      <CustomCursor />

      {/* Scan line cinematográfico — passa a cada 6s */}
      <div className="pointer-events-none absolute inset-0 z-10">
        <div
          className="absolute left-0 right-0 h-[1px] bg-sal/40 animate-scan-line"
          style={{ boxShadow: '0 0 8px rgba(200,16,46,0.6)' }}
        />
      </div>

      {/* Réguas verticais decorativas (lado direito) */}
      <div className="pointer-events-none absolute top-0 bottom-0 right-8 w-px bg-paper/5 hidden lg:block">
        {Array.from({ length: 20 }).map((_, i) => (
          <div
            key={i}
            className="absolute right-0 h-px bg-paper/10"
            style={{ top: `${5 + i * 4.7}%`, width: i % 5 === 0 ? '12px' : '6px' }}
          />
        ))}
      </div>

      {/* Indicador online — canto superior direito */}
      <div className="absolute top-6 right-6 lg:right-16 z-20 flex items-baseline gap-2 font-mono text-[10px] uppercase tracking-widest text-paper/60">
        <span className="w-1.5 h-1.5 bg-good rounded-full animate-pulse-dot" />
        <span>Sistema online</span>
        <span className="text-paper/30">·</span>
        <span className="tabular text-paper/80">{horaFormatada}</span>
      </div>

      {/* Asterisco rotacionando — canto inferior esquerdo */}
      <div className="absolute bottom-6 left-6 z-20 font-mono text-sal text-2xl animate-asterisk-spin opacity-50 select-none">
        ✱
      </div>

      {/* Conteúdo central */}
      <main className="relative z-20 min-h-screen flex flex-col items-center justify-center px-6 py-12">
        {/* Logo SAL EXPRESS */}
        <div className="animate-login-entry" style={{ animationDelay: '0.1s' }}>
          <img
            src="/sal-express-logo.png"
            alt="Sal Express"
            className="h-24 md:h-28 w-auto select-none"
            draggable={false}
          />
        </div>

        {/* Divider vermelho fino */}
        <div
          className="h-[2px] w-12 bg-sal mt-8 mb-8 animate-login-entry"
          style={{ animationDelay: '0.4s' }}
        />

        {/* Título editorial gigante */}
        <div
          className="text-center animate-login-entry"
          style={{ animationDelay: '0.5s' }}
        >
          <h1 className="font-display text-5xl md:text-6xl font-500 tracking-tight leading-none">
            Cockpit
          </h1>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-paper/50 mt-3">
            Relacionamento · Operação MG-ES
          </p>
        </div>

        {/* Form */}
        <form
          onSubmit={handleLogin}
          className="w-full max-w-xs mt-12 space-y-6 animate-login-entry"
          style={{ animationDelay: '0.7s' }}
        >
          <FormField
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            autoFocus
          />

          <FormField
            label="Senha"
            type="password"
            value={senha}
            onChange={setSenha}
          />

          {erro && (
            <div className="border-l-2 border-sal pl-3 py-1 font-mono text-[11px] text-sal animate-login-entry">
              {erro}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !email || !senha}
            className="group w-full flex items-center justify-center gap-2 mt-8 py-3 font-mono text-xs font-600 uppercase tracking-[0.25em] text-paper border border-paper/30 hover:border-sal hover:bg-sal hover:text-paper transition-colors duration-200 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:border-paper/30 disabled:hover:bg-transparent disabled:hover:text-paper"
          >
            {loading ? 'ENTRANDO' : 'ENTRAR'}
            <span className="inline-block transition-transform duration-200 group-hover:translate-x-1">
              →
            </span>
          </button>
        </form>

        {/* Footer microcopy */}
        <footer
          className="mt-16 text-center animate-login-entry"
          style={{ animationDelay: '1.0s' }}
        >
          <p className="font-display italic text-sm text-paper/40">
            Acesso restrito · operadores e gestão
          </p>
          <p className="font-mono text-[9px] uppercase tracking-widest text-paper/25 mt-2">
            v0.4 · IA + humanos · {new Date().getFullYear()}
          </p>
        </footer>
      </main>
    </div>
  );
}
```

---

## 5. Componente `FormField` (input com underline vermelho que cresce)

```tsx
function FormField({
  label, type, value, onChange, autoFocus,
}: {
  label: string;
  type: 'email' | 'password';
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  const [focused, setFocused] = useState(false);

  return (
    <div className="relative">
      <label className="font-mono text-[10px] uppercase tracking-[0.25em] text-paper/40 block mb-2">
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
        className="w-full bg-transparent border-0 border-b border-paper/20 pb-2 pt-1 font-mono text-base text-paper placeholder-paper/20 focus:outline-none focus:border-paper/0 tabular"
        style={{ caretColor: '#C8102E', cursor: 'text' }}
      />
      {/* Underline vermelho que CRESCE no focus / quando tem valor */}
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

## 6. Componente `CustomCursor` (crosshair vermelho seguindo mouse)

```tsx
function CustomCursor() {
  const [pos, setPos] = useState({ x: -100, y: -100 });
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      setPos({ x: e.clientX, y: e.clientY });
      setVisible(true);
    };
    const leave = () => setVisible(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseleave', leave);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseleave', leave);
    };
  }, []);

  return (
    <div
      className={`pointer-events-none fixed z-50 transition-opacity duration-200 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
      style={{ left: pos.x - 12, top: pos.y - 12, width: 24, height: 24 }}
    >
      <div className="relative w-full h-full">
        <div className="absolute left-1/2 top-0 w-px h-2 bg-sal -translate-x-1/2" />
        <div className="absolute left-1/2 bottom-0 w-px h-2 bg-sal -translate-x-1/2" />
        <div className="absolute top-1/2 left-0 h-px w-2 bg-sal -translate-y-1/2" />
        <div className="absolute top-1/2 right-0 h-px w-2 bg-sal -translate-y-1/2" />
        <div className="absolute left-1/2 top-1/2 w-1 h-1 bg-sal rounded-full -translate-x-1/2 -translate-y-1/2" />
      </div>
    </div>
  );
}
```

**Atenção:** `cursor-none` no root da tela de login esconde o cursor do
sistema. O `CustomCursor` substitui. Os `<input>` têm `cursor-text` inline
pra preservar o caret de digitação. Após login, na app principal, o cursor
volta ao normal automaticamente (porque o `cursor-none` é só na rota /login).

---

## 7. AuthContext (`AuthContext.tsx`)

```tsx
import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

type OperadorContext = {
  id: string;
  nome: string;
  papel: 'gestor' | 'operador';
  email_relacionamento: string | null;
  carteira: string[];
  segmentos: string[];
};

const AuthCtx = createContext<{
  user: any | null;
  operador: OperadorContext | null;
  loading: boolean;
  signOut: () => Promise<void>;
}>({ user: null, operador: null, loading: true, signOut: async () => {} });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<any | null>(null);
  const [operador, setOperador] = useState<OperadorContext | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      if (session?.user) carregarOperador(session.user.id);
      else setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUser(session?.user ?? null);
        if (session?.user) carregarOperador(session.user.id);
        else { setOperador(null); setLoading(false); }
      }
    );
    return () => subscription.unsubscribe();
  }, []);

  async function carregarOperador(userId: string) {
    const { data } = await supabase
      .from('operadores')
      .select('id, nome, papel, email_relacionamento, carteira, segmentos')
      .eq('user_id', userId)
      .eq('ativo', true)
      .maybeSingle();
    setOperador(data ?? null);
    setLoading(false);
  }

  async function signOut() {
    await supabase.auth.signOut();
    setUser(null);
    setOperador(null);
  }

  return (
    <AuthCtx.Provider value={{ user, operador, loading, signOut }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
```

---

## 8. ProtectedRoute (gating)

```tsx
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, operador, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !user) navigate('/login');
  }, [loading, user, navigate]);

  if (loading) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center">
        <span className="inline-flex items-center justify-center w-6 h-6 border border-ink rounded-full">
          <span className="w-[1px] h-3 bg-ink origin-bottom animate-analog-tick" />
        </span>
      </div>
    );
  }

  if (!user) return null;

  if (!operador) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center p-6">
        <div className="max-w-sm bg-paper border-2 border-sal shadow-flat p-6 text-center">
          <div className="font-display text-2xl mb-3">Acesso não liberado</div>
          <p className="font-display italic text-ink-soft text-sm">
            Seu email tá autenticado, mas você não tem cadastro como operador.
            Fala com o Caio pra liberar.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
```

---

## 9. App router

```tsx
<AuthProvider>
  <BrowserRouter>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/*" element={
        <ProtectedRoute>
          <AppLayout />
        </ProtectedRoute>
      } />
    </Routes>
  </BrowserRouter>
</AuthProvider>
```

---

## 10. Top bar (header pós-login) — atualização

Substitui o placeholder `nomeOperador` + corrige o `minutosDesdeUltimoSync`
fake (que mostrava "37min") pelo dado real via RPC nova:

```tsx
import { useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import { supabase } from '@/lib/supabase';

function TopBar() {
  const { operador, signOut } = useAuth();
  const [minSync, setMinSync] = useState<number | null>(null);
  const [now, setNow] = useState(() => new Date());

  // Hora atual (atualiza 1x/seg)
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Indicador de sync REAL — chama RPC e atualiza a cada 30s
  // (sync-bastao roda a cada 5min, então valor oscila entre 0-5)
  useEffect(() => {
    const fetchSync = async () => {
      const { data } = await supabase.rpc('minutos_desde_ultimo_sync_bastao');
      setMinSync(typeof data === 'number' ? data : null);
    };
    fetchSync();
    const id = setInterval(fetchSync, 30_000);
    return () => clearInterval(id);
  }, []);

  const horaAtual = now.toLocaleTimeString('pt-BR', { hour12: false }).slice(0, 5);
  const syncOk = minSync !== null && minSync <= 10; // tolerância 2x o intervalo

  return (
    <header className="bg-ink text-paper border-b-2 border-ink relative z-10">
      <div className="flex items-center h-15 px-6">
        {/* Logo editorial */}
        <div className="flex items-baseline gap-2">
          <span className="font-display text-xl font-700 tracking-tight">Cockpit</span>
          <span className="font-mono text-[10px] uppercase tracking-widest text-paper/60">
            Sal Express · Relacionamento
          </span>
        </div>

        {/* Centro: sync indicator + clock */}
        <div className="ml-auto flex items-center gap-6 font-mono text-xs uppercase tracking-wider">
          <span className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full animate-pulse-dot ${syncOk ? 'bg-good' : 'bg-warn'}`} />
            <span className="text-paper/60">SYNC</span>
            <span className="text-paper">
              {minSync === null ? '—' : minSync === 0 ? 'agora' : `há ${minSync}min`}
            </span>
          </span>
          <span className="text-paper/40">|</span>
          <span className="tabular text-paper">{horaAtual}</span>
        </div>

        {/* Operador */}
        <div className="ml-6 flex items-center gap-3 pl-6 border-l border-paper/20">
          <span className="font-display italic text-sm">
            {operador?.nome ?? '...'}
          </span>
          {operador?.papel === 'gestor' && (
            <span className="font-mono text-[9px] uppercase tracking-wider bg-sal text-paper px-1.5 py-0.5">
              GESTOR
            </span>
          )}
          <button
            onClick={signOut}
            className="text-[10px] uppercase tracking-widest text-paper/60 hover:text-sal"
          >
            Sair
          </button>
        </div>
      </div>
      <div className="h-[2px] bg-sal" />
    </header>
  );
}
```

**Sobre o indicador SYNC**:
- O backend tem cron `sync-bastao-every-5min` que roda a cada 5 minutos
- A nova RPC `minutos_desde_ultimo_sync_bastao()` retorna minutos desde o
  último run com sucesso
- Em condições normais o valor oscila entre **0 e 5 min**
- Se passar de 10min, o dot fica amarelo (`bg-warn`) sinalizando sync atrasado
- O placeholder antigo "há 37min" era valor fake do Lovable — agora é real

---

## 11. Saudação personalizada (linha abaixo do header)

```tsx
function Saudacao({ totalParaFazer }: { totalParaFazer: number }) {
  const { operador } = useAuth();
  const primeiroNome = (operador?.nome ?? '').split(' ')[0];
  const horaAtual = new Date().getHours();
  const saudacao =
    horaAtual < 12 ? 'Bom dia'
    : horaAtual < 18 ? 'Boa tarde'
    : 'Boa noite';

  return (
    <div className="bg-paper-deep px-6 py-3 border-b border-rule font-display italic text-ink-soft text-sm">
      {saudacao}, {primeiroNome}.{' '}
      <span className="font-ui not-italic font-500 text-ink">
        {totalParaFazer} cards aguardando ação.
      </span>
      {totalParaFazer === 0 && (
        <span className="font-mono text-good text-xs ml-2 not-italic">
          ✦ TUDO EM DIA
        </span>
      )}
    </div>
  );
}
```

---

## 12. Filtros do Kanban — sem mudança

A RLS no banco já filtra automaticamente:

- **Caio** (gestor) → vê todos os ~70 cards do banco
- **Larissa** (operador) → vê só cards onde `assigned_operator_id = ela`
  OR `pagador ∈ carteira (193 CNPJs)` OR `segmento_codigo ∈ {007, 010, 018}`

Os filtros das colunas (PARA FAZER / AGUARDANDO VALIDAÇÃO HUMANA / etc.)
continuam idênticos — cada usuário vê o subconjunto que tem direito.

---

## 13. Credenciais ativas

| Usuário | Email | Senha | Papel |
|---|---|---|---|
| **Caio** | `caio@salexpress.com.br` | (sua atual no Supabase) | gestor (vê tudo) |
| **Larissa** | `relacionamento.farmaceutico@salexpress.com.br` | passar via canal seguro | operador (filtrado por carteira + segmentos) |

A senha temporária da Larissa eu te entrego direto, você compartilha com
ela. Quando ela quiser trocar, vai em **Settings → Security** do Supabase
Auth (ou implementamos tela de "trocar senha" depois — não bloqueante).

---

## 14. Checklist final

- [ ] Subir logo SAL EXPRESS em `public/sal-express-logo.png`
- [ ] Adicionar `--midnight` nas CSS vars
- [ ] Adicionar `midnight` em colors + keyframes/animações novas no Tailwind config
- [ ] Criar `LoginPage.tsx` exato como spec
- [ ] Criar `FormField` + `CustomCursor` componentes
- [ ] Criar `AuthContext` + `AuthProvider`
- [ ] Criar `ProtectedRoute`
- [ ] Atualizar router pra envolver app inteira
- [ ] Atualizar `TopBar` pra usar `useAuth().operador` + RPC `minutos_desde_ultimo_sync_bastao`
- [ ] Saudação personalizada com `operador.nome`
- [ ] Botão Sair funcionando
- [ ] Testar login Caio (gestor → vê tudo)
- [ ] Testar login Larissa (operador → vê só os do segmento dela)
- [ ] Testar erro de login (senha errada → mensagem com border vermelha à esquerda)
- [ ] Testar logout → redireciona pra `/login`
- [ ] Validar animação cinematográfica de boot (logo → divider → título → form → footer em sequência)
- [ ] Validar custom cursor (crosshair vermelho seguindo mouse)
- [ ] Validar scan line passando ~6s
- [ ] Validar indicador SYNC mostrando 0-5min real (não mais "37min" fake)

---

## Resultado esperado

Operador abre o sistema → tela quase-preta → logo SAL EXPRESS aparece com
fade elegante → divider vermelho fino → título "Cockpit" surge embaixo em
serif gigante → subtítulo "Relacionamento · Operação MG-ES" em mono caps →
formulário materializa → digita email/senha (underline vermelho cresce no
focus, caret vermelho) → clica ENTRAR (seta `→` desliza) → tela transiciona
pra paper claro do Kanban com saudação personalizada.

Sensação: **entrar num avião. Ou num centro de controle. Algo importante.**
Não "fazer login num SaaS qualquer".
