// Guard: os assets em public/pdfjs-wasm/ DEVEM ser byte-a-byte os do
// pdfjs-dist instalado — ao fazer bump do pacote, re-copiar (senão o decoder
// JBIG2 volta a falhar silenciosamente e o guard da conversão bloqueia scans
// que o pdf.js decodifica; foi a raiz do "contorno manual" da NF 158084).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ARQUIVOS = [
  "jbig2.wasm",
  "jbig2_nowasm_fallback.js",
  "openjpeg.wasm",
  "openjpeg_nowasm_fallback.js",
  "qcms_bg.wasm",
];

describe("public/pdfjs-wasm espelha o pdfjs-dist instalado", () => {
  for (const f of ARQUIVOS) {
    it(f, () => {
      const doPacote = createHash("sha256").update(readFileSync(`node_modules/pdfjs-dist/wasm/${f}`)).digest("hex");
      const doPublic = createHash("sha256").update(readFileSync(`public/pdfjs-wasm/${f}`)).digest("hex");
      expect(doPublic).toBe(doPacote);
    });
  }
});
