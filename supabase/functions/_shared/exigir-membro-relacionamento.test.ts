// INV-190 — porta do Relacionamento. Sem rede: dependências injetadas.
// Rodar: deno test --allow-env supabase/functions/_shared/exigir-membro-relacionamento.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type DepsMembroRelacionamento,
  exigirMembroRelacionamento,
  negarSeOperadorAlheio,
  type OperadorDoUsuario,
} from "./exigir-membro-relacionamento.ts";

const SERVICE = "chave-service-do-runtime";
const USUARIOS: Record<string, string> = {
  "jwt-larissa": "uid-larissa",
  "jwt-gestor": "uid-gestor",
  "jwt-operacao": "uid-operacao", // login da Operação: não está em operadores
  "jwt-inativo": "uid-inativo",
};
const OPERADORES: Record<string, OperadorDoUsuario> = {
  "uid-larissa": { id: "op-larissa", papel: "operador", ativo: true },
  "uid-gestor": { id: "op-gestor", papel: "gestor", ativo: true },
};

function deps(extra: Partial<DepsMembroRelacionamento> = {}) {
  const chamadas = { probe: 0, operador: 0 };
  const d: DepsMembroRelacionamento = {
    serviceRoleKey: SERVICE,
    verificarUsuario: (t) => Promise.resolve(USUARIOS[t] ?? null),
    ehServiceRole: (t) => {
      chamadas.probe++;
      return Promise.resolve(t === "chave-service-rotacionada");
    },
    buscarOperadorAtivo: (u) => {
      chamadas.operador++;
      return Promise.resolve(OPERADORES[u] ?? null);
    },
    ...extra,
  };
  return { d, chamadas };
}

function req(token?: string): Request {
  const h = new Headers({ "Content-Type": "application/json" });
  if (token !== undefined) h.set("Authorization", `Bearer ${token}`);
  return new Request("http://x/fn", { method: "POST", headers: h, body: "{}" });
}

async function corpo(r: Response) {
  return await r.json();
}

Deno.test("service_role por igualdade passa sem consultar nada", async () => {
  const { d, chamadas } = deps();
  const r = await exigirMembroRelacionamento(req(SERVICE), { deps: d });
  assert(r.ok);
  assertEquals(r.chamador, { tipo: "service_role" });
  assertEquals(chamadas, { probe: 0, operador: 0 });
});

Deno.test("service_role com chave diferente da do runtime passa pela prova de capacidade", async () => {
  const { d } = deps();
  const r = await exigirMembroRelacionamento(req("chave-service-rotacionada"), { deps: d });
  assert(r.ok);
  assertEquals(r.chamador.tipo, "service_role");
});

Deno.test("operador ativo do Relacionamento passa com o próprio operador", async () => {
  const { d } = deps();
  const r = await exigirMembroRelacionamento(req("jwt-larissa"), { deps: d });
  assert(r.ok);
  assertEquals(r.chamador, { tipo: "membro", userId: "uid-larissa", operadorId: "op-larissa", papel: "operador" });
});

Deno.test("gestor passa", async () => {
  const { d } = deps();
  const r = await exigirMembroRelacionamento(req("jwt-gestor"), { deps: d });
  assert(r.ok && r.chamador.tipo === "membro" && r.chamador.papel === "gestor");
});

Deno.test("login da Operação (sem linha em operadores) leva 403 JSON", async () => {
  const { d } = deps();
  const r = await exigirMembroRelacionamento(req("jwt-operacao"), { deps: d, corsHeaders: { "X-Cors": "1" } });
  assert(!r.ok);
  assertEquals(r.resposta.status, 403);
  assertEquals(r.resposta.headers.get("Content-Type"), "application/json");
  assertEquals(r.resposta.headers.get("X-Cors"), "1");
  const b = await corpo(r.resposta);
  assertEquals(b.ok, false);
  assertEquals(b.codigo, "NAO_MEMBRO_RELACIONAMENTO");
});

Deno.test("operador inativo (lookup filtra ativo) leva 403", async () => {
  const { d } = deps();
  const r = await exigirMembroRelacionamento(req("jwt-inativo"), { deps: d });
  assert(!r.ok);
  assertEquals(r.resposta.status, 403);
});

Deno.test("linha devolvida com ativo=false também é recusada (defesa dupla)", async () => {
  const { d } = deps({ buscarOperadorAtivo: () => Promise.resolve({ id: "x", papel: "operador", ativo: false }) });
  const r = await exigirMembroRelacionamento(req("jwt-larissa"), { deps: d });
  assert(!r.ok);
  assertEquals(r.resposta.status, 403);
});

Deno.test("sem Authorization leva 401 e não chama nada", async () => {
  const { d, chamadas } = deps();
  const r = await exigirMembroRelacionamento(req(), { deps: d });
  assert(!r.ok);
  assertEquals(r.resposta.status, 401);
  assertEquals(chamadas, { probe: 0, operador: 0 });
});

Deno.test("token inválido/forjado (inclusive JWT com role=service_role não assinado) leva 401", async () => {
  const forjado = `x.${btoa(JSON.stringify({ role: "service_role" }))}.y`;
  const { d } = deps();
  for (const t of ["lixo", forjado, "anon-key"]) {
    const r = await exigirMembroRelacionamento(req(t), { deps: d });
    assert(!r.ok, t);
    assertEquals(r.resposta.status, 401);
  }
});

Deno.test("falha ao consultar operadores é fail-CLOSED (503), nunca libera", async () => {
  const { d } = deps({ buscarOperadorAtivo: () => Promise.reject(new Error("timeout")) });
  const r = await exigirMembroRelacionamento(req("jwt-larissa"), { deps: d });
  assert(!r.ok);
  assertEquals(r.resposta.status, 503);
});

Deno.test("negarSeOperadorAlheio: próprio passa, alheio 403, gestor e service passam", async () => {
  const membro = { tipo: "membro" as const, userId: "u", operadorId: "op-larissa", papel: "operador" };
  assertEquals(negarSeOperadorAlheio(membro, "op-larissa"), null);
  const r = negarSeOperadorAlheio(membro, "op-duilio");
  assert(r);
  assertEquals(r.status, 403);
  assertEquals((await r.json()).codigo, "OPERADOR_ALHEIO");
  assert(negarSeOperadorAlheio(membro, undefined)); // só operador_nome → recusa
  assertEquals(negarSeOperadorAlheio({ ...membro, papel: "gestor" }, "op-duilio"), null);
  assertEquals(negarSeOperadorAlheio({ tipo: "service_role" }, "op-duilio"), null);
});
