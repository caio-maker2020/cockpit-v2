// =============================================================================
// wurth-intranet — núcleo PURO do robô da intranet Würth (Ingrid, 2026-08-11).
//
// Fonte: vídeos da Ingrid (11/08) + decisões do Caio:
//   • Consulta "Pendência na Transportadora": Incluídos E Tratadas Würth
//     preenchidos (01/01 do ano → hoje), Situação=Solucionado Würth.
//   • Tabela: Emp | Nota Fiscal | Data | CGC/CPF | Razão Social | Telefone |
//     Solução | Data Solução | Obs  (a coluna É a NF — confirmado nos frames).
//   • Solução "Reentrega" → sugerir oc 21 com a Obs (contato/horário/referência).
//   • Solução "Devolver a Würth" → sugerir oc 44 (modal padrão pede
//     volumes/base/motivo — o motivo vem da ressalva que já está no card).
//   • Obs com "envio de CCE" → a carta chega por E-MAIL novo; aqui só marca.
//   • Prefixo do CTRC decide o login: AMB/WTB → AMPLA (Betim); WTC/ARP → SAL
//     (Cotia). O robô SUGERE; a Ingrid aprova. Nunca lança sozinho.
//
// Fetch/login ficam no wurth-intranet-client; aqui só lógica testável.
// =============================================================================

export type LoginWurth = "sal" | "ampla";

/** AMB/WTB → ampla (Betim); WTC/ARP → sal (Cotia); outro → null. */
export function loginPorPrefixoCtrc(ctrc: string | null | undefined): LoginWurth | null {
  const p = (ctrc ?? "").trim().slice(0, 3).toUpperCase();
  if (p === "AMB" || p === "WTB") return "ampla";
  if (p === "WTC" || p === "ARP") return "sal";
  return null;
}

export interface LinhaRetornoWurth {
  emp: string;
  nf: string;
  data: string;
  cgc: string;
  razaoSocial: string;
  telefone: string;
  solucao: string;
  dataSolucao: string;
  obs: string;
}

/** Solução normalizada → efeito no Cockpit. */
export type EfeitoRetorno =
  | { tipo: "sugerir_21"; instrucao: string }
  | { tipo: "sugerir_44" }
  | { tipo: "aguardar_cce" }
  | { tipo: "ignorar"; motivo: string };

export function mapearEfeito(linha: Pick<LinhaRetornoWurth, "solucao" | "obs">): EfeitoRetorno {
  const obs = (linha.obs ?? "").trim();
  // CCE vence a Solução: a linha costuma vir como "Reentrega" + Obs "CCE
  // ENVIADA" — a sugestão de 21 nasce do E-MAIL da CCE (com o PDF), não daqui.
  if (/\bCCE\b/i.test(obs)) return { tipo: "aguardar_cce" };
  const sol = (linha.solucao ?? "").trim().toLowerCase();
  if (sol.includes("reentrega")) return { tipo: "sugerir_21", instrucao: obs };
  if (sol.includes("devolver")) return { tipo: "sugerir_44" };
  return { tipo: "ignorar", motivo: `solução não mapeada: "${linha.solucao}"` };
}

/**
 * Enxerta a instrução da intranet (Obs de uma Reentrega) numa proposta oc 21 QUE
 * JÁ EXISTE no menu do card, preservando o resto do payload (Caio 2026-08-12).
 *
 * Motivo: o card Würth nasce com o menu completo de ocs (21/33/44/54/55/56), então
 * a proposta dedicada do robô (`!jaTem`) nunca é criada e a instrução da Obs
 * ("reentregar horário comercial, BERENICE") ficava só no `ia_sugestao` do card,
 * SEM chegar ao SSW. O executor monta a Instrução do SSW a partir de
 * `args.descricao` (→ `montarDescricaoSsw`), por isso o enxerto vai ali. Só se
 * aplica à oc 21 (a 44 coleta volumes/motivo no modal). Idempotência é garantida
 * a montante pela dedupe (`wurth_retornos_processados`): só se chega aqui em
 * retorno novo.
 */
export function enxertarInstrucaoReentrega(
  propostaPayload: Record<string, unknown> | null | undefined,
  instrucao: string,
  linha: Pick<LinhaRetornoWurth, "solucao" | "dataSolucao" | "obs">,
): Record<string, unknown> {
  const pp = (propostaPayload ?? {}) as Record<string, unknown>;
  const argsAntigos = (pp["args"] as Record<string, unknown> | undefined) ?? {};
  const metaAntiga = (pp["meta"] as Record<string, unknown> | undefined) ?? {};
  const rationaleAntigo = typeof pp["rationale"] === "string" ? (pp["rationale"] as string) : "";
  return {
    ...pp,
    recomendada: true,
    texto: instrucao,
    args: {
      ...argsAntigos,
      descricao: `Reentrega autorizada pelo cliente via intranet Würth — ${instrucao}`,
    },
    rationale:
      (rationaleAntigo ? `${rationaleAntigo} · ` : "") +
      `Intranet Würth (${linha.dataSolucao}): ${linha.solucao}` +
      (linha.obs ? ` — ${linha.obs}` : ""),
    meta: {
      ...metaAntiga,
      origem: "robo-intranet-wurth",
      texto_ssw_sugerido: instrucao,
    },
  };
}

/** Chave de dedupe: linha nova da MESMA NF (ciclo novo) processa de novo. */
export function chaveDedupe(l: Pick<LinhaRetornoWurth, "nf" | "dataSolucao" | "solucao">): {
  nf: string;
  data_solucao: string;
  solucao: string;
} {
  return {
    nf: normalizarNfWurth(l.nf),
    data_solucao: (l.dataSolucao ?? "").trim(),
    solucao: (l.solucao ?? "").trim(),
  };
}

export function normalizarNfWurth(nf: string | null | undefined): string {
  return (nf ?? "").replace(/\D/g, "").replace(/^0+/, "");
}

/**
 * Parseia a tabela da consulta_devolucao POR CABEÇALHO (resiliente a coluna
 * extra/ordem). Aceita cabeçalhos parciais ("Nota", "Solução", "Obs"...).
 */
export function parseTabelaConsulta(html: string | null | undefined): LinhaRetornoWurth[] {
  if (!html) return [];
  const tabelas = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  for (const tabela of tabelas) {
    const linhas = tabela.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    if (linhas.length < 2) continue;
    const headers = celulas(linhas[0]!).map((h) => h.toLowerCase());
    const idxNf = headers.findIndex((h) => h.includes("nota"));
    const idxSol = headers.findIndex((h) => h === "solução" || h === "solucao" || h.startsWith("solu"));
    const idxObs = headers.findIndex((h) => h.startsWith("obs"));
    if (idxNf < 0 || idxSol < 0 || idxObs < 0) continue;
    const idxEmp = headers.findIndex((h) => h === "emp" || h.includes("filial"));
    // "Data Solução" vem DEPOIS de Solução; "Data" (inclusão) vem antes da NF
    const idxDataSol = headers.findIndex((h, i) => i > idxSol && h.includes("data"));
    const idxData = headers.findIndex((h) => h === "data");
    const idxCgc = headers.findIndex((h) => h.includes("cgc") || h.includes("cnpj") || h.includes("cpf"));
    const idxRazao = headers.findIndex((h) => h.includes("raz"));
    const idxTel = headers.findIndex((h) => h.includes("tel"));

    const out: LinhaRetornoWurth[] = [];
    for (const tr of linhas.slice(1)) {
      const c = celulas(tr);
      const nf = c[idxNf] ?? "";
      if (!/\d{3,}/.test(nf)) continue; // linha vazia/rodapé
      out.push({
        emp: pega(c, idxEmp),
        nf,
        data: pega(c, idxData),
        cgc: pega(c, idxCgc),
        razaoSocial: pega(c, idxRazao),
        telefone: pega(c, idxTel),
        solucao: pega(c, idxSol),
        dataSolucao: pega(c, idxDataSol),
        obs: pega(c, idxObs),
      });
    }
    if (out.length > 0) return out;
  }
  return [];
}

function pega(c: string[], i: number): string {
  return i >= 0 ? (c[i] ?? "") : "";
}

function celulas(tr: string): string[] {
  const tds = tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? [];
  return tds.map((td) =>
    td
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim()
  );
}
