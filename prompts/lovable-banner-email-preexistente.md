# Lovable — UMA caixa roxa "Sugestão da IA" no topo (tratativa detectada + ação)

**Escopo:** frontend (detalhe do card). Backend pronto e já deployado.

## O que muda (resumo do que o Caio pediu)

Hoje aparecem DUAS coisas: um **banner amarelo** no topo ("TRATATIVA DETECTADA…") e a
**caixa roxa "SUGESTÃO DA IA"** na coluna da direita. **Isso está errado.** O certo:

1. **Some o banner amarelo.**
2. A **caixa roxa "Sugestão da IA" sobe pro topo**, no lugar onde estava o banner amarelo
   (largura cheia, área de banner — **não** na coluna da direita).
3. A caixa roxa passa a ter **2 seções empilhadas, separadas por divisor**:
   - **Seção A — 📨 Tratativa detectada (o raciocínio):** todo o conteúdo que estava no
     banner amarelo (o agente puxou a conversa do cliente, assunto, e-mails dos participantes,
     e o botão **descartar**).
   - **Seção B — 🤖 Sugestão da IA (padrão):** a sugestão de ação como antes, com o botão
     **"Aprovar oc 54 + e-mail"** que abre o editor de template.

```ts
const pre = card.email_preexistente_sugerido;   // detecção/adoção da thread
const ia  = card.ia_sugestao_oc_resposta;         // sugestão de ação do agente
```

---

## Seção A — 📨 Tratativa detectada (raciocínio)
Renderiza **só quando `pre?.auto === true`**. É o conteúdo do antigo banner amarelo, agora
DENTRO da caixa roxa, no topo dela.

- **Título:** "📨 Tratativa detectada — o agente puxou a conversa do cliente" + chip de estado
  conforme `pre.roteamento`: `'aguardando_voce'` → chip **AGUARDANDO VOCÊ**;
  `'cliente_respondeu'` → chip **CLIENTE RESPONDEU**.
- **Texto (raciocínio):** use `pre.nota_agente` (já vem pronto do backend).
- **Assunto + participantes:** do candidato principal —
  `const c = pre.candidatos.find(x => x.gmail_thread_id === pre.thread_principal)` → mostra
  `c.assunto` e os chips `c.participantes[]` (igual já estava no banner amarelo).
- **Botão "Não é deste card — seguir em e-mail novo"** (mantém o que já existe):
  ```ts
  await supabase.rpc("descartar_email_preexistente", { p_card_id: cardId });
  //  → desfaz a adoção (remove msgs importadas, solta a thread, volta o state).
  //     Após ok, recarregar o card. A tratativa volta a ser um E-MAIL NOVO (fluxo normal).
  ```
  Deixe claro no subtexto: **"se descartar, a tratativa segue em um e-mail novo."**
- **Divisor** separando da Seção B.

## Seção B — 🤖 Sugestão da IA (padrão, como antes)
Lê `ia` (= `ia_sugestao_oc_resposta`). É o banner de ação que você JÁ tinha — só não pode mais
inventar o label.

- **Título da sugestão:** **use `ia.titulo` quando existir** (ex.:
  *"Notificar o extravio ao cliente — lançar oc 54 + e-mail"*). **NUNCA** use o label default
  de oc 54 (*"Re-lançar 54 (cliente respondeu inconclusivo)"*) quando
  `ia.contexto === 'cobrou_antes_notificacao'` — nesse caso o cliente **criou a conversa** e nós
  **ainda não notificamos**; a ação é **notificar o extravio**, não "cliente respondeu".
- **Confiança:** `ia.confianca` (ex.: ALTA 90%).
- **Motivo/análise:** `ia.motivo`.
- **Botão primário "Aprovar oc 54 + e-mail":** dispara a **proposta que já existe nos `todos`**
  com `tool === 'lancar_oc_e_enviar_email'` e `proposta_payload.args.codigo_ssw === 54` (ela já
  carrega `template_id` do **extravio**, ex.: `FALTA_DE_VOLUME`). Ao aprovar, **abre o editor de
  e-mail com o template de extravio** (modal de edição), NA thread principal — não cria e-mail
  paralelo. (Os campos `ia.acao_tool`/`ia.acao_codigo_ssw` apontam exatamente essa proposta.)
- **"Ver outras opções"** → expande as demais propostas do card (as 8 de oc=49: reentrega 21,
  55, 44, 56, 33, 41, etc.), como já faz hoje.

> ⚠️ O botão **"54 + EMAIL"** que "sumiu" deve voltar exatamente aqui: ele é o botão primário
> da Seção B (aprova a proposta `lancar_oc_e_enviar_email` e abre o editor de template). Antes ele
> só existia dentro da sugestão do agente — por isso some quando a sugestão muda de forma. Mantenha-o
> SEMPRE atrelado à proposta `lancar_oc_e_enviar_email`, não ao layout da sugestão.

---

## Selo "🏷️ THREAD PRINCIPAL" (mantém)
No seletor de tratativas (mig 212, `listar_tratativas_email_do_card`), a thread cujo
`gmail_thread_id === pre.thread_principal` (= `cards.tratativa_email_escolhida`) recebe um chip
**🏷️ THREAD PRINCIPAL** e fica pré-selecionada. As respostas saem nela (o executor já usa
`tratativa_email_escolhida`).

## Botão "📨 Já tem tratativa? Buscar" (casos antigos, sob demanda)
O auto é **só daqui pra frente**. Pra cards ANTIGOS sem e-mail rastreado, um botão discreto perto
das ações:
```ts
await supabase.rpc("buscar_tratativa_do_card", { p_card_id: cardId });
//  → busca sob demanda (por NF, acha thread antiga); se casar (NF+cliente), auto-adota em ~2min.
```
Mostre em card ativo SEM tratativa de e-mail ainda. Após o clique: toast "Buscando…"; recarregar
em ~2min (se achou, aparece a caixa roxa com as 2 seções).

---

## Smoke test — NF 807867 (Duilio)
1. **Uma** caixa roxa **no topo** (largura cheia). **Sem** banner amarelo.
2. **Seção A:** "📨 Tratativa detectada — o agente puxou a conversa do cliente" + chip
   **AGUARDANDO VOCÊ**; assunto *"ATRASO DE ENTREGA | NF 807867 | … CHAMADO : 1155527"* + chips
   sabrina/jhonatan/rafael @ovd.com.br; botão "Não é deste card — seguir em e-mail novo".
3. **Divisor.**
4. **Seção B:** título **"Notificar o extravio ao cliente — lançar oc 54 + e-mail"** (NÃO "cliente
   respondeu inconclusivo"); confiança ALTA; motivo; botão **"Aprovar oc 54 + e-mail"**.
5. Clicar "Aprovar oc 54 + e-mail" → abre o editor com o **template de extravio**, na thread da
   cliente (principal). Não cria e-mail novo.
6. "Não é deste card — seguir em e-mail novo" → recarrega; conversa importada some; card volta ao
   normal (tratativa será um e-mail novo).

## Resumo de 1 linha
Uma caixa roxa "Sugestão da IA" no topo (largura cheia, no lugar do banner amarelo, que some),
com 2 seções: **A) Tratativa detectada** (raciocínio `pre.nota_agente` + assunto/participantes +
descartar→e-mail novo) e **B) Sugestão da IA** (usa `ia.titulo`, nunca o label de "cliente respondeu
inconclusivo"; botão "Aprovar oc 54 + e-mail" dispara a proposta `lancar_oc_e_enviar_email` com
template de extravio).
