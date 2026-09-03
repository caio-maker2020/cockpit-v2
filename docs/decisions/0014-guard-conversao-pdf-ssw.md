# 0014 — Guard da conversão PDF→JPEG pro SSW (falha explícita > sucesso silencioso)

Data: 2026-07-17
Status: aceito (branch `correcao-melhoria-oc33-descricao-itens-pdfs-ssw`; merge a decidir pelo Caio)

## Contexto

Caso âncora **NF 135724 / DUILIO**: a minuta de despacho OVD 1442182 (`NF 135724.pdf`) subiu
pro SSW como imagem **quase em branco** — só o resíduo cinza do fundo, sem o texto. O PDF era
um scan em modo "alta compressão" (MRC): fundo JPEG fraco + **máscara JBIG2** com todo o
texto preto. O pdf.js (conversor do front, `convertPdfBlobToJpegFiles`) **não decodifica**
essa máscara e ainda assim **resolve o render como sucesso**, no máximo com um warning de
console (`Dependent image isn't ready yet`). Ninguém detecta; o lixo sobe pro SSW.

Evidência medida (2026-07-17):
- Reprodução determinística com pdfjs-dist 5.7.284 (o do front) **e** 6.1.200 (latest):
  ambos quebram — **upgrade não resolve**. Retry do render também não.
- ~**6%** dos PDFs inbound têm JBIG2 (6/100 amostrados) — e são justamente **minutas e
  romaneios assinados escaneados** (o documento central do fluxo de completude).
- Dos 5 únicos testados: **4 quebraram de verdade** (2 quase em branco, 2 com texto
  fragmentado) — e **1 quebrou SEM warning nenhum**.
- Poppler/pdfium renderizam o mesmo arquivo perfeitamente (fix 1b possível).

## Decisão

**Guard de dois sinais** no funil único de conversão (nenhum sinal sozinho cobre tudo):
1. **Hook no `console.warn`** durante o `page.render()` capturando
   `Dependent image isn't ready` (pegou 4/5 dos casos reais);
2. **Piso de pixels não-brancos** (2%, `avaliarPaginaConvertida` em
   `apps/cockpit-web/src/lib/pdfConversaoGuard.ts`) — pega o modo que falha calado.

Qualquer sinal → a conversão **FALHA com mensagem clara** pro operador ("scan em formato
incompatível — tire um print/foto e anexe como JPEG") em vez de subir imagem quebrada.
Telemetria: card_event `ConversaoPdfBloqueadaGuard` (best-effort, nunca bloqueia o fluxo).

Aplicado nos **dois trilhos**: front próprio (`apps/cockpit-web`) direto na branch; Lovable
via prompt `prompts/lovable-guard-conversao-pdf-jbig2.md`.

## Critério de decisão do fix 1b (conversão server-side)

O guard É o instrumento de medição. Contar `ConversaoPdfBloqueadaGuard` por 2–4 semanas:
- **≥ ~2 bloqueios/semana** e contorno manual pesando → construir conversão robusta como
  FALLBACK acionado só no bloqueio (pdfium-WASM em Edge Function, ou microserviço poppler —
  este último exige novo ADR, fere o Supabase-only do ADR 0001).
- **< 1/semana** → guard basta; 1b não se paga.

O peso do 1b que motivou adiar: Edge Function Deno não roda binário nativo; pdfium-WASM =
~5-8 MB no bundle, cold start de segundos, ~30-90 MB de RAM por página num isolate de
256 MB, payloads de PDF até 10 MB trafegando por request.

## Alternativas descartadas

- **Upgrade do pdfjs-dist:** testado (6.1.200) — quebra igual.
- **Retry do render:** testado — a imagem dependente nunca fica pronta; falha permanente.
- **Trocar a lib client-side:** não existe alternativa madura com JBIG2 no browser.
- **Só piso de pixels:** refutado pelo caso real de 51,7% não-branco com texto fragmentado.
- **Só warning-hook:** refutado pelo caso real que quebra sem warning (`minuta assinada.pdf`).

## Guards

`pdfConversaoGuard.test.ts` (6 testes: quase-branca sem warning, warning com conteúdo,
página normal passa, limiar exato, regex do warning, mensagem com contorno) + item no
/verify-cockpit. Caso irmão da mesma NF (descrição/valor não materializada): adendo do
ADR 0023.
