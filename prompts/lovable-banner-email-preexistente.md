# Lovable — Tratativa de e-mail detectada (puxa thread do cliente como principal)

**Escopo:** frontend (detalhe do card). Backend pronto.

## Importante: NÃO criar banner grande novo — REUSAR o que já existe

O agente AUTO-ADOTA a thread do cliente: importa as mensagens (aba MENSAGENS), marca como
tratativa principal, roteia o card (CLIENTE RESPONDEU vs AGUARDANDO VOCÊ) e **preenche a sugestão
do agente (`ia_sugestao_oc_resposta`)** — que é o **banner que você já tem** ("🤖 IA sugere oc N"
com "Aprovar oc N + email" que abre o editor). **NÃO faça um banner novo gigante** — o front
anterior ficou poluído por causa disso. Quase tudo já funciona pelos mecanismos existentes:

| O quê | De onde vem (já existe) |
|---|---|
| Aba (CLIENTE RESPONDEU / AGUARDANDO VOCÊ) | `cards.cliente_respondeu_em` (backend seta certo) |
| Mensagens da conversa | aba MENSAGENS (são reais, importadas) |
| **Análise + ação "oc 54 + email"** | **banner `ia_sugestao_oc_resposta` que você já renderiza** + a proposta nos `todos` |

Ou seja: **mantém o banner do agente e o painel de Ações propostas como estavam.** Você só
ADICIONA 2 coisas pequenas (abaixo), lendo `cards.email_preexistente_sugerido` quando `auto===true`.

```ts
const sug = card.email_preexistente_sugerido;  // quando sug?.auto === true:
// sug.thread_principal  → gmail_thread_id que virou a tratativa principal
// sug.roteamento        → 'cliente_respondeu' | 'aguardando_voce'  (informativo)
```

## Adição 1 — selo "🏷️ THREAD PRINCIPAL"
No seletor de tratativas (mig 212, `listar_tratativas_email_do_card`), a thread cujo
`gmail_thread_id === sug.thread_principal` (= `cards.tratativa_email_escolhida`) recebe um chip
**🏷️ THREAD PRINCIPAL** e fica pré-selecionada. As respostas saem nela (o executor já usa
`tratativa_email_escolhida`). A thread que o Cockpit criou (se houver) fica secundária.

## Adição 2 — botão "Não é deste card · descartar"
Um botão discreto (no topo do card ou junto do seletor de tratativas) quando `sug?.auto === true`:
```ts
await supabase.rpc("descartar_email_preexistente", { p_card_id: cardId });
//   → { ok:true, revertido:true }  (desfaz a adoção: remove msgs importadas, solta a
//      tratativa, volta o state). Após ok, recarregar o card.
```

## Ajuste fino no banner do agente que você já tem (`ia_sugestao_oc_resposta`)
O backend agora preenche `ia_sugestao_oc_resposta.contexto`:
- `'cobrou_antes_notificacao'` → o cliente cobrou ANTES de qualquer notificação nossa. Trocar o
  cabeçalho do banner de "🤖 IA sugere (resposta do cliente)" para algo como **"📨 Cliente cobrou
  antes da notificação — sugiro notificar"**. O `motivo` traz a análise do agente. A ação
  "Aprovar oc 54 + email" abre o editor NA thread principal (igual hoje).
- ausente / outro → comportamento normal (resposta do cliente).

## Smoke test
1. NF 807867 (Duilio): card em AGUARDANDO VOCÊ; MENSAGENS mostra a conversa da Sabrina/OVD; o
   banner do agente aparece com a análise + **"Aprovar oc 54 + email"** (abre o editor na thread
   principal); a thread está marcada 🏷️ THREAD PRINCIPAL; botão "Não é deste card · descartar".
2. Aprovar "oc 54 + email" → editor abre na thread da cliente (principal), não cria e-mail paralelo.
3. "Não é deste card · descartar" → recarrega; mensagens importadas somem; card volta ao normal.

## Resumo de 1 linha
NÃO fazer banner novo: reusar o banner `ia_sugestao_oc_resposta` (análise + "oc 54 + email") e o
painel de Ações propostas como estão; só ADICIONAR o selo 🏷️ THREAD PRINCIPAL e o botão
"Não é deste card · descartar" (lendo `cards.email_preexistente_sugerido.auto/thread_principal`),
e ajustar o cabeçalho do banner quando `ia_sugestao.contexto==='cobrou_antes_notificacao'`.
