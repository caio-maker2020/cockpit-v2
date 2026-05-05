# Cockpit v2 — Redesenho do Kanban (colunas + auto-aprovação visual)

Cole esse prompt no Lovable. Mudanças no banco já estão aplicadas (migration 022).

---

## O que mudar

### 1. Colunas do Kanban — passa de 6 pra 5

**Antes:** ENTRANDO · EM PROCESSAMENTO · SUA AÇÃO · AGUARDANDO CLIENTE · AGUARDANDO SSW · RESOLVIDOS

**Agora:** EM PROCESSAMENTO · SUA AÇÃO · AGUARDANDO CLIENTE · **AÇÃO EXECUTADA** · **AÇÃO AUTÔNOMA**

- **Remova** a coluna `ENTRANDO` — não tem mais utilidade.
- **Renomeie** `AGUARDANDO SSW` → `AÇÃO EXECUTADA`.
- **Renomeie** `RESOLVIDOS` → `AÇÃO AUTÔNOMA`.

### 2. Filtros de cada coluna (PostgREST / supabase-js)

Use esses filtros exatos no fetch da lista do Kanban. Sempre adicione `state.neq.CANCELADO` no global pra esconder cards cancelados.

| Coluna | Filtro PostgREST |
|---|---|
| **EM PROCESSAMENTO** | `state=in.(EM_TRIAGEM,AGUARDANDO_VINCULACAO,AGUARDANDO_AGENTE,AGUARDANDO_CONTEXTO)&aprovacao_modo=is.null` |
| **SUA AÇÃO** | `state=eq.AGUARDANDO_VALIDACAO_HUMANA` |
| **AGUARDANDO CLIENTE** | `state=eq.AGUARDANDO_CLIENTE` |
| **AÇÃO EXECUTADA** | `aprovacao_modo=eq.humana&state=neq.CANCELADO` |
| **AÇÃO AUTÔNOMA** | `aprovacao_modo=eq.autonoma&state=neq.CANCELADO` |

Em supabase-js fica:
```ts
// EM PROCESSAMENTO
.from("cards")
  .select("...")
  .in("state", ["EM_TRIAGEM","AGUARDANDO_VINCULACAO","AGUARDANDO_AGENTE","AGUARDANDO_CONTEXTO"])
  .is("aprovacao_modo", null)

// SUA AÇÃO
.from("cards").select("...").eq("state", "AGUARDANDO_VALIDACAO_HUMANA")

// AGUARDANDO CLIENTE
.from("cards").select("...").eq("state", "AGUARDANDO_CLIENTE")

// AÇÃO EXECUTADA (aprovação humana)
.from("cards").select("...").eq("aprovacao_modo", "humana").neq("state", "CANCELADO")

// AÇÃO AUTÔNOMA (auto-aprovação)
.from("cards").select("...").eq("aprovacao_modo", "autonoma").neq("state", "CANCELADO")
```

### 3. Coluna nova `cards.aprovacao_modo`

- Tipo: `text` ou `null`
- Valores possíveis: `'humana'`, `'autonoma'`, `null`
- `null` = ainda não houve aprovação (card está em pré-aprovação)
- `'humana'` = operador clicou Aprovar
- `'autonoma'` = sistema auto-aprovou (regra do vinculador)

Atualize os tipos TS gerados do Supabase (`Database['public']['Tables']['cards']['Row']`) pra incluir o campo.

### 4. Badge no detalhe do card / no card do Kanban

Quando `aprovacao_modo === 'autonoma'`, mostra um badge visual diferente. Sugestão:

- **Card no Kanban**: pequeno selo no canto superior direito.
  - `'autonoma'` → badge azul/roxo "🤖 AUTO" (ou ícone de robô + "Autônomo")
  - `'humana'` → badge cinza "✋ Humano" (opcional, pra simetria)

- **Detalhe do card** (sidebar esquerda, abaixo do título): badge maior e mais explicativo:
  - `'autonoma'` → "Aprovado automaticamente pelo agente"
  - `'humana'` → "Aprovado por <nome do operador que clicou>" (busca via `todos.approved_by` → `operadores.nome`)

### 5. Coluna nova `todos.auto_approval_rule`

Quando o agente auto-aprova, esse campo guarda a regra que disparou (ex: `"ultima_oc_13_e_cliente_autorizou_reentrega"`). Mostra no detalhe do todo, dentro do card aberto:

```
Status: ✅ Aprovado automaticamente
Regra: ultima_oc_13_e_cliente_autorizou_reentrega
```

Quando é aprovação humana, `auto_approval_rule` é `null` e mostra:
```
Status: ✅ Aprovado por João Silva às 14:32
```

### 6. Timeline de eventos (aba "Eventos" do card)

Quando aparecer o evento `AutoAprovacaoPermitida`, renderiza com ícone de robô e cor diferenciada. Payload tem:
```json
{
  "regra": "ultima_oc_13_e_cliente_autorizou_reentrega",
  "todo_id": "...",
  "action_id": "...",
  "proposta_payload": { ... }
}
```

Render sugerido:
> 🤖 **Auto-aprovação permitida** — Regra: `ultima_oc_13_e_cliente_autorizou_reentrega`
> O agente decidiu executar sem validação humana.

E o evento `AcaoPropostaPeloAgente` agora tem 2 campos novos no payload pra exibir contexto:
- `cliente_autorizou_reentrega` (boolean)
- `cod_ultima_ocorrencia` (number)

Render sugerido:
> 💡 **Ação proposta**: Lançar ocorrência 21
> Última ocorrência SSW: 13 · Cliente autorizou reentrega: ✅ sim

### 7. Estado terminal "RESOLVIDO" — pra onde vai?

Como a coluna RESOLVIDOS sumiu do Kanban, cards com `state='RESOLVIDO'` ficam invisíveis no quadro principal. Cria um link/aba **"Resolvidos"** secundária (filtro top-bar ou rota separada `/resolvidos`) que lista esses cards. Não polui o Kanban operacional.

### 8. Não muda

- Detalhe do card (sidebar esquerda com NF, CTRC, pagador, base, operador atribuído, etc.).
- Aba Mensagens / Eventos / Histórico SSW.
- Botão Aprovar / Rejeitar — continua chamando `aprovar_e_executar` / `rejeitar_acao`.
- O card de auto-aprovação **não tem botão Aprovar** porque já foi aprovado pelo sistema. O todo aparece como `status='aprovado'` direto.

---

## Resumo da regra de negócio (pro contexto)

- **Cards na coluna AÇÃO AUTÔNOMA** = sistema decidiu lançar ocorrência sozinho. Hoje, regra ativa: NF na allowlist (`["86964"]`) + última ocorrência SSW = 13 + IA detectou autorização explícita do cliente.
- **Cards na coluna AÇÃO EXECUTADA** = operador humano aprovou e ocorrência foi (ou está sendo) lançada no SSW.
- O gestor olhando o quadro consegue separar de bate-pronto o que é trabalho do agente do que precisou de humano.
