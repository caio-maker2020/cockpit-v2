// =============================================================================
// baixa-motorista-worker — o executor das baixas do motorista (ADR 0040).
// Roda na edge `processar-baixas-motorista` (cron de 1 min, mig 421). Sem I/O
// próprio: repositório, download da evidência e o ENVELOPE `lancarSswBaixa` são
// injetados → deno test.
//
// Rodada (flag `baixa_motorista_receber` OFF = nada roda):
//   0. prazos: baixa que passou do fim do dia seguinte ao ocorrido vira `erro`
//      ("expirou"); baixa reservada que não terminou em 15 min vira `erro`
//      ("lançamento interrompido") — NUNCA é relançada às cegas;
//   (com `baixa_motorista_lancar_ssw` OFF ou sem canal configurado, para aqui:
//    as baixas ESPERAM — o freio pausa, não descarta)
//   A. preparar: piloto (base/motorista) e lista fechada de insucesso → na_fila;
//   B. SSW: reserva no banco (RPC com advisory lock, janela global de 60 s,
//      2/min, teto 3, quarentena de 30 min depois de login recusado; insucesso
//      antes de entrega) e lança UMA POR VEZ, na mesma sessão:
//        cerca no banco (duplicidade, Relacionamento executando no CTRC) →
//        evidência baixada e conferida (sha256 + mime) → FREIO relido →
//        envelope (verdade do SSW → ja_no_ssw | tripé → lança com a hora real).
// =============================================================================

import type { AnexoBytes } from "./ssw-internal-client.ts";
import type { BaixaParaSsw, CanalBaixa, LancarSswBaixaResult } from "./lancar-ssw-baixa.ts";
import { type BaixaRow, FLAG_BAIXA_LANCAR_SSW, FLAG_BAIXA_RECEBER } from "./baixa-motorista-contrato.ts";
import { conferirEvidencia, type ResultadoDownload } from "./baixa-motorista-evidencia.ts";
// Os MESMOS parâmetros de vazão da ponte v2 (importados, não copiados — INV-159/INV-173).
import {
  JANELA_VAZAO_SEGUNDOS,
  LANCAMENTO_TRAVADO_MIN,
  LIMITE_SSW_POR_MINUTO,
  QUARENTENA_LOGIN_MIN,
  TETO_SSW_POR_MINUTO,
  vagasDeLancamento,
} from "./ponte-operacao-worker.ts";

export { JANELA_VAZAO_SEGUNDOS, LANCAMENTO_TRAVADO_MIN, LIMITE_SSW_POR_MINUTO, QUARENTENA_LOGIN_MIN, TETO_SSW_POR_MINUTO, vagasDeLancamento };

/** Falhas ANTES do submit (nada gravado) contam tentativa; na 3ª, a baixa vira `erro`. */
export const MAX_TENTATIVAS = 3;
export const LIMITE_PREPARAR_POR_RODADA = 50;

export type StatusFinal = "executado" | "ja_no_ssw" | "recusado" | "erro";

export interface FinalizarBaixa {
  status: StatusFinal;
  categoria: string | null;
  motivo: string;
  protocolo?: string | null;
  canal?: CanalBaixa | null;
}

export interface DevolverBaixa {
  categoria: string;
  motivo: string;
  /** true = falha que conta para MAX_TENTATIVAS (leitura do SSW, rede da evidência). */
  contarTentativa: boolean;
}

export interface AuditBaixa {
  baixa_id: string;
  idempotency_key: string;
  request_payload: Record<string, unknown>;
  response_payload: Record<string, unknown>;
  status: "success" | "failed";
  external_id: string | null;
}

export interface FatosDuplicidadeBaixa {
  /** Outra baixa de ENTREGA deste CTRC que já terminou executado/ja_no_ssw. */
  entregaFeitaPor: string | null;
  /** Outra baixa deste CTRC reservada agora (lancando). */
  emVooPor: string | null;
}

export interface RepoWorkerBaixas {
  flagLigada(key: string): Promise<boolean>;
  /** baixa_motorista_config.canal; null = sem canal (nada vai ao SSW). Erro → null. */
  canal(): Promise<CanalBaixa | null>;
  /** RPC: prazo vencido e lançamento travado → erro. Devolve quantas. */
  expirar(travadoMin: number): Promise<number>;
  paraPreparar(limite: number): Promise<BaixaRow[]>;
  /** Lista de piloto (base e/ou motorista). Erro → false (fail-closed). */
  noPiloto(base: string | null, motoristaId: string): Promise<boolean>;
  /** Lista fechada de insucesso. Erro → false (fail-closed). */
  codigoInsucessoPermitido(codigo: number): Promise<boolean>;
  marcarNaFila(baixaId: string): Promise<void>;
  /** Só finaliza baixa ainda não final. */
  finalizar(baixaId: string, f: FinalizarBaixa): Promise<void>;
  /** RPC com advisory lock: reserva até as vagas da janela (contagem global). */
  reservar(limitePorMinuto: number, quarentenaMin: number): Promise<BaixaRow[]>;
  /** lancando → na_fila, guardando a última falha (a de login liga a quarentena). */
  devolverParaFila(baixaId: string, d: DevolverBaixa): Promise<void>;
  /** Algum card do CTRC em EXECUTANDO_ACAO (o executor está lançando agora). Lança em erro. */
  relacionamentoExecutandoNoCtrc(ctrc: string): Promise<boolean>;
  /** Lança em erro → não lança (dúvida). */
  duplicidade(b: BaixaRow): Promise<FatosDuplicidadeBaixa>;
  registrarAudit(a: AuditBaixa): Promise<void>;
}

export interface DepsWorkerBaixas {
  repo: RepoWorkerBaixas;
  baixarEvidencia(id: string): Promise<ResultadoDownload>;
  /** O ENVELOPE (`lancarSswBaixa`) — a única porta para o SSW. */
  lancar(args: { canal: CanalBaixa; baixa: BaixaParaSsw; evidencia: AnexoBytes | null }): Promise<LancarSswBaixaResult>;
  limitePorMinuto?: number;
}

export interface ResumoWorkerBaixas {
  skipped: string | null;
  expiradas: number;
  preparadas: number;
  recusadas_preparo: number;
  reservadas: number;
  executadas: number;
  ja_no_ssw: number;
  recusadas: number;
  erros_ssw: number;
  devolvidas: number;
  quarentena: boolean;
  erros: string[];
}

// ── peças puras ──────────────────────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Limite do f6 ("Informações complementares") da opção 101: é o que o setor lê no histórico. */
export const LIMITE_F6 = 70;

/**
 * Pura: o texto que vai ao SSW (≤ 500; o portal ainda sanitiza para latin-1).
 * O portal põe os primeiros 70 caracteres no f6 (o que o setor lê na coluna do
 * histórico) e, passando de 70, o texto inteiro na observação (`observ`). Por isso o
 * fato vem primeiro: quem recebeu, ou — no insucesso — o que o MOTORISTA escreveu
 * (`texto`), e só depois a origem.
 */
export function montarTextoBaixa(b: Pick<
  BaixaRow,
  | "baixa_id" | "tipo" | "codigo_ocorrencia" | "recebedor_nome" | "recebedor_documento" | "motorista_nome"
  | "rota_placa" | "rota_id" | "geo_lat" | "geo_lng" | "geo_precisao_m" | "base" | "texto"
>): string {
  const partes: string[] = [];
  if (b.tipo === "entrega") {
    partes.push(
      b.recebedor_nome
        ? `ENTREGUE A ${b.recebedor_nome}${b.recebedor_documento ? ` DOC ${b.recebedor_documento}` : ""}`
        : "ENTREGUE (RECEBEDOR NAO INFORMADO)",
    );
  } else if (b.texto) {
    partes.push(b.texto);
    partes.push(`INSUCESSO (OC ${pad2(b.codigo_ocorrencia)}) RELATADO PELO MOTORISTA`);
  } else {
    partes.push(`INSUCESSO NA ENTREGA (OC ${pad2(b.codigo_ocorrencia)}) RELATADO PELO MOTORISTA`);
  }
  partes.push(`MOTORISTA ${b.motorista_nome}${b.rota_placa ? ` PLACA ${b.rota_placa}` : ""} ROTA ${b.rota_id}${b.base ? ` BASE ${b.base}` : ""}`);
  if (b.geo_lat !== null && b.geo_lng !== null) {
    partes.push(`GPS ${b.geo_lat.toFixed(5)},${b.geo_lng.toFixed(5)}${b.geo_precisao_m !== null ? ` +-${Math.round(b.geo_precisao_m)}m` : ""}`);
  }
  partes.push(`BAIXA PELO APP DO ROTEIRIZADOR ${b.baixa_id.slice(0, 8)}`);
  return partes.join(" | ").slice(0, 500);
}

export function paraSsw(b: BaixaRow): BaixaParaSsw {
  return {
    baixaId: b.baixa_id,
    tipo: b.tipo,
    codigo: b.codigo_ocorrencia,
    ctrc: b.ctrc,
    nf: b.nf,
    ocorridoEm: b.ocorrido_em,
    texto: montarTextoBaixa(b),
  };
}

/**
 * Pura: a ordem de lançamento dentro da rodada — insucesso antes de entrega (o
 * insucesso precisa entrar antes de a 01 encerrar o CTRC), depois a hora real do
 * evento e a ordem de chegada. A RPC já devolve assim; isto não depende dela.
 */
export function ordenarParaLancar<T extends Pick<BaixaRow, "tipo" | "ocorrido_em" | "seq">>(baixas: T[]): T[] {
  return [...baixas].sort((a, b) =>
    Number(b.tipo === "insucesso") - Number(a.tipo === "insucesso") ||
    Date.parse(a.ocorrido_em) - Date.parse(b.ocorrido_em) ||
    a.seq - b.seq
  );
}

export type Interpretacao =
  | { acao: "finalizar"; f: FinalizarBaixa }
  | { acao: "devolver"; d: DevolverBaixa; quarentena: boolean; pararRodada: boolean };

/**
 * Pura: resultado do envelope → destino da baixa.
 *   - executado / ja_no_ssw → final;
 *   - recusa de mérito (tripé, CTRC/NF divergentes, nota encerrada, sem dados) → recusado;
 *   - login recusado → volta à fila, QUARENTENA de 30 min, para a rodada (INV-159 d);
 *   - credencial mal configurada → volta à fila sem gastar tentativa, para a rodada;
 *   - leitura falhou antes do submit → volta à fila (conta tentativa; na 3ª, erro);
 *   - o SSW recusou o submit, ou caiu NO MEIO → `erro`. Nunca relança às cegas.
 */
export function interpretarResultado(r: LancarSswBaixaResult, b: Pick<BaixaRow, "tentativas">, canal: CanalBaixa): Interpretacao {
  if (r.ok) {
    return r.resultado === "executado"
      ? { acao: "finalizar", f: { status: "executado", categoria: null, motivo: `lançada no SSW (${canal}): ${r.protocolo}`.slice(0, 500), protocolo: r.protocolo, canal } }
      : { acao: "finalizar", f: { status: "ja_no_ssw", categoria: "ja_no_ssw", motivo: r.motivo, canal } };
  }
  switch (r.categoria) {
    case "guard_tripe":
    case "ctrc_nf_divergente":
    case "nota_encerrada":
    case "webapi_sem_dados":
    case "entrada_invalida":
      return { acao: "finalizar", f: { status: "recusado", categoria: r.categoria, motivo: r.motivo, canal } };
    case "sessao_invalida":
      return { acao: "devolver", d: { categoria: "sessao_invalida", motivo: r.motivo, contarTentativa: false }, quarentena: true, pararRodada: true };
    case "credencial":
      return { acao: "devolver", d: { categoria: "credencial", motivo: r.motivo, contarTentativa: false }, quarentena: false, pararRodada: true };
    case "leitura_ssw":
      if (b.tentativas + 1 >= MAX_TENTATIVAS) {
        return { acao: "finalizar", f: { status: "erro", categoria: "leitura_ssw", motivo: `desistiu após ${MAX_TENTATIVAS} tentativas sem gravar nada: ${r.motivo}`.slice(0, 500), canal } };
      }
      return { acao: "devolver", d: { categoria: "leitura_ssw", motivo: r.motivo, contarTentativa: true }, quarentena: false, pararRodada: false };
    case "ssw_recusou":
      return { acao: "finalizar", f: { status: "erro", categoria: "ssw_recusou", motivo: `o SSW recusou o lançamento: ${r.motivo}`.slice(0, 500), canal } };
    case "interrompido":
    default:
      return {
        acao: "finalizar",
        f: { status: "erro", categoria: "lancamento_interrompido", motivo: `lançamento interrompido: conferir no SSW antes de lançar de novo (${r.motivo})`.slice(0, 500), canal },
      };
  }
}

// ── laço ─────────────────────────────────────────────────────────────────────

/** Freio de emergência: true = pode lançar. Lido IMEDIATAMENTE antes de cada ida ao SSW. */
export async function freioLiberado(repo: Pick<RepoWorkerBaixas, "flagLigada">): Promise<boolean> {
  return await repo.flagLigada(FLAG_BAIXA_LANCAR_SSW);
}

const msgDe = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function devolverOuDesistir(repo: RepoWorkerBaixas, b: BaixaRow, d: DevolverBaixa, resumo: ResumoWorkerBaixas): Promise<void> {
  if (d.contarTentativa && b.tentativas + 1 >= MAX_TENTATIVAS) {
    await repo.finalizar(b.baixa_id, { status: "erro", categoria: d.categoria, motivo: `desistiu após ${MAX_TENTATIVAS} tentativas sem gravar nada: ${d.motivo}`.slice(0, 500) });
    resumo.erros_ssw++;
    return;
  }
  await repo.devolverParaFila(b.baixa_id, d);
  resumo.devolvidas++;
}

async function devolverResto(repo: RepoWorkerBaixas, resto: BaixaRow[], d: DevolverBaixa, resumo: ResumoWorkerBaixas) {
  for (const x of resto) {
    try {
      await repo.devolverParaFila(x.baixa_id, d);
      resumo.devolvidas++;
    } catch (e) {
      resumo.erros.push(`devolver ${x.baixa_id}: ${msgDe(e)}`);
    }
  }
}

export async function rodarWorkerBaixas(deps: DepsWorkerBaixas): Promise<ResumoWorkerBaixas> {
  const { repo } = deps;
  const resumo: ResumoWorkerBaixas = {
    skipped: null, expiradas: 0, preparadas: 0, recusadas_preparo: 0, reservadas: 0, executadas: 0, ja_no_ssw: 0,
    recusadas: 0, erros_ssw: 0, devolvidas: 0, quarentena: false, erros: [],
  };
  if (!(await repo.flagLigada(FLAG_BAIXA_RECEBER))) {
    resumo.skipped = "flag_off";
    return resumo;
  }

  // 0. prazos
  try {
    resumo.expiradas = await repo.expirar(LANCAMENTO_TRAVADO_MIN);
  } catch (e) {
    resumo.erros.push(`expirar: ${msgDe(e)}`);
  }

  // Freio no começo: só decide se a rodada mexe na fila. É relido antes de cada lançamento.
  if (!(await repo.flagLigada(FLAG_BAIXA_LANCAR_SSW))) {
    resumo.skipped = "lancar_ssw_off";
    return resumo;
  }
  const canal = await repo.canal();
  if (!canal) {
    resumo.skipped = "sem_canal";
    resumo.erros.push("baixa_motorista_config.canal não configurado (webapi | portal101): nada vai ao SSW");
    return resumo;
  }

  // A. preparar (sem SSW)
  for (const b of await repo.paraPreparar(LIMITE_PREPARAR_POR_RODADA)) {
    try {
      if (!(await repo.noPiloto(b.base, b.motorista_id))) {
        await repo.finalizar(b.baixa_id, { status: "recusado", categoria: "fora_do_piloto", motivo: `a base ${b.base ?? "(sem base)"} / motorista ${b.motorista_nome} não está no piloto da baixa pelo app: lançar à mão` });
        resumo.recusadas_preparo++;
        continue;
      }
      if (b.tipo === "insucesso" && !(await repo.codigoInsucessoPermitido(b.codigo_ocorrencia))) {
        await repo.finalizar(b.baixa_id, { status: "recusado", categoria: "codigo_saiu_da_lista", motivo: `a oc ${pad2(b.codigo_ocorrencia)} saiu da lista de insucesso antes do lançamento` });
        resumo.recusadas_preparo++;
        continue;
      }
      await repo.marcarNaFila(b.baixa_id);
      resumo.preparadas++;
    } catch (e) {
      resumo.erros.push(`preparar ${b.baixa_id}: ${msgDe(e)}`);
    }
  }

  // B. SSW — vazão no banco, uma por vez, sempre pelo envelope.
  const reservadas = ordenarParaLancar(await repo.reservar(deps.limitePorMinuto ?? LIMITE_SSW_POR_MINUTO, QUARENTENA_LOGIN_MIN));
  resumo.reservadas = reservadas.length;
  for (let i = 0; i < reservadas.length; i++) {
    const b = reservadas[i]!;
    try {
      // cerca no banco (dúvida = não lança agora)
      let fatos: FatosDuplicidadeBaixa;
      let executando: boolean;
      try {
        fatos = await repo.duplicidade(b);
        executando = await repo.relacionamentoExecutandoNoCtrc(b.ctrc);
      } catch (e) {
        await devolverOuDesistir(repo, b, { categoria: "nao_conferiu_duplicidade", motivo: `não deu para conferir duplicidade: ${msgDe(e)}`, contarTentativa: true }, resumo);
        continue;
      }
      if (b.tipo === "entrega" && fatos.entregaFeitaPor) {
        await repo.finalizar(b.baixa_id, { status: "ja_no_ssw", categoria: "entrega_de_outra_baixa", motivo: `a 01 deste CTRC já foi feita pela baixa ${fatos.entregaFeitaPor}; nada foi gravado` });
        resumo.ja_no_ssw++;
        continue;
      }
      if (fatos.emVooPor || executando) {
        await repo.devolverParaFila(b.baixa_id, {
          categoria: fatos.emVooPor ? "outra_baixa_em_voo" : "relacionamento_executando",
          motivo: fatos.emVooPor ? `a baixa ${fatos.emVooPor} deste CTRC está sendo lançada agora` : "o Relacionamento está lançando uma ocorrência neste CTRC agora",
          contarTentativa: false,
        });
        resumo.devolvidas++;
        continue;
      }
      if (b.tipo === "insucesso" && !(await repo.codigoInsucessoPermitido(b.codigo_ocorrencia))) {
        await repo.finalizar(b.baixa_id, { status: "recusado", categoria: "codigo_saiu_da_lista", motivo: `a oc ${pad2(b.codigo_ocorrencia)} saiu da lista de insucesso antes do lançamento` });
        resumo.recusadas++;
        continue;
      }

      // evidência: os bytes são os que o motorista mandou?
      let evidencia: AnexoBytes | null = null;
      if (b.evidencia_id && b.evidencia_sha256 && b.evidencia_mime) {
        const dl = await deps.baixarEvidencia(b.evidencia_id);
        if (!dl.ok) {
          if (dl.tipo === "transitorio") {
            await devolverOuDesistir(repo, b, { categoria: "evidencia_indisponivel", motivo: dl.motivo, contarTentativa: true }, resumo);
          } else {
            await repo.finalizar(b.baixa_id, { status: "recusado", categoria: "evidencia_indisponivel", motivo: dl.motivo });
            resumo.recusadas++;
          }
          continue;
        }
        const conf = await conferirEvidencia(dl, { sha256: b.evidencia_sha256, mime: b.evidencia_mime });
        if (!conf.ok) {
          await repo.finalizar(b.baixa_id, { status: "recusado", categoria: "evidencia_invalida", motivo: conf.motivo });
          resumo.recusadas++;
          continue;
        }
        evidencia = { bytes: dl.bytes, mimeType: b.evidencia_mime, filename: `baixa-${b.baixa_id.slice(0, 8)}.${b.evidencia_mime === "application/pdf" ? "pdf" : "jpg"}` };
      }

      // FREIO DE EMERGÊNCIA: relido antes de CADA ida ao SSW, dentro do laço.
      // Entre esta leitura e o deps.lancar() abaixo só se monta o texto.
      if (!(await freioLiberado(repo))) {
        await devolverResto(repo, reservadas.slice(i), { categoria: "freio", motivo: "lançamento no SSW desligado no meio da rodada", contarTentativa: false }, resumo);
        resumo.erros.push("baixa_motorista_lancar_ssw desligada no meio da rodada — reservadas voltaram para a fila");
        break;
      }
      const alvo = paraSsw(b);
      let r: LancarSswBaixaResult;
      try {
        r = await deps.lancar({ canal, baixa: alvo, evidencia });
      } catch (e) {
        r = { ok: false, categoria: "interrompido", fase: "submit", motivo: msgDe(e) };
      }
      const it = interpretarResultado(r, b, canal);
      if (it.acao === "finalizar") {
        await repo.finalizar(b.baixa_id, it.f);
        if (it.f.status === "executado") resumo.executadas++;
        else if (it.f.status === "ja_no_ssw") resumo.ja_no_ssw++;
        else if (it.f.status === "recusado") resumo.recusadas++;
        else resumo.erros_ssw++;
        try {
          await repo.registrarAudit({
            baixa_id: b.baixa_id,
            idempotency_key: `baixa_motorista:${b.baixa_id}`,
            request_payload: {
              origem: "baixa_motorista", baixa_id: b.baixa_id, canal, tipo: b.tipo, codigo_ssw: b.codigo_ocorrencia,
              ctrc: b.ctrc, nf: b.nf, ocorrido_em: b.ocorrido_em, texto: alvo.texto, base: b.base,
              motorista: { id: b.motorista_id, nome: b.motorista_nome }, evidencia_sha256: b.evidencia_sha256,
            },
            response_payload: { ok: r.ok, status: it.f.status, categoria: it.f.categoria, motivo: it.f.motivo, fase: r.ok ? null : r.fase },
            status: it.f.status === "executado" || it.f.status === "ja_no_ssw" ? "success" : "failed",
            external_id: it.f.protocolo ?? null,
          });
        } catch (e) {
          resumo.erros.push(`audit ${b.baixa_id}: ${msgDe(e)}`);
        }
        continue;
      }
      await devolverOuDesistir(repo, b, it.d, resumo);
      if (it.pararRodada) {
        // Login recusado (ou credencial errada): para aqui. As já reservadas voltam
        // para a fila e a RPC não reserva nada por QUARENTENA_LOGIN_MIN (INV-159 d).
        resumo.quarentena = it.quarentena;
        await devolverResto(repo, reservadas.slice(i + 1), { categoria: it.d.categoria, motivo: "rodada parada: " + it.d.motivo, contarTentativa: false }, resumo);
        break;
      }
    } catch (e) {
      // Erro inesperado DEPOIS da reserva: a baixa fica em `lancando` e a etapa 0
      // a transforma em `erro` (sem relançar às cegas).
      resumo.erros.push(`lancar ${b.baixa_id}: ${msgDe(e)}`);
    }
  }
  return resumo;
}

