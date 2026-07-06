PROMPT Lovable — FIX aba ⚠️ CONFLITOS "Erro ao carregar conflitos"

## Sintoma
A aba **⚠️ CONFLITOS** mostra **"Erro ao carregar conflitos"** + botão TENTAR NOVAMENTE.
Acontece com o operador (ex.: Victor) enquanto as outras abas (Tratativas, Extravios…) carregam
normal. Logo a sessão/login dele está OK — é só o fetch desta aba que está quebrando.

## Causa (confirmada no backend — NÃO é o banco)
O backend está 100% saudável. A view existe, tem GRANT SELECT pra `authenticated`, a RLS por
operador funciona e a query do operador retorna os cards dele (Victor tem 3 cards BUNZL na fila).
Ou seja: **o erro está no código desta aba no front** — provavelmente (a) fetch via `fetch()`
com URL/headers hardcoded em vez do client `supabase`, ou (b) a query/endpoint errado, ou (c) o
erro real está sendo engolido por um `catch` genérico que só mostra "Erro ao carregar".

## O que fazer

### 1. Buscar SEMPRE pelo client `supabase` (nunca `fetch` cru)
Garanta que a aba use exatamente isto (sem `fetch(`${VITE_SUPABASE_URL}/rest/v1/...`)`, sem
montar header `apikey`/`Authorization` na mão — o client já cuida):
```ts
const { data, error } = await supabase
  .from('v_cards_requer_atencao')
  .select('*')
  .order('detectada_em', { ascending: false });

if (error) {
  // NÃO engolir: logar o erro real e mostrar a mensagem do PostgREST
  console.error('[CONFLITOS] erro ao carregar v_cards_requer_atencao:', {
    message: error.message, code: error.code, details: error.details, hint: error.hint,
  });
  // mostrar o erro real na UI (pelo menos enquanto debugamos)
  setErro(`Erro ao carregar conflitos: ${error.message}${error.code ? ` (${error.code})` : ''}`);
  return;
}
```
Colunas que a view devolve: `card_id, nf, ctrc, state, empresa_cliente, assigned_operator_id,
de_oc, para_oc, oc_fora_escopo, de_state, origem_pass, detectada_em`. Não invente coluna nova
no `.select()` nem no `.order()` — só essas existem.

### 2. Não tratar "lista vazia" como erro
`data` pode vir `[]` (zero conflitos é o estado normal/saudável). Vazio **não** é erro:
- `error` presente → tela de erro (com a mensagem real do item 1).
- `error` ausente e `data.length === 0` → estado vazio **"Não existe conflitos neste momento"**.
- `error` ausente e `data.length > 0` → lista.

### 3. Realtime não pode derrubar o carregamento
Se a aba assina realtime em `cards`, um erro/timeout na subscription **não** pode jogar a UI no
estado de erro. Isole: o carregamento inicial é o `select` acima; a subscription só faz refetch.
Se a subscription falhar, no máximo cai pro refetch a cada ~30s — nunca "Erro ao carregar".

### 4. Confirmar que é a view certa
A fonte é a view **`v_cards_requer_atencao`** (não uma RPC, não uma edge function, não
`v_mudancas_suspeitas`). Se o código atual estiver chamando outro nome/endpoint, troque pra essa
view com o `.from()` do item 1.

## Resultado esperado
A aba carrega os cards de conflito do operador (ou "Não existe conflitos neste momento" quando
vazio). Se ainda der erro, a mensagem agora mostra o motivo real do PostgREST (item 1) em vez do
genérico — me mande esse texto que eu fecho no backend.
