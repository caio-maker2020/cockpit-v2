# Lovable — Fix: checkbox "ENVIAR EMAIL" precisa propagar pro back quando desmarcado

## Bug observado (NF 754750, Caio 2026-05-12)

Larissa abriu o card NF 754750 (oc=49), clicou em aprovar a proposta "lançar 54 + email FALTA_DE_VOLUME". No modal, **desmarcou** o checkbox "ENVIAR EMAIL PRO CLIENTE JUNTO COM O LANÇAMENTO" e clicou em CONFIRMAR.

Resultado errado: a ocorrência 54 foi lançada **E** o email foi enviado pro cliente. O checkbox foi ignorado.

Causa raiz: o handler do botão CONFIRMAR está enviando pro back `extras = { validar_evidencia: false }` (sem informação do estado do checkbox de email). Como o `proposta_payload.tool === 'lancar_oc_e_enviar_email'`, o executor decide enviar email baseado SÓ no tool, ignorando a intenção da Larissa.

---

## Fix

No modal de aprovação que tem o checkbox "ENVIAR EMAIL PRO CLIENTE JUNTO COM O LANÇAMENTO":

### 1. Estado inicial do checkbox

Depende da proposta:

```tsx
const propostaOriginalEnviaEmail =
  todo.proposta_payload?.tool === 'lancar_oc_e_enviar_email';

const [enviarEmail, setEnviarEmail] = useState(propostaOriginalEnviaEmail);
```

- Quando proposta é `lancar_oc_e_enviar_email` (regra criou a versão "completa") → **default MARCADO**. A proposta original já é enviar email; Larissa precisa desmarcar ativamente se quiser cancelar.
- Quando proposta é `lancar_ocorrencia` (sem email) → **default DESMARCADO**. Larissa precisa marcar ativamente se quiser adicionar email.

### 2. Sempre incluir o valor explícito em extras

No handler do botão CONFIRMAR:

```tsx
async function handleConfirmar() {
  const extras = {
    validar_evidencia: validarEvidencia,
    enviar_email: enviarEmail,  // ← SEMPRE incluir, true ou false
  };

  const { error } = await supabase.rpc('aprovar_e_executar', {
    p_todo_id: todoId,
    p_extras: extras,
  });

  if (error) { toast.error(error.message); return; }
  toast.success(
    enviarEmail
      ? `Lançando oc ${codigoSsw} + enviando email...`
      : `Lançando oc ${codigoSsw} (sem email).`
  );
}
```

**Importante:** mandar `enviar_email: true/false` SEMPRE, não condicional. O back já aceita os dois formatos:
- `extras.enviar_email = false` → não envia email (equivalente a `skip_email: true`)
- `extras.enviar_email = true` → envia email se proposta original tinha conteúdo

### 3. Aviso visual quando desmarcado

Logo abaixo do checkbox, mostrar uma linha de feedback condicional:

```tsx
{!enviarEmail && propostaOriginalEnviaEmail && (
  <p className="text-xs text-orange-600 mt-1">
    ⚠ Email NÃO será enviado. Vou apenas lançar a oc {codigoSsw} no SSW.
  </p>
)}
```

Isso elimina ambiguidade — Larissa vê em texto claro o que vai acontecer.

---

## Checklist do fix

- [ ] Default do checkbox depende de `tool === 'lancar_oc_e_enviar_email'`
- [ ] Handler do CONFIRMAR sempre inclui `enviar_email: <bool>` em `p_extras`
- [ ] Aviso laranja "Email NÃO será enviado" aparece quando checkbox desmarcado E proposta original era enviar
- [ ] Toast de sucesso reflete a decisão ("sem email" vs "+ enviando email")

---

## Backend (já corrigido — não mexer)

Em [supabase/functions/executor/index.ts:381](supabase/functions/executor/index.ts#L381) o executor agora aceita ambos os formatos:

```ts
const skipEmail = argsExtras?.["skip_email"] === true ||
                  argsExtras?.["enviar_email"] === false;
```

Então mesmo se um modal antigo continuar mandando `skip_email: true`, segue funcionando. O novo é `enviar_email` (mais intuitivo, alinhado com o label do checkbox).

---

## Resumo

Bug: checkbox visual sem propagação pro back. Larissa desmarca → front não envia flag → executor envia email por padrão da proposta.

Fix: handler do CONFIRMAR **sempre** inclui `enviar_email: true|false` em `p_extras`. Default do checkbox segue intenção da proposta original. Aviso visual quando há divergência.
