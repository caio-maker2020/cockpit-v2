# Lovable — Checkbox "ENVIAR EMAIL" opcional em TODAS as variantes de oc=54

**Data:** 2026-05-20
**Status:** Backend 100% pronto (aceita `extras.enviar_email=false`). Front precisa garantir checkbox em TODAS as variantes.

Caio: "quero que todas as opcoes de lancar 54 podem ser desmarcadas de mandar email, sendo opcional ou nao... a cargo do operador."

Substitui parcialmente [`lovable-fix-checkbox-enviar-email.md`](lovable-fix-checkbox-enviar-email.md) — generaliza pra TODAS as 8 entry points.

---

## As 8 variantes de oc=54 com email

Toda proposta abaixo é gerada por `regras-auto-acao.ts` com `tool='lancar_oc_e_enviar_email'`. **Cada uma precisa do checkbox** no modal de aprovação:

| Origem (cod_ultima_ocorrencia) | Template email | Contexto |
|---|---|---|
| **oc=10** (recusa total) | RECUSA_TOTAL | Cliente recusou entrega total |
| **oc=11** (problemas com endereço) | PROBLEMAS_COM_ENDERECO | Endereço errado / não localizado |
| **oc=13** (excepcional `cliente_config_oc13`) | FALTA_DE_VOLUME | 12 CNPJs específicos |
| **oc=19** (falta de volumes) | FALTA_DE_VOLUME | Entrega parcial |
| **oc=20** (extravio localizado) | dropdown template | Larissa escolhe template no modal |
| **oc=35** (recusa parcial) | RECUSA_PARCIAL | Recusa parcial |
| **oc=49** (tratativa relacionamento) | FALTA_DE_VOLUME | Em tratativa, lança 54 + cobra cliente |
| **oc=54** (recobrança 2ª) | FALTA_DE_VOLUME | Recobrar quando cliente não respondeu |

**TODAS** as 8 entry points precisam do checkbox idêntico, com mesmo comportamento.

---

## Componente reusável: `<CheckboxEnviarEmail>`

Cria 1 vez, reusa nos 8 modais. Evita drift entre eles.

```tsx
// components/CheckboxEnviarEmail.tsx
interface Props {
  /** Tool da proposta original — define o default do checkbox */
  toolProposta: string; // 'lancar_oc_e_enviar_email' | 'lancar_ocorrencia' | ...
  /** Código da oc que será lançada (51, 54, etc) — pro toast e aviso */
  codigoSsw: number;
  /** Template de email da proposta — pro aviso visual */
  templateId?: string | null;
  /** State controlado (pai mantém o boolean) */
  value: boolean;
  onChange: (v: boolean) => void;
}

export function CheckboxEnviarEmail({ toolProposta, codigoSsw, templateId, value, onChange }: Props) {
  const propostaOriginalEnviaEmail = toolProposta === 'lancar_oc_e_enviar_email';
  
  return (
    <div className="flex flex-col gap-1 rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 p-3">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
          className="w-4 h-4 accent-zinc-700"
        />
        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
          Enviar email pro cliente junto com o lançamento
        </span>
      </label>
      {templateId && (
        <p className="text-xs text-zinc-500 ml-6">
          Template: <span className="font-mono">{templateId}</span>
        </p>
      )}
      {!value && propostaOriginalEnviaEmail && (
        <p className="text-xs text-orange-600 dark:text-orange-400 ml-6">
          ⚠ Email NÃO será enviado. Apenas lançando oc {codigoSsw} no SSW.
        </p>
      )}
      {value && !propostaOriginalEnviaEmail && (
        <p className="text-xs text-blue-600 dark:text-blue-400 ml-6">
          📧 Email será adicionado ao lançamento (proposta original era só lançar a oc).
        </p>
      )}
    </div>
  );
}
```

---

## Default do checkbox (regra única)

```tsx
const propostaOriginalEnviaEmail = todo.proposta_payload?.tool === 'lancar_oc_e_enviar_email';
const [enviarEmail, setEnviarEmail] = useState(propostaOriginalEnviaEmail);
```

- **Proposta era `lancar_oc_e_enviar_email`** → checkbox **MARCADO** por default (operador desmarca pra cancelar email)
- **Proposta era `lancar_ocorrencia`** (sem email) → checkbox **DESMARCADO** por default (operador marca pra adicionar email)

Isso é universal pras 8 entry points e qualquer futura.

---

## Handler do CONFIRMAR (sempre inclui flag)

Todos os 8 modais usam o mesmo padrão:

```tsx
async function handleConfirmar() {
  const extras = {
    ...outrosExtras,           // texto, anexos, filial, validar_evidencia, etc
    enviar_email: enviarEmail, // ← SEMPRE incluir, true ou false
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
  onClose();
}
```

**Importante:** o front sempre manda `enviar_email: true|false` em extras. Nunca omite. O backend já trata:

- `extras.enviar_email = false` → não envia email
- `extras.enviar_email = true` → envia se proposta original tinha conteúdo

---

## Onde plugar no modal de cada variante

Pra cada um dos 8 modais que aprovam oc=54 com email:

```tsx
function ModalAprovarOc54({ todo, onClose }) {
  const [enviarEmail, setEnviarEmail] = useState(
    todo.proposta_payload?.tool === 'lancar_oc_e_enviar_email'
  );
  
  // ... outros estados (texto, anexos, filial, etc)
  
  return (
    <Dialog>
      <DialogHeader>...</DialogHeader>
      
      {/* Campos atuais do modal (texto, anexos, etc) */}
      
      {/* ↓↓↓ CHECKBOX SEMPRE PRESENTE quando codigoSsw=54 ↓↓↓ */}
      {todo.proposta_payload?.args?.codigo_ssw === 54 && (
        <CheckboxEnviarEmail
          toolProposta={todo.proposta_payload?.tool}
          codigoSsw={54}
          templateId={todo.proposta_payload?.args?.template_id}
          value={enviarEmail}
          onChange={setEnviarEmail}
        />
      )}
      
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button onClick={handleConfirmar}>Aprovar e executar</Button>
      </DialogFooter>
    </Dialog>
  );
}
```

---

## Critério de aceite (testar nas 8 origens)

1. **Card com oc=49 (Larissa abre proposta "lançar 54 + email FALTA_DE_VOLUME")**: checkbox aparece marcado. Desmarca → confirma → SSW lança oc=54 sem email. ✓
2. **Card com oc=10 (proposta "lançar 54 + email RECUSA_TOTAL")**: checkbox marcado. Desmarca → sem email. ✓
3. **Card com oc=11 (PROBLEMAS_COM_ENDERECO)**: idem. ✓
4. **Card com oc=19 (FALTA_DE_VOLUME)**: idem. ✓
5. **Card com oc=20 (template dropdown — FALTA_DE_VOLUME default)**: checkbox marcado mesmo com dropdown. Desmarca → sem email mas template_id ignorado. ✓
6. **Card com oc=35 (RECUSA_PARCIAL)**: idem. ✓
7. **Card com oc=54 já (recobrança 2ª)**: checkbox marcado. Desmarca → relança 54 sem novo email. ✓
8. **Card oc=13 excepcional (cliente_config_oc13)**: checkbox marcado. Desmarca → 54 sem email. ✓
9. **Tela do extras inverso (proposta `lancar_ocorrencia` pura sem email)**: checkbox **DESMARCADO** por default. Marca → email é adicionado (precisa template fornecido).
10. **Toast reflete a decisão**: "Lançando oc 54 + enviando email..." vs "Lançando oc 54 (sem email)."

---

## Backend (já pronto — não mexer)

`supabase/functions/executor/index.ts` linha ~421 já lida:

```ts
const skipEmail = argsExtras?.["skip_email"] === true ||
                  argsExtras?.["enviar_email"] === false;
```

Aceita ambos formatos antigos e novos. Front manda `enviar_email`, segue funcionando.

---

## Resumo do que aplicar no Lovable

1. **Criar 1 componente reusável** `<CheckboxEnviarEmail>` (código acima)
2. **Renderizar em TODOS os 8 modais** que mostram propostas de oc=54 (ou qualquer proposta com tool=`lancar_oc_e_enviar_email`)
3. **Handler do CONFIRMAR sempre inclui** `enviar_email: bool` em `p_extras`
4. **Default do checkbox** segue intenção da proposta original (`tool === 'lancar_oc_e_enviar_email'` → marcado; senão desmarcado)
5. **Aviso visual** quando há divergência entre default e escolha do operador

Não tem nada novo no backend. Só consistência no front.
