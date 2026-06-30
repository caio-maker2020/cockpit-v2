# Lovable — FIX: botão "Aprovar oc=54 + email" está disparando a confirmação de "SEM e-mail"

## Bug em produção (NF 27573 — operadora Larissa)
No card recomendado, a operadora clica no botão **"Aprovar oc=54 + email"** (banner azul "RECOMENDADO PELO AGENTE IA — EXTRAVIO PARCIAL"). Em vez de abrir o envio do e-mail, aparece o pop-up:

> "Esta ação lança a oc 54 no SSW mas **NÃO envia e-mail**. O cliente **NÃO será notificado**. Confirmar?"

Isso é **contraditório**: o botão diz "+ email", mas a confirmação é a da ação **oposta** (lançar 54 **sem** notificar). Se a operadora confirmar, o cliente fica sem aviso achando que foi notificado.

## Causa (confirmada no backend — o dado está correto)
Esse card tem **duas** ações pendentes com `codigo_ssw = 54`, que são **opostas** (já documentado no INV-027 / prompt `lovable-banner-acao-exata-com-email-vs-sem-email.md`):

| todo | `proposta_payload.acao_key` | `tool` | `meta.modo` | `meta.sem_email_explicito` | comportamento |
|---|---|---|---|---|---|
| A (recomendada) | `lancar_oc_e_enviar_email:54` | `lancar_oc_e_enviar_email` | `completo` | — | lança 54 **E envia e-mail** |
| B (exceção) | `lancar_ocorrencia:54` | `lancar_ocorrencia` | `sem_email` | `true` | lança 54 **SEM e-mail** |

E o banner aponta **corretamente** pra ação A:
- `cards.aviso_alteracao_oc.proposta_destacada_acao = "lancar_oc_e_enviar_email:54"`
- `cards.analise_padrao_resultado.proposta_destacada_acao = "lancar_oc_e_enviar_email:54"`

**O front está resolvendo a ação clicada pelo NÚMERO da oc (54) e/ou decidindo qual confirmação mostrar por "existe um todo sem-e-mail de 54?", em vez de olhar o `acao_key` do todo que o banner realmente aponta.** Resultado: o botão "+ email" cai no todo B e mostra a confirmação dele.

> Observação: a confirmação "SEM e-mail" (texto acima) já está implementada certa — o problema é **só** que ela está sendo disparada para o todo errado. Faltou vincular o botão do banner por `acao_key`.

## O que corrigir (front-only)

### 1. O botão do banner submete o `todo.id` da ação destacada — resolvido por `acao_key`
- Encontre o todo destacado assim: `todo` pendente cujo `proposta_payload.acao_key === card.analise_padrao_resultado.proposta_destacada_acao` (string exata).
  - (Se houver `proposta_payload.recomendada === true` em algum pendente, ele tem precedência — caso romaneio interno.)
- Guarde **esse `todo.id`** e dispare exatamente ele ao clicar. **Nunca** re-resolver por `codigo_ssw === 54` depois.
- O rótulo do botão e a ação executada têm que vir do **mesmo** todo.

```ts
// CERTO
const destacada = todos.find(t => t.proposta_payload?.recomendada === true)
  ?? todos.find(t => t.proposta_payload?.acao_key === card.analise_padrao_resultado?.proposta_destacada_acao);
aprovar(destacada.id);

// ERRADO (causa do bug)
const t = todos.find(t => t.proposta_payload?.args?.codigo_ssw === 54); // pega qualquer 54
```

### 2. A confirmação "não notifica" é decidida pelo todo RESOLVIDO, não por número
Mostre o pop-up "...NÃO envia e-mail. O cliente NÃO será notificado." **somente quando o todo que vai ser executado** tem `proposta_payload.meta.sem_email_explicito === true`.

- Todo A (`tool === 'lancar_oc_e_enviar_email'` **ou** `meta.modo === 'completo'`): **NUNCA** esse pop-up. Abrir o fluxo de **envio de e-mail** (composer/preview com `args.template_id`, destinatário `args.email_destino`; se `meta.precisa_email_destino === true`, exigir o destinatário antes de enviar).
- Todo B (`meta.sem_email_explicito === true`): aí sim o pop-up de não-notificação, e só executa após "Confirmar".

### 3. As duas linhas de 54 permanecem separadas (não colapsar)
Na lista "Ações propostas", renderize A e B como **duas linhas distintas**, cada uma com seu selo e seu botão vinculado ao próprio `todo.id`:
- A: selo **"✉️ + E-MAIL AO CLIENTE"**.
- B: selo **"🚫 SEM E-MAIL — cliente NÃO será notificado"**, discreto (uso de exceção).

Nunca dedupe/merge por `codigo_ssw`.

## Critério de aceite
- No card NF 27573 (e qualquer card com as duas 54): clicar **"Aprovar oc=54 + email"** abre o fluxo de **envio de e-mail** — jamais o pop-up "não será notificado".
- O pop-up "não será notificado" só aparece ao clicar na linha **"🚫 SEM E-MAIL"**.
- É impossível clicar numa achando que é a outra; o selo de cada linha bate com o que acontece ao aprovar.

## Referência
Reforça/retoma `prompts/lovable-banner-acao-exata-com-email-vs-sem-email.md` (INV-027, NF 463457). A confirmação foi implementada; falta vincular o botão do banner por `acao_key`.
