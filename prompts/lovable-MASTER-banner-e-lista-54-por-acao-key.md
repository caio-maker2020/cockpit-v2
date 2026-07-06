# Lovable — MASTER: banner e lista de ações vinculam por `acao_key`, NUNCA pelo número

> Consolida e substitui `lovable-FIX-banner-mais-email-dispara-confirmacao-sem-email.md`
> + `lovable-FIX-banner-oc13-vincula-por-acao-key.md` + `lovable-banner-acao-exata-com-email-vs-sem-email.md`.
> Cobre TODOS os casos recorrentes (NF 463457, 27573, 296374, 1093446).

## O problema (recorrente)
Um card pode ter DUAS ações de oc **54 opostas**, e elas coexistem de propósito:

| acao_key | tool | meta | o que faz |
|---|---|---|---|
| `lancar_oc_e_enviar_email:54` | `lancar_oc_e_enviar_email` | `modo=completo` | lança 54 **E envia e-mail** ao cliente |
| `lancar_ocorrencia:54` | `lancar_ocorrencia` | `sem_email_explicito=true` | lança 54 **SEM e-mail** (cliente NÃO é avisado) |

Hoje o front trata as duas pelo **NÚMERO 54**, então: (a) o banner "Aprovar 54+email"
aciona a 54 sem-email; (b) na lista as duas aparecem iguais ("Lançar oc 54"). Resultado:
a operadora aprova achando que notifica, o cliente nunca é avisado.

## Regra única: identidade da ação é o `acao_key`, não o número
Todo todo tem `proposta_payload.acao_key = "<tool>:<codigo_ssw>"` (já vem do backend).
O backend também diz qual é a recomendada do banner (já corrigido nos 2 agentes):

```ts
const destacadaKey =
  card.aviso_alteracao_oc?.proposta_destacada_acao            // ← fonte principal (todos os agentes)
  ?? card.analise_padrao_resultado?.proposta_destacada_acao   // compat
  ?? null;
```

## 1. Botão do banner dispara o todo resolvido por `acao_key`
```ts
const todoDestacado =
  todos.find(t => t.proposta_payload?.recomendada === true)      // precedência (romaneio interno)
  ?? (destacadaKey && todos.find(t => t.proposta_payload?.acao_key === destacadaKey));

aprovar(todoDestacado.id);   // executa ESTE todo.id — nada de re-buscar por número depois

// ERRADO (a causa do bug): todos.find(t => t.proposta_payload?.args?.codigo_ssw === 54)
```
O rótulo do botão e a ação executada vêm do **mesmo** `todoDestacado`. Se `destacadaKey`
existir mas nenhum todo casar (raro): NÃO cair no número — mostrar "recomendação
indisponível, escolha manualmente".

## 2. As duas 54 são linhas DISTINTAS na lista (não colapsar)
Renderizar cada todo pela sua identidade, cada botão vinculado ao próprio `todo.id`:
- `meta.modo === 'completo'` (ou `tool === 'lancar_oc_e_enviar_email'`): selo
  **`✉️ + E-MAIL AO CLIENTE`**.
- `meta.sem_email_explicito === true`: selo **`🚫 SEM E-MAIL — cliente NÃO será notificado`** (discreto, uso de exceção).

Nunca dedupe/merge por `codigo_ssw`. Nunca titule só por "Lançar oc {N}" — use a
`descricao` do todo (ela já distingue "+ email" de "sem e-mail").

## 3. Confirmação "não notifica" é decidida pelo todo RESOLVIDO
- Todo com `meta.sem_email_explicito === true` → pop-up "…NÃO envia e-mail. Cliente NÃO
  será notificado. Confirmar?" e só executa após confirmar.
- Todo `lancar_oc_e_enviar_email` / `meta.modo === 'completo'` → **NUNCA** esse pop-up;
  abrir o fluxo de **envio de e-mail** (composer/preview com `args.template_id`,
  destinatário `args.email_destino`; se `meta.precisa_email_destino === true`, exigir o
  destinatário antes de enviar).

## Critério de aceite
- NF 1093446 / 1093461 / 780190 / 780191 / 779901 (oc=13) e NF 27573 / 296374: clicar
  "Aprovar oc=54+email" abre o **envio de e-mail** (`lancar_oc_e_enviar_email:54`),
  jamais o pop-up "não notifica".
- Na lista, as duas 54 aparecem como linhas diferentes, com selos ✉️ e 🚫 batendo com o
  que acontece ao aprovar.
- É impossível clicar numa achando que é a outra.

## Backend (contexto — nada a fazer no front além do acima)
Já entregue: `acao_key` em todo todo (trigger); `aviso_alteracao_oc.proposta_destacada_acao`
gravado pelos agentes `agente-sugere-ocs-padrao` e `agente-oc13-autonomo`.
