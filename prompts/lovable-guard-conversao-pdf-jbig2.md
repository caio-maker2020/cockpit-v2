# Lovable — Guard da conversão PDF→JPEG: bloquear scan JBIG2 que sai quase em branco

**Data:** 2026-07-17
**Bug em produção:** NF 135724 (Duilio). A minuta de despacho `NF 135724.pdf` era um scan
de scanner em modo "alta compressão" (camada JBIG2 com o texto). O pdf.js **não decodifica
essa camada e não avisa** — "converteu com sucesso" uma página quase em branco, que subiu
pro SSW como romaneio ilegível. Medição no acervo real: ~6% dos PDFs recebidos são desse
formato, e 4 de 5 testados quebram — um deles **sem warning nenhum** no console.

## O que mudar

Na função `convertPdfBlobToJpegFiles` (em `src/components/cards/ProposedActions.tsx`),
adicionar um guard de **dois sinais** por página, logo após o `page.render(...)`:

1. **Warning do pdf.js**: durante o render, interceptar `console.warn` e marcar se algum
   argumento casar com `/dependent image isn'?t ready/i`.
2. **Piso de pixels**: medir no canvas a fração de pixels não-brancos (canal R, G ou B
   < 200). Página de documento com **menos de 2%** de conteúdo = conversão perdida.

Qualquer um dos dois sinais → **lançar erro** (a conversão FALHA e o toast de erro já
existente mostra a mensagem) em vez de subir a imagem quebrada.

## Código (colar dentro de `convertPdfBlobToJpegFiles`, no loop de páginas)

Substituir a linha `await page.render({ canvasContext: ctx, viewport }).promise;` por:

```ts
// Guard (2026-07-17, NF 135724): pdf.js não decodifica a camada JBIG2 de PDFs
// escaneados e "resolve com sucesso" uma página quase em branco. Dois sinais:
// warning no console durante o render + piso de pixels não-brancos.
let warningPdfjs = false;
const origWarn = console.warn;
console.warn = (...args: unknown[]) => {
  if (args.some((a) => typeof a === "string" && /dependent image isn'?t ready/i.test(a))) {
    warningPdfjs = true;
  }
  origWarn.apply(console, args as Parameters<typeof console.warn>);
};
try {
  await page.render({ canvasContext: ctx, viewport }).promise;
} finally {
  console.warn = origWarn;
}
const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
let naoBrancos = 0;
const totalPx = Math.floor(imgData.length / 4);
for (let p = 0; p + 2 < imgData.length; p += 4) {
  if (imgData[p] < 200 || imgData[p + 1] < 200 || imgData[p + 2] < 200) naoBrancos++;
}
const fracao = totalPx > 0 ? naoBrancos / totalPx : 0;
if (warningPdfjs || fracao < 0.02) {
  const causa = warningPdfjs
    ? "o conversor não decodificou a camada de texto do scan"
    : "a página convertida ficou quase em branco";
  throw new Error(
    `Página ${i} de "${baseName}" perdeu o conteúdo na conversão (${causa}). ` +
    `Esse PDF é um scan em formato incompatível (JBIG2). ` +
    `Contorno: tire um print/foto do documento e anexe como imagem JPEG.`,
  );
}
```

## Telemetria (opcional, mas importante — decide a próxima evolução)

Antes do `throw`, inserir um evento best-effort (nunca deixar o insert derrubar o fluxo):

```ts
try {
  await supabase.from("card_events").insert({
    card_id: card.id,
    event_type: "ConversaoPdfBloqueadaGuard",
    actor_type: "operator",
    actor_id: "front-conversao-pdf",
    payload: { filename: baseName, pagina: i, motivo: warningPdfjs ? "warning_pdfjs" : "pagina_quase_branca", fracao_nao_branca: Number(fracao.toFixed(4)) },
  });
} catch { /* telemetria nunca bloqueia */ }
```

(Se `card` não estiver no escopo da função, passe `card.id` como parâmetro novo opcional —
os dois modais que chamam a conversão têm `card` em mãos.)

## O que NÃO mudar

- NÃO mexer na qualidade da conversão (scale 2.5 / JPEG 0.92 — fix de 2026-05-15).
- NÃO mexer na separação conversão × upload (fix de 2026-06-23) — o erro do guard cai no
  catch de CONVERSÃO, com a mensagem real no toast, como já funciona hoje.
- NÃO bloquear PDFs digitais normais (DANFEs etc.) — eles têm >2% de conteúdo e não
  disparam warning; o guard não os afeta.

## Como validar

1. Anexar um PDF digital comum (DANFE) num modal de oc 33 → converte e sobe normal.
2. Anexar um PDF escaneado JBIG2 (ex.: a minuta da NF 135724, thread do e-mail de 16/07)
   → toast vermelho com "perdeu o conteúdo na conversão... tire um print/foto" e NADA sobe.
