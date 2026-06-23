# Lovable — Tratativa de e-mail detectada (puxa thread do cliente como principal)

**Escopo:** frontend (detalhe do card). Backend pronto, atrás da flag `scan_email_pre_card_enabled`.

## O que o backend faz (pra você entender o que renderizar)

O agente detecta quando o **cliente/base já tinha uma thread de e-mail** sobre a NF (que o
Cockpit não estava acompanhando) — no nascimento do card OU quando chega um e-mail novo (poll).
Quando detecta (com trava robusta NF + domínio do cliente), ele **AUTO-ADOTA**:

1. **Puxa a thread do cliente** → as mensagens entram no card (aba MENSAGENS, normais).
2. Marca essa thread como **TRATATIVA PRINCIPAL** (`tratativa_email_escolhida`) → o Cockpit passa
   a responder NELA (não cria e-mail paralelo — regra de menos e-mails).
3. **Roteia** o card por uma REGRA INVIOLÁVEL:
   - Se o Cockpit **JÁ tinha notificado** o cliente (e ele respondeu / abriu thread depois) →
     card vai pra **CLIENTE RESPONDEU** (`cliente_respondeu_em` setado).
   - Se o Cockpit **NUNCA notificou** (o cliente cobrou ANTES) → card **fica em AGUARDANDO VOCÊ**
     (não seta `cliente_respondeu_em`) — o operador ainda precisa notificar. O agente deixa uma
     **nota** sugerindo notificar.
4. **Interpreta** a conversa (async, via pipeline) → preenche `ia_sugestao_oc_resposta`.

**Importante:** a aba (CLIENTE RESPONDEU vs AGUARDANDO VOCÊ) **já funciona** pelo `cliente_respondeu_em`
que o backend seta certo — você NÃO precisa mexer no filtro das abas. As mensagens **já aparecem**
na MENSAGENS (são reais, importadas). O que falta é só renderizar 3 coisas novas.

## De onde ler

Pra o card aberto, leia direto a coluna `cards.email_preexistente_sugerido` (jsonb). Quando ela
tem `auto === true`, a thread foi auto-adotada e você renderiza o bloco abaixo:
```ts
const sug = card.email_preexistente_sugerido;
// sug.auto === true        → thread detectada e adotada
// sug.roteamento           → 'cliente_respondeu' | 'aguardando_voce'
// sug.nota_agente          → string (texto do agente pro operador) — pode ser null
// sug.thread_principal     → gmail_thread_id que virou a tratativa principal
// sug.candidatos[0]        → { assunto, participantes[], ... } da thread detectada
```

## O que renderizar (3 coisas)

### 1. Banner da nota do agente (quando `sug.nota_agente` existe)
No topo do detalhe do card, um banner âmbar/informativo com o texto de `sug.nota_agente`. Ex.
real (807867, cliente cobrou antes da notificação):
```
┌────────────────────────────────────────────────────────────────────────────┐
│ 📨 TRATATIVA DETECTADA — o agente puxou a conversa do cliente                │
│ {sug.nota_agente}                                                            │
│   → "O cliente cobrou esta NF ANTES de qualquer notificação nossa — puxei o  │
│      histórico da thread dele (pede posição da entrega). Segue em AGUARDANDO │
│      VOCÊ: ainda falta notificar. Sugiro notificar o extravio (oc 54) NESTA  │
│      thread, pra não criar e-mail paralelo."                                 │
│                                                  [ Não é deste card · descartar ]│
└────────────────────────────────────────────────────────────────────────────┘
```
- Se `roteamento === 'cliente_respondeu'`, o texto da nota será sobre "cliente respondeu" e o card
  estará em CLIENTE RESPONDEU (badge "📬 CLIENTE RESPONDEU" já existente).
- Se `roteamento === 'aguardando_voce'`, mostra o banner acima e o card segue em AGUARDANDO VOCÊ
  com as propostas normais (notificar oc 54 etc.) — o operador aprova a notificação como sempre.

### 2. Flag "🏷️ THREAD PRINCIPAL" na aba MENSAGENS / no seletor de tratativas
A thread cujo `gmail_thread_id === sug.thread_principal` (= `cards.tratativa_email_escolhida`) é a
**principal**. No componente de múltiplas tratativas (mig 212, `listar_tratativas_email_do_card`),
marque essa thread com um selo **🏷️ THREAD PRINCIPAL** e deixe-a pré-selecionada. As respostas do
operador saem nela (o executor já usa `tratativa_email_escolhida`). A outra thread (a que o Cockpit
criou, se houver) aparece como secundária.

### 3. Botão "Não é deste card / descartar"
No banner (item 1), um botão **"Não é deste card · descartar"** → chama:
```ts
await supabase.rpc("descartar_email_preexistente", { p_card_id: cardId });
//   → { ok:true, revertido:true }  (desfaz a adoção: remove as msgs importadas,
//      solta a tratativa principal, volta o state — limpa tudo que a feature pôs)
```
Depois do `ok`, recarrega o card (o banner some, as mensagens importadas somem, volta ao normal).

## Tokens visuais
- Banner da nota: indigo/âmbar informativo (fundo `--info-soft`/`--warning-soft`, borda-esquerda
  3px). Texto em `Bricolage Grotesque`; NF/datas/e-mails em `JetBrains Mono`.
- Selo "🏷️ THREAD PRINCIPAL": chip discreto na tratativa escolhida.
- "Não é deste card · descartar": botão ghost/outline (ação destrutiva leve).

## Smoke test
1. NF 807867 (Duilio): card em **AGUARDANDO VOCÊ** (não CLIENTE RESPONDEU), aba MENSAGENS mostra a
   conversa da cliente (Sabrina/OVD), banner com a nota do agente sugerindo notificar, e a thread
   marcada 🏷️ THREAD PRINCIPAL. As propostas de notificar (oc 54) aparecem normais.
2. Aprovar a notificação → o e-mail sai NA thread principal (a da cliente), não cria outra.
3. "Não é deste card · descartar" → recarrega; banner + mensagens importadas somem; card volta ao normal.
4. (Quando for `cliente_respondeu`) card aparece em CLIENTE RESPONDEU com a conversa + a sugestão do agente.

## Resumo de 1 linha
Lendo `cards.email_preexistente_sugerido` (auto/roteamento/nota_agente/thread_principal): renderizar
o banner da nota do agente + o selo 🏷️ THREAD PRINCIPAL + o botão "Não é deste card · descartar"
(`descartar_email_preexistente`). Abas e mensagens já funcionam pelo backend. Zero mudança de schema.
