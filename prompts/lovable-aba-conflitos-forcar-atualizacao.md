PROMPT Lovable — Aba ⚠️ CONFLITOS + banner "ocorrência alterou" + FORÇAR ATUALIZAÇÃO

## Contexto (regra de negócio — invariante 2026-06-22)
Card em **escopo protegido** — aba **AGUARDANDO VOCÊ** (`state = AGUARDANDO_VALIDACAO_HUMANA`)
ou **AGUARDANDO CLIENTE** (`state = AGUARDANDO_CLIENTE`, oc=54) — **nunca sai da visão do
Cockpit por ação automática**. Quando a Operação (ou outro time) lança uma ocorrência **por
fora** que tira a NF do escopo de Relacionamento, o backend **NÃO move o card**: ele marca um
sinal e o card aparece numa aba nova **⚠️ CONFLITOS**, com banner no card. O card só sai quando
o operador clicar **FORÇAR ATUALIZAÇÃO** e confirmar.

(PARA FAZER = `AGUARDANDO_AGENTE` **não** entra nessa regra — continua saindo naturalmente.)

> **Importante (regra de quando flagga):** CONFLITOS só aparece quando a oc foi lançada
> **POR FORA do Cockpit** (Operação/outro time mexeu no SSW). Quando o **próprio operador
> aprova uma oc dentro do Cockpit** (ex.: cliente respondeu, agente sugeriu oc 55, operador
> aprova 55), o card segue o **fluxo normal** (EXECUTANDO_ACAO → ACAO_EXECUTADA → TRANSFERIDO)
> e **NÃO** aparece em CONFLITOS — isso é garantido pelo backend (o flag só nasce em cards que
> ficaram parados em AGUARDANDO VOCÊ / AGUARDANDO CLIENTE com a oc mudando sem aprovação). O
> front não precisa fazer nada pra distinguir — é só consequência do `state`.

---

## 1. Nova aba `⚠️ CONFLITOS`

Fonte: **`v_cards_requer_atencao`** (view nova, RLS automática por operador — `security_invoker`).
```ts
const { data } = await supabase
  .from('v_cards_requer_atencao')
  .select('*')
  .order('detectada_em', { ascending: false });
```
Colunas retornadas: `card_id, nf, ctrc, state, empresa_cliente, assigned_operator_id,
de_oc, para_oc, oc_fora_escopo, de_state, origem_pass, detectada_em`.

UI (visual atrativo, sem poluição, dentro do layout atual):
- Badge de contagem no título da aba: `⚠️ CONFLITOS ({data.length})`. Só mostrar o badge se > 0.
- Lista de cards. Cada item:
  - **NF {nf}** + `empresa_cliente`.
  - Linha-resumo: *"A última ocorrência mudou: **oc {de_oc} → oc {para_oc}**"*.
  - Chip do `state` traduzido pra origem: `AGUARDANDO_VALIDACAO_HUMANA` → "Aguardando Você",
    `AGUARDANDO_CLIENTE` → "Aguardando Cliente". (Mostra de qual aba o card veio.)
  - Texto-guia: *"NF {nf} está com um conflito de ocorrência. Clique para verificar e aprovar."*
  - Card clicável → abre o detalhe do card (`/cards/{card_id}`).
- Realtime: assinar mudanças na tabela `cards` (coluna `mudanca_suspeita`) **ou** refetch a cada ~30s.
- **Estado vazio (importante):** quando `data.length === 0`, mostrar a mensagem
  **"Não existe conflitos neste momento"** (centralizada, leve). A aba tende sempre a 0 — o
  backend remove o card da view no instante em que ele sai do estado protegido (transferiu,
  finalizou, ou o operador forçou). Se não houver nada, é exatamente esse estado vazio.

> ⚠️ NÃO confundir com a aba existente "AGUARDANDO VOCÊ". CONFLITOS é uma fila transversal
> (agrega cards das 2 abas protegidas que precisam de decisão de FORÇAR).

---

## 2. Banner grande no detalhe do card

O detalhe do card já carrega a tabela `cards`. **Incluir a coluna `mudanca_suspeita`** no SELECT
do card (jsonb). Renderizar o banner quando:
```ts
card.mudanca_suspeita?.tipo === 'saiu_de_escopo' && !card.mudanca_suspeita?.vista_em
```
Banner (destaque forte — vermelho/âmbar, no topo do card, acima das propostas):
> ## ⚠️ ÚLTIMA OCORRÊNCIA SE ALTEROU NA ÚLTIMA ATUALIZAÇÃO
> A ocorrência deste card mudou de **oc {mudanca_suspeita.de_oc} → oc {mudanca_suspeita.para_oc}**.
> Essa nova ocorrência **não é de relacionamento**. Verifique o histórico e decida.
>
> [ Ver histórico SSW ]   [ **FORÇAR ATUALIZAÇÃO** ]

- "Ver histórico SSW" abre/rola pro histórico que o card já exibe (`historico_ssw`).
- "FORÇAR ATUALIZAÇÃO" → fluxo do item 3.

> Esse banner é **distinto** do banner laranja de extravio (que vem de `v_mudancas_suspeitas`).
> Não mexer no de extravio.

---

## 3. Botão + modal "FORÇAR ATUALIZAÇÃO" (fluxo 2 passos)

O botão **FORÇAR ATUALIZAÇÃO** deve estar **sempre disponível** no detalhe de card em escopo
protegido (`AGUARDANDO_VALIDACAO_HUMANA` ou `AGUARDANDO_CLIENTE`) — não só nos flaggados. Isso
cobre o caso **finalizadora** (entrega/baixa), que o backend não sinaliza automaticamente: o
operador vê pelo histórico que finalizou e força.

**Passo 1 — preview (dry-run, não aplica nada):**
```ts
const { data: pv } = await supabase.functions.invoke('atualizar-card-via-portal-ssw', {
  body: { card_id, preview: true },
});
// pv: { ok, preview:true, oc_portal, oc_anterior, decisao, state_alvo, finalizadora, sai_da_visao, ja_atualizado }
```

**Passo 2 — modal de confirmação** (texto conforme o que o preview retornou):
- `pv.ja_atualizado === true` → não abre confirm; toast "Card já está sincronizado com o SSW (oc {oc_portal})." e refetch.
- `pv.finalizadora === true` → título "Ocorrência finalizadora":
  > *"Trata-se de ocorrência finalizadora (oc {oc_portal}). Se você aprovar, o card será
  > finalizado e sairá automaticamente da sua visão. Tem certeza?"*  → **Sim / Não**
- `pv.sai_da_visao === true` (e não finalizadora → transferido):
  > *"A última ocorrência (oc {oc_portal}) não é de relacionamento. Se você aprovar, o card
  > sairá da sua visão e seguirá o fluxo dessa ocorrência. Tem certeza?"*  → **Sim / Não**
- senão (`sai_da_visao === false` → segue como relacionamento/extravio):
  > *"A última ocorrência é oc {oc_portal}. O card será atualizado e seguirá em tratativa no
  > Cockpit. Confirmar?"*  → **Sim / Não**

**No "Sim" — aplica (2 chamadas, nessa ordem):**
```ts
// (a) limpa o flag de conflito + destrava (RPC existente, mig 218):
await supabase.rpc('liberar_card_suspeito_lockado', { p_card_id: card_id });
// (b) relê o SSW e move o card pro destino real:
const { data: res } = await supabase.functions.invoke('atualizar-card-via-portal-ssw', {
  body: { card_id }, // SEM preview → aplica
});
// res: { ok, decisao, oc_portal, state_anterior, state_novo }
```
Depois: toast de resultado ("Card finalizado", "Card transferido para outro setor",
"Card atualizado") + refetch das listas (some da aba CONFLITOS e da aba de origem conforme o novo state).

**No "Não":** fecha o modal, nada acontece (card continua onde está, banner permanece).

---

## 4. Contrato backend (já pronto — nada a implementar no backend)

| Item | Assinatura / detalhe |
|---|---|
| View aba | `v_cards_requer_atencao` (SELECT livre p/ authenticated; RLS por operador). Colunas no item 1. |
| Coluna do banner | `cards.mudanca_suspeita` (jsonb). Banner quando `tipo='saiu_de_escopo'` e `vista_em` nulo. |
| Preview | edge `atualizar-card-via-portal-ssw`, body `{ card_id, preview:true }` → `{ oc_portal, decisao, state_alvo, finalizadora, sai_da_visao, ja_atualizado }`. **Não aplica.** |
| Aplicar | edge `atualizar-card-via-portal-ssw`, body `{ card_id }` → aplica e retorna `{ decisao, state_novo }`. |
| Limpar flag + destravar | RPC `liberar_card_suspeito_lockado(p_card_id uuid)` → `{ ok, desbloqueado }`. |

Observações:
- A view de extravio `v_mudancas_suspeitas` **não** lista esses cards de conflito (filtrada por
  `tipo`). O banner/laranja de extravio continua como está.
- `marcar_mudanca_suspeita_vista(p_card_id)` (existente) **não** é usada aqui — pro conflito a
  baixa do flag acontece via `liberar_card_suspeito_lockado` ao FORÇAR. (Se quiser um "apenas vi,
  decido depois" que tira o banner sem mover, dá pra usar `marcar_mudanca_suspeita_vista`, mas o
  card sairia da aba CONFLITOS — **não recomendado**; mantenha o card na fila até FORÇAR.)

## Resumo de 1 linha
Aba **⚠️ CONFLITOS** lista cards cuja oc saiu de escopo (`v_cards_requer_atencao`); banner grande
no card; **FORÇAR ATUALIZAÇÃO** faz preview (modal com texto certo p/ finalizadora vs fora-de-escopo)
e, no "Sim", `liberar_card_suspeito_lockado` + `atualizar-card-via-portal-ssw` movem o card.
