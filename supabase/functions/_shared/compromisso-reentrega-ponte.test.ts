// Guard — compromisso de reentrega pós-oc 21 (ADR 0034).
// Trava: flag OFF / não-21 / sem data = zero efeito (nenhum insert, nenhuma
// chamada); CTRC do card; idempotencyKey card_id:reentrega:data; 201/200/400/503
// registram audit_log + card_event e NUNCA lançam (tratativa segue).
// Rodar: deno test --no-check supabase/functions/_shared/compromisso-reentrega-ponte.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  enviarCompromissoReentregaSeCombinado,
  EVENTO_COMPROMISSO_ENVIADO,
  EVENTO_COMPROMISSO_FALHOU,
  extrairCompromissoReentrega,
  FLAG_PONTE_COMPROMISSOS,
} from "./compromisso-reentrega-ponte.ts";
import { createRoteirizadorPonteClient } from "./roteirizador-ponte-client.ts";

function supabaseFalso(flags: Record<string, boolean>) {
  const inserts: Array<{ tabela: string; row: Record<string, unknown> }> = [];
  const sb = {
    from(tabela: string) {
      return {
        select() {
          return {
            eq(_c: string, key: string) {
              return { maybeSingle: () => Promise.resolve({ data: key in flags ? { enabled: flags[key] } : null, error: null }) };
            },
          };
        },
        insert(row: Record<string, unknown>) {
          inserts.push({ tabela, row });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { sb, inserts };
}

function clientePonte(status: number, body: unknown = {}) {
  const chamadas: Array<{ url: string; body: unknown }> = [];
  const client = createRoteirizadorPonteClient({
    env: { apiUrl: "https://ri", token: "t" }, sleep: () => Promise.resolve(), maxTentativas: 2,
    fetch: ((url: string, init: RequestInit) => {
      chamadas.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }) as unknown as typeof fetch,
  });
  return { client, chamadas };
}

const EXTRAS = { data_reentrega: "2026-09-26", janela_inicio: "09:00", janela_fim: "11:00", observacao_reentrega: "portaria só de manhã" };
const INPUT = { cardId: "card-77", ctrc: "amb642904-1 ", codigoSsw: 21, extras: EXTRAS, todoId: "todo-1" };

Deno.test("extrair: data estruturada + CTRC do card + chave determinística", () => {
  const r = extrairCompromissoReentrega(EXTRAS, { id: "card-77", ctrc: "amb642904-1 " });
  assert(r.tipo === "ok");
  if (r.tipo === "ok") {
    assertEquals(r.compromisso, {
      ctrc: "AMB642904-1", tipo: "reentrega", data: "2026-09-26", janelaInicio: "09:00",
      janelaFim: "11:00", observacao: "portaria só de manhã", cardId: "card-77",
      idempotencyKey: "card-77:reentrega:2026-09-26",
    });
  }
});

Deno.test("extrair: sem data = sem_data; data/janela inválida ou card sem CTRC = invalido", () => {
  assertEquals(extrairCompromissoReentrega({}, { id: "c", ctrc: "X" }).tipo, "sem_data");
  assertEquals(extrairCompromissoReentrega(null, { id: "c", ctrc: "X" }).tipo, "sem_data");
  assertEquals(extrairCompromissoReentrega({ data_reentrega: "26/09/2026" }, { id: "c", ctrc: "X" }).tipo, "invalido");
  assertEquals(extrairCompromissoReentrega({ data_reentrega: "2026-02-30" }, { id: "c", ctrc: "X" }).tipo, "invalido");
  assertEquals(extrairCompromissoReentrega({ data_reentrega: "2026-09-26", janela_inicio: "9h" }, { id: "c", ctrc: "X" }).tipo, "invalido");
  assertEquals(extrairCompromissoReentrega({ data_reentrega: "2026-09-26", janela_inicio: "14:00", janela_fim: "09:00" }, { id: "c", ctrc: "X" }).tipo, "invalido");
  assertEquals(extrairCompromissoReentrega({ data_reentrega: "2026-09-26" }, { id: "c", ctrc: null }).tipo, "invalido");
});

Deno.test("flag OFF (ou linha ausente): nenhuma chamada, nenhum insert", async () => {
  for (const flags of [{}, { [FLAG_PONTE_COMPROMISSOS]: false }] as Array<Record<string, boolean>>) {
    const { sb, inserts } = supabaseFalso(flags);
    const { client, chamadas } = clientePonte(201);
    const r = await enviarCompromissoReentregaSeCombinado(sb, INPUT, { client });
    assertEquals(r.motivo, "flag_off");
    assertEquals([chamadas.length, inserts.length], [0, 0]);
  }
});

Deno.test("não-21 e sem data: no-op mesmo com flag ON", async () => {
  const { sb, inserts } = supabaseFalso({ [FLAG_PONTE_COMPROMISSOS]: true });
  const { client, chamadas } = clientePonte(201);
  assertEquals((await enviarCompromissoReentregaSeCombinado(sb, { ...INPUT, codigoSsw: 54 }, { client })).motivo, "nao_e_21");
  assertEquals((await enviarCompromissoReentregaSeCombinado(sb, { ...INPUT, extras: {} }, { client })).motivo, "sem_data");
  assertEquals([chamadas.length, inserts.length], [0, 0]);
});

Deno.test("201: POST com CTRC do card + audit_log success + card_event enviado", async () => {
  const { sb, inserts } = supabaseFalso({ [FLAG_PONTE_COMPROMISSOS]: true });
  const { client, chamadas } = clientePonte(201, { id: 9 });
  const r = await enviarCompromissoReentregaSeCombinado(sb, INPUT, { client });
  assertEquals([r.enviado, r.motivo], [true, "criado"]);
  assertEquals((chamadas[0]!.body as { ctrc: string }).ctrc, "AMB642904-1");
  const audit = inserts.find((i) => i.tabela === "audit_log")!.row;
  assertEquals([audit["external_system"], audit["status"], audit["idempotency_key"]],
    ["roteirizador", "success", "roteirizador_compromisso:card-77:reentrega:2026-09-26"]);
  const ev = inserts.find((i) => i.tabela === "card_events")!.row;
  assertEquals(ev["event_type"], EVENTO_COMPROMISSO_ENVIADO);
  assertEquals((ev["payload"] as { repetido: boolean }).repetido, false);
});

Deno.test("200 (mesma chave reenviada): repetido, sem erro", async () => {
  const { sb, inserts } = supabaseFalso({ [FLAG_PONTE_COMPROMISSOS]: true });
  const { client } = clientePonte(200, { id: 9 });
  const r = await enviarCompromissoReentregaSeCombinado(sb, INPUT, { client });
  assertEquals([r.enviado, r.motivo], [true, "repetido"]);
  const ev = inserts.find((i) => i.tabela === "card_events")!.row;
  assertEquals((ev["payload"] as { repetido: boolean }).repetido, true);
});

Deno.test("400 e 503: registra falha (audit failed + CompromissoRoteirizadorFalhou) e não lança", async () => {
  for (const status of [400, 503]) {
    const { sb, inserts } = supabaseFalso({ [FLAG_PONTE_COMPROMISSOS]: true });
    const { client } = clientePonte(status, { erro: "x" });
    const r = await enviarCompromissoReentregaSeCombinado(sb, INPUT, { client });
    assertEquals([r.enviado, r.motivo], [false, "falhou"]);
    const audit = inserts.find((i) => i.tabela === "audit_log")!.row;
    assertEquals(audit["status"], "failed");
    assert(String(audit["idempotency_key"]).includes(":falha:"));
    assertEquals(inserts.find((i) => i.tabela === "card_events")!.row["event_type"], EVENTO_COMPROMISSO_FALHOU);
  }
});

Deno.test("ponte desligada (env ausente): no-op com flag ON", async () => {
  const { sb, inserts } = supabaseFalso({ [FLAG_PONTE_COMPROMISSOS]: true });
  const client = createRoteirizadorPonteClient({ env: null });
  const r = await enviarCompromissoReentregaSeCombinado(sb, INPUT, { client });
  assertEquals(r.motivo, "ponte_desligada");
  assertEquals(inserts.length, 0);
});

Deno.test("banco explodindo no insert não derruba o executor", async () => {
  const sb = {
    from(t: string) {
      if (t === "feature_flags") {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { enabled: true } }) }) }) };
      }
      return { insert: () => { throw new Error("check violation audit_log_external_system_check"); } };
    },
  };
  const { client } = clientePonte(201);
  const r = await enviarCompromissoReentregaSeCombinado(sb, INPUT, { client });
  assertEquals(r.enviado, true);
});
