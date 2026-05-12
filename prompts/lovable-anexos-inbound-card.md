# Lovable — Anexos do cliente (inbound) no card

## Contexto

Hoje quando o cliente responde um email da Larissa **com anexo** (ex: PDF do romaneio de coleta assinado, foto de comprovante), o Cockpit captura o texto mas **não mostrava o anexo**. Larissa precisava abrir o Gmail manualmente pra baixar o arquivo.

**Caio 2026-05-12**: backend agora baixa automaticamente os anexos dos emails inbound e salva em `email_anexos` com `origem='inbound'` + `message_inbox_id`. O front precisa **renderizar esses anexos no card** com botão de download.

---

## A mudança

**Onde**: na timeline de mensagens do card (aba CLIENTE RESPONDEU ou onde o histórico de inbound/outbound aparece). Cada mensagem inbound (do cliente) que tiver anexos mostra um bloco "📎 Anexos do cliente" abaixo do texto.

```
┌─────────────────────────────────────────────────────────────────┐
│ ✉️  transporte6@rioclarense.com.br                  12/05 10:34 │
│                                                                  │
│ Segue conforme solicitado, gentileza informar prazo de buscas.  │
│                                                                  │
│ 📎 Anexos do cliente:                                            │
│ ┌────────────────────────────────────────────┐ ┌──────────────┐ │
│ │ 📄 Untitled_20260512_104420.pdf — 320 KB   │ │ ⬇ Baixar     │ │
│ └────────────────────────────────────────────┘ └──────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Como buscar anexos por mensagem

Usar PostgREST com filtros:

```ts
const { data: anexos } = await supabase
  .from("email_anexos")
  .select("id, filename, mime_type, size_bytes, storage_path")
  .eq("message_inbox_id", msgInboxId)
  .eq("origem", "inbound")
  .order("uploaded_at", { ascending: true });
```

**Otimização**: em vez de query por mensagem, fazer 1 query batch pelos `message_inbox_ids` exibidos e agrupar em memória:

```ts
const msgIds = mensagensInbound.map(m => m.id);
const { data: todosAnexos } = await supabase
  .from("email_anexos")
  .select("id, filename, mime_type, size_bytes, message_inbox_id, storage_path")
  .in("message_inbox_id", msgIds)
  .eq("origem", "inbound");
const anexosPorMsg = groupBy(todosAnexos, "message_inbox_id");
```

### Botão "⬇ Baixar"

Gera URL assinada do bucket privado (TTL curto, 60s):

```ts
const { data: signed } = await supabase.storage
  .from("email_anexos")
  .createSignedUrl(anexo.storage_path, 60);
if (signed?.signedUrl) {
  window.open(signed.signedUrl, "_blank");
}
```

### Detalhes de UI

- **Ícone por mime_type**: 📄 PDF (`application/pdf`), 🖼 imagem (`image/*`), 📊 Excel (`application/vnd.ms-excel` / `xlsx`), 📝 Word (`application/msword` / `docx`), 📋 CSV/TXT, 📎 fallback.
- **Tamanho**: formatar com KB/MB (ex: `320 KB`, `1.2 MB`).
- **Hover/click**: mostra tooltip "Baixar (URL assinada, expira em 60s)".
- **Sem anexos**: o bloco "📎 Anexos do cliente" **NÃO aparece** (não renderiza header vazio).

### Bonus (opcional, fase 2)

- Click em PDF → preview embed (iframe com URL assinada). Mantém botão "Baixar" também.
- Click em imagem → modal lightbox.

---

## Contrato técnico

| Campo | Tipo | Origem |
|---|---|---|
| `email_anexos.id` | uuid | PK |
| `email_anexos.filename` | text | nome original do arquivo |
| `email_anexos.mime_type` | text | content-type |
| `email_anexos.size_bytes` | bigint | tamanho |
| `email_anexos.message_inbox_id` | uuid | FK pra messages_inbox |
| `email_anexos.origem` | `'inbound'` | filtro obrigatório (não mostra outbound aqui) |
| `email_anexos.storage_path` | text | path no bucket `email_anexos` (privado) |

**Bucket**: `email_anexos` (privado — Supabase Storage). URL assinada obrigatória pra download (`createSignedUrl`).

---

## Resumo

| Elemento | Mudança |
|---|---|
| Timeline mensagens inbound | Bloco "📎 Anexos do cliente" se mensagem tem anexos |
| Query | `email_anexos.origem='inbound'` filtrado por `message_inbox_id` |
| Download | `createSignedUrl(path, 60)` → `window.open` |
| Ícone | Baseado em mime_type |
| Tamanho | Format KB/MB |

Nada mais muda — apenas adiciona renderização inline na timeline.
