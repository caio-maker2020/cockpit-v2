# Lovable — Aba AGUARDANDO VOCÊ ordenada por mais antigo + cadastro de nome do contato

**Data:** 2026-05-27
**Backend:** `executor` já deployado. `{primeiro_nome}` agora resolve em cascata:
1. `contatos_cliente.nome_pessoa` cadastrado pelo email destinatário
2. Derivado do email (`allyson.ferreira@...` → `Allyson`)
3. Fallback empresa (comportamento legado)

Faltam 2 mudanças no front:

---

## 1. Ordenação da aba AGUARDANDO VOCÊ

Hoje a aba mostra cards em ordem arbitrária (provavelmente `created_at DESC`). Mudar para **mais antigo primeiro** pela data da última ocorrência no Bastão — operador foca no que está parado há mais tempo e limpa primeiro.

**Query atual (presumida):**

```ts
const { data: cards } = await supabase
  .from("cards")
  .select("...")
  .eq("state", "AGUARDANDO_VALIDACAO_HUMANA")
  .eq("lock_aguardando_validacao", true)
  .order("created_at", { ascending: false });
```

**Mudar para:**

```ts
const { data: cards } = await supabase
  .from("cards")
  .select("...")
  .eq("state", "AGUARDANDO_VALIDACAO_HUMANA")
  .eq("lock_aguardando_validacao", true)
  .order("bastao_data_ultima_ocorrencia", { ascending: true, nullsFirst: false })
  .order("created_at", { ascending: true });           // desempate quando datas iguais
```

**Regra:** `bastao_data_ultima_ocorrencia` é DATE (granularidade dia). Cards de 20/05 aparecem antes de 26/05. Quando 2+ cards têm a mesma data, desempate por `created_at ASC` (o mais antigo no Cockpit primeiro).

**Aplicar nas abas:**
- AGUARDANDO VOCÊ (principal)
- CLIENTE RESPONDEU (também útil — operador limpa primeiro o cliente que respondeu há mais tempo)

Manter outras abas (Inbox geral, Histórico, etc) com ordenação atual se já estiverem OK.

---

## 2. Cadastro/edição do nome do contato

A tabela `contatos_cliente` já tem coluna `nome_pessoa`. Hoje preenchida via planilha de import, mas alguns CNPJs ficaram sem (genéricos `comercial@`, `sac@`, etc).

**Adicionar na aba CADASTROS → CONTATOS:**

Coluna "Nome da pessoa" editável inline. Quando operador edita, salva via:

```ts
async function atualizarNomePessoa(contatoId: string, novoNome: string) {
  const { error } = await supabase
    .from("contatos_cliente")
    .update({ nome_pessoa: novoNome.trim() || null })
    .eq("id", contatoId);

  if (error) {
    toast.error(`Não consegui salvar: ${error.message}`);
    return;
  }
  toast.success("Nome atualizado");
}
```

**Tabela visual (sugestão):**

```
┌─ Contatos do operador ─────────────────────────────────────────────┐
│ Email                       Cliente            Nome (editável)     │
│ allyson.ferreira@althaia    ALTHAIA            [Allyson         ] │
│ comercial@lifenutri         LIFE NUTRI         [               ✏] │
│ giovanna.andrade@isapa      ISAPA              [Giovanna        ] │
│ ...                                                                │
└────────────────────────────────────────────────────────────────────┘
```

- Input texto livre (até 50 chars).
- Quando vazio + salvar: grava NULL (executor cai no fallback derivação ou empresa).
- Validação opcional: mostrar warning "este email parece genérico (comercial@) — recomendado deixar em branco".

---

## 3. Preview do que o cliente vai ver

Bônus: no composer de email, mostrar visualmente como o `{primeiro_nome}` foi resolvido. Ajuda operador a perceber se ficou ruim e ajustar antes:

```tsx
<small className="text-ink-mute italic">
  📨 Email vai começar com: "Olá {primeiroNomeResolvido}," ·
  {nomeOrigemFonte === "contato" && "do cadastro do contato"}
  {nomeOrigemFonte === "email" && `derivado do email ${emailDestino}`}
  {nomeOrigemFonte === "empresa" && `usando o nome da empresa (sem nome cadastrado)`}
  {nomeOrigemFonte === "empresa" && (
    <a href={`/cadastros/contatos?email=${emailDestino}`}>
      → Cadastrar nome do contato
    </a>
  )}
</small>
```

(Opcional — o executor já faz o lookup automaticamente, mas mostrar a fonte ajuda transparência.)

---

## Validação

1. Card com email `allyson.ferreira@althaia.com.br` → email gerado começa com "Olá Allyson," (mesmo sem cadastro manual).
2. Card com email `comercial@lifenutri.com.br` (genérico) → cai no fallback empresa: "Olá LIFE NUTRI," (operador pode cadastrar nome no Cadastros).
3. Aba AGUARDANDO VOCÊ: card oc=49 do dia 20/05 aparece ANTES do card oc=10 do dia 26/05.

Cola no Lovable.
