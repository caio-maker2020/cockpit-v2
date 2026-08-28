// =============================================================================
// agente-extravio-regras — regras PURAS do agente autônomo D+4 (PART 2).
// Testáveis sem I/O. A regra de segurança inviolável vive aqui (INV-020).
// =============================================================================

/** Ocorrências de extravio (responsabilidade Perdas). */
export const EXTRAVIO_OCS: ReadonlySet<number> = new Set([6, 9, 16]);

/**
 * REGRA DE SEGURANÇA INVIOLÁVEL (Caio 2026-06-24): o agente SÓ pode lançar a oc 49
 * se a ÚLTIMA ocorrência REAL no SSW ainda for de extravio (6/9/16) — ou seja,
 * NADA foi lançado depois do extravio. Qualquer outra oc → algo já aconteceu →
 * NÃO lança (vira AUTÔNOMO NÃO RODOU). `null` (SSW indisponível/sem oc) → também
 * NÃO lança (na dúvida, não age). Esta checagem roda ANTES de TODO lançamento.
 */
export function podeAgenteLancar49(ocRealSsw: number | null | undefined): boolean {
  return ocRealSsw != null && EXTRAVIO_OCS.has(ocRealSsw);
}

/** Caio 2026-08-28 (regra v2 da oc43, B4): última real = 43 (manutenção de
 *  perecível) com um EXTRAVIO imediatamente antes = LIMPO — a 43 não
 *  interrompe o trilho; o prazo de perdas segue contando do extravio original
 *  e a 49 do prazo pode ser lançada normalmente. */
export function podeAgenteLancar49PosManutencao(
  ocRealSsw: number | null | undefined,
  ocImediatamenteAnterior: number | null | undefined,
): boolean {
  if (podeAgenteLancar49(ocRealSsw)) return true;
  return ocRealSsw === 43 &&
    ocImediatamenteAnterior != null && EXTRAVIO_OCS.has(ocImediatamenteAnterior);
}

/**
 * Proposta lancar_49 que o agente RECRIA on-demand quando não há nenhuma pendente
 * (Caio 2026-06-26, NF 2053248): o operador escolheu o e-mail antes (email_sem_oc) →
 * a lancar_49 do lote foi auto-cancelada ("outra opção foi aprovada"). O extravio
 * SEGUE contando; no D+4 o agente recria a proposta e lança a 49 conforme a regra
 * normal. INVARIANTE: `enviar_email: false` (o cliente já foi notificado — nunca
 * duplica e-mail) + descricao "PRAZO DE PERDAS EXPIRADO" + meta.acao 'lancar_49'.
 */
export function montarPropostaLancar49(
  nf: string,
  cnpjRemetente: string | null,
): {
  tool: "lancar_oc_e_enviar_email";
  args: {
    nf: string;
    codigo_ssw: 49;
    cnpj_remetente: string | null;
    descricao: string;
    extras: { enviar_email: false; texto_descricao: string };
  };
  texto: null;
  rationale: string;
  meta: {
    acao: "lancar_49";
    modo: "sem_email";
    origem: "extravio_cockpit";
    tinha_intencao_email: false;
    recriada_pelo_agente: true;
  };
} {
  const DESC = "PRAZO DE PERDAS EXPIRADO";
  return {
    tool: "lancar_oc_e_enviar_email",
    args: {
      nf,
      codigo_ssw: 49,
      cnpj_remetente: cnpjRemetente,
      descricao: DESC,
      extras: { enviar_email: false, texto_descricao: DESC },
    },
    texto: null,
    rationale:
      "Extravio sem localização: lançar oc 49 (prazo de perdas expirado) → segue pra Relacionamento.",
    meta: {
      acao: "lancar_49",
      modo: "sem_email",
      origem: "extravio_cockpit",
      tinha_intencao_email: false,
      recriada_pelo_agente: true,
    },
  };
}
