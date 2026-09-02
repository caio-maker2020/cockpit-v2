// =============================================================================
// escada-indenizacao — REGRA ANTI-VETO R4 (playbook 02/09).
//
// Vetos-âncora: NF 51096 (armou 56; certo: 59+e-mail pedindo docs), NF 67975
// (armou aguardar; certo: só o e-mail — a 59 já estava lançada), NF 1508990
// (armou 59+e-mail DE NOVO; certo: 33 — os docs já tinham chegado).
//
// A ESCADA (Duilio p9, confirmada): faltante/avaria →
//   (1) sem 59 no ciclo → 59 + e-mail pedindo os documentos;
//   (2) 59 lançada SEM e-mail depois → só o e-mail na thread (nunca relançar);
//   (3) documentos completos (dossiê) → 33 formaliza o ressarcimento.
//
// Documentos (Duilio p9): EXTRAVIO = romaneio de coleta + descritivo + valor
// do item; AVARIA = os mesmos + se possível imagem da avaria. NF não entra.
//
// Exceção romaneio-interno (p13, verificada em cliente_config): PRATI/Würth/
// Black&Decker — a Sal busca o romaneio na própria plataforma; o e-mail pede
// SÓ descritivo + valor.
//
// Itens da 33 com muitos volumes: print JPEG anexado (decisão Caio 02/09),
// nunca texto espremido nos 500 chars — implementado no fluxo da 33 (gate-33
// continua sendo a trava; a 33 é sempre aprovada pelo operador).
// =============================================================================

const OCS_EXTRAVIO_CICLO: ReadonlySet<number> = new Set([6, 9, 16, 31]);

export type DegrauIndenizacao =
  | { degrau: "pedir_docs_59"; corpo_email: string; tipo: "extravio" | "avaria" }
  | { degrau: "so_email_docs"; corpo_email: string; tipo: "extravio" | "avaria" }
  | { degrau: "formalizar_33" };

/** Contexto de indenização? (extravio no ciclo, card em 59, ou faltante na entrega) */
export function ehContextoIndenizacao(
  historico: ReadonlyArray<{ codigo: number | null }>,
  ocCard: number | null,
): boolean {
  if (ocCard === 59) return true;
  return historico.some((o) => OCS_EXTRAVIO_CICLO.has(o.codigo ?? -1));
}

/** O caso é avaria (não extravio)? — oc 8 ou keyword no histórico. */
export function ehCasoAvaria(
  historico: ReadonlyArray<{ codigo: number | null; instrucao: string | null }>,
): boolean {
  return historico.some((o) => o.codigo === 8 || /AVARIA/i.test(o.instrucao ?? ""));
}

/** Corpo do e-mail pedindo os documentos — lista do Duilio (p9). */
export function corpoEmailDocs(opts: {
  tipo: "extravio" | "avaria";
  romaneioInterno: boolean;
}): string {
  const docs: string[] = [];
  if (!opts.romaneioInterno) docs.push("romaneio de coleta");
  docs.push("descritivo do(s) item(ns)", "valor do(s) item(ns)");
  if (opts.tipo === "avaria") docs.push("se possível, imagem da avaria");
  const lista = docs.map((d) => `- ${d}`).join("\n");
  return (
    `Prezado(a),\n\n` +
    `Para darmos andamento ao processo de ${opts.tipo === "avaria" ? "ressarcimento da avaria" : "indenização"} ` +
    `da NF em assunto, precisamos dos seguintes documentos/informações:\n\n${lista}\n\n` +
    `Assim que recebermos, seguimos imediatamente com a formalização.\n\nFicamos no aguardo.`
  );
}

/** Decide o degrau da escada. `null` = fora do contexto ou nada a mudar.
 *  Entradas verificáveis pelo caller:
 *  - dossieCompleto: as 3 evidências (romaneio+descritivo+valor) já chegaram;
 *  - houve59NoCiclo / emailEnviadoAposUltima59: do histórico + card_events. */
export function decidirDegrauIndenizacao(opts: {
  historico: ReadonlyArray<{ codigo: number | null; instrucao: string | null }>;
  ocCard: number | null;
  ocSugerida: number | null;
  dossieCompleto: boolean;
  houve59NoCiclo: boolean;
  emailEnviadoAposUltima59: boolean | null;
  romaneioInterno: boolean;
}): DegrauIndenizacao | null {
  if (!ehContextoIndenizacao(opts.historico, opts.ocCard)) return null;
  const tipo = ehCasoAvaria(opts.historico) ? "avaria" as const : "extravio" as const;

  // (3) docs completos → 33 formaliza (gate-33 valida o dossiê; operador aprova).
  if (opts.dossieCompleto && (opts.ocSugerida === 59 || opts.ocSugerida === 54)) {
    return { degrau: "formalizar_33" };
  }
  // (2) 59 lançada e o e-mail nunca saiu → só o e-mail (âncora NF 67975).
  if (
    opts.houve59NoCiclo && opts.emailEnviadoAposUltima59 === false &&
    opts.ocSugerida === 59
  ) {
    return { degrau: "so_email_docs", corpo_email: corpoEmailDocs({ tipo, romaneioInterno: opts.romaneioInterno }), tipo };
  }
  // (1) faltante sem 59 e o fluxo indo pra 56 → 59 + e-mail docs (âncora NF 51096).
  if (!opts.houve59NoCiclo && opts.ocSugerida === 56) {
    return { degrau: "pedir_docs_59", corpo_email: corpoEmailDocs({ tipo, romaneioInterno: opts.romaneioInterno }), tipo };
  }
  return null;
}
