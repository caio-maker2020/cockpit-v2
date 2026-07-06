# P0 LOVABLE — Banner/ação "54 + email" deve resolver por acao_key/todo_id, NUNCA por codigo_ssw=54

## Contexto (produção)
O backend (executor v129) já bloqueia executar "54 sem email" quando a recomendação era
"54 + email" (card_event `Oc54SemEmailBloqueadaRecomendacaoEraEmail`). Então hoje NÃO há
dano silencioso — mas o front ainda clica no todo ERRADO e a operação passa a FALHAR.
Corrigir o front para clicar no todo certo.

## Verdade do dado (confirmada no banco)
Um card de oc=54 tem DUAS ações pendentes, com `acao_key` DISTINTOS:
- **COM EMAIL** → `acao_key = "lancar_oc_e_enviar_email:54"`, `tool = "lancar_oc_e_enviar_email"`, `meta.sem_email_explicito` ausente.
- **SEM EMAIL** → `acao_key = "lancar_ocorrencia:54"`, `tool = "lancar_ocorrencia"`, `meta.sem_email_explicito = true`.

A recomendação destacada vem em:
`card.aviso_alteracao_oc.proposta_destacada_acao` OU `card.analise_padrao_resultado.proposta_destacada_acao`
(string exata, ex.: `"lancar_oc_e_enviar_email:54"`).

## REGRA INEGOCIÁVEL
**NUNCA resolver a ação por `args.codigo_ssw === 54`.** O número 54 é AMBÍGUO (duas ações).
Resolver SEMPRE por `acao_key` exato ou `todo_id`.

## Correção

### 1. Resolver o todo destacado por acao_key EXATO
```ts
const destacadaKey =
  card.aviso_alteracao_oc?.proposta_destacada_acao ??
  card.analise_padrao_resultado?.proposta_destacada_acao ?? null;

// precedência: proposta.recomendada === true (caso romaneio interno) vence
const todoDestacado =
  todos.find(t => t.proposta_payload?.recomendada === true) ??
  todos.find(t => t.proposta_payload?.acao_key === destacadaKey);

// CERTO: aprovar exatamente esse todo_id
aprovar(todoDestacado.id);

// PROIBIDO (causa do bug):
// const t = todos.find(t => t.proposta_payload?.args?.codigo_ssw === 54);
```
O rótulo do botão e o todo executado vêm do MESMO todo.

### 2. Ação "54 + email" (acao_key = "lancar_oc_e_enviar_email:54" OU tool === "lancar_oc_e_enviar_email")
- SEMPRE abrir o **composer/modal de email** (preview do template `args.template_id`,
  destinatário `args.email_destino`; se `meta.precisa_email_destino === true`, exigir o
  destinatário antes de enviar).
- NUNCA aprovar direto. NUNCA mostrar a confirmação "não notifica".
- NUNCA cair no todo com `meta.sem_email_explicito === true`.

### 3. Ação "54 sem email" (só da linha cujo todo tem meta.sem_email_explicito === true)
- Mostrar confirmação CLARA: "Esta ação lança a oc 54 mas NÃO envia e-mail. O cliente NÃO será notificado. Confirmar?".
- Só executa após "Confirmar".
- Ao aprovar, enviar nos extras:
  ```
  extras.confirmou_sem_email_deliberado = true   // ÚNICO jeito de o backend liberar
  extras.skip_email = true
  extras.enviar_email = false
  ```
  (Sem `confirmou_sem_email_deliberado=true`, o backend v129 BLOQUEIA e a ação falha.)

### 4. Fail-safe OBRIGATÓRIO (proibido fallback por número)
- Se NÃO encontrar o todo por `acao_key` exata (ou por `todo_id`):
  - **NÃO** fazer fallback por `codigo_ssw === 54`.
  - Mostrar erro claro ("Não consegui identificar a ação recomendada — abra a lista de Ações propostas e escolha a linha correta") e abrir a lista de ações.

### 5. Não deduplicar por codigo_ssw
- "54 + email" e "54 sem email" são DUAS linhas distintas, cada uma com seu selo e seu
  botão vinculado ao próprio `todo.id`:
  - COM EMAIL: selo "✉️ + E-MAIL AO CLIENTE".
  - SEM EMAIL: selo "🚫 SEM E-MAIL — cliente NÃO será notificado" (uso de exceção, discreto).
- NUNCA merge/dedupe por `codigo_ssw`.

## Critério de aceite
- Clicar no banner "54 + email" abre o composer (nunca o pop-up "não notifica").
- O `todo_id` aprovado tem `proposta_payload.acao_key === "lancar_oc_e_enviar_email:54"`.
- O todo aprovado NÃO tem `meta.sem_email_explicito === true`.
- Clicar na linha "🚫 SEM E-MAIL" envia `extras.confirmou_sem_email_deliberado=true` (+ skip_email + enviar_email=false).
- NÃO existe nenhum caminho que, ao clicar "+email", aprove um todo por `codigo_ssw===54`.
- Validar no DevTools/Network o payload da RPC `auto_aprovar_e_executar` (ou equivalente de aprovação).

## Referência
Reforça INV-027 (`prompts/lovable-banner-acao-exata-com-email-vs-sem-email.md`) e o backend guard
`_shared/guard-oc54-sem-email.ts` (executor v129).
