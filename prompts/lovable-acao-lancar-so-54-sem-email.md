# Lovable — nova ação "Lançar SÓ oc 54 (sem e-mail)" lado a lado da "54 + e-mail"

## Contexto

No detalhe do card, na lista **Ações propostas / Ações sugeridas**, hoje existe a
opção **"Aguardando retorno do cliente (com email)"** (oc 54) que abre o editor de
e-mail (**ABRIR EDITOR**) antes de lançar.

O backend passou a criar, **ao lado dela**, uma segunda ação que lança **só a oc 54
no SSW, SEM enviar e-mail** (a operadora notifica o cliente por outro canal, ou o
e-mail já existe numa thread anterior). É um caminho pontual — a operadora usa quando
a IA errou e ela quer só registrar o 54 e seguir.

**Nenhuma mudança de schema.** É só renderização: a nova ação já chega como um `todo`
normal na lista. O que muda é **como o front decide mostrar "ABRIR EDITOR" vs "LANÇAR"**.

## Como identificar cada uma (campos do `todos.proposta_payload`)

As ações vêm de `todos` (mesma listagem de hoje). Distinga pelo `proposta_payload`:

**"54 + e-mail" (já existe — abre editor):**
```jsonc
{
  "tool": "lancar_oc_e_enviar_email",
  "args": { "codigo_ssw": 54, "template_id": "FALTA_DE_VOLUME", "email_destino": "..." },
  "meta": { "modo": "completo", "tinha_intencao_email": true }
}
```

**"54 SEM e-mail" (nova — lança direto, NÃO abre editor):**
```jsonc
{
  "tool": "lancar_ocorrencia",
  "args": { "codigo_ssw": 54 },          // <- sem template_id, sem email_destino
  "meta": { "modo": "sem_email", "sem_email_explicito": true, "gemeo_de_codigo_email": 54 }
}
```
O `descricao` do todo já vem como **"Lançar SÓ oc 54 (sem email) — re-aguardar cliente sem notificar"**.

## Regra de renderização (o ajuste)

A decisão de **abrir o editor de e-mail** (botão "ABRIR EDITOR") deve depender do
**tool/meta**, NUNCA só de `codigo_ssw === 54`:

- Mostrar **"ABRIR EDITOR"** (composer de e-mail) **somente** quando
  `proposta_payload.tool === 'lancar_oc_e_enviar_email'`
  **OU** `proposta_payload.meta?.modo === 'completo'`
  **OU** `proposta_payload.args?.template_id` existe.
- Para a nova ação (`meta.sem_email_explicito === true` **ou** `tool === 'lancar_ocorrencia'`),
  mostrar **"LANÇAR →"** (lançamento direto, **sem** abrir composer).

Sugestão de rótulo/visual da nova opção (linha da oc 54):
- Título: **"Aguardando retorno do cliente — SEM e-mail"**
- Subtítulo: "Lança só a oc 54 no SSW (não envia e-mail). Use quando o cliente já foi
  avisado por outro canal."
- Badge discreto: `SEM E-MAIL` (pra não confundir com a "com email" logo acima).

As duas ficam lado a lado na lista — a "com email" continua sendo a recomendada pela IA
quando houver sugestão; a "sem email" é a alternativa pontual.

## O que acontece ao clicar "LANÇAR →" na opção sem e-mail

Chamar a MESMA RPC de aprovação já usada hoje, **sem extras de e-mail**:

```ts
const { data, error } = await supabase.rpc('aprovar_e_executar', { p_todo_id: <id do todo> });
// p_extras pode ser omitido (null). NÃO passar template/destinatários/texto.
```

O backend (executor) já trata: como o `tool` é `lancar_ocorrencia` e não há `template_id`
nem destinatários, **não dispara e-mail** — lança só a oc 54 no SSW e o card vai pra
`AGUARDANDO_CLIENTE` (igual ao fluxo "54 + email", só que sem o e-mail). Idempotência e
guard do tripé continuam valendo.

> Importante: NÃO abrir o modal de e-mail pra essa opção. Se abrir o composer e a
> operadora preencher destinatário/texto, o executor passa a enviar e-mail (o composer
> manual vence) — o que é exatamente o que essa opção quer evitar.

## Lembrete (padrão do projeto)

Dropdown/lista de ocorrências continua vindo de `ocorrencias_dicionario` (dinâmico) —
não hardcodar. Aqui só foi adicionada uma variante de ação da oc 54; o catálogo de ocs
não mudou.
