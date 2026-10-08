// Guard — envelope da baixa no SSW (ADR 0040, INV-176/175/176). SSW falso (io injetado).
// Trava:
//   - a 01 já no SSW → ja_no_ssw SEM gravar; insucesso em nota entregue → recusa;
//   - tripé (CTRC/NF/localização) roda antes do submit e barra divergência;
//   - CTRC da baixa nunca trocado (divergência no SSW = recusa, não "outro CTRC");
//   - hora real (nunca futura) nos dois canais;
//   - canal webapi só com a credencial da conta de serviço (INV-013);
//   - fase do erro: antes do submit (repetível) × no submit (erro, nunca relança);
//   - a sessão do portal sai de readSswLancamentoEnv (fonte).
// Rodar: deno test --no-check --allow-read supabase/functions/_shared/lancar-ssw-baixa.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type BaixaParaSsw,
  classificarErroLeitura,
  credencialWebApiEhDaContaDeServico,
  decidirPelaVerdade,
  extrairCnpjRemetente,
  formatarDataHoraWebApi,
  lancarSswBaixa,
  MARCA_LOGIN_WEBAPI,
  type SswBaixaIo,
} from "./lancar-ssw-baixa.ts";
import type { DescobrirUltimaOcSswResultado, LancarOcorrenciaPortalOpts, SswSessao } from "./ssw-internal-client.ts";
import type { LancarOcorrenciaInput } from "./ssw-client.ts";

const AGORA = Date.parse("2026-10-07T15:00:00Z"); // 12:00 SP
const ENV = { SSW_LANCAMENTO_USUARIO: "ai.salex", SSW_USERNAME: "AI.SALEX" };

/** HTML do act=O / detalhe com os 3 rótulos do tripé (mesmo layout do validar-tripe-ssw.test.ts). */
function htmlTripe(ctrc = "VGA123456-7", nf = "638789", loc = "EM ROTA DE ENTREGA") {
  return `<div class=lbl>CTRC:</div> <A class=baselnk href=#>${ctrc}</A>
    <div class=lbl>Nota&nbsp;fiscal:</div> <div class=data>001/${nf}</div>
    <div class=lbl>Localiza&ccedil;&atilde;o atual:</div> <div class=data>${loc}</div>
    <div class=lbl>Remetente:</div> <div class=data>FABRICA SA 12.345.678/0001-99</div>`;
}

const baixa = (over: Partial<BaixaParaSsw> = {}): BaixaParaSsw => ({
  baixaId: "7a1c2e3f-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
  tipo: "entrega",
  codigo: 1,
  ctrc: "VGA123456-7",
  nf: "638789",
  ocorridoEm: "2026-10-07T14:40:00.000Z", // 11:40 SP
  texto: "ENTREGUE A MARIA | MOTORISTA JOAO",
  ...over,
});

const verdade = (ocs: Array<{ codigo: number; data?: string }>): DescobrirUltimaOcSswResultado =>
  ocs.length === 0
    ? { sucesso: false, motivo: "ssw_sem_oc" }
    : {
      sucesso: true, oc: ocs[0]!.codigo, dataBrtMs: null, dataRaw: ocs[0]!.data ?? null,
      ocorrencias: ocs.map((o) => ({ codigo: o.codigo, usuario: "fulano", data: o.data ?? "06/10/26 09:00" })),
    };

class SswFalso {
  chamadas: string[] = [];
  verdade: DescobrirUltimaOcSswResultado = verdade([{ codigo: 85 }]);
  htmlAtoO = htmlTripe();
  htmlDetalhe = htmlTripe();
  optsPortal: LancarOcorrenciaPortalOpts | null = null;
  inputWebApi: LancarOcorrenciaInput | null = null;
  falhaSessao: string | null = null;
  falhaDetalhe: string | null = null;
  portalLanca = false;
  webapi: { ok: true } | { ok: false; status: number } | "throw" | "login" = { ok: true };

  io(): Partial<SswBaixaIo> {
    const sessao: SswSessao = { cookies: new Map(), criadoEm: 0, tokenExpMs: Number.MAX_SAFE_INTEGER };
    return {
      abrirSessao: () => {
        this.chamadas.push("sessao");
        return this.falhaSessao ? Promise.reject(new Error(this.falhaSessao)) : Promise.resolve(sessao);
      },
      lerVerdade: () => { this.chamadas.push("verdade"); return Promise.resolve(this.verdade); },
      buscarDetalhe: (_s, nf, ctrc) => {
        this.chamadas.push(`detalhe:${nf}:${ctrc}`);
        return this.falhaDetalhe ? Promise.reject(new Error(this.falhaDetalhe)) : Promise.resolve({ nf, seq_ctrc: "1", familia: "F", html: this.htmlDetalhe });
      },
      lancarPortal: async (_s, _d, opts) => {
        this.chamadas.push("portal");
        this.optsPortal = opts;
        if (this.portalLanca) throw new Error("timeout no submit");
        const g = await opts.validarAntesDoSubmit!(this.htmlAtoO);
        if (!g.ok) return { ok: false, error: `Guard tripé rejeitou lançamento: ${g.motivo}`, bloqueado_por_guard: { motivo: g.motivo, detalhe: g.detalhe } };
        this.chamadas.push("submit");
        return { ok: true, seq_oc: "(confirmar)", descricao: "oc=01 lançada", raw_response_snippet: "" };
      },
      listarCtrcs: () => {
        this.chamadas.push("listar");
        return Promise.resolve([
          { ctrc: "VGA123456-7", tipo: "NORMAL", pagador: "P", data_emissao: "", cancelado: true, seq_ctrc: "0", familia: "", chave_cte: "9".repeat(44), remetente: "", destinatario: "" },
          { ctrc: "VGA123456-7", tipo: "NORMAL", pagador: "P", data_emissao: "", cancelado: false, seq_ctrc: "1", familia: "", chave_cte: "3126".padEnd(44, "1"), remetente: "", destinatario: "" },
          { ctrc: "VGA999999-1", tipo: "", pagador: "P", data_emissao: "", cancelado: false, seq_ctrc: "2", familia: "", chave_cte: "8".repeat(44), remetente: "", destinatario: "" },
        ]);
      },
      lancarWebApi: (_env, input) => {
        this.chamadas.push("webapi");
        this.inputWebApi = input;
        if (this.webapi === "throw") return Promise.reject(new Error("conexão caiu"));
        if (this.webapi === "login") return Promise.reject(new Error(`${MARCA_LOGIN_WEBAPI}: SSW token error [401]`));
        return Promise.resolve(this.webapi.ok
          ? { ok: true, protocolo: "P-123", idempotencyKey: "k", raw: {} }
          : { ok: false, idempotencyKey: "k", status: this.webapi.status, error: "DOCUMENTO NAO ENCONTRADO", raw: {} });
      },
    };
  }
}

const rodar = (s: SswFalso, over: Partial<Parameters<typeof lancarSswBaixa>[0]> = {}) =>
  lancarSswBaixa({ env: ENV, canal: "portal101", baixa: baixa(), evidencia: null, agoraMs: AGORA, io: s.io(), ...over });

// ── verdade do SSW ───────────────────────────────────────────────────────────

Deno.test("ja_no_ssw: a 01 já está no CTRC → nada é gravado (nem detalhe, nem submit)", async () => {
  const s = new SswFalso();
  s.verdade = verdade([{ codigo: 1, data: "07/10/26 11:41" }, { codigo: 85 }]);
  const r = await rodar(s);
  assert(r.ok && r.resultado === "ja_no_ssw");
  assertEquals(s.chamadas, ["sessao", "verdade"]);
});

Deno.test("ja_no_ssw: a 01 mais antiga no histórico também conta (não só a última)", () => {
  const d = decidirPelaVerdade({ tipo: "entrega", codigo: 1, ocorridoEmMs: AGORA, verdade: verdade([{ codigo: 85 }, { codigo: 1 }]) });
  assertEquals(d.acao, "ja_no_ssw");
});

Deno.test("insucesso em nota já entregue → recusa (nota_encerrada), sem submit", async () => {
  const s = new SswFalso();
  s.verdade = verdade([{ codigo: 1 }]);
  const r = await rodar(s, { baixa: baixa({ tipo: "insucesso", codigo: 18 }) });
  assert(!r.ok && r.categoria === "nota_encerrada" && r.fase === "antes_do_submit");
  assert(!s.chamadas.includes("portal"));
});

Deno.test("insucesso idêntico (mesmo código, mesma hora) já no SSW → ja_no_ssw", () => {
  const d = decidirPelaVerdade({
    tipo: "insucesso", codigo: 18, ocorridoEmMs: Date.parse("2026-10-07T11:40:30-03:00"),
    verdade: verdade([{ codigo: 18, data: "07/10/26 11:41" }]),
  });
  assertEquals(d.acao, "ja_no_ssw");
  const outraHora = decidirPelaVerdade({
    tipo: "insucesso", codigo: 18, ocorridoEmMs: Date.parse("2026-10-07T15:00:00-03:00"),
    verdade: verdade([{ codigo: 18, data: "07/10/26 11:41" }]),
  });
  assertEquals(outraHora.acao, "lancar"); // segunda tentativa no mesmo dia é fato novo
});

Deno.test("CTRC encerrado (30/32) → recusa; CTRC sem ocorrência → pode lançar", () => {
  assertEquals(decidirPelaVerdade({ tipo: "entrega", codigo: 1, ocorridoEmMs: AGORA, verdade: verdade([{ codigo: 32 }]) }).acao, "falha");
  assertEquals(decidirPelaVerdade({ tipo: "entrega", codigo: 1, ocorridoEmMs: AGORA, verdade: verdade([]) }).acao, "lancar");
});

Deno.test("leitura do SSW falhou → não lança agora (antes do submit, repetível)", async () => {
  const s = new SswFalso();
  s.verdade = { sucesso: false, motivo: "ssw_erro", detalhe: "timeout" };
  const r = await rodar(s);
  assert(!r.ok && r.categoria === "leitura_ssw" && r.fase === "antes_do_submit");
  assert(!s.chamadas.includes("portal"));
});

// ── CTRC da baixa e tripé ────────────────────────────────────────────────────

Deno.test("CTRC da baixa diverge do SSW → recusa; nunca troca de CTRC", async () => {
  const s = new SswFalso();
  s.falhaDetalhe = "SSW buscar NF 638789: CTRC no SSW é VGA999999-1 mas card espera VGA123456-7. Provável…";
  const r = await rodar(s);
  assert(!r.ok && r.categoria === "ctrc_nf_divergente");
  assert(s.chamadas.includes("detalhe:638789:VGA123456-7"), "o detalhe é buscado COM o CTRC da baixa");
  assert(!s.chamadas.includes("portal"));
});

Deno.test("tripé barra antes do submit: localização ENTREGUE, NF diferente, CTRC diferente", async () => {
  for (const html of [htmlTripe("VGA123456-7", "638789", "ENTREGUE"), htmlTripe("VGA123456-7", "111"), htmlTripe("VGA000000-0")]) {
    const s = new SswFalso();
    s.htmlAtoO = html;
    const r = await rodar(s);
    assert(!r.ok && r.categoria === "guard_tripe" && r.fase === "antes_do_submit", html.slice(0, 80));
    assert(!s.chamadas.includes("submit"));
  }
});

// ── portal 101 ───────────────────────────────────────────────────────────────

Deno.test("portal101: lança com a HORA REAL, o código, o texto e a evidência", async () => {
  const s = new SswFalso();
  const ev = { bytes: new Uint8Array([0xff, 0xd8, 0xff]), filename: "b.jpg", mimeType: "image/jpeg" };
  const r = await rodar(s, { evidencia: ev });
  assert(r.ok && r.resultado === "executado" && r.canal === "portal101");
  assertEquals(s.chamadas, ["sessao", "verdade", "detalhe:638789:VGA123456-7", "portal", "submit"]);
  assertEquals(s.optsPortal!.codigoSsw, 1);
  assertEquals(s.optsPortal!.dataHoraEvento!.toISOString(), "2026-10-07T14:40:00.000Z");
  assertEquals(s.optsPortal!.imagens!.length, 1);
  assertEquals(s.optsPortal!.segregarCtrc, undefined, "a baixa nunca segrega CTRC");
});

Deno.test("hora nunca futura: aparelho >10 min adiantado → nada vai ao SSW; até 10 min → aceito e limitado a agora − 2 min", async () => {
  const s = new SswFalso();
  const r = await rodar(s, { baixa: baixa({ ocorridoEm: new Date(AGORA + 11 * 60_000).toISOString() }) });
  assert(!r.ok && r.categoria === "entrada_invalida");
  assertEquals(s.chamadas, []);
  const s2 = new SswFalso();
  await rodar(s2, { baixa: baixa({ ocorridoEm: new Date(AGORA + 9 * 60_000).toISOString() }) });
  assertEquals(s2.optsPortal!.dataHoraEvento!.getTime(), AGORA - 2 * 60_000);
  const s3 = new SswFalso();
  await rodar(s3, { canal: "webapi", baixa: baixa({ ocorridoEm: new Date(AGORA + 9 * 60_000).toISOString() }) });
  assertEquals(s3.inputWebApi!.dataHoraEvento, "2026-10-07T11:58:00:000-03:00");
});

Deno.test("portal101: exceção no meio do lançamento → interrompido NO SUBMIT (o worker marca erro)", async () => {
  const s = new SswFalso();
  s.portalLanca = true;
  const r = await rodar(s);
  assert(!r.ok && r.categoria === "interrompido" && r.fase === "submit");
});

Deno.test("login recusado → sessao_invalida antes de tudo; env ausente → credencial", async () => {
  const s = new SswFalso();
  s.falhaSessao = "SSW login falhou — sem cookie 'token' após POST";
  const r = await rodar(s);
  assert(!r.ok && r.categoria === "sessao_invalida" && r.fase === "antes_do_submit");
  assertEquals(s.chamadas, ["sessao"]);
  const s2 = new SswFalso();
  s2.falhaSessao = "SSW_LANCAMENTO_* env vars ausentes — conta de serviço ai.salex";
  const r2 = await rodar(s2);
  assert(!r2.ok && r2.categoria === "credencial");
});

// ── WebAPI ───────────────────────────────────────────────────────────────────

Deno.test("webapi: credencial da WebAPI ≠ conta de serviço → nada é chamado (INV-013)", async () => {
  assertEquals(credencialWebApiEhDaContaDeServico({ SSW_USERNAME: "ai.salex", SSW_LANCAMENTO_USUARIO: "AI.SALEX " }), true);
  assertEquals(credencialWebApiEhDaContaDeServico({ SSW_USERNAME: "larissa", SSW_LANCAMENTO_USUARIO: "ai.salex" }), false);
  assertEquals(credencialWebApiEhDaContaDeServico({ SSW_LANCAMENTO_USUARIO: "ai.salex" }), false);
  const s = new SswFalso();
  const r = await rodar(s, { canal: "webapi", env: { SSW_USERNAME: "larissa", SSW_LANCAMENTO_USUARIO: "ai.salex" } });
  assert(!r.ok && r.categoria === "credencial");
  assertEquals(s.chamadas, []);
});

Deno.test("webapi: tripé na tela do CTRC, chave do CT-e do CTRC EXATO não cancelado, CNPJ, código 01, hora real, 1 imagem", async () => {
  const s = new SswFalso();
  const ev = { bytes: new Uint8Array([0xff, 0xd8, 0xff]), filename: "b.jpg", mimeType: "image/jpeg" };
  const r = await rodar(s, { canal: "webapi", evidencia: ev });
  assert(r.ok && r.resultado === "executado" && r.canal === "webapi");
  assertEquals(s.chamadas, ["sessao", "verdade", "detalhe:638789:VGA123456-7", "listar", "webapi"]);
  const i = s.inputWebApi!;
  assertEquals(i.chaveCTe, "3126".padEnd(44, "1"));
  assertEquals(i.cnpjRemetente, "12345678000199");
  assertEquals(i.codigo, "01");
  assertEquals(i.dataHoraEvento, "2026-10-07T11:40:00:000-03:00");
  assertEquals(i.imagem, btoa(String.fromCharCode(0xff, 0xd8, 0xff)));
  assertEquals(i.todoId, baixa().baixaId);
});

Deno.test("webapi: tripé que não casa (layout/CTRC/localização) → recusa sem chamar a WebAPI", async () => {
  const s = new SswFalso();
  s.htmlDetalhe = "<html>layout novo</html>";
  const r = await rodar(s, { canal: "webapi" });
  assert(!r.ok && r.categoria === "guard_tripe");
  assert(!s.chamadas.includes("webapi"));
});

Deno.test("webapi: 4xx = o SSW recusou (submit); 5xx/exceção = interrompido; login antes do envio = sessao_invalida", async () => {
  const s = new SswFalso();
  s.webapi = { ok: false, status: 400 };
  const r = await rodar(s, { canal: "webapi" });
  assert(!r.ok && r.categoria === "ssw_recusou" && r.fase === "submit");
  const s2 = new SswFalso();
  s2.webapi = { ok: false, status: 502 };
  const r2 = await rodar(s2, { canal: "webapi" });
  assert(!r2.ok && r2.categoria === "interrompido" && r2.fase === "submit");
  const s3 = new SswFalso();
  s3.webapi = "throw";
  const r3 = await rodar(s3, { canal: "webapi" });
  assert(!r3.ok && r3.categoria === "interrompido");
  const s4 = new SswFalso();
  s4.webapi = "login";
  const r4 = await rodar(s4, { canal: "webapi" });
  assert(!r4.ok && r4.categoria === "sessao_invalida" && r4.fase === "antes_do_submit");
});

// ── peças puras ──────────────────────────────────────────────────────────────

Deno.test("formatos e classificadores", () => {
  assertEquals(formatarDataHoraWebApi(Date.parse("2026-10-07T03:05:09.007Z")), "2026-10-07T00:05:09:007-03:00");
  assertEquals(classificarErroLeitura("SSW login falhou — x"), "sessao_invalida");
  assertEquals(classificarErroLeitura("SSW buscar NF 1: tem 2 CTRCs mas nenhum bate com card.ctrc=X."), "ctrc_nf_divergente");
  assertEquals(classificarErroLeitura("fetch failed"), "leitura_ssw");
  assertEquals(extrairCnpjRemetente("<b>Remetente</b> ACME 12345678000199"), "12345678000199");
  assertEquals(extrairCnpjRemetente("<b>Destinatário</b> 12.345.678/0001-99"), null);
});

Deno.test("fonte: sessão de lançamento por readSswLancamentoEnv; nunca por operador; nunca o envelope do Relacionamento", async () => {
  const src = await Deno.readTextFile(new URL("./lancar-ssw-baixa.ts", import.meta.url));
  assert(/obterSessao\(readSswLancamentoEnv\(env\)\)/.test(src));
  assertEquals(/loadSswInternalEnvForCard\(|readSswInternalEnv\(/.test(src), false);
  assertEquals(/from "\.\/lancar-ssw-portal\.ts"/.test(src), false);
  assertEquals(/segregarCtrc/.test(src), false);
});
