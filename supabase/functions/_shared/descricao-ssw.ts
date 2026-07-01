// =============================================================================
// descricao-ssw.ts — monta o texto que vai pro SSW (campo Instrução/Complemento)
// a partir da descrição base + extras que a operadora preencheu na aprovação.
//
// REGRA RAIZ (Caio 2026-06-24 — bug NF 59299 / Larissa, oc=44 devolução):
//
//   O portal SSW tem 2 campos de texto na tela 101:
//     - f6  ("Informações complementares", maxlength=70) → é a coluna
//       "Instrução/Complemento" que o SETOR que recebe a oc (Devolução) LÊ.
//     - observ ("Instrução", textarea, maxlength=500) → backup completo.
//   `lancarOcorrenciaPortal` corta os primeiros 70 chars do texto pra f6.
//
//   Bug: a descrição base da oc=44 ("Cliente autorizou devolução — encaminha
//   pro setor de Devolução") tem ~61 chars. Quando a operadora informa
//   quantidade_volumes / motivo / filial, esses extras eram CONCATENADOS DEPOIS
//   da base → estouravam os 70 chars → o setor de Devolução via só
//   "...DE DEVOLUCAO | VOLUM" e PERDIA quantos volumes e por quê.
//   Caso âncora: NF 59299 AMB342013-2, extras {volumes:2, motivo:DESACORO,
//   filial:POA} chegaram truncados como "VOLUM" no SSW (print do Caio).
//
//   Fix: os extras operacionais que a operadora digita (Volumes, Motivo,
//   Filial, Obs) vêm PRIMEIRO no texto — ANTES da boilerplate base. Assim
//   sobrevivem ao corte de 70 chars do f6 e o setor enxerga a info que importa.
//   A descrição base vira o final do texto (continua íntegra no observ/500).
//
// Pra adicionar campo novo que deve aparecer no SSW: EXTENDA a whitelist
// EXTRAS_PRA_DESCRICAO_SSW explicitamente (iterar por todos os extras VAZAVA
// flags internas tipo `validar_evidencia: false` /
// `responder_thread_cliente: [object Object]` pro texto — ver NF 2161614).
// =============================================================================

/**
 * Whitelist explícita: SÓ estes extras viram texto operacional pro SSW.
 * Ordem aqui = ordem de prioridade no texto (o que vem antes sobrevive ao
 * corte de 70 chars do campo f6 que o setor lê).
 */
export const EXTRAS_PRA_DESCRICAO_SSW: Record<string, string> = {
  quantidade_volumes: "Volumes",
  motivo: "Motivo",
  filial: "Filial",
  texto_complementar: "Obs",
};

/** Tamanho do campo f6 (Informações complementares) que o setor LÊ na coluna. */
export const SSW_F6_MAXLEN = 70;
/** Tamanho do campo observ (Instrução textarea, backup completo). */
export const SSW_OBSERV_MAXLEN = 500;

export interface MontarDescricaoArgs {
  baseDescricao: string;
  extras?: Record<string, unknown> | null;
}

/**
 * Monta o texto da oc pro SSW.
 *
 * - Se `extras.texto_descricao` (texto livre — ocs 41/56) vier preenchido, ELE
 *   é a descrição (substitui a base). Limitado a 500 chars.
 * - Senão: extras operacionais whitelisted PRIMEIRO (na ordem da whitelist),
 *   `baseDescricao` por último. Junta com " | ", limita a 500 chars.
 *   Garante que Volumes/Motivo caibam nos primeiros 70 chars (campo f6).
 */
export function montarDescricaoSsw({ baseDescricao, extras }: MontarDescricaoArgs): string {
  if (!extras || typeof extras !== "object") {
    return baseDescricao.slice(0, SSW_OBSERV_MAXLEN);
  }

  // Texto livre (ocs com campo livre) substitui a descrição inteira.
  const textoLivre = extras["texto_descricao"] as string | number | undefined;
  if (textoLivre != null && String(textoLivre).trim() !== "") {
    return String(textoLivre).slice(0, SSW_OBSERV_MAXLEN);
  }

  // Extras operacionais PRIMEIRO (sobrevivem ao corte de 70 do f6), base depois.
  const partes: string[] = [];
  for (const [key, label] of Object.entries(EXTRAS_PRA_DESCRICAO_SSW)) {
    const raw = extras[key];
    if (raw == null) continue;
    const value = String(raw).trim();
    if (value === "" || value === "[object Object]") continue;
    partes.push(`${label}: ${value}`);
  }
  partes.push(baseDescricao);
  return partes.join(" | ").slice(0, SSW_OBSERV_MAXLEN);
}

/**
 * Campos que a operadora é OBRIGADA a preencher pra lançar oc=44 (devolução):
 * quantos volumes voltam e o motivo. Sem isso o setor de Devolução não
 * consegue tratar. O modal do Cockpit DEVE coletar — inclusive quando a oc=44
 * vem como sugestão do agente no banner (Caio 2026-06-24, NF 59299).
 */
export const CAMPOS_OBRIGATORIOS_OC44 = ["quantidade_volumes", "motivo"] as const;

/**
 * Retorna a lista de campos obrigatórios AUSENTES pra a oc dada.
 * Hoje só a oc=44 tem campos obrigatórios; outras ocs retornam [] sempre.
 * Vazio = pode lançar. Não-vazio = bloquear lançamento (faltou info do modal).
 */
export function camposObrigatoriosAusentes(
  codigoSsw: number,
  extras?: Record<string, unknown> | null,
): string[] {
  if (codigoSsw !== 44) return [];
  const e = (extras && typeof extras === "object" ? extras : {}) as Record<string, unknown>;
  return CAMPOS_OBRIGATORIOS_OC44.filter((campo) => {
    const v = e[campo];
    return v == null || String(v).trim() === "";
  });
}
