// Guard do ÚNICO ponto de I/O da regra da oc 55 automática (ADR 0025).
//
// Este loader é chamado de dentro de caminhos que rodam pra TODOS os clientes
// (agente-sugere-ocs-padrao, interpretador-resposta-cliente). Se ele lançar,
// derruba a análise de cards que não têm nada a ver com o projeto. Por isso a
// regra é: NUNCA lança, e qualquer falha vira estado INERTE.
//
// Rodar: deno test --no-check --allow-net --allow-env \
//          supabase/functions/_shared/seguir-parcial-carregar.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  carregarContextoSeguirParcial,
  cnpjTemAutorizacaoPermanente,
  CONTEXTO_INERTE,
} from "./seguir-parcial-carregar.ts";

const CNPJ = "13309775000195";

/** Client falso: registra as tabelas consultadas e devolve o que mandarmos. */
function fakeDb(resp: {
  flags?: { data?: unknown; error?: { message: string } };
  whitelist?: { data?: unknown; error?: { message: string } };
  explode?: boolean;
}) {
  const tabelasLidas: string[] = [];
  const db = {
    tabelasLidas,
    from(tabela: string) {
      if (resp.explode) throw new Error("boom");
      tabelasLidas.push(tabela);
      const resultado = tabela === "feature_flags"
        ? (resp.flags ?? { data: [] })
        : (resp.whitelist ?? { data: [] });
      const thenable = {
        select: () => thenable,
        in: () => thenable,
        eq: () => thenable,
        then: (
          ok: (v: unknown) => unknown,
        ) => Promise.resolve(resultado).then(ok),
      };
      return thenable;
    },
  };
  return db;
}

Deno.test("flag OFF: estado inerte e a whitelist NEM é consultada", async () => {
  const db = fakeDb({
    flags: { data: [{ key: "seguir_parcial_auto_enabled", enabled: false }] },
  });
  const ctx = await carregarContextoSeguirParcial(db);
  assertEquals(ctx.flagOn, false);
  assertEquals(ctx.whitelist.size, 0);
  // custo no caminho comum (todos os clientes) = 1 query leve, e só.
  assertEquals(db.tabelasLidas, ["feature_flags"]);
});

Deno.test("flag ausente na tabela = OFF (nunca liga por omissão)", async () => {
  const ctx = await carregarContextoSeguirParcial(fakeDb({ flags: { data: [] } }));
  assertEquals(ctx.flagOn, false);
});

Deno.test("sombra é FAIL-SAFE: ausente ou erro => sombra LIGADA (não lança)", async () => {
  const semLinha = await carregarContextoSeguirParcial(
    fakeDb({ flags: { data: [{ key: "seguir_parcial_auto_enabled", enabled: true }] } }),
  );
  assertEquals(semLinha.sombra, true);

  const comSombraOn = await carregarContextoSeguirParcial(fakeDb({
    flags: {
      data: [
        { key: "seguir_parcial_auto_enabled", enabled: true },
        { key: "seguir_parcial_auto_sombra", enabled: true },
      ],
    },
  }));
  assertEquals(comSombraOn.sombra, true);
});

Deno.test("só sai da sombra com enabled=false EXPLÍCITO", async () => {
  const ctx = await carregarContextoSeguirParcial(fakeDb({
    flags: {
      data: [
        { key: "seguir_parcial_auto_enabled", enabled: true },
        { key: "seguir_parcial_auto_sombra", enabled: false },
      ],
    },
    whitelist: { data: [] },
  }));
  assertEquals(ctx.sombra, false);
});

Deno.test("flag ON: carrega whitelist e normaliza CNPJ mascarado", async () => {
  const ctx = await carregarContextoSeguirParcial(fakeDb({
    flags: { data: [{ key: "seguir_parcial_auto_enabled", enabled: true }] },
    whitelist: {
      data: [
        { cnpj_pagador: "13.309.775/0001-95", ativo: true, aplica_oc06: true, aplica_oc08: true },
        { cnpj_pagador: "lixo", ativo: true, aplica_oc06: true, aplica_oc08: true },
      ],
    },
  }));
  assertEquals(ctx.flagOn, true);
  assertEquals(ctx.whitelist.size, 1);
  assertEquals(ctx.whitelist.get(CNPJ)?.aplica_oc06, true);
});

Deno.test("coluna aplica_* ausente não vira desligado silencioso (default true)", async () => {
  const ctx = await carregarContextoSeguirParcial(fakeDb({
    flags: { data: [{ key: "seguir_parcial_auto_enabled", enabled: true }] },
    whitelist: { data: [{ cnpj_pagador: CNPJ, ativo: true }] },
  }));
  assertEquals(ctx.whitelist.get(CNPJ)?.aplica_oc06, true);
  assertEquals(ctx.whitelist.get(CNPJ)?.aplica_oc08, true);
});

Deno.test("erro em feature_flags → inerte, sem lançar", async () => {
  const ctx = await carregarContextoSeguirParcial(
    fakeDb({ flags: { error: { message: "permission denied" } } }),
  );
  assertEquals(ctx, CONTEXTO_INERTE);
});

Deno.test("erro na whitelist (ex.: migration não aplicada) → inerte, sem lançar", async () => {
  const ctx = await carregarContextoSeguirParcial(fakeDb({
    flags: { data: [{ key: "seguir_parcial_auto_enabled", enabled: true }] },
    whitelist: { error: { message: 'relation "cliente_config_seguir_parcial_auto" does not exist' } },
  }));
  assertEquals(ctx.flagOn, false);
  assertEquals(ctx.whitelist.size, 0);
});

Deno.test("exceção crua (rede caiu) → inerte, sem lançar", async () => {
  const ctx = await carregarContextoSeguirParcial(fakeDb({ explode: true }));
  assertEquals(ctx, CONTEXTO_INERTE);
});

Deno.test("cnpjTemAutorizacaoPermanente: só com flag ON e cliente ativo", async () => {
  const ctx = await carregarContextoSeguirParcial(fakeDb({
    flags: { data: [{ key: "seguir_parcial_auto_enabled", enabled: true }] },
    whitelist: { data: [{ cnpj_pagador: CNPJ, ativo: true }] },
  }));
  assertEquals(cnpjTemAutorizacaoPermanente(ctx, CNPJ), true);
  assertEquals(cnpjTemAutorizacaoPermanente(ctx, "13.309.775/0001-95"), true); // mascarado
  assertEquals(cnpjTemAutorizacaoPermanente(ctx, "99999999999999"), false);
  assertEquals(cnpjTemAutorizacaoPermanente(ctx, null, undefined), false);
  assertEquals(cnpjTemAutorizacaoPermanente(ctx, null, CNPJ), true); // remetente como fallback
  // com o contexto inerte, nunca autoriza
  assertEquals(cnpjTemAutorizacaoPermanente(CONTEXTO_INERTE, CNPJ), false);
});
