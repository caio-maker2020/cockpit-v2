# Lovable — Aba RESPOSTA aceita PDF (não só imagem)

**Data:** 2026-05-19
**Bug observado:** Duilio (operador) tentou anexar PDF na aba RESPOSTA do card NF 1492103 várias vezes e a UI rejeitou — só aceitava imagem. PDF é o tipo mais comum de anexo no contexto (notas fiscais, romaneios assinados, comprovantes).

## O que mudar

No composer da **aba RESPOSTA** do card (componente `AbaRespostaCard` ou equivalente), o input de anexo (botão "Anexar arquivo" / drag-and-drop) deve aceitar **TODOS os MIMEs já suportados pelo backend**:

- `application/pdf` ← prioridade
- `image/jpeg`, `image/jpg`, `image/png`, `image/gif`, `image/webp`
- `application/msword`
- `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- `application/vnd.ms-excel`
- `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- `text/csv`
- `text/plain`

## Código (TSX)

Localize o `<input type="file">` da aba RESPOSTA e ajuste:

```tsx
<input
  type="file"
  accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt"
  multiple
  onChange={(e) => handleFileSelect(e.target.files)}
/>
```

Se estiver usando algum drag-and-drop / lib (ex: react-dropzone), ajuste o `accept` correspondente:

```tsx
const { getRootProps, getInputProps } = useDropzone({
  accept: {
    'application/pdf': ['.pdf'],
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/png': ['.png'],
    'image/gif': ['.gif'],
    'image/webp': ['.webp'],
    'application/msword': ['.doc'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
    'application/vnd.ms-excel': ['.xls'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
    'text/csv': ['.csv'],
    'text/plain': ['.txt'],
  },
  maxSize: 10 * 1024 * 1024, // 10MB
  multiple: true,
});
```

## Validação visual

- Texto-guia abaixo do botão de anexo: "PDF, imagens, Word, Excel, CSV ou texto. Até 10MB."
- Mensagem de erro se MIME inválido: "Tipo de arquivo não suportado. Use PDF, imagem, Word, Excel, CSV ou texto."
- Mensagem de erro se >10MB: "Arquivo muito grande. Limite de 10MB por anexo."

## Backend (não precisa mexer)

O endpoint `upload-anexo-email` (POST `/functions/v1/upload-anexo-email`) e o bucket `storage.email_anexos` **já aceitam** todos esses MIMEs. Confirmado por consulta direta:

```sql
SELECT allowed_mime_types FROM storage.buckets WHERE id='email_anexos';
-- → {application/pdf, image/jpeg, image/png, ..., text/plain}
```

Caso âncora real: cliente da NF 1492103 enviou PDF "1493069 NF.pdf" inbound (Ana Costa, 2026-05-18 20:55) e o gmail-poll-inbox capturou corretamente em `email_anexos` com `mime_type=application/pdf`. Inbound funciona; outbound (composer Lovable) é o que está restringindo.

## Critério de aceite

1. Duilio (ou qualquer operador) consegue arrastar/anexar um PDF na aba RESPOSTA
2. Preview mostra "📄 nome.pdf" com tamanho
3. Submit da resposta envia o PDF no email (Gmail API multipart MIME)
4. PDF aparece em `email_anexos` com `origem='outbound'` e some após `enviado_em` (cleanup pós-envio, comportamento já existente)
