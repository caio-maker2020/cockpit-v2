// Guard — envelope do SSW da Operação (ADR 0041 D7; INV-181, INV-013, INV-046).
// Peças do SSW e repositório FALSOS: nenhum login, nenhuma rede.
// Rodar: deno test --no-check --allow-read supabase/functions/_shared/lancar-ssw-portal-operacao.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type AcaoOpExistente,
  cercaAntesDoSsw,
  lancarSswPortalOperacao,
  type PecasSsw,
  type RepoAcoesOperacao,
} from "./lancar-ssw-portal-operacao.ts";
import { RELANCAMENTO_JANELA_SKIP_MS } from "./lancar-ssw-portal.ts";

const AGORA = Date.parse("2026-10-07T12:00:00Z");
const ITEM = { id: "item-1", ctrc: "VGA1-1", nf: "1001" };

class RepoMem implements RepoAcoesOperacao {
  linhas: Array<AcaoOpExistente & { op_item_id: string; codigo_oc: number; ctrc: string }> = [];
  log: string[] = [];
  n = 0;
  inserir(a: { op_item_id: string; op_lancamento_id: string; codigo_oc: number; ctrc: string; nf: string }) {
    this.log.push(`inserir:${a.codigo_oc}`);
    if (this.linhas.some((l) => l.op_item_id === a.op_item_id && l.codigo_oc === a.codigo_oc && l.ctrc === a.ctrc)) return Promise.resolve("conflito" as const);
    const id = `acao-${++this.n}`;
    this.linhas.push({ id, sucesso: null, finalizado_em: null, op_item_id: a.op_item_id, codigo_oc: a.codigo_oc, ctrc: a.ctrc });
    return Promise.resolve({ id });
  }
  existente(a: { op_item_id: string; codigo_oc: number; ctrc: string }) {
    return Promise.resolve(this.linhas.find((l) => l.op_item_id === a.op_item_id && l.codigo_oc === a.codigo_oc && l.ctrc === a.ctrc) ?? null);
  }
  apagar(id: string) { this.log.push(`apagar:${id}`); this.linhas = this.linhas.filter((l) => l.id !== id); return Promise.resolve(); }
  finalizar(id: string, r: { sucesso: boolean }) {
    this.log.push(`finalizar:${id}:${r.sucesso}`);
    const l = this.linhas.find((x) => x.id === id)!;
    l.sucesso = r.sucesso;
    l.finalizado_em = new Date(AGORA).toISOString();
    return Promise.resolve();
  }
}

function pecas(over: Partial<{ tripeOk: boolean; sessaoFalha: boolean; ssw: "ok" | "erro"; ultimaOc: number | null }> = {}) {
  const chamadas: string[] = [];
  const o = { tripeOk: true, sessaoFalha: false, ssw: "ok" as "ok" | "erro", ultimaOc: 13 as number | null, ...over };
  const p = {
    readSswLancamentoEnv: (env: Record<string, string | undefined>) => { chamadas.push("readSswLancamentoEnv"); return { dominio: "d", cpf: "c", usuario: env.SSW_LANCAMENTO_USUARIO ?? "ai.salex", senha: "s" }; },
    obterSessao: () => { chamadas.push("obterSessao"); return o.sessaoFalha ? Promise.reject(new Error("login recusado")) : Promise.resolve({} as never); },
    buscarNFInterno: (_s: unknown, nf: string, opts: { ctrcEsperado: string | null }) => { chamadas.push(`buscarNFInterno:${nf}:${opts.ctrcEsperado}`); return Promise.resolve({} as never); },
    lancarOcorrenciaPortal: async (_s: unknown, _d: unknown, opts: { codigoSsw: number; texto?: string; validarAntesDoSubmit?: (h: string) => Promise<{ ok: boolean; motivo?: string; detalhe?: string }>; permitirLocalizacaoBaixada?: boolean }) => {
      chamadas.push(`lancar:${opts.codigoSsw}:${opts.texto}`);
      assertEquals((opts as Record<string, unknown>).permitirLocalizacaoBaixada, undefined, "a Operação nunca dispensa a localização");
      const v = await opts.validarAntesDoSubmit!("<html/>");
      if (!v.ok) return { ok: false, error: "guard", bloqueado_por_guard: { motivo: v.motivo!, detalhe: v.detalhe! }, raw_response_snippet: "" };
      chamadas.push("submit");
      return o.ssw === "ok" ? { ok: true, seq_oc: "SEQ-1", descricao: "", raw_response_snippet: "ok" } : { ok: false, error: "SSW 500", raw_response_snippet: "x" };
    },
    descobrirUltimaOcSsw: () => { chamadas.push("descobrirUltimaOcSsw"); return Promise.resolve(o.ultimaOc === null ? { sucesso: false, motivo: "ssw_erro" } : { sucesso: true, oc: o.ultimaOc, dataBrtMs: null, dataRaw: null, ocorrencias: [] }); },
    validarTripeCtrcNfPagador: (a: { cardCtrc: string; cardNf: string; htmlAtoO: string }) => {
      chamadas.push(`tripe:${a.cardCtrc}:${a.cardNf}`);
      return o.tripeOk ? { ok: true, ctrc_ssw: a.cardCtrc, nf_ssw: a.cardNf, localizacao: "EM TRANSITO" } : { ok: false, motivo: "ctrc_finalizado", detalhe: "ENTREGUE" };
    },
    agoraMs: () => AGORA,
  } as unknown as PecasSsw;
  return { p, chamadas };
}

const lancar = (repo: RepoAcoesOperacao, p: PecasSsw, over: Partial<{ codigo: number; textoOperador: string }> = {}) =>
  lancarSswPortalOperacao({
    env: { SSW_LANCAMENTO_USUARIO: "ai.salex" }, repo, item: ITEM, lancamentoId: "L1",
    codigoSsw: over.codigo ?? 36, textoOperador: over.textoOperador ?? "chegou", textoSsw: "chegou (Operação VGA por Joao)", pecas: p,
  });

Deno.test("caminho feliz: idempotência antes, sessão pela conta de serviço, tripé com CTRC/NF DO ITEM, submit", async () => {
  const repo = new RepoMem();
  const { p, chamadas } = pecas();
  const r = await lancar(repo, p);
  assert(r.ok && !r.idempotent_skip);
  assertEquals(chamadas, [
    "readSswLancamentoEnv", "obterSessao", "buscarNFInterno:1001:VGA1-1",
    "lancar:36:chegou (Operação VGA por Joao)", "tripe:VGA1-1:1001", "submit",
  ]);
  assertEquals(repo.log, ["inserir:36", "finalizar:acao-1:true"]);
});

Deno.test("cercas ANTES da idempotência: proibido e 41/56 sem texto não consomem a chave nem tocam o SSW", async () => {
  for (const [codigo, texto] of [[49, "x"], [54, "x"], [33, "x"], [44, "x"], [6, "x"], [41, "curto"], [56, ""]] as const) {
    const repo = new RepoMem();
    const { p, chamadas } = pecas();
    const r = await lancar(repo, p, { codigo, textoOperador: texto });
    assert(!r.ok, `oc ${codigo} deveria ser recusada`);
    assertEquals(repo.log, [], `oc ${codigo} consumiu a chave`);
    assertEquals(chamadas, [], `oc ${codigo} tocou o SSW`);
  }
  assertEquals(cercaAntesDoSsw(41, "o veículo quebrou na BR-381"), null);
  assertEquals(cercaAntesDoSsw(56, "falta o número da nota no romaneio"), null);
});

Deno.test("tripé reprovado → guard_tripe, nada submetido, linha finalizada com sucesso=false", async () => {
  const repo = new RepoMem();
  const { p, chamadas } = pecas({ tripeOk: false });
  const r = await lancar(repo, p);
  assert(!r.ok && r.categoria === "guard_tripe");
  assert(!chamadas.includes("submit"));
  assertEquals(repo.linhas[0]!.sucesso, false);
});

Deno.test("login recusado → sessao_invalida (o worker põe em quarentena)", async () => {
  const repo = new RepoMem();
  const r = await lancar(repo, pecas({ sessaoFalha: true }).p);
  assert(!r.ok && r.categoria === "sessao_invalida");
});

Deno.test("idempotência: em voo (sucesso=null) aborta sem SSW; recente com sucesso → skip; falhou → retry", async () => {
  const repo = new RepoMem();
  repo.linhas.push({ id: "velha", sucesso: null, finalizado_em: null, op_item_id: ITEM.id, codigo_oc: 36, ctrc: ITEM.ctrc });
  const a = pecas();
  const r1 = await lancar(repo, a.p);
  assert(!r1.ok && r1.categoria === "db_erro");
  assertEquals(a.chamadas, []);

  repo.linhas[0]!.sucesso = true;
  repo.linhas[0]!.finalizado_em = new Date(AGORA - 60_000).toISOString();
  const b = pecas({ ultimaOc: 13 });
  const r2 = await lancar(repo, b.p);
  assert(r2.ok && r2.idempotent_skip, "lançamento recente = duplo clique → skip");
  assert(!b.chamadas.includes("submit"));

  repo.linhas[0]!.sucesso = false;
  const c = pecas();
  const r3 = await lancar(repo, c.p);
  assert(r3.ok && !r3.idempotent_skip);
  assert(repo.log.includes("apagar:velha"));
});

Deno.test("idempotência com a MESMA decisão do Relacionamento: antigo + SSW mostra outra oc → relança; leitura falhou → skip", async () => {
  const antigo = new Date(AGORA - RELANCAMENTO_JANELA_SKIP_MS - 60_000).toISOString();
  const repo = new RepoMem();
  repo.linhas.push({ id: "velha", sucesso: true, finalizado_em: antigo, op_item_id: ITEM.id, codigo_oc: 36, ctrc: ITEM.ctrc });
  const semVerdade = pecas({ ultimaOc: null });
  const r1 = await lancar(repo, semVerdade.p);
  assert(r1.ok && r1.idempotent_skip, "sem verdade do SSW não relança");
  const jaNoTopo = pecas({ ultimaOc: 36 });
  const r2 = await lancar(repo, jaNoTopo.p);
  assert(r2.ok && r2.idempotent_skip, "a oc já é a última");
  const outraPorCima = pecas({ ultimaOc: 21 });
  const r3 = await lancar(repo, outraPorCima.p);
  assert(r3.ok && !r3.idempotent_skip);
  assert(outraPorCima.chamadas.includes("submit"));
});

Deno.test("INV-013 estático: o envelope da Operação só abre sessão por readSswLancamentoEnv", async () => {
  const src = await Deno.readTextFile(new URL("./lancar-ssw-portal-operacao.ts", import.meta.url));
  const codigo = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
  assertEquals((codigo.match(/loadSswInternalEnvForCard\(/g) ?? []).length, 0);
  assertEquals((codigo.match(/readSswInternalEnv\(/g) ?? []).length, 0);
  assert(codigo.includes("p.obterSessao(p.readSswLancamentoEnv(args.env))"));
  assert(!codigo.includes("permitirLocalizacaoBaixada"), "a Operação nunca dispensa a checagem de localização");
  assert(codigo.includes("decidirIdempotenciaRelancamento({"), "reusa a decisão do Relacionamento, não copia");
});
