// Guard de não-regressão — credencial ÚNICA ai.salex pra TODO acesso SSW
// (leitura E lançamento). Rodar: deno test supabase/functions/_shared/ssw-credencial-unica.test.ts
//
// Regra (Caio 2026-08-06, incidente l.silva): o login pessoal l.silva — usado
// como fallback legado de leitura e credencial fixa do Forçar Atualização —
// parou de autenticar no SSW em 06/08 (~11h-12h30 BRT) e derrubou a operação:
// Forçar Atualização quebrado pra TODOS os cards + histórico/confirmação
// quebrados pros 4 operadores sem secret próprio (JULIA/FELIPE/KAROLINE/
// LARISSA) — 639 AgenteOcsPadraoFalhou em 4h30.
//
// Decisão: TODO acesso SSW resolve pra conta de serviço (SSW_LANCAMENTO_*),
// independente de operador. NUNCA reintroduzir resolução por login pessoal.
import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  loadSswInternalEnvForCard,
  readSswInternalEnv,
} from "./ssw-internal-client.ts";

// Valores FICTÍCIOS (nunca commitar credencial real — repo é público).
const SERVICO = {
  SSW_LANCAMENTO_DOMINIO: "SEP",
  SSW_LANCAMENTO_USUARIO: "robo.servico",
  SSW_LANCAMENTO_SENHA: "senha-servico-teste",
  SSW_LANCAMENTO_CPF: "00000000000",
};

const OPERADOR_DUILIO = {
  SSW_INTERNAL_DUILIO_DOMINIO: "SEP",
  SSW_INTERNAL_DUILIO_USUARIO: "duilio.pessoal",
  SSW_INTERNAL_DUILIO_SENHA: "senha-duilio-teste",
  SSW_INTERNAL_DUILIO_CPF: "11111111111",
};

const LEGADO = {
  SSW_INTERNAL_DOMINIO: "SEP",
  SSW_INTERNAL_USUARIO: "legado.pessoal",
  SSW_INTERNAL_SENHA: "senha-legado-teste",
  SSW_INTERNAL_CPF: "22222222222",
};

Deno.test("readSswInternalEnv usa conta de serviço mesmo com operadorNome e secret do operador presentes", () => {
  const env = { ...SERVICO, ...OPERADOR_DUILIO, ...LEGADO };
  const cred = readSswInternalEnv(env, "DUILIO");
  assertEquals(cred.usuario, "robo.servico");
  assertEquals(cred.senha, "senha-servico-teste");
  assertEquals(cred.cpf, "00000000000");
  assertEquals(cred.dominio, "SEP");
});

Deno.test("readSswInternalEnv sem operadorNome também resolve conta de serviço", () => {
  const cred = readSswInternalEnv({ ...SERVICO, ...LEGADO });
  assertEquals(cred.usuario, "robo.servico");
});

Deno.test("readSswInternalEnv NUNCA resolve login pessoal quando a conta de serviço existe", () => {
  const env = { ...SERVICO, ...OPERADOR_DUILIO, ...LEGADO };
  for (const operador of ["DUILIO", "JULIA", "ISA E KAROL", null]) {
    const cred = readSswInternalEnv(env, operador);
    assertEquals(cred.usuario, "robo.servico");
  }
});

Deno.test("fallback legado só quando SSW_LANCAMENTO_* ausente (dev/test)", () => {
  const cred = readSswInternalEnv({ ...OPERADOR_DUILIO, ...LEGADO }, "DUILIO");
  assertEquals(cred.usuario, "duilio.pessoal");
  const credLegado = readSswInternalEnv({ ...LEGADO }, "JULIA");
  assertEquals(credLegado.usuario, "legado.pessoal");
});

Deno.test("conta de serviço incompleta (sem senha) cai no fallback em vez de credencial mutilada", () => {
  const semSenha = { ...SERVICO, ...LEGADO } as Record<string, string | undefined>;
  delete semSenha["SSW_LANCAMENTO_SENHA"];
  const cred = readSswInternalEnv(semSenha);
  assertEquals(cred.usuario, "legado.pessoal");
});

Deno.test("sem credencial nenhuma → throw (não inventa login)", () => {
  assertThrows(() => readSswInternalEnv({}));
});

Deno.test("loadSswInternalEnvForCard não consulta o banco e retorna a conta de serviço", async () => {
  // Stub que EXPLODE se qualquer query for feita — a resolução por operador
  // via cards/operadores está desativada por decisão (Caio 2026-08-06).
  const supabaseExplosivo = {
    from(_t: string): never {
      throw new Error(
        "loadSswInternalEnvForCard consultou o banco — resolução por operador foi reintroduzida (regressão do incidente l.silva)",
      );
    },
  } as unknown as Parameters<typeof loadSswInternalEnvForCard>[0];

  const cred = await loadSswInternalEnvForCard(
    supabaseExplosivo,
    { ...SERVICO, ...OPERADOR_DUILIO, ...LEGADO },
    "card-qualquer",
  );
  assertEquals(cred.usuario, "robo.servico");
});
