// Testes da admissão de e-mail em thread nova (Dimensional/Nortel, 2026-08-11).
// O exemplo espelha o caso real: gabriela.moura@b2c.srv.br respondendo a
// "Recusa Total 1599966" num e-mail NOVO com a NF só no corpo.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  __resetCacheThreadNovaForTest,
  carregarEmailsThreadNova,
  deveAdmitirEmailNaoCasado,
  extrairEmailPuro,
} from "./resposta-thread-nova.ts";

const MARCADOS = new Set(["gabriela.moura@b2c.srv.br", "maria.rodrigues@b2c.srv.br"]);

Deno.test("extrai e-mail puro de From com nome, colchetes e maiúsculas", () => {
  assertEquals(extrairEmailPuro("Gabriela <Gabriela.Moura@b2c.srv.br>"), "gabriela.moura@b2c.srv.br");
  assertEquals(extrairEmailPuro("gabriela.moura@b2c.srv.br"), "gabriela.moura@b2c.srv.br");
  assertEquals(extrairEmailPuro('"Moura, Gabriela" <gabriela.moura@b2c.srv.br>'), "gabriela.moura@b2c.srv.br");
  assertEquals(extrairEmailPuro("sem-arroba"), null);
  assertEquals(extrairEmailPuro(null), null);
});

Deno.test("admite: flag ON + remetente marcado + inédito", () => {
  const r = deveAdmitirEmailNaoCasado({
    flagLigada: true,
    fromHeader: "gabriela.moura@b2c.srv.br",
    emailsMarcados: MARCADOS,
    jaExisteNoInbox: false,
  });
  assertEquals(r.admitir, true);
  assertEquals(r.motivo, "contato_thread_nova");
});

Deno.test("flag OFF nunca admite (comportamento atual preservado)", () => {
  const r = deveAdmitirEmailNaoCasado({
    flagLigada: false,
    fromHeader: "gabriela.moura@b2c.srv.br",
    emailsMarcados: MARCADOS,
    jaExisteNoInbox: false,
  });
  assertEquals(r.admitir, false);
  assertEquals(r.motivo, "flag_off");
});

Deno.test("remetente NÃO marcado não entra (e-mail pessoal continua descartado)", () => {
  const r = deveAdmitirEmailNaoCasado({
    flagLigada: true,
    fromHeader: "alguem@gmail.com",
    emailsMarcados: MARCADOS,
    jaExisteNoInbox: false,
  });
  assertEquals(r.admitir, false);
  assertEquals(r.motivo, "remetente_nao_marcado");
});

Deno.test("dedupe por Message-ID: mesma msg na caixa da Ingrid E do Duilio = 1 admissão", () => {
  const r = deveAdmitirEmailNaoCasado({
    flagLigada: true,
    fromHeader: "gabriela.moura@b2c.srv.br",
    emailsMarcados: MARCADOS,
    jaExisteNoInbox: true,
  });
  assertEquals(r.admitir, false);
  assertEquals(r.motivo, "dedupe_message_id");
});

Deno.test("loader: normaliza, cacheia e sobrevive a erro (fail-open pro cache)", async () => {
  __resetCacheThreadNovaForTest();
  let chamadas = 0;
  const fake = {
    from: () => ({
      select: () => ({
        eq: () => {
          chamadas++;
          return Promise.resolve({
            data: [
              { identificador: " Gabriela.Moura@B2C.srv.br ", tipo: "email", ativo: true },
              { identificador: "", tipo: "email", ativo: true },
              { identificador: "31999990000", tipo: "telefone", ativo: true },
              { identificador: "inativo@b2c.srv.br", tipo: "email", ativo: false },
            ],
            error: null,
          });
        },
      }),
    }),
    // deno-lint-ignore no-explicit-any
  } as any;
  const s1 = await carregarEmailsThreadNova(fake);
  assertEquals([...s1], ["gabriela.moura@b2c.srv.br"]);
  await carregarEmailsThreadNova(fake); // cache → não re-consulta
  assertEquals(chamadas, 1);

  // erro depois de cache válido → devolve o cache
  __resetCacheThreadNovaForTest();
  const fakeErr = {
    from: () => ({
      select: () => ({ eq: () => Promise.resolve({ data: null, error: { message: "boom" } }) }),
    }),
    // deno-lint-ignore no-explicit-any
  } as any;
  const s2 = await carregarEmailsThreadNova(fakeErr);
  assertEquals(s2.size, 0);
});
