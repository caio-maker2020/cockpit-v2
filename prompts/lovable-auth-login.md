# Cockpit — Tela de login + Auth context (complemento do redesign)

> Cole esse prompt junto com o `lovable-redesign-completo.md`. Adiciona
> autenticação via Supabase Auth — sem isso ninguém entra no Cockpit.

## Contexto

- Backend já tem RLS ativo. Sem login, todas as queries retornam vazio (RLS bloqueia anônimo).
- 2 usuários criados:
  - **Caio**: `caio@salexpress.com.br` — papel `gestor` — vê tudo
  - **Larissa**: `relacionamento.farmaceutico@salexpress.com.br` — papel `operador` — vê só cards do segmento dela (007/010/018) e cards atribuídos a ela
- Filtro automático via RLS (front não precisa fazer lógica de visibilidade).

## 1. Tela de login

Coloca como rota raiz `/login` (ou ProtectedRoute envolvendo tudo).

**Visual** (mantém estética ferroviário-modernista):

```jsx
<div className="min-h-screen bg-paper flex items-center justify-center p-6">
  <div className="w-full max-w-sm">
    {/* Logo editorial */}
    <div className="mb-8 text-center">
      <div className="font-display text-3xl font-700 tracking-tight text-ink">
        Cockpit
      </div>
      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-soft mt-1">
        Sal Express · Relacionamento
      </div>
      <div className="h-[2px] w-12 bg-sal mx-auto mt-4"></div>
    </div>

    {/* Card de login */}
    <form
      onSubmit={handleLogin}
      className="bg-paper border-2 border-ink shadow-flat p-6 space-y-4"
    >
      <div>
        <label className="font-mono text-[10px] uppercase tracking-widest text-ink-soft block mb-1">
          Email
        </label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
          className="w-full px-3 py-2 bg-paper-deep border-2 border-ink font-mono text-sm focus:outline-none focus:border-sal focus:shadow-flat-sm"
          placeholder="seu@salexpress.com.br"
        />
      </div>

      <div>
        <label className="font-mono text-[10px] uppercase tracking-widest text-ink-soft block mb-1">
          Senha
        </label>
        <input
          type="password"
          value={senha}
          onChange={(e) => setSenha(e.target.value)}
          required
          className="w-full px-3 py-2 bg-paper-deep border-2 border-ink font-mono text-sm focus:outline-none focus:border-sal focus:shadow-flat-sm"
        />
      </div>

      {erro && (
        <div className="bg-sal-tint border border-sal text-sal-deep font-mono text-xs px-3 py-2">
          {erro}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full bg-sal text-paper font-mono text-xs font-600 uppercase tracking-widest px-6 py-3 border-2 border-ink shadow-flat hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-flat-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:opacity-40 transition-all"
      >
        {loading ? 'Entrando...' : 'Entrar →'}
      </button>
    </form>

    <p className="font-display italic text-xs text-ink-soft text-center mt-6">
      Acesso restrito · Sal Express
    </p>
  </div>
</div>
```

## 2. Lógica do login

```ts
async function handleLogin(e) {
  e.preventDefault();
  setLoading(true);
  setErro(null);

  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password: senha,
  });

  setLoading(false);

  if (error) {
    setErro('Email ou senha incorretos. Tenta de novo.');
    return;
  }

  // Login OK → redireciona pro Kanban
  // (auth context dispara automaticamente)
  navigate('/');
}
```

## 3. Auth Context (envolve a app inteira)

```tsx
// AuthContext.tsx
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

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [operador, setOperador] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Pega sessão atual
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      if (session?.user) {
        carregarOperador();
      } else {
        setLoading(false);
      }
    });

    // Listen pra mudança de auth
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUser(session?.user ?? null);
        if (session?.user) {
          carregarOperador();
        } else {
          setOperador(null);
          setLoading(false);
        }
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  async function carregarOperador() {
    const { data, error } = await supabase
      .from('operadores')
      .select('id, nome, papel, email_relacionamento, carteira, segmentos')
      .eq('user_id', (await supabase.auth.getUser()).data.user?.id)
      .eq('ativo', true)
      .maybeSingle();

    if (error) console.error('Erro ao carregar operador:', error);
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

## 4. ProtectedRoute (gating)

```tsx
function ProtectedRoute({ children }) {
  const { user, operador, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !user) navigate('/login');
  }, [loading, user, navigate]);

  if (loading) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center">
        <AnalogClock />
      </div>
    );
  }

  if (!user) return null;

  if (!operador) {
    // User logado mas sem cadastro em operadores — bloqueio explícito
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center p-6">
        <div className="max-w-sm bg-paper border-2 border-sal shadow-flat p-6 text-center">
          <div className="font-display text-xl mb-2">Acesso não liberado</div>
          <p className="font-display italic text-ink-soft text-sm">
            Seu email tá autenticado, mas você não tem cadastro como operador.
            Fala com o Caio pra liberar.
          </p>
        </div>
      </div>
    );
  }

  return children;
}
```

Envolve a app:

```tsx
<AuthProvider>
  <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/*" element={<ProtectedRoute><AppLayout /></ProtectedRoute>} />
  </Routes>
</AuthProvider>
```

## 5. Header — usar dados do operador real

No Top bar (do redesign), substitui `nomeOperador` placeholder:

```tsx
const { operador, signOut } = useAuth();

<span className="font-display italic text-sm">
  {operador?.nome ?? '...'}
</span>

{operador?.papel === 'gestor' && (
  <span className="font-mono text-[9px] uppercase tracking-wider bg-sal text-paper px-1.5 py-0.5 ml-2">
    GESTOR
  </span>
)}

<button onClick={signOut} className="text-[10px] uppercase tracking-widest text-paper/60 hover:text-sal">
  Sair
</button>
```

## 6. Saudação personalizada

```tsx
const { operador } = useAuth();
const primeiroNome = operador?.nome.split(' ')[0] ?? '';
const horaAtual = new Date().getHours();
const saudacao = horaAtual < 12 ? 'Bom dia' : horaAtual < 18 ? 'Boa tarde' : 'Boa noite';
```

## 7. Filtros do Kanban — RLS faz tudo automaticamente

Não precisa adicionar `.eq('assigned_operator_id', ...)` ou `.in('segmento_codigo', ...)` nos filtros. **A RLS no banco já filtra**:

- Caio (gestor) → vê todos os 69+ cards do banco.
- Larissa (operador) → vê apenas cards onde `assigned_operator_id = id da Larissa` OU `pagador ∈ carteira (193 CNPJs)` OU `segmento_codigo ∈ {007, 010, 018}`.

Os filtros do Kanban v2 (PARA FAZER, AGUARDANDO VALIDAÇÃO HUMANA, etc.) continuam idênticos — só que cada usuário vê o subconjunto que tem direito.

## 8. Credenciais iniciais

| Usuário | Email | Senha temporária |
|---|---|---|
| Caio (gestor) | `caio@salexpress.com.br` | (já existente — usa a sua atual) |
| Larissa (operador) | `relacionamento.farmaceutico@salexpress.com.br` | **passar pelo canal seguro** |

A senha da Larissa eu mostro pro Caio aqui no terminal, ele compartilha com ela via canal seguro. Larissa pode trocar via Supabase Auth (futura tela de "Trocar senha" — não bloqueante pro MVP).

## 9. Forçar troca de senha no primeiro login (opcional, próximo passo)

Pra MVP de segunda, pode pular. Se quiser implementar depois:

```tsx
// Marca em user_metadata.precisa_trocar_senha=true ao criar
// Após login, ProtectedRoute checa e redireciona pra /trocar-senha
```

Ou usar o fluxo nativo do Supabase com `inviteUserByEmail` + link de magic password reset.

## 10. Checklist de implementação Auth

- [ ] Criar `AuthProvider` (context)
- [ ] Criar `LoginPage` (rota `/login`)
- [ ] Criar `ProtectedRoute` que envolve a app
- [ ] Substituir `nomeOperador` placeholder no header pelo `useAuth().operador.nome`
- [ ] Saudação personalizada com `operador.nome`
- [ ] Botão Sair no header
- [ ] Testar com Caio (gestor — vê tudo) e Larissa (operador — vê só os dela)
- [ ] Estado de loading no boot da app (mostra `AnalogClock`)
- [ ] Estado de erro "operador não cadastrado" se user_id auth não bate em operadores

---

Cola isso DEPOIS do prompt principal. Lovable consolida tudo numa app só.
