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

// ---------------------------------------------------------------------------
// 3) Path 4 fallback_orfao (Caio 2026-07-21, mig 305 — "nada deve ficar órfão")
//    Caso real: Bastão mandou responsável "KAROL" (pessoa fora do Cockpit,
//    ≠ KAROLINE) → card ficava órfão/invisível. Cascata esgotada agora cai no
//    operador com recebe_cards_orfaos=true (ISABELY em prod).
// ---------------------------------------------------------------------------
const ROSTER_COM_FALLBACK = [
  ...ROSTER,
  { id: "op-fb", nome: "ISABELY", carteira: [], segmentos: [], ativo: true, cockpit_ativo: true, recebe_cards_orfaos: true },
];

Deno.test("fallback_orfao: nome desconhecido ('KAROL') sem carteira/segmento -> operador padrão", async () => {
  __resetResolverCachesForTest();
  const r = await resolveOperadorDoCard(fakeSupabase(ROSTER_COM_FALLBACK), {
    responsavelNome: "KAROL",
    cnpjPagador: "99999999999999",
    segmentoCodigo: "Outros",
  });
  assertEquals(r.via, "fallback_orfao");
  assertEquals(r.operadorId, "op-fb");
});

Deno.test("fallback_orfao: SEM operador-fallback configurado -> continua nenhum/null", async () => {
  __resetResolverCachesForTest();
  const r = await resolveOperadorDoCard(fakeSupabase(ROSTER), {
    responsavelNome: "KAROL",
    cnpjPagador: "99999999999999",
    segmentoCodigo: "Outros",
  });
  assertEquals(r.via, "nenhum");
  assertEquals(r.operadorId, null);
});

Deno.test("PRECEDÊNCIA: carteira/nome/segmento GANHAM do fallback_orfao", async () => {
  __resetResolverCachesForTest();
  const porCarteira = await resolveOperadorDoCard(fakeSupabase(ROSTER_COM_FALLBACK), {
    responsavelNome: "KAROL",
    cnpjPagador: "11111111111111",
  });
  assertEquals(porCarteira.operadorId, "op-cart");

  __resetResolverCachesForTest();
  const porNome = await resolveOperadorDoCard(fakeSupabase(ROSTER_COM_FALLBACK), {
    responsavelNome: "NOME_OP",
    cnpjPagador: "99999999999999",
  });
  assertEquals(porNome.operadorId, "op-name");

  __resetResolverCachesForTest();
  const porSegmento = await resolveOperadorDoCard(fakeSupabase(ROSTER_COM_FALLBACK), {
    responsavelNome: "KAROL",
    cnpjPagador: "99999999999999",
    segmentoCodigo: "043",
  });
  assertEquals(porSegmento.operadorId, "op-seg");
});

Deno.test("fallback_orfao NÃO se aplica a carteira_dormente (curto-circuito preservado, NF 568107)", async () => {
  __resetResolverCachesForTest();
  const roster = [
    ...ROSTER_COM_FALLBACK,
    { id: "op-dorm", nome: "DORMENTE_OP", carteira: ["22222222222222"], segmentos: [], ativo: true, cockpit_ativo: false },
  ];
  const r = await resolveOperadorDoCard(fakeSupabase(roster), {
    responsavelNome: "KAROL",
    cnpjPagador: "22222222222222",
  });
  assertEquals(r.via, "carteira_dormente");
  assertEquals(r.operadorId, null);
});

Deno.test("fallback_orfao NÃO se aplica a cnpj_excluido (blacklist preservada)", async () => {
  __resetResolverCachesForTest();
  const r = await resolveOperadorDoCard(
    fakeSupabase(ROSTER_COM_FALLBACK, [{ cnpj_pagador: "33333333333333" }]),
    { responsavelNome: "KAROL", cnpjPagador: "33333333333333" },
  );
  assertEquals(r.via, "cnpj_excluido");
  assertEquals(r.operadorId, null);
});
