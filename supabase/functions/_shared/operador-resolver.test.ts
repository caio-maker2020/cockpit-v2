// Testes de regressão do resolver de operador — Fase 2 (raiz dos órfãos por
// segmento). Caio 2026-06-27. Rodar: deno test operador-resolver.test.ts
//
// Cobre: normalização de segmento (código puro, rótulo completo, espaços, sem
// código válido) E a garantia de PRECEDÊNCIA (carteira/nome > segmento) — a
// ordem da cascata NÃO pode mudar com a normalização.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  __resetResolverCachesForTest,
  normalizarCodigoSegmento,
  resolveOperadorDoCard,
} from "./operador-resolver.ts";

// ---------------------------------------------------------------------------
// 1) normalizarCodigoSegmento — função pura
// ---------------------------------------------------------------------------
Deno.test("normaliza: código puro '043' -> '043'", () => {
  assertEquals(normalizarCodigoSegmento("043"), "043");
});

Deno.test("normaliza: rótulo completo '043 - CURVA F' -> '043'", () => {
  assertEquals(normalizarCodigoSegmento("043 - CURVA F"), "043");
});

Deno.test("normaliza: rótulos reais do Bastão -> código", () => {
  assertEquals(normalizarCodigoSegmento("001 - AUTO PECAS"), "001");
  assertEquals(normalizarCodigoSegmento("022 - MOTOBIKE"), "022");
  assertEquals(normalizarCodigoSegmento("018 - INDUSTRIA FARMACEUTICA"), "018");
});

Deno.test("normaliza: com espaços nas pontas '  043 - curva f  ' -> '043'", () => {
  assertEquals(normalizarCodigoSegmento("  043 - curva f  "), "043");
});

Deno.test("normaliza: sem código válido -> null", () => {
  assertEquals(normalizarCodigoSegmento("Outros"), null);
  assertEquals(normalizarCodigoSegmento(""), null);
  assertEquals(normalizarCodigoSegmento(null), null);
  assertEquals(normalizarCodigoSegmento(undefined), null);
  assertEquals(normalizarCodigoSegmento("   "), null);
});

Deno.test("normaliza: não confunde 2 ou 4 dígitos com código de 3", () => {
  assertEquals(normalizarCodigoSegmento("43"), null);    // 2 dígitos
  assertEquals(normalizarCodigoSegmento("0431"), null);  // 4 dígitos seguidos
});

// ---------------------------------------------------------------------------
// 2) resolveOperadorDoCard — precedência + match por segmento normalizado
// ---------------------------------------------------------------------------
const ROSTER = [
  { id: "op-cart", nome: "CARTEIRA_OP", carteira: ["11111111111111"], segmentos: [], ativo: true, cockpit_ativo: true },
  { id: "op-name", nome: "NOME_OP", carteira: [], segmentos: [], ativo: true, cockpit_ativo: true },
  { id: "op-seg", nome: "SEG_OP", carteira: [], segmentos: ["043"], ativo: true, cockpit_ativo: true },
];

// Fake mínimo do SupabaseClient: responde só às 2 queries que o resolver faz.
function fakeSupabase(operadores: unknown[], excluidos: unknown[] = []) {
  return {
    from(table: string) {
      if (table === "operadores") {
        return { select: (_c: string) => Promise.resolve({ data: operadores, error: null }) };
      }
      if (table === "cnpjs_excluidos_cockpit") {
        return {
          select: (_c: string) => ({
            eq: (_col: string, _v: unknown) => Promise.resolve({ data: excluidos, error: null }),
          }),
        };
      }
      throw new Error("fakeSupabase: tabela inesperada " + table);
    },
  } as unknown as Parameters<typeof resolveOperadorDoCard>[0];
}

Deno.test("segmento por RÓTULO completo agora casa (raiz Fase 2): '043 - CURVA F' -> SEG_OP", async () => {
  __resetResolverCachesForTest();
  const r = await resolveOperadorDoCard(fakeSupabase(ROSTER), {
    responsavelNome: null,
    cnpjPagador: "99999999999999", // fora de qualquer carteira
    segmentoCodigo: "043 - CURVA F",
  });
  assertEquals(r.via, "segmento");
  assertEquals(r.operadorId, "op-seg");
});

Deno.test("segmento por CÓDIGO puro '043' -> SEG_OP", async () => {
  __resetResolverCachesForTest();
  const r = await resolveOperadorDoCard(fakeSupabase(ROSTER), {
    responsavelNome: null,
    cnpjPagador: "99999999999999",
    segmentoCodigo: "043",
  });
  assertEquals(r.via, "segmento");
  assertEquals(r.operadorId, "op-seg");
});

Deno.test("segmento com ESPAÇOS '  043 - CURVA F  ' -> SEG_OP", async () => {
  __resetResolverCachesForTest();
  const r = await resolveOperadorDoCard(fakeSupabase(ROSTER), {
    responsavelNome: null,
    cnpjPagador: "99999999999999",
    segmentoCodigo: "  043 - CURVA F  ",
  });
  assertEquals(r.via, "segmento");
  assertEquals(r.operadorId, "op-seg");
});

Deno.test("segmento SEM código válido ('Outros') -> nenhum (sem dono)", async () => {
  __resetResolverCachesForTest();
  const r = await resolveOperadorDoCard(fakeSupabase(ROSTER), {
    responsavelNome: null,
    cnpjPagador: "99999999999999",
    segmentoCodigo: "Outros",
  });
  assertEquals(r.via, "nenhum");
  assertEquals(r.operadorId, null);
});

Deno.test("PRECEDÊNCIA: carteira (CNPJ) ganha de segmento", async () => {
  __resetResolverCachesForTest();
  const r = await resolveOperadorDoCard(fakeSupabase(ROSTER), {
    responsavelNome: null,
    cnpjPagador: "11111111111111", // carteira do CARTEIRA_OP
    segmentoCodigo: "043 - CURVA F", // também casaria SEG_OP
  });
  assertEquals(r.via, "carteira_cnpj");
  assertEquals(r.operadorId, "op-cart"); // NÃO op-seg
});

Deno.test("PRECEDÊNCIA: nome do responsável ganha de segmento", async () => {
  __resetResolverCachesForTest();
  const r = await resolveOperadorDoCard(fakeSupabase(ROSTER), {
    responsavelNome: "NOME_OP",
    cnpjPagador: "99999999999999", // fora de carteira
    segmentoCodigo: "043 - CURVA F", // também casaria SEG_OP
  });
  assertEquals(r.via, "responsavel_nome");
  assertEquals(r.operadorId, "op-name"); // NÃO op-seg
});
