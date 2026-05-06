# Lovable — PATCH no modal de email (2 problemas pra resolver)

## Problema 1 (bug): textarea apaga quando Larissa começa a digitar

Hoje o campo "TEXTO DO EMAIL" está usando **placeholder** em vez de **value** (ou alguma reset no `onChange`). Quando Larissa começa a digitar, o texto desaparece.

**Fix:** usar React state controlado. Pseudocódigo:

```tsx
const [corpoEmail, setCorpoEmail] = useState('');

// Quando o modal abre OU template muda → preencher state:
setCorpoEmail(data.template_atual.corpo_renderizado);

<textarea
  value={corpoEmail}
  onChange={(e) => setCorpoEmail(e.target.value)}
  // SEM placeholder com texto pré-formatado
/>
```

Larissa precisa conseguir editar livremente sem o texto sumir.

---

## Problema 2: falta seletor de template

Adicionar uma "caixinha" (radio buttons OU dropdown — o que ficar melhor no layout) **acima do TEXTO DO EMAIL**, pra Larissa escolher qual template usar.

### Como popular as opções

Ao abrir o modal, chamar:

```ts
const { data } = await supabase.rpc('preview_email_todo', {
  p_todo_id: todoId
});
```

A resposta tem:
```jsonc
{
  "email_destino": "atendimento.transportes8@...",
  "template_atual": {
    "id": "RECUSA_TOTAL",
    "nome": "Recusa total da entrega — solicitar tratativa",
    "assunto_renderizado": "[Sal Express] NF 2148226 — recusa total",
    "corpo_renderizado": "Olá COM.CIRURGI.,\n\nA entrega da NF 2148226 foi recusada totalmente no destino.\n\nVeja a evidência registrada no destino: {link_evidencia}\n\nComo prefere prosseguir?\n..."
  },
  "templates_disponiveis": [
    { "id": "RECUSA_TOTAL", "nome": "Recusa total..." },
    { "id": "COBRANCA_LEMBRETE", "nome": "Cobrança de lembrete..." }
  ]
}
```

### O que mostrar

Cada item de `templates_disponiveis` vira uma opção. Default selecionado = `template_atual.id`.

### O que acontece ao trocar de template

Quando Larissa muda a opção, **chama a RPC de novo** com `p_template_id_override` pra puxar o corpo do template novo:

```ts
const onTemplateChange = async (novoId: string) => {
  const { data } = await supabase.rpc('preview_email_todo', {
    p_todo_id: todoId,
    p_template_id_override: novoId,
  });
  setTemplateSelecionado(novoId);
  setAssunto(data.template_atual.assunto_renderizado);
  setCorpoEmail(data.template_atual.corpo_renderizado); // ← popula o textarea
};
```

O textarea recebe o novo conteúdo. Larissa pode editar normalmente (sem apagar nada — graças ao Fix 1).

---

## Adicionar também: campo ASSUNTO editável

Acima do TEXTO DO EMAIL, adicionar um input de texto "ASSUNTO" também controlado por state:

```tsx
const [assunto, setAssunto] = useState('');

// Inicializa com data.template_atual.assunto_renderizado quando modal abre
// e quando trocar de template

<input
  type="text"
  value={assunto}
  onChange={(e) => setAssunto(e.target.value)}
/>
```

---

## Ao clicar CONFIRMAR

Passar os 3 valores em `p_extras`:

```ts
const extras = {
  email_destinatarios: destinatariosMarcados, // já existia
  assunto_override: assunto,
  texto_email_customizado: corpoEmail,
};

if (templateSelecionado !== templateOriginalId) {
  extras.template_id_override = templateSelecionado;
}

await supabase.rpc('aprovar_e_executar', {
  p_todo_id: todoId,
  p_extras: extras,
});
```

Backend (executor) já lê esses 4 campos de `extras`. Sem mexer no backend.

---

## Layout esperado (mantém tudo que já tem + 2 adições marcadas com NOVO)

```
┌─ Aprovar e enviar email — NF 2148226 ──┐
│                                          │
│ DESTINATÁRIOS  [igual hoje]              │
│ ☑ atendimento.transportes5@rio...        │
│ ☐ atendimento.transportes9@rio...        │
│ ☐ ...                                    │
│                                          │
│ TEMPLATE *  ← NOVO                       │
│ ◉ Recusa total da entrega                │
│ ○ Cobrança de lembrete                   │
│   (ou usar dropdown — escolha o que     │
│    encaixar melhor)                      │
│                                          │
│ ASSUNTO *  ← NOVO                        │
│ [Sal Express] NF 2148226 — recusa...    │
│                                          │
│ TEXTO DO EMAIL *  [igual hoje, mas       │
│ valor controlado por state — NÃO apaga  │
│ ao editar]                               │
│ ┌──────────────────────────────────┐    │
│ │ Olá COM.CIRURGI.,                │    │
│ │                                   │    │
│ │ A entrega da NF 2148226 foi      │    │
│ │ recusada totalmente no destino.  │    │
│ │                                   │    │
│ │ Veja a evidência registrada no   │    │
│ │ destino: {link_evidencia}        │    │
│ │ ...                               │    │
│ └──────────────────────────────────┘    │
│                                          │
│ Como funciona: [igual hoje]              │
│                                          │
│              [CANCELAR]  [CONFIRMAR →]  │
└──────────────────────────────────────────┘
```

---

## Resumo

Duas coisas a fazer:

1. **Corrigir o bug:** textarea TEXTO DO EMAIL precisa ser controlado por `useState` + `value` (não placeholder), pra Larissa editar sem perder o texto.
2. **Adicionar caixinha TEMPLATE** acima do TEXTO DO EMAIL, populada por `preview_email_todo` RPC, com handler que repopula assunto+corpo ao trocar.

Bonus (já estava no prompt anterior): adicionar campo ASSUNTO editável também.

---

## Adendo Caio 2026-05-06 — Checkbox "Validar evidência" pra oc=49

**Bug NF 342390:** Larissa quis lançar oc=54+template FALTA_DE_VOLUME pós-oc=49. Esse caso NÃO precisa de evidência fotográfica (volume faltante, não recusa). Mas executor bloqueou o envio porque a regra de evidência estava aplicada generalizada.

**Regra ajustada:**
- **oc=10/11/35**: regra de evidência SEMPRE aplica (recusa/endereço errado precisa foto). Backend valida automático, sem checkbox.
- **oc=49**: regra desligada por default. Checkbox no modal de email permite Larissa ATIVAR caso-a-caso quando o motivo da oc=49 envolve evidência.
- **Outras ocs**: idem oc=49 — checkbox decide.

### O que adicionar no modal

Logo abaixo do dropdown de TEMPLATE (e acima do ASSUNTO), quando `card.cod_ultima_ocorrencia === 49`:

```
┌──────────────────────────────────────────────────────┐
│ ☐ Validar evidência antes de enviar                  │
│   Aplica regra de bloqueio se SSW não tiver foto     │
│   anexada na oc do card. Ative só se o motivo        │
│   exige foto (ex: contestação de recusa).            │
└──────────────────────────────────────────────────────┘
```

Default: **OFF** (desmarcado).

Para `cod_ultima_ocorrencia` ∈ [10, 11, 35]: NÃO mostrar checkbox (validação é sempre forçada no backend, mostrar pode confundir).

Para outras ocs: mostrar checkbox também (default OFF).

### Como passar pro backend

Ao clicar CONFIRMAR, incluir no `extras`:

```ts
const extras = {
  email_destinatarios: destinatariosMarcados,
  assunto_override: assunto,
  texto_email_customizado: corpoEmail,
  validar_evidencia: validarEvidenciaChecked, // boolean
};
if (templateSelecionado !== templateOriginalId) {
  extras.template_id_override = templateSelecionado;
}

await supabase.rpc('aprovar_e_executar', { p_todo_id: todoId, p_extras: extras });
```

Backend (executor) lê `extras.validar_evidencia`. Se `true` E template usa `{link_evidencia}` E oc não está em [10,11,35] → roda scraping. Se `false` → envia direto. Para [10,11,35] sempre valida independente do flag.
