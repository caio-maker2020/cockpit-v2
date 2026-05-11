# Lovable — Checkbox "PULAR VERIFICAÇÃO DE EVIDÊNCIA" no modal de aprovação

## Contexto

Quando o card está com `cards.cod_ultima_ocorrencia` em **10, 11 ou 35**, e Larissa aprova uma proposta **que dispara email pro cliente** (ex: oc=54 com email, ou template manual), o Cockpit hoje valida automaticamente se o SSW tem foto correlacionada à oc atual do card. Se não tiver, **bloqueia o lançamento** com erro "Evidencia ausente pra oc=X" e reverte o todo pra `pendente`.

**Importante**: a oc da PROPOSTA é geralmente **54** (ou pode ser outro código). A oc que dispara a validação é a do CARD (10/11/35). O checkbox aparece no modal de aprovação da proposta (54 etc.), não na 10/11/35.

**Essa regra é correta na maioria dos casos** — não queremos mandar email com link de foto quebrada pro cliente.

**Mas tem exceção real:** operação às vezes lança a foto na oc errada (ex: NF 353730 — foto foi pra oc=26 e não pra oc=35). Larissa abre o SSW manualmente, vê que tem foto válida, anexa ela na oc certa por fora do Cockpit, mas o gate continua bloqueando porque o scraping ainda não enxergou a foto correta. Resultado: Larissa fica travada.

**Solução**: 1 checkbox que Larissa pode marcar pra pular a verificação automática — ela assume responsabilidade de anexar a foto manualmente no SSW antes (ou depois) do lançamento.

---

## A mudança

**Adicionar 1 checkbox no modal de aprovação quando TODAS estas condições forem verdadeiras:**

1. `cards.cod_ultima_ocorrencia` ∈ {10, 11, 35} (a oc atual do card)
2. A proposta sendo aprovada vai mandar email pro cliente (ex: `proposta_payload.tool === "lancar_oc_e_enviar_email"` OU operadora preencheu manualmente destinatário + texto/template no modal)
3. `proposta_payload.template_id` ou o texto manual conter `{link_evidencia}` (sinal de que o email vai ter o link de foto)

Se as 3 condições forem TRUE, mostrar o checkbox abaixo dos extras do modal:

```
┌──────────────────────────────────────────────────────────┐
│  54  Aguardando retorno do cliente (com email)           │
│                                                           │
│  Destinatários: marcelo@cliente.com.br                   │
│  Anexos (opcional): [+ Adicionar arquivo]                │
│                                                           │
│  ⚠ Detectado: evidência ausente pra oc=35 do card        │
│  ({cards.evidencia_diagnostico})                         │
│                                                           │
│  ☐ Lançar mesmo assim sem verificar evidência            │
│     (vou anexar a foto manualmente no SSW)               │
│                                                           │
│                            CANCELAR  [CONFIRMAR →]       │
└──────────────────────────────────────────────────────────┘
```

### Em quais propostas mostrar

Resumindo: **toda proposta com email cujo template tem `{link_evidencia}` e o card está em oc 10/11/35**. Na prática hoje é a proposta **oc=54 com email** (caminho mais comum no fluxo recusa total/parcial/problema endereço).

Não mostrar pra:
- Propostas sem email (`skip_email=true` ou tool=`lancar_ocorrencia`)
- Propostas com email cujo template/texto NÃO contém `{link_evidencia}`
- Cards cuja `cod_ultima_ocorrencia` está fora de {10, 11, 35}

### Default

**Sempre desmarcado.** Larissa precisa marcar conscientemente.

### Aviso visual reforçado quando marcado

Quando Larissa marca o checkbox, mostrar pequeno aviso abaixo:

```
⚠ Lembre de anexar a evidência manualmente no SSW.
```

### Alerta de evidência ausente

O front já lê `cards.evidencia_status` e `cards.evidencia_diagnostico`. Se `evidencia_status !== 'ok_com_foto_correlacionada'`, mostrar alerta acima do checkbox (texto laranja):

> ⚠ Detectado: evidência ausente pra oc={cod_ultima_ocorrencia} do card ({evidencia_diagnostico})

Se `evidencia_status === 'ok_com_foto_correlacionada'`, **NÃO mostrar o checkbox** (não precisa pular nada — evidência está OK). Caso de uso só faz sentido quando há problema.

---

## Contrato técnico (backend)

A RPC `aprovar_e_executar(p_todo_id, p_extras)` já aceita um jsonb arbitrário. Quando Larissa marca o checkbox, passar:

```json
{
  "skip_evidencia": true,
  ...outros extras que já passam hoje (email_destinatarios, anexos_ids, texto_email, etc.)
}
```

Quando NÃO marcado: não passar a chave (ou passar `false`).

O executor (já deployado) lê `extras.skip_evidencia === true` e desliga o gate de validação SOMENTE quando `cards.cod_ultima_ocorrencia` ∈ {10, 11, 35}. Auditoria grava `card_event EvidenciaIgnoradaPorOperador` automaticamente.

---

## Resumo

| Elemento | Mudança |
|---|---|
| Modal de aprovação | Novo checkbox abaixo dos extras existentes |
| Quando mostrar | Card em oc 10/11/35 + proposta com email + template tem `{link_evidencia}` + `evidencia_status≠ok` |
| Default | Desmarcado |
| Texto checkbox | "Lançar mesmo assim sem verificar evidência (vou anexar a foto manualmente no SSW)" |
| Aviso quando marcado | "⚠ Lembre de anexar a evidência manualmente no SSW." |

Caso típico real: card em oc=35, Larissa aprova proposta oc=54+email → modal mostra o checkbox.
