// Guard de não-regressão — credencial ÚNICA de lançamento de oc no SSW.
// Rodar: deno test supabase/functions/_shared/ssw-lancamento-env.test.ts
//
// Regra (Caio 2026-06-22): TODO lançamento de oc no portal SSW usa a conta de
// serviço ai.salex via readSswLancamentoEnv, INDEPENDENTE do operador do card.
// Antes, oc=33 saía como Larissa (credencial legada SSW_INTERNAL_* sem operador)
// — ver NF 651244 / card d11717f9 (Duilio aprovou, SSW registrou Larissa).
import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { readSswLancamentoEnv } from "./ssw-internal-client.ts";

const LANC = {
  SSW_LANCAMENTO_USUARIO: "ai.salex",
  SSW_LANCAMENTO_SENHA: "Sal325",
  SSW_LANCAMENTO_CPF: "73230421604",
  SSW_LANCAMENTO_DOMINIO: "SEP",
};

Deno.test("readSswLancamentoEnv retorna a conta de serviço ai.salex", () => {
  const env = readSswLancamentoEnv({ ...LANC });
  assertEquals(env.usuario, "ai.salex");
  assertEquals(env.cpf, "73230421604");
  assertEquals(env.senha, "Sal325");
  assertEquals(env.dominio, "SEP");
});

Deno.test("dominio cai pra SSW_INTERNAL_DOMINIO e depois SSW_DOMAIN", () => {
  const semDom = { ...LANC } as Record<string, string | undefined>;
  delete semDom.SSW_LANCAMENTO_DOMINIO;
  assertEquals(readSswLancamentoEnv({ ...semDom, SSW_INTERNAL_DOMINIO: "SEP" }).dominio, "SEP");
  assertEquals(readSswLancamentoEnv({ ...semDom, SSW_DOMAIN: "SEP" }).dominio, "SEP");
});

Deno.test("NUNCA cai pra credencial de operador — ignora SSW_INTERNAL_*/_DUILIO_*", () => {
  // Mesmo com credenciais de operador presentes, lançamento usa ai.salex.
  const env = readSswLancamentoEnv({
    ...LANC,
    SSW_INTERNAL_USUARIO: "l.silva", // legado = Larissa
    SSW_INTERNAL_DUILIO_USUARIO: "duilio.real",
  });
  assertEquals(env.usuario, "ai.salex");
});

Deno.test("SEM fallback silencioso: faltando usuario/senha/cpf → THROW", () => {
  for (const faltante of ["SSW_LANCAMENTO_USUARIO", "SSW_LANCAMENTO_SENHA", "SSW_LANCAMENTO_CPF"]) {
    const env = { ...LANC } as Record<string, string | undefined>;
    delete env[faltante];
    // Mesmo com credencial de operador disponível, deve falhar alto (não logar como outro).
    assertThrows(
      () => readSswLancamentoEnv({ ...env, SSW_INTERNAL_USUARIO: "l.silva", SSW_INTERNAL_CPF: "x", SSW_INTERNAL_SENHA: "y", SSW_INTERNAL_DOMINIO: "SEP" }),
      Error,
      "SSW_LANCAMENTO_",
    );
  }
});
