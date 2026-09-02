// =============================================================================
// oc49-casos-time — os casos da 49 ensinados pelo TIME via feedback obrigatório
// e validados pelo Caio em 31/08 (respostas oficiais na memória
// regras-caio-agente-49-respostas). REGRA-MESTRA: tudo POR CICLO; exceção
// única = contagem de tentativas (oc 14) no histórico INTEIRO.
//
//   P1 "3 TENTATIVAS": confirma por ≥3 ocorrências 14 (saída pra entrega) no
//      histórico — a régua mais certeira, palavra do Caio. Confirmado → 54 +
//      template TENTATIVAS_ESGOTADAS; NÃO confirmado → 55 informando que não
//      foi a 3ª tentativa.
//   P2 "CUSTO EXTRA/DEDICADO": 54 + template CUSTO_ENTREGA_DEDICADO com o
//      valor extraído. EXCEÇÃO ABSOLUTA: OVD (raiz 76635689) e FERRAMENTAS
//      GERAIS (raiz 92664028) NUNCA recebem pedido de custo — destaque vira
//      55 (seguir sem cobrança). Cobrança indevida nos demais = operador
//      escolhe 55 e o painel exige o motivo (front).
//   P4 "COBRANDO RETORNO": regex ampliado; trilho 59 = e-mail PROIBIDO
//      (relança 59 muda); trilho 54 = cobrar na MESMA thread (caso existente).
//
// Funções puras (deno test). O agente cola o resto (DB/ciclo).
// =============================================================================

/** OVD + Ferramentas Gerais por RAIZ de CNPJ (cobre todas as filiais). */
export const RAIZES_SEM_CUSTO_EXTRA: ReadonlySet<string> = new Set([
  "76635689", // O.V.D. IMPORTADORA E DISTRIBUIDORA
  "92664028", // FERRAMENTAS GERAIS
]);

export function clienteIsentoCustoExtra(cnpj: string | null | undefined): boolean {
  const dig = (cnpj ?? "").replace(/\D/g, "").padStart(14, "0");
  return dig.length === 14 && RAIZES_SEM_CUSTO_EXTRA.has(dig.slice(0, 8));
}

/** P1: a 49 fala de tentativas esgotadas? */
export function ehCasoTresTentativas(instrucao49: string): boolean {
  return /\b(3|TR[EÊ]S|TERCEIRA)\s+TENTATIVAS?\b|TENTATIVAS\s+ESGOTADAS/i.test(instrucao49);
}

/** P1: régua do Caio — conta ocorrências 14 (saída pra entrega) no histórico
 *  INTEIRO (exceção deliberada à regra de ciclo). */
export function contarSaidasParaEntrega(
  ocorrencias: ReadonlyArray<{ codigo: number | null }>,
): number {
  return ocorrencias.filter((o) => o.codigo === 14).length;
}

/** P2: a 49 fala de custo extra/dedicado? */
export function ehCasoCustoExtra(instrucao49: string): boolean {
  return /DEDICADO|CUSTO\s+(ADICIONAL|EXTRA)|VE[IÍ]CULO\s+EXCLUSIVO|CARRO\s+EXCLUSIVO|TAXA\s+DE\s+DIFICULDADE|\bTDE\b/i.test(instrucao49);
}

/** P2: extrai o valor monetário da 49 ("CARRO DEDICADO 350,00" / "R$ 420"). */
export function extrairValorCusto(instrucao49: string): string | null {
  const m = instrucao49.match(/R?\$?\s*(\d{1,3}(?:\.\d{3})*(?:,\d{2})|\d+,\d{2}|\d{2,5}(?:[.,]\d{2})?)(?!\d)/);
  if (!m) return null;
  const v = m[1]!;
  // descarta capturas que são claramente não-valor (ex.: "3" de 3 tentativas)
  if (!/[,.]/.test(v) && v.length < 2) return null;
  return v;
}

/** P4: unidade cobrando retorno — fraseados reais do time (MARIA/KAROLINE)
 *  além dos originais do caso cobranca_retorno. */
export function ehCobrancaDeRetornoAmpliada(instrucao49: string): boolean {
  return /FALTA\s+DE\s+RETORNO|CARGA\s+PARADA|DEMORA\s+NA\s+TRATATIVA|SEM\s+RETORNO|COBRAN(?:DO|[CÇ]A).{0,25}RETORNO|COMO\s+PROCEDER|POSICIONAMENTO\s+(?:DO|DA|SOBRE)|AGUARDA(?:NDO)?\s+POSI[CÇ][AÃ]O/i.test(instrucao49);
}

// =============================================================================
// REGRA ANTI-VETO R1 — ACAREAÇÃO → oc 41 (playbook de vetos, Caio+Duilio 02/09).
// Vetos-âncora: NFs 602839 e 1505043 (FELIPE) — robô armava 59+e-mail/aguardar;
// o certo é 41 com texto fixo. Duilio (p1-p3): texto = "Realizar acareação";
// pedido chega pela 49 da equipe de ressarcimento (extravio total antes do
// veredito, ou assinatura não reconhecida); o desfecho volta da base como
// oc 01/19/49 — o card segue o ciclo normal vigiando isso.
// DECISÃO CAIO 02/09: a 41 nasce FORA do trilho autônomo (não está na escada
// acoes_autonomas_veto_config → cerca acao_inativa_na_escada barra) — o
// operador aprova. Sem re-cobrança automática por ora (decisão 1).
// =============================================================================

/** R1: a 49 pede acareação? (keyword cobre ACAREACAO/ACAREAÇÃO/ACAREAR) */
export function ehCasoAcareacao(instrucao49: string): boolean {
  return /ACAREA/i.test(instrucao49);
}

/** R1: texto exato da oc 41, palavra do Duilio (p1). */
export const TEXTO_OC41_ACAREACAO = "Realizar acareação";
