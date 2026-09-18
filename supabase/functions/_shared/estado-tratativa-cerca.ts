// =============================================================================
// estado-tratativa-cerca — o PORTEIRO: valida a sugestão contra a memória do
// card ANTES de destacar/armar (plano Caio 17/09, D2/D3).
//
// Contrato anti-regressão: estado null ou schema desconhecido → {ok:true}
// (sem memória = comportamento de hoje). O porteiro só FREIA autonomia; nunca
// libera nada. Fato origem:"llm" PODE frear (D2 — conservador). No trilho de
// veto ele vira a cerca `contradiz_estado:<motivo>` (entre conteudo_incompleto
// e evidencia_nao_confirmada); no destaque vira ANOTAÇÃO visível (D3), nunca
// supressão. Flag `cerca_estado_enforce` OFF = log-only.
// PURA — deno test com os motivos canônicos travados.
// =============================================================================

import { ESTADO_SCHEMA_V, type EstadoTratativa } from "./estado-tratativa.ts";

export interface SugestaoParaCerca {
  acaoKey: string | null;          // "lancar_oc_e_enviar_email:59"
  codigoOc: number | null;
  enviaEmail: boolean;
}

export type ResultadoCerca =
  | { ok: true }
  | { ok: false; motivo: "repetiu_acao_no_ciclo" | "pediu_doc_ja_recebido" | "oc55_sem_reentrega_aberta"; detalhe: string };

/** Ocs cujo e-mail tem função de PEDIR documentos do dossiê. */
const OCS_PEDEM_DOCS: ReadonlySet<number> = new Set([59]);

export function validarSugestaoContraEstado(
  estado: EstadoTratativa | null | undefined,
  sugestao: SugestaoParaCerca,
): ResultadoCerca {
  // anti-regressão: sem memória (ou formato futuro) = passa como hoje
  if (!estado || estado.schema_v !== ESTADO_SCHEMA_V) return { ok: true };
  const oc = sugestao.codigoOc;
  if (oc == null) return { ok: true };

  // 1. repetiu a MESMA oc com sucesso neste ciclo (INV-094 generalizada).
  //    Redundância DELIBERADA com a cerca mesma_acao_no_ciclo do trilho —
  //    fontes diferentes se cruzam; divergência entre as duas = bug detectável.
  const repetida = estado.ja_feito_no_ciclo.find(
    (a) => a.codigo_oc === oc && a.resultado === "sucesso",
  );
  if (repetida) {
    return {
      ok: false,
      motivo: "repetiu_acao_no_ciclo",
      detalhe: `oc ${oc} já executada neste ciclo em ${repetida.em.slice(0, 16)} (${repetida.ref})`,
    };
  }

  // 2. e-mail pedindo documento que a memória diz já recebido (classe NF 1508990).
  if (OCS_PEDEM_DOCS.has(oc) && sugestao.enviaEmail) {
    const docsRecebidos = estado.fatos_confirmados.filter((f) => f.tipo === "recebimento_doc");
    const nadaPendente = estado.pendencias_dossie.length === 0;
    if (docsRecebidos.length > 0 && nadaPendente) {
      return {
        ok: false,
        motivo: "pediu_doc_ja_recebido",
        detalhe: `dossiê sem pendências e ${docsRecebidos.length} doc(s) já recebidos (ex.: ${docsRecebidos[0]!.detalhe})`,
      };
    }
  }

  // 3. autorizar seguir (55) sem reentrega em aberto (R5 generalizada).
  if (oc === 55 && estado.alertas.includes("oc55_sem_reentrega_aberta")) {
    return {
      ok: false,
      motivo: "oc55_sem_reentrega_aberta",
      detalhe: "não há CTRC de reentrega em aberto no histórico — a 55 não colocaria a carga na rua",
    };
  }

  return { ok: true };
}
