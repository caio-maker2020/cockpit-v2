// Guard — worker da baixa do motorista (ADR 0040, INV-175). Repositório falso com a
// MESMA conta das RPCs da mig 420 (reserva com teto/janela/quarentena/ordem; expirar).
// Trava: flags OFF, freio relido antes de cada lançamento, vazão 2/min (teto 3) até em
// paralelo, quarentena de 30 min em login recusado, reserva atômica e idempotência,
// interrompido → erro e nunca relança, TTL, ja_no_ssw, insucesso antes de entrega,
// evidência conferida (sha256) antes do SSW, piloto e lista fechada.
// Rodar: deno test --no-check --allow-read supabase/functions/_shared/baixa-motorista-worker.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { BaixaRow } from "./baixa-motorista-contrato.ts";
import { sha256Hex } from "./baixa-motorista-evidencia.ts";
import type { ResultadoDownload } from "./baixa-motorista-evidencia.ts";
import type { CanalBaixa, LancarSswBaixaResult } from "./lancar-ssw-baixa.ts";
import {
  type DepsWorkerBaixas,
  interpretarResultado,
  JANELA_VAZAO_SEGUNDOS,
  MAX_TENTATIVAS,
  montarTextoBaixa,
  type RepoWorkerBaixas,
  rodarWorkerBaixas,
  vagasDeLancamento,
} from "./baixa-motorista-worker.ts";

const T0 = Date.parse("2026-10-07T13:00:00Z"); // 10:00 SP
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
let SHA_JPEG = "";

class Mundo {
  agoraMs = T0;
  flags: Record<string, boolean> = { baixa_motorista_receber: true, baixa_motorista_lancar_ssw: true };
  canal: CanalBaixa | null = "portal101";
  piloto: Array<{ base: string | null; motorista_id: string | null }> = [{ base: "VGA", motorista_id: null }];
  codigos = new Set<number>([18]);
  baixas = new Map<string, BaixaRow>();
  executando = new Set<string>();
  lancamentos: Array<{ em: number; id: string; tipo: string; ctrc: string; temEvidencia: boolean }> = [];
  audits: string[] = [];
  chamadas: string[] = [];
  respostaLancar: (id: string) => LancarSswBaixaResult = () => ({ ok: true, resultado: "executado", canal: "portal101", protocolo: "seq", detalhe: "ok" });
  evidencia: (id: string) => ResultadoDownload = () => ({ ok: true, bytes: JPEG, contentType: "image/jpeg" });
  /** Leituras da flag de lançamento; devolve o valor a usar na N-ésima leitura (freio no meio). */
  freioPorLeitura: ((n: number) => boolean) | null = null;
  leiturasFreio = 0;
  seq = 0;

  iso(ms = this.agoraMs) { return new Date(ms).toISOString(); }
  avancar(seg: number) { this.agoraMs += seg * 1000; }

  baixa(over: Partial<BaixaRow> & { baixa_id: string }): BaixaRow {
    const b: BaixaRow = {
      seq: ++this.seq, tipo: "entrega", codigo_ocorrencia: 1, ctrc: `VGA${100000 + this.seq}-1`, nf: `${5000 + this.seq}`,
      ocorrido_em: this.iso(this.agoraMs - 30 * 60_000), recebido_em_origem: this.iso(), recebedor_nome: "Maria", recebedor_documento: null,
      geo_lat: -21.5, geo_lng: -45.4, geo_precisao_m: 10, evidencia_id: null, evidencia_sha256: null, evidencia_mime: null,
      motorista_id: "m1", motorista_nome: "João", rota_sugestao_id: "s1", rota_id: "V07", rota_veiculo_indice: 0, rota_placa: "ABC1D23",
      base: "VGA", hash_baixa: "h", recebido_em: this.iso(), prazo_em: this.iso(this.agoraMs + 36 * 3_600_000), status: "na_fila",
      status_em: this.iso(), tentativas: 0, reservado_em: null, ultima_categoria: null, ultima_falha_em: null, categoria: null,
      motivo: null, protocolo: null, canal: null, ...over,
    };
    this.baixas.set(b.baixa_id, b);
    return b;
  }

  fila(n: number, over: Partial<BaixaRow> = {}) {
    for (let i = 1; i <= n; i++) this.baixa({ baixa_id: `b${String(i).padStart(2, "0")}`, ...over });
  }

  repo(): RepoWorkerBaixas {
    // deno-lint-ignore no-this-alias
    const m = this;
    const naoFinal = (s: string) => ["recebido", "na_fila", "lancando"].includes(s);
    return {
      flagLigada: (k) => {
        m.chamadas.push(`flag:${k}`);
        if (k === "baixa_motorista_lancar_ssw" && m.freioPorLeitura) return Promise.resolve(m.freioPorLeitura(++m.leiturasFreio));
        return Promise.resolve(m.flags[k] ?? false);
      },
      canal: () => Promise.resolve(m.canal),
      expirar: (travadoMin) => {
        let n = 0;
        for (const b of m.baixas.values()) {
          const travado = b.status === "lancando" && Date.parse(b.reservado_em!) < m.agoraMs - travadoMin * 60_000;
          const vencido = (b.status === "recebido" || b.status === "na_fila") && Date.parse(b.prazo_em) < m.agoraMs;
          if (!travado && !vencido) continue;
          Object.assign(b, { status: "erro", categoria: travado ? "lancamento_interrompido" : "expirado", status_em: m.iso() });
          n++;
        }
        return Promise.resolve(n);
      },
      paraPreparar: (l) => Promise.resolve([...m.baixas.values()].filter((b) => b.status === "recebido").slice(0, l)),
      noPiloto: (base, mot) => Promise.resolve(m.piloto.some((p) => (p.base === null || p.base === base) && (p.motorista_id === null || p.motorista_id === mot))),
      codigoInsucessoPermitido: (c) => Promise.resolve(m.codigos.has(c)),
      marcarNaFila: (id) => {
        const b = m.baixas.get(id)!;
        if (b.status === "recebido") b.status = "na_fila";
        return Promise.resolve();
      },
      finalizar: (id, f) => {
        m.chamadas.push(`finalizar:${id}:${f.status}`);
        const b = m.baixas.get(id)!;
        if (naoFinal(b.status)) Object.assign(b, { status: f.status, categoria: f.categoria, motivo: f.motivo, protocolo: f.protocolo ?? null, status_em: m.iso() });
        return Promise.resolve();
      },
      // Mesma conta da RPC baixa_motorista_reservar (sem await dentro = atômico, como o advisory lock).
      reservar: (limite, quarentenaMin) => {
        m.chamadas.push("reservar");
        const todas = [...m.baixas.values()];
        const emQuarentena = todas.some((b) => b.ultima_categoria === "sessao_invalida" && Date.parse(b.ultima_falha_em!) > m.agoraMs - quarentenaMin * 60_000);
        const naJanela = todas.filter((b) => b.reservado_em && Date.parse(b.reservado_em) > m.agoraMs - 60_000).length;
        const vagas = vagasDeLancamento({ limitePorMinuto: limite, reservadosNaJanela: naJanela, emQuarentena });
        const escolhidas = todas
          .filter((b) => b.status === "na_fila" && Date.parse(b.prazo_em) > m.agoraMs)
          .sort((a, b) =>
            Number(b.tipo === "insucesso") - Number(a.tipo === "insucesso") ||
            Date.parse(a.ocorrido_em) - Date.parse(b.ocorrido_em) || a.seq - b.seq
          )
          .slice(0, vagas);
        for (const b of escolhidas) Object.assign(b, { status: "lancando", reservado_em: m.iso() });
        // Como o Postgres, sem garantia de ordem no retorno: devolve INVERTIDO de propósito.
        return Promise.resolve(escolhidas.map((b) => ({ ...b })).reverse());
      },
      devolverParaFila: (id, d) => {
        m.chamadas.push(`devolver:${id}:${d.categoria}`);
        const b = m.baixas.get(id)!;
        if (b.status === "lancando") {
          Object.assign(b, { status: "na_fila", tentativas: b.tentativas + (d.contarTentativa ? 1 : 0), ultima_categoria: d.categoria, ultima_falha_em: m.iso(), motivo: d.motivo });
        }
        return Promise.resolve();
      },
      relacionamentoExecutandoNoCtrc: (ctrc) => Promise.resolve(m.executando.has(ctrc)),
      duplicidade: (b) => {
        const outras = [...m.baixas.values()].filter((x) => x.ctrc === b.ctrc && x.baixa_id !== b.baixa_id);
        const feita = outras.find((x) => x.tipo === "entrega" && (x.status === "executado" || x.status === "ja_no_ssw"));
        const voo = outras.find((x) => x.status === "lancando" && b.reservado_em && x.reservado_em! < b.reservado_em);
        return Promise.resolve({ entregaFeitaPor: feita?.baixa_id ?? null, emVooPor: voo?.baixa_id ?? null });
      },
      registrarAudit: (a) => { m.audits.push(a.idempotency_key); return Promise.resolve(); },
    };
  }

  deps(over: Partial<DepsWorkerBaixas> = {}): DepsWorkerBaixas {
    // deno-lint-ignore no-this-alias
    const m = this;
    return {
      repo: m.repo(),
      baixarEvidencia: (id) => { m.chamadas.push(`evidencia:${id}`); return Promise.resolve(m.evidencia(id)); },
      lancar: (a) => {
        m.chamadas.push(`lancar:${a.baixa.baixaId}`);
        m.lancamentos.push({ em: m.agoraMs, id: a.baixa.baixaId, tipo: a.baixa.tipo, ctrc: a.baixa.ctrc, temEvidencia: a.evidencia !== null });
        return Promise.resolve(m.respostaLancar(a.baixa.baixaId));
      },
      ...over,
    };
  }
}

function assertVazao(tempos: number[], max: number) {
  for (const t of tempos) {
    const n = tempos.filter((x) => x >= t && x < t + JANELA_VAZAO_SEGUNDOS * 1000).length;
    assert(n <= max, `${n} lançamentos na janela que começa em ${new Date(t).toISOString()} (máx ${max})`);
  }
}

// ── flags e config ───────────────────────────────────────────────────────────

Deno.test("FLAGS OFF: baixa_motorista_receber OFF → só lê a flag; nada mais roda; SSW nunca", async () => {
  const m = new Mundo();
  m.flags.baixa_motorista_receber = false;
  m.fila(3);
  const r = await rodarWorkerBaixas(m.deps());
  assertEquals(r.skipped, "flag_off");
  assertEquals(m.chamadas, ["flag:baixa_motorista_receber"]);
});

Deno.test("FREIO OFF: baixa_motorista_lancar_ssw OFF → as baixas ESPERAM (não são descartadas); nada reservado", async () => {
  const m = new Mundo();
  m.flags.baixa_motorista_lancar_ssw = false;
  m.fila(2);
  m.baixa({ baixa_id: "nova", status: "recebido" });
  const r = await rodarWorkerBaixas(m.deps());
  assertEquals(r.skipped, "lancar_ssw_off");
  assertEquals([...m.baixas.values()].map((b) => b.status), ["na_fila", "na_fila", "recebido"]);
  assertEquals(m.lancamentos.length, 0);
  assert(!m.chamadas.includes("reservar"));
});

Deno.test("SEM CANAL: config canal NULL → nada vai ao SSW", async () => {
  const m = new Mundo();
  m.canal = null;
  m.fila(1);
  const r = await rodarWorkerBaixas(m.deps());
  assertEquals(r.skipped, "sem_canal");
  assertEquals(m.lancamentos.length, 0);
});

// ── preparar ─────────────────────────────────────────────────────────────────

Deno.test("PILOTO: fora da lista → recusado com motivo (lançar à mão); dentro → na fila e lançada", async () => {
  const m = new Mundo();
  m.baixa({ baixa_id: "fora", status: "recebido", base: "BHZ" });
  m.baixa({ baixa_id: "dentro", status: "recebido" });
  await rodarWorkerBaixas(m.deps());
  assertEquals(m.baixas.get("fora")!.status, "recusado");
  assertEquals(m.baixas.get("fora")!.categoria, "fora_do_piloto");
  assertEquals(m.baixas.get("dentro")!.status, "executado");
  const vazio = new Mundo();
  vazio.piloto = [];
  vazio.baixa({ baixa_id: "x", status: "recebido" });
  await rodarWorkerBaixas(vazio.deps());
  assertEquals(vazio.baixas.get("x")!.categoria, "fora_do_piloto");
  assertEquals(vazio.lancamentos.length, 0);
});

Deno.test("LISTA FECHADA: código de insucesso tirado da lista antes de lançar → recusado, sem SSW", async () => {
  const m = new Mundo();
  m.baixa({ baixa_id: "i", status: "recebido", tipo: "insucesso", codigo_ocorrencia: 18 });
  m.codigos.clear();
  await rodarWorkerBaixas(m.deps());
  assertEquals(m.baixas.get("i")!.categoria, "codigo_saiu_da_lista");
  assertEquals(m.lancamentos.length, 0);
});

// ── vazão, quarentena, freio ─────────────────────────────────────────────────

Deno.test("VAZÃO: 10 baixas, worker a cada 10 s por 3 min → no máximo 2 por janela de 60 s", async () => {
  const m = new Mundo();
  m.fila(10);
  for (let s = 0; s < 180; s += 10) {
    await rodarWorkerBaixas(m.deps());
    m.avancar(10);
  }
  assertVazao(m.lancamentos.map((l) => l.em), 2);
  assertEquals(m.lancamentos.length, 6);
});

Deno.test("VAZÃO: 5 execuções PARALELAS no mesmo instante não passam de 2", async () => {
  const m = new Mundo();
  m.fila(10);
  await Promise.all([1, 2, 3, 4, 5].map(() => rodarWorkerBaixas(m.deps())));
  assertEquals(m.lancamentos.length, 2);
});

Deno.test("VAZÃO: limite errado (50/min) ainda para no teto de 3", async () => {
  const m = new Mundo();
  m.fila(10);
  await rodarWorkerBaixas(m.deps({ limitePorMinuto: 50 }));
  assertEquals(m.lancamentos.length, 3);
});

Deno.test("a RPC da mig 420 tem a MESMA conta (teto 3, janela 60 s, quarentena, advisory lock, insucesso primeiro)", async () => {
  const sql = await Deno.readTextFile(new URL("../../../migration/2026-10-07_420_baixa_motorista.sql", import.meta.url));
  assert(sql.includes("least(greatest(coalesce(p_limite_por_minuto, 0), 0), 3)"));
  assert(sql.includes("pg_advisory_xact_lock(hashtext('baixa_motorista_ssw_vazao'))"));
  assert(sql.includes("reservado_em > v_agora - interval '60 seconds'"));
  assert(sql.includes("ultima_categoria = 'sessao_invalida'"));
  assert(sql.includes("ORDER BY (q.tipo = 'insucesso') DESC, q.ocorrido_em, q.seq"));
  assert(sql.includes("SELECT * FROM r ORDER BY (r.tipo = 'insucesso') DESC, r.ocorrido_em, r.seq"), "o retorno da RPC sai ordenado");
  assert(sql.includes("FOR UPDATE SKIP LOCKED"));
  // nasce inerte
  assert(/\('baixa_motorista_receber', false/.test(sql) && /\('baixa_motorista_lancar_ssw', false/.test(sql));
  assert(sql.includes("INSERT INTO public.baixa_motorista_config (id, canal) VALUES (true, NULL)"));
  assertEquals(/cron\.schedule/.test(sql), false, "o cron mora na mig 421");
  assertEquals(/INSERT INTO public\.baixa_motorista_(codigos|piloto)/.test(sql), false, "listas nascem vazias");
});

Deno.test("QUARENTENA: login recusado → para a rodada, as reservadas voltam; 30 min sem reservar; depois retoma", async () => {
  const m = new Mundo();
  m.fila(4);
  m.respostaLancar = () => ({ ok: false, categoria: "sessao_invalida", fase: "antes_do_submit", motivo: "SSW login falhou" });
  const r = await rodarWorkerBaixas(m.deps({ limitePorMinuto: 3 }));
  assert(r.quarentena);
  assertEquals(m.lancamentos.length, 1, "a 2ª reservada nem tenta");
  assert([...m.baixas.values()].every((b) => b.status === "na_fila"), "nada se perde: tudo volta para a fila");
  assertEquals(m.baixas.get("b01")!.tentativas, 0, "login recusado não gasta tentativa da baixa");
  m.respostaLancar = () => ({ ok: true, resultado: "executado", canal: "portal101", protocolo: "s", detalhe: "" });
  for (let min = 1; min < 30; min++) {
    m.avancar(60);
    await rodarWorkerBaixas(m.deps());
  }
  assertEquals(m.lancamentos.length, 1, "30 min de quarentena: nenhuma sessão nova");
  m.avancar(90);
  await rodarWorkerBaixas(m.deps());
  assertEquals(m.lancamentos.length, 3);
});

Deno.test("FREIO DE EMERGÊNCIA: desligado DURANTE a rodada → a próxima não sai; reservadas voltam à fila", async () => {
  const m = new Mundo();
  m.fila(3);
  // leitura 1 = começo da rodada; 2 = antes da 1ª; 3 = antes da 2ª (desligado)
  m.freioPorLeitura = (n) => n < 3;
  await rodarWorkerBaixas(m.deps({ limitePorMinuto: 3 }));
  assertEquals(m.lancamentos.map((l) => l.id), ["b01"]);
  assertEquals(m.baixas.get("b02")!.status, "na_fila");
  assertEquals(m.baixas.get("b03")!.status, "na_fila");
});

Deno.test("FREIO: a flag é lida IMEDIATAMENTE antes de cada chamada ao SSW (dentro do laço)", async () => {
  const m = new Mundo();
  m.fila(2);
  await rodarWorkerBaixas(m.deps());
  const idx = (s: string) => m.chamadas.indexOf(s);
  for (const id of ["b01", "b02"]) {
    const l = idx(`lancar:${id}`);
    assertEquals(m.chamadas[l - 1], "flag:baixa_motorista_lancar_ssw", `antes de lancar:${id}`);
  }
  const src = await Deno.readTextFile(new URL("./baixa-motorista-worker.ts", import.meta.url));
  assert(src.includes("if (!(await freioLiberado(repo)))"));
});

// ── idempotência, interrupção, prazo ─────────────────────────────────────────

Deno.test("IDEMPOTÊNCIA: rodar de novo (e em paralelo) nunca leva a mesma baixa 2x ao SSW", async () => {
  const m = new Mundo();
  m.fila(4);
  for (let i = 0; i < 6; i++) {
    await Promise.all([rodarWorkerBaixas(m.deps()), rodarWorkerBaixas(m.deps())]);
    m.avancar(61);
  }
  const ids = m.lancamentos.map((l) => l.id);
  assertEquals(ids.length, new Set(ids).size);
  assertEquals(ids.length, 4);
});

Deno.test("INTERRUPÇÃO: baixa travada em lancando vira erro e NÃO é relançada", async () => {
  const m = new Mundo();
  m.baixa({ baixa_id: "t", status: "lancando", reservado_em: new Date(T0 - 16 * 60_000).toISOString() });
  await rodarWorkerBaixas(m.deps());
  assertEquals(m.baixas.get("t")!.status, "erro");
  assertEquals(m.baixas.get("t")!.categoria, "lancamento_interrompido");
  assertEquals(m.lancamentos.length, 0);
});

Deno.test("INTERRUPÇÃO no submit (o SSW pode ter gravado) → erro na hora, nunca volta para a fila", async () => {
  const m = new Mundo();
  m.fila(1);
  m.respostaLancar = () => ({ ok: false, categoria: "interrompido", fase: "submit", motivo: "timeout no submit" });
  await rodarWorkerBaixas(m.deps());
  assertEquals(m.baixas.get("b01")!.status, "erro");
  m.avancar(120);
  await rodarWorkerBaixas(m.deps());
  assertEquals(m.lancamentos.length, 1);
  // e se o envelope LANÇAR exceção, o resultado é o mesmo
  const m2 = new Mundo();
  m2.fila(1);
  await rodarWorkerBaixas(m2.deps({ lancar: () => Promise.reject(new Error("isolate caiu")) }));
  assertEquals(m2.baixas.get("b01")!.status, "erro");
});

Deno.test("TTL: baixa que passou do fim do dia seguinte expira sem ir ao SSW", async () => {
  const m = new Mundo();
  m.baixa({ baixa_id: "velha", prazo_em: new Date(T0 - 1000).toISOString() });
  m.baixa({ baixa_id: "velha-recebida", status: "recebido", prazo_em: new Date(T0 - 1000).toISOString() });
  await rodarWorkerBaixas(m.deps());
  assertEquals(m.baixas.get("velha")!.status, "erro");
  assertEquals(m.baixas.get("velha")!.categoria, "expirado");
  assertEquals(m.baixas.get("velha-recebida")!.status, "erro");
  assertEquals(m.lancamentos.length, 0);
});

// ── resultados ───────────────────────────────────────────────────────────────

Deno.test("JA_NO_SSW: o envelope achou a 01 → status ja_no_ssw, auditado, nada gravado", async () => {
  const m = new Mundo();
  m.fila(1);
  m.respostaLancar = () => ({ ok: true, resultado: "ja_no_ssw", canal: "portal101", motivo: "a 01 já está no SSW" });
  await rodarWorkerBaixas(m.deps());
  assertEquals(m.baixas.get("b01")!.status, "ja_no_ssw");
  assertEquals(m.audits, ["baixa_motorista:b01"]);
});

Deno.test("JA_NO_SSW por outra baixa: a 01 do mesmo CTRC já saiu por outro baixaId → não chama o SSW", async () => {
  const m = new Mundo();
  m.baixa({ baixa_id: "primeira", ctrc: "VGA1-1", status: "executado" });
  m.baixa({ baixa_id: "repetida", ctrc: "VGA1-1" });
  await rodarWorkerBaixas(m.deps());
  assertEquals(m.baixas.get("repetida")!.status, "ja_no_ssw");
  assertEquals(m.lancamentos.length, 0);
});

Deno.test("INSUCESSO ANTES DE ENTREGA: mesma rodada, mesmo CTRC → o insucesso vai primeiro", async () => {
  const m = new Mundo();
  m.baixa({ baixa_id: "entrega", ctrc: "VGA7-7", ocorrido_em: new Date(T0 - 60 * 60_000).toISOString() });
  m.baixa({ baixa_id: "insucesso", ctrc: "VGA7-7", tipo: "insucesso", codigo_ocorrencia: 18, ocorrido_em: new Date(T0 - 30 * 60_000).toISOString() });
  await rodarWorkerBaixas(m.deps());
  assertEquals(m.lancamentos.map((l) => l.id), ["insucesso", "entrega"]);
});

Deno.test("Relacionamento lançando no mesmo CTRC agora → a baixa espera (sem gastar tentativa)", async () => {
  const m = new Mundo();
  m.fila(1);
  m.executando.add(m.baixas.get("b01")!.ctrc);
  await rodarWorkerBaixas(m.deps());
  assertEquals(m.baixas.get("b01")!.status, "na_fila");
  assertEquals(m.baixas.get("b01")!.tentativas, 0);
  assertEquals(m.lancamentos.length, 0);
});

Deno.test("EVIDÊNCIA: sha256 confere → vai junto; não confere → recusado SEM chamar o SSW", async () => {
  SHA_JPEG = await sha256Hex(JPEG);
  const m = new Mundo();
  m.baixa({ baixa_id: "boa", evidencia_id: "ev1", evidencia_sha256: SHA_JPEG, evidencia_mime: "image/jpeg" });
  m.baixa({ baixa_id: "trocada", evidencia_id: "ev2", evidencia_sha256: "0".repeat(64), evidencia_mime: "image/jpeg" });
  await rodarWorkerBaixas(m.deps());
  assertEquals(m.lancamentos.map((l) => [l.id, l.temEvidencia]), [["boa", true]]);
  assertEquals(m.baixas.get("trocada")!.status, "recusado");
  assertEquals(m.baixas.get("trocada")!.categoria, "evidencia_invalida");
});

Deno.test("EVIDÊNCIA: Roteirizador fora do ar → espera e tenta de novo; na 3ª falha, erro", async () => {
  const m = new Mundo();
  m.baixa({ baixa_id: "e", evidencia_id: "ev1", evidencia_sha256: "a".repeat(64), evidencia_mime: "image/jpeg" });
  m.evidencia = () => ({ ok: false, tipo: "transitorio", motivo: "503" });
  for (let i = 0; i < MAX_TENTATIVAS; i++) {
    await rodarWorkerBaixas(m.deps());
    m.avancar(61);
  }
  assertEquals(m.baixas.get("e")!.status, "erro");
  assertEquals(m.lancamentos.length, 0);
});

Deno.test("SSW recusou o submit → erro (humano confere), não volta para a fila", async () => {
  const m = new Mundo();
  m.fila(1);
  m.respostaLancar = () => ({ ok: false, categoria: "ssw_recusou", fase: "submit", motivo: "SSW erro: Ocorrência inválida" });
  await rodarWorkerBaixas(m.deps());
  assertEquals(m.baixas.get("b01")!.status, "erro");
  assertEquals(m.baixas.get("b01")!.categoria, "ssw_recusou");
});

Deno.test("tripé recusou → recusado com o motivo (decisão, não falha)", async () => {
  const m = new Mundo();
  m.fila(1);
  m.respostaLancar = () => ({ ok: false, categoria: "guard_tripe", fase: "antes_do_submit", motivo: "ctrc_finalizado" });
  await rodarWorkerBaixas(m.deps());
  assertEquals(m.baixas.get("b01")!.status, "recusado");
});

Deno.test("interpretação: leitura falhou antes do submit → fila até a 3ª tentativa", () => {
  const r: LancarSswBaixaResult = { ok: false, categoria: "leitura_ssw", fase: "antes_do_submit", motivo: "timeout" };
  assertEquals(interpretarResultado(r, { tentativas: 0 }, "portal101").acao, "devolver");
  const ult = interpretarResultado(r, { tentativas: MAX_TENTATIVAS - 1 }, "portal101");
  assert(ult.acao === "finalizar" && ult.f.status === "erro");
});

Deno.test("texto do SSW: o fato primeiro (cabe nos 70 do histórico), origem depois, ≤ 500", () => {
  const m = new Mundo();
  const b = m.baixa({ baixa_id: "7a1c2e3f-0000-4000-8000-000000000000", recebedor_nome: "Maria Souza", recebedor_documento: "123" });
  const t = montarTextoBaixa(b);
  assert(t.startsWith("ENTREGUE A Maria Souza DOC 123"));
  assert(t.includes("PLACA ABC1D23") && t.includes("BAIXA PELO APP DO ROTEIRIZADOR 7a1c2e3f"));
  assert(montarTextoBaixa({ ...b, motorista_nome: "x".repeat(900) }).length <= 500);
  const ins = montarTextoBaixa({ ...b, tipo: "insucesso", codigo_ocorrencia: 18 });
  assert(ins.startsWith("INSUCESSO NA ENTREGA (OC 18)"));
});

Deno.test("o worker só fala com o SSW pelo envelope injetado (fonte sem cliente SSW nem fetch)", async () => {
  for (const arq of ["./baixa-motorista-worker.ts", "../processar-baixas-motorista/index.ts"]) {
    const src = await Deno.readTextFile(new URL(arq, import.meta.url));
    assertEquals(/from "[^"]*ssw-internal-client\.ts"(?!.*type)|loginInternoSSW|obterSessao|createSswClient|lancarOcorrenciaPortal\(|fetch\(/.test(src.replace(/import type[^;]+;/g, "")), false, arq);
  }
  const edge = await Deno.readTextFile(new URL("../processar-baixas-motorista/index.ts", import.meta.url));
  assert(edge.includes('import { lancarSswBaixa } from "../_shared/lancar-ssw-baixa.ts"'));
});
