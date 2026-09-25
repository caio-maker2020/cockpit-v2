// Guard — consultar_rota_roteirizador(card.ctrc) (ADR 0034).
// Trava: flag OFF / sem CTRC / ponte desligada / ponte falhando = null (prompt de
// hoje); CTRC é o do card; bloco traz carro/motorista/situação/link e NÃO traz
// o telefone do motorista.
// Rodar: deno test --no-check supabase/functions/_shared/consultar-rota-roteirizador.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  consultarRotaRoteirizador,
  FLAG_PONTE_CONSULTA,
  montarBlocoRotaRoteirizador,
} from "./consultar-rota-roteirizador.ts";
import { createRoteirizadorPonteClient, type NotaNoPlano } from "./roteirizador-ponte-client.ts";

const NOTA: NotaNoPlano = {
  noPlano: true, ctrc: "AMB1-1", dataRef: "2026-09-25", rotaNome: "V07", statusAprovacao: "aprovada",
  carro: { indice: 1, perfil: "VAN", placa: "ABC1D23", motorista: "João", telefoneMotorista: "31999990000" },
  ordem: 4, cidade: "AIURUOCA", statusExecucao: "nao_coube", motivoExecucao: "carro cheio",
  fotoEvidenciaUrl: "https://f", decididoEm: null, compromissos: [], linkRastreio: "https://ri/rastreio/t",
};

const sbFlag = (on: boolean | null) => ({
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: on === null ? null : { enabled: on } }) }) }),
  }),
});

function cliente(status: number, body: unknown) {
  const urls: string[] = [];
  const client = createRoteirizadorPonteClient({
    env: { apiUrl: "https://ri", token: "t" }, sleep: () => Promise.resolve(), maxTentativas: 1,
    fetch: ((url: string) => {
      urls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }) as unknown as typeof fetch,
  });
  return { client, urls };
}

Deno.test("bloco: rota, carro, motorista, situação com motivo e link; sem telefone", () => {
  const b = montarBlocoRotaRoteirizador("AMB1-1", NOTA);
  assert(b.includes("25/09/2026"));
  assert(b.includes("rota V07 (aprovada)"));
  assert(b.includes("motorista João"));
  assert(b.includes("não coube no carro — motivo: carro cheio"));
  assert(b.includes("https://ri/rastreio/t"));
  assert(!b.includes("31999990000"));
});

Deno.test("bloco: rota pendente avisa que pode não sair; fora do plano é dito", () => {
  assert(montarBlocoRotaRoteirizador("X", { ...NOTA, statusAprovacao: "pendente", linkRastreio: null }).includes("pode não sair"));
  assert(montarBlocoRotaRoteirizador("X", { noPlano: false, compromissos: [] }).includes("NÃO está em nenhum plano"));
});

Deno.test("flag OFF ou ausente: null e nenhuma chamada à ponte", async () => {
  for (const on of [false, null]) {
    const { client, urls } = cliente(200, NOTA);
    assertEquals(await consultarRotaRoteirizador(sbFlag(on), { id: "c", ctrc: "AMB1-1" }, { client, agente: "t" }), null);
    assertEquals(urls.length, 0);
  }
});

Deno.test("card sem CTRC: null sem consultar (nunca busca por NF)", async () => {
  const { client, urls } = cliente(200, NOTA);
  assertEquals(await consultarRotaRoteirizador(sbFlag(true), { id: "c", ctrc: null }, { client, agente: "t" }), null);
  assertEquals(urls.length, 0);
});

Deno.test("flag ON: consulta com o CTRC do card e devolve o bloco", async () => {
  const { client, urls } = cliente(200, NOTA);
  const r = await consultarRotaRoteirizador(sbFlag(true), { id: "c", ctrc: " amb1-1" }, { client, agente: "t" });
  assertEquals(urls, ["https://ri/v3/ponte/notas/AMB1-1"]);
  assertEquals(r?.ctrc, "AMB1-1");
  assert(r?.bloco.includes("ROTA DO DIA"));
});

Deno.test("ponte 503 / desligada: null, agente segue sem ela", async () => {
  const { client } = cliente(503, {});
  assertEquals(await consultarRotaRoteirizador(sbFlag(true), { id: "c", ctrc: "A" }, { client, agente: "t" }), null);
  const off = createRoteirizadorPonteClient({ env: null });
  assertEquals(await consultarRotaRoteirizador(sbFlag(true), { id: "c", ctrc: "A" }, { client: off, agente: "t" }), null);
});
