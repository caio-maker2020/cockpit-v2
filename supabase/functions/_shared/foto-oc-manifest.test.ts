// Guard de não-regressão do bug NF 362406 (Larissa, oc=49, 2026-06-30): o
// manifesto de fotos da galeria SEMPRE lista TODAS as fotos da oc — nunca trunca
// pra 1. Foi a 3ª recorrência do "card puxa só 1 foto"; a raiz desta vez era o
// front não iterar, então a defesa durável é o backend entregar a lista inteira
// e este teste travar que ela nunca volte a virar 1.
//
// Rodar: deno test supabase/functions/_shared/foto-oc-manifest.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type FotoMetaItem,
  montarManifestoFotos,
} from "./foto-oc-manifest.ts";

function fakeFotos(n: number): FotoMetaItem[] {
  return Array.from({ length: n }, (_, idx) => ({
    idx,
    oc_descricao: "TRATATIVA DE RELACIONAMENTO",
    foto_data: "29/06/26 15:23",
    foto_instrucao: "FOTO ID INSERIDA",
  }));
}

Deno.test("ok com 8 fotos: manifesto lista as 8 (NÃO trunca pra 1) — bug NF 362406", () => {
  const { body, httpStatus } = montarManifestoFotos(49, {
    status: "ok",
    fotos: fakeFotos(8),
    fotos_total: 8,
    incompleto: false,
  });
  assertEquals(httpStatus, 200);
  assertEquals(body.ok, true);
  assertEquals(body.codigo_oc, 49);
  // CORE GUARD: total === comprimento do array === 8, nunca 1.
  assertEquals(body.fotos_total, 8);
  assertEquals(body.fotos.length, 8);
  assertEquals(body.fotos.map((f) => f.idx), [0, 1, 2, 3, 4, 5, 6, 7]);
});

Deno.test("ok com 1 foto: total 1 (oc legítima de 1 foto, ex: oc=6 GPS)", () => {
  const { body } = montarManifestoFotos(6, {
    status: "ok",
    fotos: fakeFotos(1),
    fotos_total: 1,
    incompleto: false,
  });
  assertEquals(body.fotos_total, 1);
  assertEquals(body.fotos.length, 1);
});

Deno.test("fotos_total é SEMPRE o comprimento do array, ignora fotos_total divergente", () => {
  // Mesmo que o campo fotos_total venha errado (ex: 1), o manifesto usa o array.
  const { body } = montarManifestoFotos(49, {
    status: "ok",
    fotos: fakeFotos(8),
    fotos_total: 1, // divergente de propósito
    incompleto: false,
  });
  assertEquals(body.fotos_total, 8);
  assertEquals(body.fotos.length, 8);
});

Deno.test("incompleto=true propaga (probe de paginação falhou — front deve avisar)", () => {
  const { body } = montarManifestoFotos(49, {
    status: "ok",
    fotos: fakeFotos(1),
    fotos_total: 1,
    incompleto: true,
  });
  assertEquals(body.incompleto, true);
  assert(body.ok, "ok continua true mesmo com incompleto");
});

Deno.test("oc_sem_foto: 404, fotos vazio, incompleto false", () => {
  const { body, httpStatus } = montarManifestoFotos(20, {
    status: "oc_sem_foto",
    codigo_buscado: 20,
    descricao: "EXTRAVIO LOCALIZADO",
  });
  assertEquals(httpStatus, 404);
  assertEquals(body.ok, false);
  assertEquals(body.error, "oc_sem_foto");
  assertEquals(body.fotos.length, 0);
  assertEquals(body.fotos_total, 0);
});

Deno.test("oc_nao_encontrada: 404 com ocs_disponiveis", () => {
  const { body, httpStatus } = montarManifestoFotos(99, {
    status: "oc_nao_encontrada",
    codigo_buscado: 99,
    ocs_disponiveis: [{ codigo: 49, descricao: "X", tem_foto: true }],
  });
  assertEquals(httpStatus, 404);
  assertEquals(body.error, "oc_nao_encontrada");
  assert(Array.isArray(body.ocs_disponiveis));
});

Deno.test("erro_ssw: 502", () => {
  const { body, httpStatus } = montarManifestoFotos(49, {
    status: "erro_ssw",
    motivo: "timeout",
  });
  assertEquals(httpStatus, 502);
  assertEquals(body.error, "ssw_erro");
  assertEquals(body.fotos.length, 0);
});
