# Lovable — Adicionar anexos (PDF, imagens, etc) aos emails

## Contexto

Larissa precisa anexar arquivos (PDF de NF, foto de produto, planilha de divergência, etc) nos emails enviados pelo Cockpit. Backend já está pronto:

- Tabela `email_anexos` armazena metadados.
- Bucket Storage privado `email_anexos` armazena os arquivos.
- Edge function `upload-anexo-email` recebe upload e retorna `anexo_id`.
- `aprovar_e_executar` (modal de email do todo) e `responder-email-cliente` (aba RESPOSTA) aceitam `anexos_ids: string[]` no body.
- Limites: **10MB por arquivo, máx 5 anexos, 25MB total**.
- Tipos aceitos: PDF, JPEG/PNG/GIF/WebP, Word, Excel, CSV, TXT.
- Após envio bem-sucedido, executor **deleta automaticamente** do storage (privacidade — Caio decisão).

## Onde adicionar

Em **2 lugares** do Cockpit:

### Lugar 1 — Modal de aprovação de email do todo (oc=54+email)

Lugar onde Larissa hoje vê o modal com checkbox "ENVIAR EMAIL PRO CLIENTE...". Adicionar **acima** do botão CONFIRMAR LANÇAMENTO:

```
┌────────────────────────────────────────────────────┐
│  54  Aguardando retorno do cliente (com email)     │
│                                                     │
│  ☐ ENVIAR EMAIL PRO CLIENTE JUNTO COM O LANÇAMENTO │
│                                                     │
│  📎 ANEXOS (NOVO)                                   │
│  [+ Adicionar arquivo]                             │
│  • laudo-recusa.pdf (245 KB)  [×]                  │
│  • foto-volume.jpg (1.2 MB)   [×]                  │
│                                                     │
│  Padrão 2026-05-05...    CANCELAR  [CONFIRMAR →]   │
└────────────────────────────────────────────────────┘
```

### Lugar 2 — Aba RESPOSTA (composer manual de email)

Lugar onde Larissa hoje compõe resposta direta ao cliente. Adicionar mesma UI **acima** do botão "Enviar resposta":

```
┌──────────────────────────────────────────────────────┐
│  Texto do email:                                      │
│  [textarea com sugestão da IA editável]              │
│                                                       │
│  📎 ANEXOS                                            │
│  [+ Adicionar arquivo]                               │
│                                                       │
│         [Cancelar]   [Enviar resposta →]             │
└──────────────────────────────────────────────────────┘
```

## Implementação

### State local (mesmo nos 2 modais)

```tsx
interface AnexoUploaded {
  anexo_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
}

const [anexos, setAnexos] = useState<AnexoUploaded[]>([]);
const [uploading, setUploading] = useState(false);
const fileInputRef = useRef<HTMLInputElement>(null);
```

### Componente UI

```tsx
{/* Bloco anexos */}
<div className="...">
  <label>📎 ANEXOS ({anexos.length}/5)</label>

  <input
    type="file"
    ref={fileInputRef}
    style={{ display: 'none' }}
    accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt"
    onChange={handleFileSelect}
  />

  <button
    type="button"
    onClick={() => fileInputRef.current?.click()}
    disabled={uploading || anexos.length >= 5}
  >
    {uploading ? 'Subindo...' : '+ Adicionar arquivo'}
  </button>

  {anexos.map((a) => (
    <div key={a.anexo_id} className="...">
      <span>{a.filename} ({formatSize(a.size_bytes)})</span>
      <button onClick={() => removeAnexo(a.anexo_id)}>×</button>
    </div>
  ))}

  {anexos.length >= 5 && (
    <p className="text-xs text-muted">Limite de 5 anexos atingido.</p>
  )}
</div>
```

### Handler de upload

```tsx
async function handleFileSelect(e: ChangeEvent<HTMLInputElement>) {
  const file = e.target.files?.[0];
  if (!file) return;

  if (file.size > 10 * 1024 * 1024) {
    toast.error(`Arquivo excede 10MB (${(file.size / 1024 / 1024).toFixed(1)}MB)`);
    return;
  }

  setUploading(true);
  try {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('card_id', card.id);
    if (todoId) formData.append('todo_id', todoId);

    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/upload-anexo-email`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}` },
        body: formData,
      },
    );
    const data = await res.json();
    if (!data.ok) {
      toast.error(data.error || 'Falha no upload');
      return;
    }
    setAnexos([...anexos, {
      anexo_id: data.anexo_id,
      filename: data.filename,
      mime_type: data.mime_type,
      size_bytes: data.size_bytes,
    }]);
  } catch (err) {
    toast.error('Erro ao subir arquivo');
  } finally {
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }
}

function removeAnexo(id: string) {
  setAnexos(anexos.filter((a) => a.anexo_id !== id));
  // Não precisa deletar do server — cron diário limpa órfãos após 24h.
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
```

### Ao enviar (incluir IDs no extras)

**Modal de aprovação de todo (oc=54+email):**

```ts
const extras = {
  ...extrasExistentes,  // skip_email, assunto_override, etc
  anexos_ids: anexos.map((a) => a.anexo_id),
};

await supabase.rpc('aprovar_e_executar', {
  p_todo_id: todoId,
  p_extras: extras,
});
```

**Aba RESPOSTA (responder-email-cliente):**

```ts
await supabase.functions.invoke('responder-email-cliente', {
  body: {
    card_id: card.id,
    texto: textoEditado,
    cc: ccLista,
    anexos_ids: anexos.map((a) => a.anexo_id),
  },
});
```

## Comportamento garantido (backend)

- ✅ Anexos são incluídos no email como **multipart/mixed** (Gmail multipart).
- ✅ Filename preservado (até 200 chars, caracteres especiais sanitizados).
- ✅ Após envio, arquivos são **deletados do storage** (`enviado_em` + `deletado_em` setados).
- ✅ Anexos órfãos (uploaded mas nunca enviados) são limpos pelo cron `cleanup_email_anexos_orfaos` após 24h.
- ✅ Limite de 5 anexos por card enforced no backend (retorna erro se exceder).

## Resumo em 1 frase

Adicionar bloco "📎 ANEXOS" nos 2 modais (aprovação de todo + aba RESPOSTA), upload via `POST /functions/v1/upload-anexo-email` com FormData, e incluir `anexos_ids: string[]` no body do `aprovar_e_executar` ou `responder-email-cliente`.
