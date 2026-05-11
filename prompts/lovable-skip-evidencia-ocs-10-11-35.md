# Lovable — Checkbox "PULAR VERIFICAÇÃO DE EVIDÊNCIA" no modal de aprovação das ocs 10/11/35

## Contexto

Hoje, ao aprovar uma proposta de lançamento de oc=10/11/35 com email (template usa `{link_evidencia}`), o Cockpit valida automaticamente se o SSW tem foto correlacionada à oc. Se não tiver, **bloqueia o lançamento** com erro "Evidencia ausente pra oc=X" e reverte o todo pra `pendente`.

**Essa regra é correta na maioria dos casos** — não queremos mandar email com link de foto quebrada pro cliente.

**Mas tem exceção real:** operação às vezes lança a foto na oc errada (ex: NF 353730 — foto foi pra oc=26 e não pra oc=35). Larissa abre o SSW manualmente, vê que tem foto válida, anexa ela na oc certa por fora do Cockpit, mas o gate continua bloqueando porque o scraping ainda não enxergou a foto correta. Resultado: Larissa fica travada.

**Solução**: 1 checkbox que Larissa pode marcar pra pular a verificação automática — ela assume responsabilidade de anexar a foto manualmente no SSW antes (ou depois) do lançamento.

---

## A mudança

**Adicionar 1 checkbox no modal de aprovação SE a proposta é de oc=10/11/35 com email:**

```
┌────────────────────────────────────────────────────────┐
│  35  Recusa parcial / lançar 54 + email cliente        │
│                                                         │
│  Destinatários: marcelo@cliente.com.br, sac@cliente... │
│  Anexos (opcional): [+ Adicionar arquivo]              │
│                                                         │
│  ⚠ Detectado: evidência ausente pra oc=35 (foto SSW    │
│  não bate com a oc atual)                              │
│                                                         │
│  ☐ Lançar mesmo assim sem verificar evidência          │
│     (vou anexar a foto manualmente no SSW)             │
│                                                         │
│                            CANCELAR  [CONFIRMAR →]     │
└────────────────────────────────────────────────────────┘
```

### Quando mostrar o checkbox

**Apenas para propostas com `codigo_ssw IN (10, 11, 35)`** e cujo template/texto contém `{link_evidencia}`. Em outras ocs (44, 56, 21, 54, etc), NÃO mostrar.

### Quando MARCAR o checkbox por padrão

**Nunca por padrão.** Larissa precisa marcar conscientemente.

### Aviso visual reforçado quando marcado

Quando Larissa marca o checkbox, mostrar um pequeno aviso laranja abaixo:

```
⚠ Lembre de anexar a evidência manualmente no SSW.
```

### Estado "evidência detectada como ausente"

O front já consegue ler `cards.evidencia_status` e `cards.evidencia_diagnostico`. Se `evidencia_status !== 'ok_com_foto_correlacionada'`, mostrar o alerta acima do checkbox:

> ⚠ Detectado: evidência ausente pra oc=X ({evidencia_diagnostico})

Se `evidencia_status === 'ok_com_foto_correlacionada'`, o checkbox **continua sendo mostrado** (Larissa pode querer pular mesmo assim), mas sem o alerta vermelho.

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

O executor já trata o resto (linha ~1031 — `skipEvidencia = extras?.skip_evidencia === true` desliga o gate de evidência apenas se for `true`).

---

## Resumo do que muda na UI

| Elemento | Mudança |
|---|---|
| Modal de aprovação | Novo checkbox abaixo dos extras existentes, SÓ pra oc=10/11/35 com email |
| Default | Desmarcado |
| Texto do checkbox | "Lançar mesmo assim sem verificar evidência (vou anexar a foto manualmente no SSW)" |
| Aviso quando marcado | "⚠ Lembre de anexar a evidência manualmente no SSW." |
| Aviso de evidência ausente | Continua igual ao banner amarelo já existente (renderiza `evidencia_diagnostico`) |

Nada mais muda. Bypass é audit-logado pelo backend (card_event `EvidenciaIgnoradaPorOperador`).
