import { describe, expect, it } from "vitest";
import { buscarFilaDoV3, URL_CONFIG_V3 } from "./filaDoV3";
import { lerSessaoV3, LOGIN_DO_V3 } from "../sessaoV3";

const jwt = (p: Record<string, unknown>) =>
  `x.${btoa(JSON.stringify(p)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.y`;
const AGORA_S = 1_791_000_000;

const linha = (ctrc: string) => ({
  op_item_id: `id-${ctrc}`,
  ctrc,
  status: "aberto",
  cod_ultima_ocorrencia: 41,
  sugestao: { versao_contrato: 2, acao: "aguardar", codigo: null, texto: "comprovante no malote", reavaliar_em_horas: 24 },
});

function falsa(respostas: Record<string, { status: number; corpo: unknown }>) {
  const pedidos: { url: string; auth: string | null }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    pedidos.push({ url, auth: h.get("authorization") });
    const r = respostas[url];
    if (!r) throw new Error("rede");
    return new Response(JSON.stringify(r.corpo), { status: r.status, headers: { "content-type": "application/json" } });
  };
  return { f, pedidos };
}

describe("sessão do v3 (localStorage ri_token do próprio site)", () => {
  it("aceita pessoa da operação/gestor; recusa vazio, vencido, motorista e lixo", () => {
    expect(lerSessaoV3(jwt({ sub: 7, nome: "Naiane", exp: AGORA_S + 60 }), AGORA_S)).toEqual({
      token: jwt({ sub: 7, nome: "Naiane", exp: AGORA_S + 60 }),
      nome: "Naiane",
    });
    expect(lerSessaoV3(null, AGORA_S)).toBeNull();
    expect(lerSessaoV3(jwt({ sub: 7, exp: AGORA_S - 1 }), AGORA_S)).toBeNull();
    expect(lerSessaoV3(jwt({ sub: 7, papel: "motorista", executorId: 3, exp: AGORA_S + 60 }), AGORA_S)).toBeNull();
    expect(lerSessaoV3("nao-e-jwt", AGORA_S)).toBeNull();
  });
  it("o login do v3 volta para a tela", () => {
    expect(LOGIN_DO_V3).toBe("/login?voltar=/operacao-cockpit/");
  });
});

describe("fila do v3 (GET /v3/cockpit-demo/fila)", () => {
  const sessao = { token: "tok", nome: "Naiane" };

  it("acha a API pela config do site, manda o Bearer e lê as linhas (aguardar incluso)", async () => {
    const { f, pedidos } = falsa({
      [URL_CONFIG_V3]: { status: 200, corpo: { apiUrl: "https://api.teste/" } },
      "https://api.teste/v3/cockpit-demo/fila": { status: 200, corpo: { fonte: "legado_ao_vivo", linhas: [linha("A1"), { lixo: 1 }] } },
    });
    const r = await buscarFilaDoV3(sessao, f);
    expect(r.ok).toBe(true);
    if (!("linhas" in r)) throw new Error("sem linhas");
    expect(r.linhas.map((l) => l.ctrc)).toEqual(["A1"]);
    expect(r.linhas[0]!.sugestao?.acao).toBe("aguardar");
    expect(pedidos[1]).toEqual({ url: "https://api.teste/v3/cockpit-demo/fila", auth: "Bearer tok" });
  });

  it("sem sessão: nem chama a rede", async () => {
    const { f, pedidos } = falsa({});
    expect(await buscarFilaDoV3(null, f)).toMatchObject({ ok: false, motivo: "sem_sessao" });
    expect(pedidos).toEqual([]);
  });

  it("401/403 da API viram sem_sessao; 503 traz o porquê; rede fora não lança", async () => {
    const base = { [URL_CONFIG_V3]: { status: 200, corpo: { apiUrl: "https://api.teste" } } };
    const url = "https://api.teste/v3/cockpit-demo/fila";
    expect(await buscarFilaDoV3(sessao, falsa({ ...base, [url]: { status: 401, corpo: {} } }).f)).toMatchObject({ motivo: "sem_sessao" });
    expect(await buscarFilaDoV3(sessao, falsa({ ...base, [url]: { status: 403, corpo: {} } }).f)).toMatchObject({ motivo: "sem_sessao" });
    expect(await buscarFilaDoV3(sessao, falsa({ ...base, [url]: { status: 503, corpo: { erro: "O legado não respondeu" } } }).f)).toMatchObject({
      motivo: "falhou",
      detalhe: "O legado não respondeu",
    });
    expect(await buscarFilaDoV3(sessao, falsa(base).f)).toMatchObject({ motivo: "falhou" });
    expect(await buscarFilaDoV3(sessao, falsa({}).f)).toMatchObject({ motivo: "sem_api" });
  });
});
