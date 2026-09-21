// Guard do ÚNICO ponto de I/O da cerca "Segregar CTRC" (campo f8 da tela 101).
//
// `carregarCnpjsSegregacao` É o kill-switch da feature: quem devolve o Set que
// o `segregacaoPermitida` consulta. Set vazio = ninguém segrega. Como segregar
// BLOQUEIA a carga no SSW e a retirada é manual (opção 091, o Cockpit não
// desfaz), qualquer falha de leitura tem que virar Set VAZIO — nunca exceção
// (roda no caminho quente do executor, derrubaria lançamentos que não têm nada
// a ver com segregação) e nunca whitelist "otimista".
//
// Rodar: deno test --allow-all --no-check \
//          supabase/functions/_shared/segregacao-ctrc-loader.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { carregarCnpjsSegregacao, FLAG_SEGREGACAO } from "./segregacao-ctrc.ts";

/** Os 2 CNPJs do grupo PRATI (mig 407), um deles mascarado de propósito. */
const PRATI_A = "73856593000186";
const PRATI_B = "73856593000267";

/**
 * Client falso no mesmo molde do `seguir-parcial-carregar.test.ts`: registra as
 * tabelas consultadas (pra provar que a flag OFF corta a segunda query) e
 * devolve o que mandarmos. Suporta `maybeSingle()` (leitura da flag) e o
 * await direto no builder (leitura da whitelist).
 */
function fakeDb(resp: {
  flag?: { data?: unknown; error?: { message: string } };
  whitelist?: { data?: unknown; error?: { message: string } };
  explode?: boolean;
}) {
  const tabelasLidas: string[] = [];
  const db = {
    tabelasLidas,
    from(tabela: string) {
      if (resp.explode) throw new Error("boom: conexão caiu no meio da query");
      tabelasLidas.push(tabela);
      const resultado = tabela === "feature_flags"
        ? (resp.flag ?? { data: null })
        : (resp.whitelist ?? { data: [] });
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: () => Promise.resolve(resultado),
        then: (ok: (v: unknown) => unknown) => Promise.resolve(resultado).then(ok),
      };
      return q;
    },
  };
  return db;
}

/** Silencia o console.warn do loader pra saída do teste ficar legível. */
async function semRuido<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = original;
  }
}

// Trava: se alguém renomear a flag sem atualizar a mig 407, o kill-switch passa
// a ler uma chave que não existe — e o comportamento vira "sempre OFF" silencioso.
Deno.test("a chave da flag é a da migration 407", () => {
  assertEquals(FLAG_SEGREGACAO, "segregacao_ctrc_enabled");
});

// Trava: flag inexistente no banco (migration não aplicada / linha apagada) NÃO
// pode ligar a feature por omissão. `maybeSingle` devolve data:null nesse caso.
Deno.test("flag ausente (maybeSingle => null) => Set VAZIO", async () => {
  const db = fakeDb({ flag: { data: null } });
  const cnpjs = await carregarCnpjsSegregacao(db);
  assertEquals(cnpjs.size, 0);
  assertEquals(db.tabelasLidas, ["feature_flags"]);
});

// Trava: kill-switch desligado tem que cortar a feature ANTES de consultar a
// whitelist. Se a segunda query rodar mesmo com a flag OFF, (a) paga-se query
// à toa no caminho quente do executor e (b) qualquer regressão futura que
// esqueça o `return` passa a enxergar CNPJs autorizados com a feature OFF.
Deno.test("flag enabled=false => Set VAZIO e a whitelist NEM é consultada", async () => {
  const db = fakeDb({
    flag: { data: { enabled: false } },
    whitelist: { data: [{ cnpj_pagador: PRATI_A }] },
  });
  const cnpjs = await carregarCnpjsSegregacao(db);
  assertEquals(cnpjs.size, 0);
  assertEquals(db.tabelasLidas, ["feature_flags"]);
});

// Trava: com tudo ligado a whitelist precisa chegar NORMALIZADA (só dígitos).
// O banco guarda CNPJ mascarado em várias tabelas; se o loader devolvesse o
// valor cru, o `segregacaoPermitida` (que compara com normalizarCnpj) nunca
// bateria e a PRATI ficaria sem segregar sem ninguém entender por quê.
Deno.test("flag enabled=true + 2 CNPJs ativos => Set com os 2, normalizados", async () => {
  const db = fakeDb({
    flag: { data: { enabled: true } },
    whitelist: {
      data: [
        { cnpj_pagador: "73.856.593/0001-86" },
        { cnpj_pagador: PRATI_B },
      ],
    },
  });
  const cnpjs = await carregarCnpjsSegregacao(db);
  assertEquals(cnpjs.size, 2);
  assertEquals(cnpjs.has(PRATI_A), true);
  assertEquals(cnpjs.has(PRATI_B), true);
  assertEquals(db.tabelasLidas, ["feature_flags", "cliente_config_segregacao_ctrc"]);
});

// Trava: erro ao ler a whitelist (tabela ausente, RLS, permission denied) tem
// que virar Set VAZIO — fail-CLOSED — e não pode propagar exceção pro executor.
Deno.test("erro ao ler a whitelist => Set VAZIO, SEM lançar", async () => {
  const cnpjs = await semRuido(() =>
    carregarCnpjsSegregacao(fakeDb({
      flag: { data: { enabled: true } },
      whitelist: {
        error: { message: 'relation "cliente_config_segregacao_ctrc" does not exist' },
      },
    }))
  );
  assertEquals(cnpjs.size, 0);
});

// Trava: erro preenchido JUNTO com linhas (resposta parcial) não pode ser
// aproveitado. É o `error ||` do guard: quem apenas confiasse no `data` daria
// autorização de barrar carga a partir de uma leitura que o banco já disse que
// falhou. Sem este caso, remover o teste de `error` passa despercebido — o
// mutante só quebra na iteração e cai no catch, devolvendo o mesmo Set vazio.
Deno.test("erro COM linhas na resposta => Set VAZIO (não confia em dado parcial)", async () => {
  const cnpjs = await semRuido(() =>
    carregarCnpjsSegregacao(fakeDb({
      flag: { data: { enabled: true } },
      whitelist: {
        data: [{ cnpj_pagador: PRATI_A }, { cnpj_pagador: PRATI_B }],
        error: { message: "statement timeout" },
      },
    }))
  );
  assertEquals(cnpjs.size, 0);
});

// Trava: `data` que não é array (shape inesperado do client) também é falha —
// não pode virar iteração em cima de null nem exceção.
Deno.test("whitelist com data não-array => Set VAZIO, SEM lançar", async () => {
  const cnpjs = await semRuido(() =>
    carregarCnpjsSegregacao(fakeDb({
      flag: { data: { enabled: true } },
      whitelist: { data: null },
    }))
  );
  assertEquals(cnpjs.size, 0);
});

// Trava: exceção crua (rede caiu, client mal inicializado) NÃO pode subir. Esta
// função roda no caminho quente do executor: se lançar, derruba lançamentos de
// ocorrência de cards que nada têm a ver com segregação.
Deno.test("exceção crua do client => Set VAZIO, SEM propagar", async () => {
  const cnpjs = await semRuido(() => carregarCnpjsSegregacao(fakeDb({ explode: true })));
  assertEquals(cnpjs.size, 0);
});

// Trava: linha suja na whitelist (CNPJ nulo, curto, vazio ou texto) tem que ser
// IGNORADA, nunca entrar no Set como string qualquer. Um "" no Set não casaria
// com nada hoje, mas normalizações futuras de CNPJ vazio viram autorização
// acidental de barrar carga.
Deno.test("linha com cnpj lixo/curto/nulo é ignorada, não entra no Set", async () => {
  const db = fakeDb({
    flag: { data: { enabled: true } },
    whitelist: {
      data: [
        { cnpj_pagador: null },
        { cnpj_pagador: "" },
        { cnpj_pagador: "123" },
        { cnpj_pagador: "738565930001860000" }, // 18 dígitos
        { cnpj_pagador: "lixo" },
        {}, // coluna ausente
        { cnpj_pagador: PRATI_A }, // único válido
      ],
    },
  });
  const cnpjs = await carregarCnpjsSegregacao(db);
  assertEquals(cnpjs.size, 1);
  assertEquals(cnpjs.has(PRATI_A), true);
  assertEquals(cnpjs.has(""), false);
});
