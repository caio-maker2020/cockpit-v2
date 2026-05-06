# Lovable — Adicionar checkbox "VALIDAR EVIDÊNCIA" no modal de confirmação de lançamento

## Contexto

Hoje, quando Larissa clica em aprovar um todo no Cockpit (ex: oc=54 com email), abre o modal abaixo. **Este é o modal que precisa receber 1 (UM) checkbox novo:**

```
┌────────────────────────────────────────────────────┐
│  54  Aguardando retorno do cliente (com email)     │
│                                                     │
│  ☐ ENVIAR EMAIL PRO CLIENTE JUNTO COM O LANÇAMENTO │
│     (oc=54 sem email manual — opcional)            │
│                                                     │
│  Padrão 2026-05-05...    CANCELAR  [CONFIRMAR →]   │
└────────────────────────────────────────────────────┘
```

Esse modal já existe e funciona. **Vou pedir UMA mudança específica.**

---

## A mudança

**Adicionar 1 segundo checkbox abaixo do checkbox existente:**

```
┌────────────────────────────────────────────────────┐
│  54  Aguardando retorno do cliente (com email)     │
│                                                     │
│  ☐ ENVIAR EMAIL PRO CLIENTE JUNTO COM O LANÇAMENTO │
│     (oc=54 sem email manual — opcional)            │
│                                                     │
│  ☐ VALIDAR EVIDÊNCIA ANTES DE ENVIAR  ← NOVO       │
│     Aplica regra de bloqueio se SSW não tiver      │
│     foto anexada na ocorrência atual do card.      │
│     Marque só quando o motivo da ocorrência exige  │
│     evidência (ex: contestar recusa do cliente).   │
│                                                     │
│  Padrão 2026-05-05...    CANCELAR  [CONFIRMAR →]   │
└────────────────────────────────────────────────────┘
```

### Regra de exibição

O checkbox novo **só deve aparecer** se `card.cod_ultima_ocorrencia` for **diferente** de 10, 11 ou 35.

```ts
const mostrarCheckboxValidarEvidencia =
  ![10, 11, 35].includes(card.cod_ultima_ocorrencia);
```

Para `cod_ultima_ocorrencia` em `[10, 11, 35]` (recusa total/endereço/recusa parcial): **NÃO renderizar** — backend valida automaticamente nesses casos, mostrar checkbox confunde.

### Default

Estado inicial: **desmarcado** (validação OFF). Larissa precisa marcar ativamente quando quiser forçar validação.

### O que enviar pro backend

No payload do `aprovar_e_executar`, no campo `extras`, adicionar:

```ts
const extras = {
  // ...campos existentes do modal (skip_email etc)...
  validar_evidencia: validarEvidenciaCheckbox, // boolean
};

await supabase.rpc('aprovar_e_executar', {
  p_todo_id: todoId,
  p_extras: extras,
});
```

Se Larissa NÃO marcou o checkbox: enviar `validar_evidencia: false`.
Se Larissa marcou: enviar `validar_evidencia: true`.

---

## Implementação

1. Localizar o componente do modal de confirmação de lançamento (provavelmente algo como `LancamentoConfirmModal.tsx`, `ConfirmarLancamento.tsx`, `AprovarTodoModal.tsx` — onde estiver renderizado o checkbox "ENVIAR EMAIL PRO CLIENTE...").

2. Adicionar `useState` local pra o novo checkbox:

```tsx
const [validarEvidencia, setValidarEvidencia] = useState(false);
```

3. Renderizar o segundo checkbox **logo abaixo** do checkbox "ENVIAR EMAIL...", e **acima** do rationale "Padrão 2026-05-05...":

```tsx
{![10, 11, 35].includes(card.cod_ultima_ocorrencia) && (
  <div className="...">
    <Checkbox
      checked={validarEvidencia}
      onCheckedChange={setValidarEvidencia}
      label="VALIDAR EVIDÊNCIA ANTES DE ENVIAR"
    />
    <p className="text-xs text-muted">
      Aplica regra de bloqueio se SSW não tiver foto anexada na
      ocorrência atual do card. Marque só quando o motivo exige
      evidência (ex: contestar recusa).
    </p>
  </div>
)}
```

(Estilo CSS deve seguir o padrão do checkbox existente — não inventar.)

4. No handler do botão CONFIRMAR LANÇAMENTO, incluir `validar_evidencia: validarEvidencia` no objeto `extras` que é passado pra `aprovar_e_executar`.

---

## Backend (não mexer — já está pronto)

O executor já lê `extras.validar_evidencia` e aplica a regra:
- `validar_evidencia: true` → executa scraping no SSW. Se sem foto → bloqueia envio.
- `validar_evidencia: false` (ou ausente) → envia direto sem checar.
- Para ocs `[10, 11, 35]` → SEMPRE valida, ignorando esse flag (regra de produto).

---

## Resumo em 1 frase

Adicionar UM checkbox abaixo do checkbox "ENVIAR EMAIL...", com label "VALIDAR EVIDÊNCIA ANTES DE ENVIAR", default desmarcado, condicional a `cod_ultima_ocorrencia ∉ [10,11,35]`, e enviar o valor em `extras.validar_evidencia` na chamada `aprovar_e_executar`.

Não mexer em mais nada.
