// Guard anti-regressão do sanitizador de texto pro portal SSW.
//
// Incidente 2026-07-06 (NF 655782 oc=54, operador Duilio): a oc lançada no SSW
// chegou com o campo Instrução inteiro em "?????". Causa raiz: a regex do
// limite latin-1 estava codificada com um byte NUL CRU no fonte
// (`/[^<NUL>-ÿ]/`). Alguma ferramenta que não preserva NUL removeu o byte,
// colapsando o range `\x00-ÿ` em `-ÿ` — onde `-` vira hífen literal — e a classe
// passou a apagar TODO caractere que não fosse `-`/`ÿ`, virando `?`.
//
// Fix de raiz: regex com ESCAPES ASCII (`\x00-\xFF`), imune a editor/bundler.
// Este teste trava a regressão: se o range quebrar de novo, o texto PT-BR
// deixaria de passar íntegro e o assert falha.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sanitizarParaLatin1 } from "./ssw-internal-client.ts";

Deno.test("sanitizarParaLatin1 preserva texto PT-BR com acentos (não vira '?')", () => {
  const input = "AGUARDANDO retorno do cliente pagador. Seguimos no aguardo, obrigação çãé êô à.";
  // Todos os chars estão em latin-1 (U+0000..U+00FF) → passam intactos.
  assertEquals(sanitizarParaLatin1(input), input);
});

Deno.test("sanitizarParaLatin1 NÃO substitui letras/dígitos/espaço por '?'", () => {
  const out = sanitizarParaLatin1("Nota 655782 - CTRC AES273364-1 ok");
  // Regressão do bug: com a regex quebrada isto virava "?????...".
  assertEquals(out.includes("?"), false);
  assertEquals(out, "Nota 655782 - CTRC AES273364-1 ok");
});

Deno.test("sanitizarParaLatin1 troca só char fora do latin-1 (emoji U+0100+) por '?'", () => {
  assertEquals(sanitizarParaLatin1("teste ✅ ok"), "teste ? ok");
  // 😀 = U+1F600 = surrogate pair (2 code units UTF-16) → 2 '?'. Comportamento
  // correto: a regex opera por code unit. O que importa é NÃO apagar texto válido.
  assertEquals(sanitizarParaLatin1("a😀b"), "a??b");
});

Deno.test("sanitizarParaLatin1 normaliza pontuação unicode comum (emdash/aspas)", () => {
  assertEquals(sanitizarParaLatin1("texto — com “aspas” e ‘simples’…"), 'texto - com "aspas" e \'simples\'...');
});
