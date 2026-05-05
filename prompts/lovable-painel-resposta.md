# Cockpit — Painel "Resposta" dentro do card (novo)

Cole esse prompt no Lovable. Adiciona uma seção nova no detalhe do card.
**NÃO substitui o prompt anterior do Kanban v2** — é complementar.

## O que é

Quando o agente **redator** termina de gerar uma sugestão de resposta pra
o cliente, ele cria um `todo` do tipo `responder_cliente` no card. Esse
painel mostra essa sugestão pra Larissa **editar e enviar pelo próprio
card** — sem precisar abrir Gmail/WhatsApp.

## Onde aparece

Dentro do detalhe do card aberto (lado direito, junto das abas Mensagens /
Eventos / Histórico SSW). Crie uma **aba nova "Resposta"** OU um **painel
inferior fixo** abaixo das mensagens. O que ficar mais natural na UI atual.

## Estrutura visual

```
┌────────────────────────────────────────────────────────┐
│ 💬 Resposta sugerida                  [🔄 Regenerar]    │
├────────────────────────────────────────────────────────┤
│  Canal: ⚪ WhatsApp    🔘 Email                          │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Oi João!                                          │  │
│  │                                                   │  │
│  │ Pode deixar, já lancei a reentrega aqui pra NF   │  │
│  │ 232323. Vou acompanhar e te aviso quando o       │  │
│  │ motorista sair pra entrega. Qualquer coisa me    │  │
│  │ chama.                                            │  │
│  │                                                   │  │
│  │ Larissa - Relacionamento Sal Express              │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  ⚠️ Confiança: média · gerado por IA · você pode editar │
│                                                         │
│  [✉️  Enviar resposta]                                  │
└────────────────────────────────────────────────────────┘
```

## Componentes

### 1. Buscar a sugestão atual

Quando o card abre, busca o todo pendente do tipo `responder_cliente`:

```ts
const { data: todoResposta } = await supabase
  .from("todos")
  .select("id, status, proposta_payload")
  .eq("card_id", cardId)
  .eq("status", "pendente")
  .filter("proposta_payload->>tool", "eq", "responder_cliente")
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();

// Estrutura do proposta_payload:
// {
//   tool: "responder_cliente",
//   args: { canal, destinatario, subject },
//   texto_sugerido: "...",       // ← isso vai no textarea
//   confianca: "alta" | "media" | "baixa",
//   rationale: "...",            // mostra como tooltip "por que essa resposta?"
//   modelo_usado, versao_prompt, gerado_em
// }
```

Se `todoResposta` for null → mostra estado vazio: **"Sem sugestão de resposta pendente. [Gerar resposta]"** (botão dispara redator manualmente).

### 2. Textarea editável (auto-save)

Mostra `proposta_payload.texto_sugerido` num `<textarea>` editável. Quando
Larissa digita, salva auto após 1s de idle (debounce):

```ts
async function saveTextoEditado(todoId: string, novoTexto: string) {
  // Atualiza só o campo texto_sugerido dentro do JSONB
  const { error } = await supabase.rpc("jsonb_set_via_function", { ... })
  // Mais simples: faz UPDATE no proposta_payload completo
  const { data: todo } = await supabase.from("todos").select("proposta_payload").eq("id", todoId).single();
  const novoPayload = { ...todo.proposta_payload, texto_sugerido: novoTexto, editado_em: new Date().toISOString() };
  await supabase.from("todos").update({ proposta_payload: novoPayload }).eq("id", todoId);
}
```

### 3. Botão "Regenerar"

Chama Edge Function `redator` com `force=true`:

```ts
async function regenerar(cardId: string) {
  const { data, error } = await supabase.functions.invoke("redator", {
    body: { card_id: cardId, force: true },
  });
  // Re-fetch todoResposta pra atualizar textarea com nova sugestão
}
```

### 4. Toggle Email / WhatsApp

- **Email** (default): habilitado
- **WhatsApp**: **desabilitado por enquanto** com tooltip "WhatsApp ainda não conectado". Quando Caio plugar Evolution depois, habilitamos.

### 5. Indicador de confiança

`proposta_payload.confianca`:
- **alta** → ícone verde, sem texto
- **media** → ícone amarelo "Confiança média — confira antes de enviar"
- **baixa** → ícone vermelho "Confiança baixa — provavelmente faltou contexto"

### 6. Botão "Enviar resposta"

Chama RPC `enviar_resposta_cliente(p_todo_id, p_texto_final)`:

```ts
async function enviar(todoId: string, textoFinal: string) {
  const { data, error } = await supabase.rpc("enviar_resposta_cliente", {
    p_todo_id: todoId,
    p_texto_final: textoFinal,
  });

  if (error) {
    // Mostra erro pra usuário (pode ser "envio desabilitado" durante fase preparação)
    return;
  }

  // Sucesso: refetch card_events pra mostrar evento RespostaEnviadaSolicitada
  // O envio em si é assíncrono (Edge Function consome a fila)
  // Status do todo vira "enviando" → "enviado" quando confirmar
}
```

**IMPORTANTE — fase preparação**: até segunda-feira 2026-05-04, a env
`ENVIO_DESABILITADO=true` está ativa. Quando Larissa clicar Enviar, a
Edge Function NÃO envia o email — só registra evento `RespostaEnvioBloqueadoPorFlag`
e o todo fica em status `enviando`. Mostra um banner discreto:

> 🚧 Envio em fase de preparação — clique registrado, mas email NÃO foi
> enviado ainda. Caio destrava segunda.

Detecta isso buscando `card_events` mais recente: se for tipo
`RespostaEnvioBloqueadoPorFlag`, mostra banner. Se for `RespostaEnviada`,
mostra confirmação verde.

### 7. Status do envio

Após clicar Enviar, mostra status visível no card:

| Status do todo | Render |
|---|---|
| `pendente` | "Resposta sugerida — pronta pra enviar" (estado normal) |
| `enviando` | "Enviando..." spinner |
| `enviado` | "✅ Enviado em [timestamp]" + texto vira read-only |
| `falhou` | "❌ Falhou: [motivo]" + botão "Tentar de novo" |

## Eventos novos no timeline (aba Eventos)

Adicionar render dos seguintes event_types:

- **`RespostaSugerida`** (redator gerou sugestão)
  > 🤖 **Sugestão de resposta gerada** — confiança: alta
  > Preview: "Oi João! Pode deixar..."

- **`RespostaEnviadaSolicitada`** (Larissa clicou Enviar — antes do envio real)
  > 📤 **Envio solicitado** por Larissa — destinatário: cliente@empresa.com.br

- **`RespostaEnviada`** (Postmark confirmou envio)
  > ✅ **Resposta enviada** via email — Postmark MessageID: xxx

- **`RespostaEnvioBloqueadoPorFlag`** (fase preparação)
  > 🚧 **Envio bloqueado pela flag de preparação** — aguardando go-live

- **`RespostaEnvioFalhou`** (falha permanente após retries)
  > ❌ **Falha no envio** — motivo: [...]

## Regenerar quando contexto muda?

Quando chega **mensagem nova no card** (cliente respondeu de novo), o
vinculador automaticamente chama o redator pra gerar nova sugestão. Isso
pode sobrescrever a que estava pendente. Pra evitar perder edições da
Larissa:

- Se o `proposta_payload.editado_em` é mais recente que o
  `proposta_payload.gerado_em`, **não sobrescreve** automaticamente —
  mostra um aviso "💬 Cliente respondeu de novo. [Ver nova sugestão] vai
  substituir sua edição."
- Se não foi editado, sobrescreve sem aviso (próxima sugestão é melhor).

Backend hoje sobrescreve quando chega force=true; sem force, deixa quieto
se já existe pendente. UI controla quando regenerar via botão.

## Fluxo completo (referência mental)

1. Cliente manda email → ingestor → triador → vinculador anexa ao card
2. Vinculador dispara redator em background → cria todo `responder_cliente`
3. Larissa abre o card → vê sugestão na aba Resposta
4. Edita texto se quiser
5. Clica Enviar → RPC enfileira em pgmq.respostas_envio
6. Edge Function `enviar-resposta` consome → Postmark API → email vai
7. card_event `RespostaEnviada` registrado, todo.status='enviado'

Latência típica: 5-10 segundos do clique até email sair.
