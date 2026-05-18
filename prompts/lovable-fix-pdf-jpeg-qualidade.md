# Lovable — Fix: conversão PDF → JPEG está perdendo qualidade

**Data:** 2026-05-15
**Bug em produção:** NF 351954 (cliente Althaia). Cliente enviou PDF de romaneio nítido, agente converteu em 4 JPEGs e lançou no SSW. Imagens chegaram **ilegíveis** (10-21 KB cada, texto borrado a ponto de só linhas grossas aparecerem). Larissa teve que reenviar manualmente.

## Causa

A função `convertPdfBlobToJpegFiles` no arquivo `src/components/cards/ProposedActions.tsx` (linhas ~2327-2351) está usando parâmetros de renderização insuficientes pra A4 com tabelas densas:

- `scale: 1.5` → canvas resulta em 892×1263 pixels pra A4. Texto de 8-9pt vira ~12px de altura, que é exatamente a faixa onde JPEG mais destrói detalhe
- `toBlob(..., "image/jpeg", 0.85)` → compressão DCT borra texto fino. Combinado com canvas pequeno, gera arquivos absurdamente pequenos (10-21 KB pra A4 cheia)

## Fix

Substituir o corpo da função `convertPdfBlobToJpegFiles` (em `src/components/cards/ProposedActions.tsx`) pelo código abaixo. **Mudanças mínimas e cirúrgicas — só 3 linhas mudam:**

```ts
async function convertPdfBlobToJpegFiles(pdfBlob: Blob, baseName: string): Promise<File[]> {
  const pdfjsLib: any = await import("pdfjs-dist");
  // @ts-ignore
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
  const arrayBuf = await pdfBlob.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
  const out: File[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2.5 }); // ⬅️ era 1.5 — texto de tabela ficava ilegível no SSW
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    // ⬇️ NOVO: pintar fundo branco antes do render (PDFs com transparência viram preto no JPEG sem isto)
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob: Blob = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.92), // ⬅️ era 0.85
    );
    const safeBase = baseName.replace(/\.pdf$/i, "").replace(/[^\w.-]+/g, "_");
    out.push(new File([blob], `${safeBase}_p${i}.jpg`, { type: "image/jpeg" }));
  }
  return out;
}
```

## Diff resumido (3 mudanças)

| Linha original | Linha nova |
|---|---|
| `page.getViewport({ scale: 1.5 })` | `page.getViewport({ scale: 2.5 })` |
| (inexistente) | `ctx.fillStyle = "#FFFFFF";` + `ctx.fillRect(0, 0, canvas.width, canvas.height);` antes do `page.render` |
| `canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.85)` | `canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.92)` |

## Por que esses valores

- `scale: 2.5` — A4 vira 1488×2105 pixels. Texto de 8pt vira ~20-22 pixels de altura, faixa onde JPEG q=0.92 preserva detalhe nítido. Tabelas densas, assinaturas e carimbos ficam legíveis. Tamanho final por página: ~250-500 KB (dentro do limite de 10 MB do SSW e dos 20 MB total esperado por lançamento).
- Background branco — proteção contra PDFs com camadas transparentes (raro mas acontece). Sem isso, áreas transparentes viram **preto** no JPEG (JPEG não tem alpha channel).
- `quality: 0.92` — sweet spot pra documentos com texto. Acima de 0.95 o ganho é marginal e o arquivo cresce muito. Abaixo de 0.90 o texto fino começa a borrar.

## Critério de aceite

1. Pegar o mesmo PDF do email do cliente Althaia (NF 351954) e processar pelo fluxo (modal oc=33 solo ou combo)
2. Antes de clicar "Aprovar e executar", abrir DevTools → Network → filtrar por `email_anexos` (uploads) → conferir tamanho dos 4 JPEGs no request:
   - **Antes do fix:** ~10-21 KB cada
   - **Depois do fix:** ~250-500 KB cada
3. Visualmente: o JPEG resultante (você pode baixar do Network panel) deve mostrar **texto da tabela legível** e nítido, igual ao PDF original

## Onde o fix se aplica (NÃO duplicar)

A função `convertPdfBlobToJpegFiles` é UMA função compartilhada usada pelos dois modais (combo 33+44 ~linha 2476 e oc=33 solo ~linha 2816). Mudar a função uma vez resolve os dois fluxos. **Não criar versão separada — só editar a função existente.**

## Backend (não precisa mexer)

O backend e o SSW não têm problema — apenas receberam os bytes que o front gerou. Upload multipart funcionou (status 200, 4 imagens), só recebeu imagens de baixa qualidade. Nenhuma mudança em edge function necessária.
