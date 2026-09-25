// =============================================================================
// sync-roteirizador-ponte-core — laço do sync da ponte (ADR 0034), sem I/O
// próprio: cliente da ponte e repositório (banco) são injetados → testável.
//
//   1. lê o cursor;
//   2. GET /eventos?desde=cursor (até MAX_PAGINAS por rodada);
//   3. busca cards ATIVOS pelos CTRCs da página (1 query por lote);
//   4. rotearEvento() → 1 linha por (evento, CTRC) → registrarLinha (RPC
//      atômica: PK (evento_id, ctrc) + card_event na mesma transação);
//   5. cursor só avança se TODAS as linhas da página gravaram (reprocessar é
//      seguro: linha repetida volta 'repetido' e não grava nada);
//   6. anexa alertas pendentes a cards que apareceram depois.
// =============================================================================

import type { EventoPonte, RoteirizadorPonteClient } from "./roteirizador-ponte-client.ts";
import {
  ctrcsDoEvento,
  JANELA_ALERTA_PENDENTE_HORAS,
  type LinhaEvento,
  proximoCursor,
  rotearEvento,
} from "./roteirizador-eventos-rotear.ts";

export const MAX_PAGINAS_POR_RODADA = 10;
export const LIMITE_POR_PAGINA = 200;

export interface RepoPonte {
  lerCursor(): Promise<number>;
  gravarCursor(proximo: number): Promise<void>;
  registrarErro(mensagem: string): Promise<void>;
  /** CTRC normalizado → card_id do card ATIVO mais recente. */
  cardsAtivosPorCtrc(ctrcs: string[]): Promise<Map<string, string>>;
  /** 'repetido' ou a situação gravada. Lança em erro de banco. */
  registrarLinha(linha: LinhaEvento, evento: EventoPonte): Promise<string>;
  anexarPendentes(janelaHoras: number): Promise<number>;
}

export interface ResumoSyncPonte {
  cursor_inicial: number;
  cursor_final: number;
  paginas: number;
  eventos: number;
  linhas: number;
  aplicados: number;
  aguardando_card: number;
  sem_card: number;
  ignorados: number;
  repetidos: number;
  pendentes_anexados: number;
  erro: string | null;
}

export async function sincronizarEventosPonte(
  client: RoteirizadorPonteClient,
  repo: RepoPonte,
  opts: { maxPaginas?: number; limite?: number } = {},
): Promise<ResumoSyncPonte> {
  const maxPaginas = opts.maxPaginas ?? MAX_PAGINAS_POR_RODADA;
  const limite = opts.limite ?? LIMITE_POR_PAGINA;
  const inicial = await repo.lerCursor();
  const resumo: ResumoSyncPonte = {
    cursor_inicial: inicial, cursor_final: inicial, paginas: 0, eventos: 0, linhas: 0,
    aplicados: 0, aguardando_card: 0, sem_card: 0, ignorados: 0, repetidos: 0,
    pendentes_anexados: 0, erro: null,
  };
  let cursor = inicial;

  for (let p = 0; p < maxPaginas; p++) {
    const r = await client.listarEventos(cursor, limite);
    if (!r.ok) {
      resumo.erro = `${r.erro.tipo}: ${r.erro.mensagem}`;
      break;
    }
    resumo.paginas++;
    const { eventos } = r.dados;
    resumo.eventos += eventos.length;

    let todasGravadas = true;
    if (eventos.length > 0) {
      const ctrcs = [...new Set(eventos.flatMap((e) => ctrcsDoEvento(e)))];
      const cards = ctrcs.length > 0 ? await repo.cardsAtivosPorCtrc(ctrcs) : new Map<string, string>();
      // Ordem de id garante que o log de erro aponta o primeiro evento problemático.
      for (const ev of [...eventos].sort((a, b) => a.id - b.id)) {
        for (const linha of rotearEvento(ev, cards)) {
          try {
            const sit = await repo.registrarLinha(linha, ev);
            resumo.linhas++;
            if (sit === "repetido") resumo.repetidos++;
            else if (sit === "aplicado") resumo.aplicados++;
            else if (sit === "aguardando_card") resumo.aguardando_card++;
            else if (sit === "sem_card") resumo.sem_card++;
            else resumo.ignorados++;
          } catch (e) {
            todasGravadas = false;
            resumo.erro = `evento ${ev.id} ctrc ${linha.ctrc || "-"}: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
      }
    }

    const anterior = cursor;
    const novo = proximoCursor(anterior, r.dados, todasGravadas);
    if (novo !== anterior) {
      await repo.gravarCursor(novo);
      cursor = novo;
    }
    resumo.cursor_final = cursor;
    // Para: erro de gravação, página vazia, ou a ponte não andou (fim do fluxo).
    if (!todasGravadas || eventos.length === 0 || novo === anterior) break;
  }

  try {
    resumo.pendentes_anexados = await repo.anexarPendentes(JANELA_ALERTA_PENDENTE_HORAS);
  } catch (e) {
    resumo.erro ??= `anexar pendentes: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (resumo.erro) {
    try { await repo.registrarErro(resumo.erro); } catch { /* best-effort */ }
  }
  return resumo;
}
