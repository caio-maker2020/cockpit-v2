# Lovable — Conversão PDF→JPEG: mostrar o erro REAL e separar "converter" de "subir"

**Data:** 2026-06-23
**Contexto / bug:** Duilio, no modal "Lançar oc 33" (NF 719250), clicou em PDFs do cliente pra anexar e recebeu o toast vermelho **"Falha ao converter PDF — JPEG / Edge Function returned a non-2xx status code"**. A conversão pdf.js no browser funcionou — quem falhou foi o **upload** das páginas JPEG pra edge `upload-anexo-email`, que voltou **400** porque o card tinha 29 anexos `inbound` (logos/assinaturas inline do e-mail) e batia no limite por card.

> **Backend já corrigido (deployado 2026-06-23):** o limite por card agora conta **só uploads do operador** — anexos recebidos do cliente (`origem='inbound'`) não contam mais. Então esse 400 específico **não acontece mais**. Mas o front continua mascarando QUALQUER erro do upload como "Falha ao converter PDF", e mostrando a mensagem genérica do supabase-js em vez da mensagem real do backend. **Este prompt conserta o front pra nunca mais esconder a causa.**

Aplica-se aos **dois modais** que convertem PDF: combo **33+44** e **oc=33 solo** (ambos usam a função compartilhada de conversão + o helper de upload). Conserta a função compartilhada **uma vez**.

---

## O que mudar

### 1. Separar as duas etapas (conversão ≠ upload) e rotular certo

Hoje o fluxo "anexar PDF do cliente" faz, num `try` só:
1. baixa o PDF (signed URL),
2. converte pra JPEG no browser (pdf.js),
3. faz `supabase.functions.invoke('upload-anexo-email', ...)` por página.

Quando o passo 3 falha, o `catch` mostra "Falha ao converter PDF → JPEG" — **errado**, a conversão deu certo. Separe:

```ts
// PASSO conversão (pdf.js) — erro aqui é REALMENTE conversão
let paginas: File[];
try {
  paginas = await convertPdfBlobToJpegFiles(pdfBlob, anexo.filename);
} catch (e) {
  toast.error(`Falha ao converter "${anexo.filename}" em imagem`, {
    description: e instanceof Error ? e.message : String(e),
  });
  return;
}

// PASSO upload — erro aqui é UPLOAD, mostra a mensagem REAL do backend
for (const pagina of paginas) {
  const idOuErro = await uploadAnexo(pagina, cardId, todoId);
  if (!idOuErro.ok) {
    toast.error(`Não foi possível anexar "${pagina.name}"`, { description: idOuErro.error });
    return;
  }
  anexosIds.push(idOuErro.anexo_id);
}
```

### 2. Ler a mensagem REAL do backend (não a genérica do supabase-js)

`supabase.functions.invoke` joga `error` com a mensagem genérica **"Edge Function returned a non-2xx status code"**. A mensagem útil está no **corpo** da resposta (`error.context` é um `Response`). Mesmo padrão já definido em [`prompts/lovable-upload-anexo-mostrar-erro-real.md`](prompts/lovable-upload-anexo-mostrar-erro-real.md) — reaproveite/centralize no helper de upload:

```ts
async function uploadAnexo(
  file: File, cardId: string, todoId?: string,
): Promise<{ ok: true; anexo_id: string } | { ok: false; error: string }> {
  const form = new FormData();
  form.append("file", file);
  form.append("card_id", cardId);
  if (todoId) form.append("todo_id", todoId);

  const { data, error } = await supabase.functions.invoke("upload-anexo-email", { body: form });

  if (error) {
    // A causa real (ex.: "Tipo de arquivo não suportado", "Limite de 20 anexos
    // enviados por você neste card...") vem no corpo, não em error.message.
    let real = error.message; // fallback genérico do supabase-js
    try {
      const body = await (error as any).context?.json?.();
      if (body?.error) real = body.error;
    } catch { /* corpo não-JSON: mantém genérico */ }
    return { ok: false, error: real };
  }
  if (!data?.ok) return { ok: false, error: data?.error ?? "Falha desconhecida no upload" };
  return { ok: true, anexo_id: data.anexo_id };
}
```

### 3. (opcional, recomendado) Esconder lixo de assinatura na lista de anexos do cliente

O modal lista TODOS os `email_anexos origem='inbound'` do card. A maioria é imagem inline de assinatura/logo (image001.png 165 bytes, image002.jpg 4 KB...). Isso polui a lista e confunde (o usuário marca o que parece o romaneio). Filtrar da lista de seleção os inline triviais:

- esconder por padrão imagens (`mime_type` começa com `image/`) **muito pequenas** (ex.: `size_bytes < 20000`), que são quase sempre logo/assinatura;
- manter sempre visíveis PDFs e arquivos grandes (o romaneio real);
- oferecer um "mostrar todos (N ocultos)" pra não sumir com nada de vez.

Isso é só UX da lista — não muda o backend.

---

## Critério de aceite

1. PDF que converte e sobe normal → continua funcionando (gera 1 JPEG por página, IDs entram em `anexos_ids`).
2. Forçar um erro de upload (ex.: subir um arquivo > 10MB, ou um `.heic`) → o toast mostra a **mensagem real do backend** (ex.: "Tipo de arquivo não suportado (.heic)..."), **não** "Edge Function returned a non-2xx status code" nem "Falha ao converter PDF".
3. Erro de conversão (PDF corrompido) → toast diz "Falha ao converter ... em imagem", separado do upload.
4. Lista de anexos do cliente não enche de logo/assinatura de 165 bytes (se aplicar o item 3).

## Resumo

| Antes | Depois |
|---|---|
| Qualquer falha → "Falha ao converter PDF → JPEG" | Conversão e upload têm toasts separados e corretos |
| Mostra "Edge Function returned a non-2xx status code" | Mostra a mensagem real do backend (`error.context.json().error`) |
| Lista mostra todo inbound (logos inclusos) | Esconde imagens inline triviais por padrão (opcional) |

Backend não precisa de mais nada — o limite já não conta inbound (fix 2026-06-23, edge `upload-anexo-email`).
