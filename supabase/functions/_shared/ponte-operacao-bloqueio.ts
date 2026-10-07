// =============================================================================
// ponte-operacao-bloqueio — a regra de `bloqueiaEntrega` (ADR 0039, D3).
//
// Pergunta que a regra responde, e SÓ ela: "o Relacionamento tem uma tratativa
// ABERTA nesta nota cujo desfecho pode mudar a entrega?" Se sim, entregar antes
// de ela fechar arrisca viagem perdida (endereço, recusa, cliente que pediu para
// segurar) ou entrega indevida (extravio, devolução).
//
// O que a regra NÃO faz: tirar nota do plano. O Roteirizador só MOSTRA a
// informação no painel; tirar do plano é decisão do operador (contrato v2, A).
// Por isso, na dúvida, a regra BLOQUEIA: um falso "bloqueia" custa um olhar do
// operador; um falso "libera" custa uma viagem.
//
// Entradas: `cards.state`, `estado_tratativa.situacao`, `estado_tratativa.aguardando`
// e, para dizer DE QUEM é a última ocorrência, `cards.cod_ultima_ocorrencia` +
// `ocorrencias_dicionario.responsabilidade` (fonte única, mig 204).
//
// Ordem (a primeira que casa decide):
//   R0 terminal (RESOLVIDO/CANCELADO/TRANSFERIDO)            → não bloqueia
//   R1 EXTRAVIO_MONITORADO ou última oc ∈ {6,9,16}            → bloqueia
//   R2 aguardando o cliente (state, situacao ou aguardando)   → bloqueia
//   R3 EXECUTANDO_ACAO                                         → bloqueia
//   R4 card de rastreamento (o cliente só cobrou a entrega)    → não bloqueia
//   R5 última oc é da Operação (21, 55, 13…)                   → não bloqueia
//   R6 qualquer outro card ativo                               → bloqueia
//
// Todo motivo termina com a data em que a tratativa abriu (card.created_at).
// Este arquivo é PURO: deno test.
// =============================================================================

import { dataBrSaoPaulo, ehTerminal } from "./ponte-operacao-comum.ts";

/** Ocorrências de extravio no SSW (iguais a EXTRAVIO_OCS / INV-017). */
export const OCS_EXTRAVIO: ReadonlySet<number> = new Set([6, 9, 16]);

export interface EntradaBloqueio {
  state: string;
  tipo: string | null;
  situacao: string | null;
  aguardandoQuem: string | null;
  aguardandoDesde: string | null;
  codUltimaOcorrencia: number | null;
  /** `ocorrencias_dicionario` da última oc; null = desconhecida (lookup falhou ou código fora do dicionário). */
  ocDicionario: { descricao: string; responsabilidade: string } | null;
  /** cards.created_at — a data em que a tratativa abriu. */
  tratativaDesde: string | null;
}

export type RegraBloqueio = "R0" | "R1" | "R2" | "R3" | "R4" | "R5" | "R6";

export interface ResultadoBloqueio {
  bloqueiaEntrega: boolean;
  motivoBloqueio: string | null;
  regra: RegraBloqueio;
}

function descOc(e: EntradaBloqueio): string {
  if (e.codUltimaOcorrencia === null) return "sem ocorrência registrada";
  const d = e.ocDicionario?.descricao?.trim();
  return d ? `oc ${e.codUltimaOcorrencia} — ${d}` : `oc ${e.codUltimaOcorrencia}`;
}

function comData(motivo: string, e: EntradaBloqueio): string {
  const d = dataBrSaoPaulo(e.tratativaDesde);
  return d ? `${motivo}. Tratativa aberta em ${d}.` : `${motivo}.`;
}

function desde(e: EntradaBloqueio): string {
  const d = dataBrSaoPaulo(e.aguardandoDesde);
  return d ? ` desde ${d}` : "";
}

export function decidirBloqueioEntrega(e: EntradaBloqueio): ResultadoBloqueio {
  // R0 — o Relacionamento já encerrou (ou passou a outra área que não é do Cockpit).
  if (ehTerminal(e.state)) {
    return { bloqueiaEntrega: false, motivoBloqueio: null, regra: "R0" };
  }

  // R1 — extravio: a carga não foi localizada. Entregar é, no mínimo, contraditório.
  if (e.state === "EXTRAVIO_MONITORADO" || (e.codUltimaOcorrencia !== null && OCS_EXTRAVIO.has(e.codUltimaOcorrencia))) {
    return {
      bloqueiaEntrega: true,
      motivoBloqueio: comData(`Extravio em monitoramento (${descOc(e)})`, e),
      regra: "R1",
    };
  }

  // R2 — o Relacionamento está esperando o cliente dizer o que fazer (oc 54/59).
  if (e.state === "AGUARDANDO_CLIENTE" || e.situacao === "aguardando_cliente" || e.aguardandoQuem === "cliente") {
    return {
      bloqueiaEntrega: true,
      motivoBloqueio: comData(`Aguardando retorno do cliente pagador${desde(e)} (${descOc(e)})`, e),
      regra: "R2",
    };
  }

  // R3 — uma ocorrência está sendo lançada no SSW agora; o desfecho ainda não existe.
  if (e.state === "EXECUTANDO_ACAO") {
    return {
      bloqueiaEntrega: true,
      motivoBloqueio: comData(`O Relacionamento está lançando uma ocorrência no SSW agora (${descOc(e)})`, e),
      regra: "R3",
    };
  }

  // R4 — card de rastreamento: o cliente quer que a nota chegue. Não é motivo para segurar.
  if (e.tipo === "rastreamento") {
    return { bloqueiaEntrega: false, motivoBloqueio: null, regra: "R4" };
  }

  // R5 — a última ocorrência é da Operação (reentrega combinada, seguir para
  // entrega…): a nota voltou ao fluxo normal. Vale inclusive para ACAO_EXECUTADA
  // (ex.: a 21 que o Relacionamento acabou de lançar libera a entrega).
  if (e.ocDicionario?.responsabilidade === "Operação") {
    return { bloqueiaEntrega: false, motivoBloqueio: null, regra: "R5" };
  }

  // R6 — tratativa aberta com ocorrência do Relacionamento, Cliente, Perdas,
  // Ressarcimento, Devolução ou Agendamento — ou desconhecida (fail-safe).
  let motivo: string;
  if (e.state === "ACAO_EXECUTADA" || e.state === "AGUARDANDO_TERCEIRO" || e.situacao === "aguardando_area_interna") {
    motivo = `Ação do Relacionamento lançada no SSW, aguardando confirmação (${descOc(e)})`;
  } else if (e.situacao === "acao_agendada") {
    motivo = `Ação do Relacionamento agendada no trilho de veto (${descOc(e)})`;
  } else if (e.state === "AGUARDANDO_VALIDACAO_HUMANA" || e.situacao === "pronto_para_acao" || e.aguardandoQuem === "operador") {
    motivo = `Tratativa aberta no Relacionamento, aguardando decisão do operador${desde(e)} (${descOc(e)})`;
  } else {
    motivo = `Tratativa aberta no Relacionamento (${descOc(e)})`;
  }
  return { bloqueiaEntrega: true, motivoBloqueio: comData(motivo, e), regra: "R6" };
}
