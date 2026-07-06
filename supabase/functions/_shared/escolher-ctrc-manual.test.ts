// Testes da função pura escolherCtrcManual (feature "Criar Card" manual).
// Guard de não-regressão INV-028. Rodar:
//   deno test supabase/functions/_shared/escolher-ctrc-manual.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type CtrcCandidatoManual,
  escolherCtrcManual,
} from "./escolher-ctrc-manual.ts";

// Fábrica de candidato com defaults sensatos (não-cancelado, não-finalizado).
function c(over: Partial<CtrcCandidatoManual> & { ctrc: string }): CtrcCandidatoManual {
  return {
    tipo: "NORMAL",
    pagador: "ACME LTDA",
    cancelado: false,
    finalizado: false,
    ...over,
  };
}

// --- caminho detalhe-único (1 CTRC, tipo="" = DESCONHECIDO, não complementar) ---

Deno.test("1 CTRC só com tipo vazio (detalhe-único) → unico", () => {
  const r = escolherCtrcManual([c({ ctrc: "AMB368633-7", tipo: "", pagador: "" })]);
  assertEquals(r.tipo, "unico");
  if (r.tipo === "unico") assertEquals(r.ctrc.ctrc, "AMB368633-7");
});

Deno.test("1 NORMAL não-finalizado → unico", () => {
  const r = escolherCtrcManual([c({ ctrc: "AMB368633-7", tipo: "NORMAL" })]);
  assertEquals(r.tipo, "unico");
});

Deno.test("1 CTRC só, finalizado → sem_ctrc_ativo", () => {
  const r = escolherCtrcManual([c({ ctrc: "AMB368633-7", finalizado: true })]);
  assertEquals(r.tipo, "sem_ctrc_ativo");
});

Deno.test("tudo cancelado → sem_ctrc_ativo", () => {
  const r = escolherCtrcManual([
    c({ ctrc: "A-1", cancelado: true }),
    c({ ctrc: "B-2", cancelado: true, tipo: "REVERSA" }),
  ]);
  assertEquals(r.tipo, "sem_ctrc_ativo");
});

// --- caminho lista (≥2 CTRCs, tipo confiável) ---

Deno.test("NORMAL + REVERSA, ambos não-finalizados → escolher (devolução vs normal)", () => {
  const r = escolherCtrcManual([
    c({ ctrc: "AMB368633-7", tipo: "NORMAL" }),
    c({ ctrc: "AMB999888-2", tipo: "REVERSA" }),
  ]);
  assertEquals(r.tipo, "escolher");
  if (r.tipo === "escolher") {
    assertEquals(r.opcoes.length, 2);
    // NORMAL sempre primeiro na lista de opções.
    assertEquals(r.opcoes[0]!.tipo, "NORMAL");
    assertEquals(r.opcoes[1]!.tipo, "REVERSA");
  }
});

Deno.test("NORMAL finalizado + REVERSA não-finalizado → unico (a REVERSA)", () => {
  const r = escolherCtrcManual([
    c({ ctrc: "AMB368633-7", tipo: "NORMAL", finalizado: true }),
    c({ ctrc: "AMB999888-2", tipo: "REVERSA", finalizado: false }),
  ]);
  assertEquals(r.tipo, "unico");
  if (r.tipo === "unico") assertEquals(r.ctrc.tipo, "REVERSA");
});

Deno.test("complementar (tipo vazio) NÃO entra na escolha quando há ≥2 CTRCs", () => {
  // 1 NORMAL elegível + 1 complementar (tipo="") → o complementar é ignorado,
  // sobra 1 elegível → unico (o NORMAL). Espelha a regra "não complementar".
  const r = escolherCtrcManual([
    c({ ctrc: "AMB368633-7", tipo: "NORMAL" }),
    c({ ctrc: "AMB777666-3", tipo: "" }), // reentrega/complementar
  ]);
  assertEquals(r.tipo, "unico");
  if (r.tipo === "unico") assertEquals(r.ctrc.ctrc, "AMB368633-7");
});

Deno.test("NORMAL + REVERSA + complementar → escolher só entre NORMAL e REVERSA", () => {
  const r = escolherCtrcManual([
    c({ ctrc: "N-1", tipo: "NORMAL" }),
    c({ ctrc: "R-2", tipo: "REVERSA" }),
    c({ ctrc: "C-3", tipo: "" }),
  ]);
  assertEquals(r.tipo, "escolher");
  if (r.tipo === "escolher") assertEquals(r.opcoes.length, 2);
});

Deno.test("2 NORMAIS não-finalizados → ambiguo (regra de ouro: não chutar)", () => {
  const r = escolherCtrcManual([
    c({ ctrc: "N-1", tipo: "NORMAL" }),
    c({ ctrc: "N-2", tipo: "NORMAL" }),
  ]);
  assertEquals(r.tipo, "ambiguo");
  if (r.tipo === "ambiguo") assertEquals(r.motivo, "multiplos_ctrcs_normais");
});

Deno.test("2 REVERSAS sem NORMAL → ambiguo", () => {
  const r = escolherCtrcManual([
    c({ ctrc: "R-1", tipo: "REVERSA" }),
    c({ ctrc: "R-2", tipo: "REVERSA" }),
  ]);
  assertEquals(r.tipo, "ambiguo");
  if (r.tipo === "ambiguo") assertEquals(r.motivo, "multiplas_reversas");
});

Deno.test("≥2 CTRCs, todos finalizados → sem_ctrc_ativo", () => {
  const r = escolherCtrcManual([
    c({ ctrc: "N-1", tipo: "NORMAL", finalizado: true }),
    c({ ctrc: "R-2", tipo: "REVERSA", finalizado: true }),
  ]);
  assertEquals(r.tipo, "sem_ctrc_ativo");
});

Deno.test("tipo desconhecido entre ≥2 elegíveis → ambiguo (não chutar)", () => {
  const r = escolherCtrcManual([
    c({ ctrc: "N-1", tipo: "NORMAL" }),
    c({ ctrc: "X-2", tipo: "ALGO_ESTRANHO" }),
  ]);
  assertEquals(r.tipo, "ambiguo");
  if (r.tipo === "ambiguo") assertEquals(r.motivo, "tipo_ctrc_desconhecido");
});
