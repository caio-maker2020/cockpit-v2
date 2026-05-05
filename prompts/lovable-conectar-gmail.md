# Cockpit — Botão "Conectar Gmail" pra operadora

> Cole esse prompt INTEIRO no Lovable.
>
> **NÃO mexe** em outras telas/funcionalidades existentes. Adiciona 1 botão
> em 1 lugar específico.

---

## Contexto

Cada operadora autoriza UMA VEZ o Cockpit a enviar emails em nome dela
via Gmail (OAuth Workspace). Depois disso, todos os emails automáticos
do sistema saem direto da inbox dela com a reputação do Gmail
(zero spam, zero DKIM/DNS necessário).

A coluna `operadores.gmail_oauth_credentials` (jsonb) guarda o
refresh_token. Se `null` → não conectada. Se preenchida → conectada com
o `email` que está no jsonb.

---

## 1. Onde colocar o botão

Em alguma tela de **configuração/perfil** acessível pela operadora —
pode ser:

- Settings/Configurações dela (se existe)
- Card no topo do Kanban se ela ainda não conectou
- Página dedicada `/configuracoes/email` ou similar

Se nada disso existe, criar uma **página simples** `/configuracoes` com
1 seção "Email do Cockpit" e o botão dentro.

## 2. Componente `ConectarGmailCard`

```tsx
function ConectarGmailCard() {
  const { user } = useAuth(); // hook existente do projeto
  const queryClient = useQueryClient();
  const [conectando, setConectando] = useState(false);

  // Busca status atual (operador tem credentials?)
  const { data: operador } = useQuery({
    queryKey: ['operador-gmail', user?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('operadores')
        .select('id, nome, email_relacionamento, gmail_oauth_credentials')
        .eq('user_id', user!.id)
        .maybeSingle();
      return data;
    },
    enabled: !!user?.id,
  });

  const conectado = !!operador?.gmail_oauth_credentials?.email;
  const emailConectado = operador?.gmail_oauth_credentials?.email;
  const conectadoEm = operador?.gmail_oauth_credentials?.conectado_em;

  async function handleConectar() {
    setConectando(true);
    const { data, error } = await supabase.functions.invoke('oauth-gmail-start');
    setConectando(false);
    if (error || !data?.ok) {
      toast.error(error?.message ?? data?.error ?? 'Erro ao iniciar OAuth');
      return;
    }
    // Redireciona o navegador da operadora pra Google
    window.location.href = data.auth_url;
  }

  async function handleDesconectar() {
    if (!operador?.id) return;
    if (!confirm('Desconectar o Gmail? Os próximos emails voltam pra Postmark (podem cair em spam).')) return;
    const { error } = await supabase
      .from('operadores')
      .update({ gmail_oauth_credentials: null })
      .eq('id', operador.id);
    if (error) { toast.error(error.message); return; }
    toast.success('Gmail desconectado.');
    queryClient.invalidateQueries({ queryKey: ['operador-gmail'] });
  }

  return (
    <div className="bg-paper border border-ink/15 p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-mono text-[11px] uppercase tracking-wider text-ink">
          📧 Email do Cockpit
        </h3>
        {conectado ? (
          <span className="font-mono text-[10px] uppercase tracking-wider text-green-700 bg-green-50 px-2 py-0.5 border border-green-300">
            ✓ Conectado
          </span>
        ) : (
          <span className="font-mono text-[10px] uppercase tracking-wider text-amber-700 bg-amber-50 px-2 py-0.5 border border-amber-300">
            ⚠ Não conectado
          </span>
        )}
      </div>

      {conectado ? (
        <>
          <p className="text-sm text-ink/70 mb-3">
            Os emails automáticos do Cockpit estão saindo de{' '}
            <strong>{emailConectado}</strong>.
            {conectadoEm && (
              <span className="text-ink/40 text-xs block mt-1">
                Conectado em {new Date(conectadoEm).toLocaleString('pt-BR')}
              </span>
            )}
          </p>
          <button
            onClick={handleDesconectar}
            className="bg-paper text-ink font-mono text-[10px] font-600 uppercase tracking-wider px-3 py-1.5 border border-ink/30 hover:border-ink transition-colors"
          >
            Desconectar
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-ink/70 mb-4">
            Conecte sua conta Gmail do Workspace pra que os emails automáticos
            do Cockpit saiam direto da sua caixa. Sem isso, os emails podem
            cair em spam dos clientes.
          </p>
          <button
            onClick={handleConectar}
            disabled={conectando}
            className="bg-sal text-paper font-mono text-[10px] font-600 uppercase tracking-wider px-4 py-2 hover:bg-ink transition-colors disabled:opacity-40"
          >
            {conectando ? 'Abrindo Google...' : '🔐 Conectar Gmail'}
          </button>
          <p className="text-[11px] text-ink/40 mt-3">
            Você vai ser redirecionado pra accounts.google.com pra autorizar.
            Permissão pedida: enviar emails em nome da sua conta. Pode revogar
            a qualquer momento.
          </p>
        </>
      )}
    </div>
  );
}
```

## 3. Comportamento

1. Operadora clica **"Conectar Gmail"**
2. Frontend chama Edge Function `oauth-gmail-start` (auth via Bearer)
3. Backend retorna `{ auth_url }`
4. Frontend faz `window.location = auth_url`
5. Browser dela vai pra accounts.google.com
6. Ela autoriza com a conta `relacionamento.farmaceutico@salexpress.com.br`
7. Google redireciona pra Vercel callback
8. Callback troca code por refresh_token, salva no banco
9. Página HTML de sucesso aparece pra ela
10. Ela fecha aba e volta pro Cockpit
11. Status do card vira "✓ Conectado"

## 4. Checklist

- [ ] Adicionar componente `ConectarGmailCard` numa tela de configuração da operadora
- [ ] Garantir que `useAuth` retorna `user.id` (mesma chave que está em `operadores.user_id`)
- [ ] Testar fluxo end-to-end:
  - [ ] Card mostra "⚠ Não conectado"
  - [ ] Clica "Conectar Gmail" → vai pro Google
  - [ ] Autoriza → redirect pra Vercel → página de sucesso
  - [ ] Volta pro Cockpit → card mostra "✓ Conectado: relacionamento.farmaceutico@salexpress.com.br"
  - [ ] Botão "Desconectar" volta pro estado inicial

---

## Resultado esperado

Larissa conecta uma vez. Daí pra frente, todo email que o Cockpit
disparar pelo nome dela sai da inbox dela mesma — sem cair em spam.
