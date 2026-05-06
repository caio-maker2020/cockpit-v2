# Lovable — Modal de edição de email antes de aprovar todo

## Contexto

Hoje, quando Larissa clica "Aprovar e Executar" num to-do com `proposta_payload.tool === 'lancar_oc_e_enviar_email'`, o cockpit dispara `aprovar_e_executar(todo_id)` direto e o executor envia o email com **assunto e corpo padronizados do template**, sem permitir edição.

Larissa precisa **editar assunto e corpo** antes do envio (e às vezes trocar de template), porque o texto padrão nem sempre encaixa no contexto do cliente.

Backend já está pronto:
- RPC `preview_email_todo(p_todo_id uuid, p_template_id_override text default null)` devolve template atual + lista de templates aplicáveis + assunto/corpo já renderizados com vars do card.
- RPC `aprovar_e_executar(p_todo_id uuid, p_extras jsonb)` já aceita extras. Executor lê `extras.assunto_override`, `extras.texto_email_customizado`, `extras.template_id_override`.
- Placeholder `{link_evidencia}` deve ser preservado literal no texto editado — executor gera token de evidência só na hora do envio.

## O que implementar

Quando Larissa clicar "Aprovar e Executar" num to-do cujo `proposta_payload.tool === 'lancar_oc_e_enviar_email'`, **NÃO** dispare `aprovar_e_executar` direto. Em vez disso, abra um modal.

### Fluxo do modal

**1. Ao abrir:** chamar
```ts
const { data, error } = await supabase.rpc('preview_email_todo', {
  p_todo_id: todoId
});
```

`data` retorna:
```jsonc
{
  "todo_id": "uuid",
  "card_id": "uuid",
  "nf": "2148226",
  "codigo_ssw_proposta": 54,
  "cod_ultima_ocorrencia_card": 10,
  "email_destino": "atendimento.transportes8@rioclarense.com.br",
  "template_atual": {
    "id": "RECUSA_TOTAL",
    "nome": "Recusa total da entrega — solicitar tratativa",
    "descricao": "...",
    "assunto_renderizado": "[Sal Express] NF 2148226 — recusa total da entrega",
    "corpo_renderizado": "Olá COM.CIRURGI.,\n\nA entrega da NF 2148226...",
    "usa_link_evidencia": true
  },
  "templates_disponiveis": [
    { "id": "RECUSA_TOTAL", "nome": "...", "descricao": "..." },
    { "id": "COBRANCA_LEMBRETE", "nome": "...", "descricao": "..." }
  ]
}
```

**2. Renderizar modal** com:

- **Título:** "Aprovar e enviar email — NF {nf}"
- **Para:** `email_destino` (texto cinza, não editável por enquanto — TODO futuro: editar destinatário)
- **Template (dropdown/select):** opções de `templates_disponiveis`. Default = `template_atual.id`. Mostra `nome` no select; `descricao` em tooltip.
- **Assunto (input texto):** valor inicial = `template_atual.assunto_renderizado`. Editável.
- **Corpo (textarea, ~14 linhas):** valor inicial = `template_atual.corpo_renderizado`. Editável.
- **Aviso visual** se `template_atual.usa_link_evidencia === true`: card amarelo claro com texto: *"O placeholder `{link_evidencia}` será substituído por um link único no momento do envio. Mantenha-o no texto se quiser que o cliente veja a evidência."* Use ícone 🔗 ou similar.
- **Botões no rodapé:**
  - `[Cancelar]` (fecha modal sem ação)
  - `[Aprovar e enviar →]` (primary, dispara aprovação)

**3. Ao trocar template no dropdown:**

Re-chamar a RPC com `p_template_id_override: novoId`. Substituir os campos assunto/corpo pelos novos valores renderizados.

**Importante:** se Larissa já editou assunto/corpo manualmente e troca template, mostrar `confirm()` ou diálogo: *"Trocar de template descarta as edições atuais. Continuar?"*. Só recarrega se confirmar.

**4. Ao clicar "Aprovar e enviar":**

```ts
const extras: Record<string, unknown> = {
  assunto_override: assuntoEditado,
  texto_email_customizado: corpoEditado,
};
if (templateIdEscolhido !== data.template_atual.id) {
  // só envia override se Larissa trocou
  extras.template_id_override = templateIdEscolhido;
}

const { data: result, error } = await supabase.rpc('aprovar_e_executar', {
  p_todo_id: todoId,
  p_extras: extras,
});
if (error) {
  toast.error(`Não consegui aprovar: ${error.message}`);
  return;
}
toast.success('Aprovado. Email enviando...');
fecharModal();
recarregarCard();
```

### Quando NÃO abrir o modal

Para to-dos com outras tools (ex: `lancar_ocorrencia` puro, sem email), **mantenha o comportamento atual** (aprovação direta sem modal).

Detecção:
```ts
const precisaModalEmail =
  todo.proposta_payload?.tool === 'lancar_oc_e_enviar_email';
```

### Edge cases

- **Email destino null:** se `email_destino` vier null mesmo após fallback, mostrar campo com input vazio + label vermelha "⚠️ Cliente sem email cadastrado — informe manualmente". Botão "Aprovar" desabilitado até preencher (ou TODO futuro: passar `extras.email_destinatarios` array). Por enquanto, bloquear aprovação seria suficiente.
- **Erro na RPC preview:** mostrar toast erro, manter botão original (aprovação direta) como fallback de segurança.
- **`templates_disponiveis` vazio:** improvável com a regra atual (sempre tem ao menos COBRANCA_LEMBRETE), mas se acontecer, mostrar template_atual sozinho como única opção (dropdown desabilitado).

## Tipos TypeScript sugeridos

```ts
interface PreviewEmailRpcResponse {
  todo_id: string;
  card_id: string;
  nf: string;
  codigo_ssw_proposta: number;
  cod_ultima_ocorrencia_card: number;
  email_destino: string | null;
  template_atual: {
    id: string;
    nome: string;
    descricao: string;
    assunto_renderizado: string;
    corpo_renderizado: string;
    usa_link_evidencia: boolean;
  };
  templates_disponiveis: Array<{
    id: string;
    nome: string;
    descricao: string;
  }>;
}
```

## Resumo das mudanças

- **Componente novo:** `EditarEmailModal.tsx` (ou similar) — abre quando `tool === 'lancar_oc_e_enviar_email'`.
- **Substituir** o `handleAprovar(todoId)` direto: passa a abrir modal nesses casos; outros tools continuam direto.
- **Sem mudança de schema** — backend já aceita os extras.
