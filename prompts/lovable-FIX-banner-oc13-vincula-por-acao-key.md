# Lovable — FIX: banner "Aprovar oc=54 + email" abre a opção "54 SEM e-mail"

## Bug (NF 1093446 — UNIAO QUIMICA, oc=13)
No banner **"RECOMENDADO PELO AGENTE IA — Lançar oc=54 + email"**, ao clicar em
**"✓ Aprovar oc=54+email"**, o que o front destaca/aciona em **Ações propostas** é a
opção **"54 SEM E-MAIL — cliente NÃO será notificado"** (que está listada em cima).
Contradição: aprovar o banner (+email) tem que cair na ação **54 + email**, que está
logo abaixo.

## Causa (backend já corrigido — front precisa consumir)
O card tem **duas** ações de oc 54, opostas:
| acao_key | comportamento |
|---|---|
| `lancar_oc_e_enviar_email:54` | lança 54 **E envia e-mail** (a recomendada) |
| `lancar_ocorrencia:54` (meta.sem_email_explicito=true) | lança 54 **SEM e-mail** |

O front resolve o botão do banner pelo **NÚMERO 54** → pega a primeira 54 da lista (a
sem-email). O correto é resolver pelo **`acao_key`** da ação recomendada.

O backend agora entrega a chave: **`cards.aviso_alteracao_oc.proposta_destacada_acao`**
(= `"lancar_oc_e_enviar_email:54"`). É gravado por TODOS os agentes que produzem o
banner (agente-sugere-ocs-padrao E agente-oc13-autonomo). Os 5 cards oc=13 que estavam
sem a chave já foram backfillados.

## O que corrigir (front-only)

### 1. Resolver a ação destacada por `acao_key` (fonte única)
```ts
// fonte do vínculo do banner — nesta ordem:
const destacadaKey =
  card.aviso_alteracao_oc?.proposta_destacada_acao          // ← principal (todos os agentes)
  ?? card.analise_padrao_resultado?.proposta_destacada_acao // compat ocs-padrao
  ?? null;

// o todo que o banner aponta:
const todoDestacado =
  todos.find(t => t.proposta_payload?.recomendada === true)   // precedência (romaneio interno)
  ?? (destacadaKey && todos.find(t => t.proposta_payload?.acao_key === destacadaKey));

aprovar(todoDestacado.id);   // dispara ESSE todo.id

// ERRADO (causa do bug): todos.find(t => t.proposta_payload?.args?.codigo_ssw === 54)
```
- O rótulo do botão e a ação executada vêm do **mesmo** `todoDestacado`.
- **Nunca** re-resolver por `codigo_ssw === 54` depois de identificar o todo.
- Se `destacadaKey` existir mas nenhum todo casar (raro), NÃO cair no número — mostrar
  "recomendação indisponível, escolha manualmente" e não pré-selecionar nenhuma 54.

### 2. Confirmação "não notifica" é decidida pelo todo RESOLVIDO
Só mostrar o pop-up "…NÃO envia e-mail. Cliente NÃO será notificado." quando o todo que
vai executar tem `meta.sem_email_explicito === true`. Todo `lancar_oc_e_enviar_email` /
`meta.modo === 'completo'` → abre o fluxo de **envio de e-mail**, nunca esse pop-up.

### 3. As duas 54 continuam linhas distintas (não colapsar) — igual `lovable-FIX-banner-mais-email-dispara-confirmacao-sem-email.md` §3
Selo `✉️ + E-MAIL AO CLIENTE` vs `🚫 SEM E-MAIL`, cada botão no seu `todo.id`.

## Critério de aceite
- NF 1093446 (e as outras 4: 1093461, 780190, 780191, 779901): clicar "Aprovar oc=54+email"
  no banner abre o **envio de e-mail** (ação `lancar_oc_e_enviar_email:54`), jamais o
  pop-up "não será notificado".
- O pop-up "não notifica" só aparece clicando na linha `🚫 SEM E-MAIL`.

## Referência
Complementa `lovable-FIX-banner-mais-email-dispara-confirmacao-sem-email.md` (INV-027,
NF 27573/296374). A diferença deste caso: o banner vinha do fluxo **oc=13**
(`aviso_alteracao_oc.tipo = 'ia_sugestao_oc13'`), cujo `proposta_destacada_acao` estava
faltando no backend (já corrigido). Regra do front é a mesma: **vincular por acao_key,
nunca por número**, lendo de `aviso_alteracao_oc.proposta_destacada_acao`.
