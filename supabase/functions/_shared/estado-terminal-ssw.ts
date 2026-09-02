// =============================================================================
// estado-terminal-ssw — REGRA ANTI-VETO R6 (playbook 02/09).
//
// (a) Âncora NF 1034543 (LARISSA): "No SSW já está sinalizado como entrega
//     realizada" — e o robô armou 56. A checagem INV-022 roda no VENCIMENTO;
//     aqui a cerca roda na ARMAÇÃO, com o historico_ssw já em mãos (custo
//     zero): último andamento = entrega/baixa → não arma nada.
// (b) Âncora NF 70120 (ISABELY): "direcionado ao setor devoluções, precisa
//     esperar a movimentação". Sinal do Duilio (p12): oc 30 finalizando o
//     CT-e normal informando que o CT-e REVERSA foi emitido. Com devolução em
//     curso, não arma janela nenhuma — o card espera o setor.
// =============================================================================

/** Último andamento do histórico indica encerramento (entrega/baixa)? */
export function ultimaOcIndicaEncerramento(
  historico: ReadonlyArray<{ codigo: number | null; instrucao: string | null }>,
): boolean {
  const ult = historico[historico.length - 1];
  if (!ult) return false;
  if (ult.codigo === 1) return true; // entrega realizada
  return /ENTREGA\s+REALIZADA|MERCADORIA\s+ENTREGUE|BAIXAD[OA]/i.test(ult.instrucao ?? "");
}

/** Devolução em curso? (Duilio p12: oc 30 fechando o CT-e normal por causa da
 *  reversa, ou menção a CT-e/CTRC reversa emitido no histórico) */
export function devolucaoEmCurso(
  historico: ReadonlyArray<{ codigo: number | null; instrucao: string | null }>,
): boolean {
  for (let i = historico.length - 1; i >= 0; i--) {
    const o = historico[i]!;
    if (o.codigo === 30 && /REVERSA/i.test(o.instrucao ?? "")) return true;
    if (/CT-?E?\s+REVERSA|CTRC\s+REVERSA|REVERSA\s+(J[AÁ]\s+)?EMITID[OA]/i.test(o.instrucao ?? "")) return true;
  }
  return false;
}
