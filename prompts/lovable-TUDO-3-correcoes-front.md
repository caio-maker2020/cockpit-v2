# Lovable — 3 correções de front do Cockpit (aplicar todas)

São 3 ajustes independentes na interface. Todos os dados já existem no backend — é só
consumir/filtrar/renderizar como descrito. Cada seção tem seu critério de aceite.

---

# CORREÇÃO 1 — Banner e lista da oc 54 vinculam por identidade da ação (`acao_key`), nunca pelo número

## Problema
Um card pode ter DUAS ações de oc **54 opostas**, que coexistem de propósito:

| acao_key | tool | meta | o que faz |
|---|---|---|---|
| `lancar_oc_e_enviar_email:54` | `lancar_oc_e_enviar_email` | `modo=completo` | lança 54 **E envia e-mail** ao cliente |
| `lancar_ocorrencia:54` | `lancar_ocorrencia` | `sem_email_explicito=true` | lança 54 **SEM e-mail** (cliente NÃO é avisado) |

Hoje o front trata as duas pelo **NÚMERO 54**. Então (a) o botão do banner "Aprovar
54+email" aciona a 54 **sem-email**; e (b) na lista as duas aparecem iguais ("Lançar oc
54"). A operadora aprova achando que notifica → cliente nunca é avisado. (NF 1093446,
27573, 296374.)

## Regra: identidade da ação é o `acao_key`, não o número
O backend já entrega a ação recomendada do banner:
```ts
const destacadaKey =
  card.aviso_alteracao_oc?.proposta_destacada_acao            // ← fonte principal (todos os agentes)
  ?? card.analise_padrao_resultado?.proposta_destacada_acao   // compat
  ?? null;
```

### 1a. Botão do banner dispara o todo resolvido por `acao_key`
```ts
const todoDestacado =
  todos.find(t => t.proposta_payload?.recomendada === true)      // precedência (romaneio interno)
  ?? (destacadaKey && todos.find(t => t.proposta_payload?.acao_key === destacadaKey));

aprovar(todoDestacado.id);   // executa ESTE todo.id — nunca re-buscar por número depois

// ERRADO (a causa do bug): todos.find(t => t.proposta_payload?.args?.codigo_ssw === 54)
```
Rótulo do botão e ação executada vêm do **mesmo** `todoDestacado`. Se `destacadaKey`
existir mas nenhum todo casar: NÃO cair no número — mostrar "recomendação indisponível,
escolha manualmente".

### 1b. As duas 54 são linhas DISTINTAS na lista (não colapsar)
Cada todo com seu selo e seu botão vinculado ao próprio `todo.id`:
- `meta.modo === 'completo'` (ou `tool === 'lancar_oc_e_enviar_email'`) → **`✉️ + E-MAIL AO CLIENTE`**
- `meta.sem_email_explicito === true` → **`🚫 SEM E-MAIL — cliente NÃO será notificado`** (discreto)

Nunca dedupe/merge por `codigo_ssw`. Nunca titule só "Lançar oc {N}" — use a `descricao`
do todo (ela já distingue "+ email" de "sem e-mail").

### 1c. Confirmação "não notifica" é decidida pelo todo RESOLVIDO
- `meta.sem_email_explicito === true` → pop-up "…NÃO envia e-mail. Cliente NÃO será
  notificado. Confirmar?" e só executa após confirmar.
- `lancar_oc_e_enviar_email` / `meta.modo === 'completo'` → **NUNCA** esse pop-up; abrir o
  fluxo de **envio de e-mail** (composer com `args.template_id`, destinatário
  `args.email_destino`; se `meta.precisa_email_destino === true`, exigir o destinatário).

## Critério de aceite (Correção 1)
- NF 1093446 / 1093461 / 780190 / 780191 / 779901 / 27573 / 296374: clicar "Aprovar
  oc=54+email" abre o **envio de e-mail** (`lancar_oc_e_enviar_email:54`), jamais o
  pop-up "não notifica".
- Na lista, as duas 54 aparecem como linhas diferentes com selos ✉️ e 🚫 batendo com o
  que acontece ao aprovar. Impossível clicar numa achando que é a outra.

---

# CORREÇÃO 2 — Aba "CLIENTE RESPONDEU" só pra oc=54; oc≠54 respondida volta pra "AGUARDANDO VOCÊ"

## Problema
Card em **oc=49** (relacionamento — exige ação da operadora) com o cliente tendo
respondido aparece na aba **CLIENTE RESPONDEU**; deveria estar em **AGUARDANDO VOCÊ**
(NF 165296). A regra atual bucketiza só por `cliente_respondeu_em`, ignorando a oc.

## Regra refinada
CLIENTE RESPONDEU é só quando `cod_ultima_ocorrencia = 54` (fluxo "notifiquei o cliente,
aguardo o retorno"). Em qualquer outra oc (49/20/35/…) o card volta pra AGUARDANDO VOCÊ,
com badge indicando que o cliente respondeu (a resposta segue visível). As duas abas
continuam mutuamente exclusivas.

### Filtros
Aba **AGUARDANDO VOCÊ**:
```ts
.eq('state', 'AGUARDANDO_VALIDACAO_HUMANA')
.or('cliente_respondeu_em.is.null,cod_ultima_ocorrencia.neq.54')
```
Aba **CLIENTE RESPONDEU**:
```ts
.eq('state', 'AGUARDANDO_VALIDACAO_HUMANA')
.not('cliente_respondeu_em', 'is', null)
.eq('cod_ultima_ocorrencia', 54)
```

### Badge
Card que cai em AGUARDANDO VOCÊ **com `cliente_respondeu_em != null`** (oc≠54) mantém o
badge **`📬 cliente respondeu · há {tempo}`** no topo (mesmo visual âmbar). Muda só a
coluna, a resposta não some.

## Critério de aceite (Correção 2)
- NF 165296 (oc=49, respondeu) aparece em AGUARDANDO VOCÊ com badge "cliente respondeu".
- Cards oc=54 respondidos continuam em CLIENTE RESPONDEU.
- Nenhum card nas duas abas ao mesmo tempo.

---

# CORREÇÃO 3 — Galeria HISTÓRICO SSW mostra TODAS as fotos da oc (não só a 1ª)

## Problema
Ao abrir a foto de uma ocorrência com várias fotos, aparece só a 1ª. Ex.: NF 362406,
oc=49 tem **8 fotos**. Não embutir os paginadores `01..08` do viewer do SSW — eles só
funcionam dentro da sessão do portal e ficam mortos no card.

## Solução: consumir o manifesto (1 chamada lista todas as fotos)
A edge function `foto-oc-card` tem um modo `list` que devolve a lista completa.

### 3a. Buscar o manifesto
`POST {SUPABASE_URL}/functions/v1/foto-oc-card`, header `Authorization: Bearer <JWT>`:
```json
{ "card_id": "<uuid>", "codigo_oc": 49, "list": true }
```
Resposta:
```json
{ "ok": true, "codigo_oc": 49, "fotos_total": 8, "incompleto": false,
  "fotos": [ { "idx": 0, "oc_descricao": "…", "foto_data": "29/06/26 15:23", "foto_instrucao": "FOTO ID INSERIDA" }, … ] }
```

### 3b. Renderizar a galeria a partir de `fotos` (declarativo)
Para cada item, buscar o binário no mesmo endpoint (modo binário, sem `list`), passando o `idx`:
```
POST /functions/v1/foto-oc-card   { "card_id": "<uuid>", "codigo_oc": 49, "idx": <f.idx> }
→ image/jpeg (ou application/pdf) inline
```
Renderizar como `manifesto.fotos.map(f => <img src={fetchFoto(f.idx)} />)` com contador
**"{i+1} de {fotos_total}"** e navegação/miniaturas; rótulo de cada foto = `foto_data` +
`foto_instrucao`. **Não** parar no idx 0; **não** embutir o viewer do SSW.

### 3c. Tratar `incompleto`
Se `incompleto === true`, mostrar aviso discreto "Pode haver fotos não carregadas — abrir
no SSW para conferir".

## Critério de aceite (Correção 3)
- NF 362406 → oc 49: galeria mostra "1 de 8" e navega pelas 8 fotos distintas.
- Uma oc com 1 foto (ex.: oc 6 dessa NF) mostra "1 de 1" sem navegação.
