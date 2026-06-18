# Cockpit — "Mudança suspeita" (relacionamento → extravio)

Quando a última ocorrência de um card sai de relacionamento e vira extravio
(6/9/16), o backend marca o card como **suspeito** (possível erro de processo).
Regra: o card segue a última oc (vai pra Extravios), MAS com alerta visual forte.
Exceção: se o card estava **lockado em "Aguardando Você"**, ele **fica lockado lá**
até o operador dar OK. Tudo já está no backend — só consumir.

## 1. Banner no topo do Cockpit (todas as abas)

Leia a view `v_mudancas_suspeitas` (RLS por operador — só vê os seus):
```
const { data } = await supabase.from('v_mudancas_suspeitas').select('*');
// [{ card_id, nf, de_oc, para_oc, de_state, requer_ok, state, ... }]
```
Renderize um banner laranja fixo no topo quando houver linhas:
- 1 item: `⚠ Agente detectou mudança suspeita — NF {nf}. Clique para revisar.`
- N itens: `⚠ {N} cards com mudança suspeita — clique para revisar.`
- Clicar → navega pro card (`/cards/{card_id}`; se vários, abre o 1º e/ou lista).
- Atualize via realtime (subscribe em `cards` por `mudanca_suspeita`) ou refetch ~30s.

## 2. Card laranja

No kanban (Extravios E nas abas de relacionamento), se o card tem
`mudanca_suspeita != null` e `mudanca_suspeita.vista_em == null`, renderize em
**laranja forte** (borda + leve fundo `amber/orange-500`), com um selo
`⚠ MUDANÇA SUSPEITA`. É o sinal pra chamar a atenção do operador.

## 3. Ao ABRIR o card suspeito

- **Card NÃO lockado** (já está em Extravios, `requer_ok = false`): ao abrir o
  detalhe, chame `supabase.rpc('marcar_mudanca_suspeita_vista', { p_card_id })`.
  Isso zera o banner (o operador já viu). O selo laranja pode sumir após isso.

- **Card LOCKADO em "Aguardando Você"** (`requer_ok = true`): o card está parado,
  lockado, na aba de relacionamento (regra de lock). Mostre o detalhe com o aviso
  laranja explicando: _"A última ocorrência deste card virou EXTRAVIO (oc {para_oc}),
  mas ele estava aguardando você. Confirme para movê-lo para Extravios, ou corrija
  a ocorrência abaixo."_ E ofereça um botão de **OK**:
  ```
  // OK = libera o lock + move pra Extravios na hora
  await supabase.rpc('liberar_card_suspeito_lockado', { p_card_id });
  await supabase.functions.invoke('atualizar-card-via-portal-ssw', { body: { card_id } });
  // refetch das listas (relacionamento + extravios)
  ```
  Botão: **"✓ OK — mover para Extravios"**. Depois do OK, o card sai do
  "Aguardando Você" e aparece em Extravios.

## 4. Ações de correção (já vêm como propostas no card)

O operador, ao revisar um card suspeito, decide se é extravio real ou lançamento
errado. As opções aparecem como propostas (todos) no card de extravio:
- **oc 49** (`lancar_49`) — volta pro relacionamento (prazo perdas).
- **Notificar + oc 54** (`email_mais_54`) — com editor de e-mail.
- **oc 54 SEM e-mail** (`lancar_54_sem_email`) — **NOVO**: corrige lançamento
  errado reposicionando o card sem e-mailar o cliente. (É proposta de só-oc:
  `meta.tinha_intencao_email = false` → aprova direto, SEM abrir editor de e-mail.)
- **oc 55** (`lancar_55`) — autorizar seguir entrega.

(As de só-oc — 49, 55, 54-sem-email — NÃO abrem editor de e-mail. A decisão de
abrir editor é por `proposta.proposta_payload.meta.tinha_intencao_email === true`,
nunca pelo nome do tool.)

## Contrato backend (pronto)
| Recurso | Uso |
|---|---|
| view `v_mudancas_suspeitas` | banner topo (RLS por operador) |
| RPC `marcar_mudanca_suspeita_vista(p_card_id)` | zera banner ao abrir (card não lockado) |
| RPC `liberar_card_suspeito_lockado(p_card_id)` | OK do operador (card lockado) → desbloqueia |
| `atualizar-card-via-portal-ssw` (invoke) | move o card destravado pra Extravios na hora |
| campo `cards.mudanca_suspeita` (jsonb) | `{de_oc,para_oc,de_state,requer_ok,detectada_em,vista_em}` |

## Aceite
1. Card que vira extravio vindo de relacionamento aparece **laranja** + no banner do topo.
2. Abrir o card (não lockado) zera o banner.
3. Card lockado em "Aguardando Você" fica lá até o **OK** → aí vai pra Extravios.
4. Proposta "oc 54 SEM e-mail" aprova direto, sem editor.
