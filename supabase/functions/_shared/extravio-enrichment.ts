// =============================================================================
// extravio-enrichment — lógica compartilhada de ENRIQUECIMENTO de card de
// extravio (oc 6/9/16). Usado pelo sync-bastao (sync único, ADR 0005) e — até
// ser aposentado — pelo sync-extravios-bastao.
//
// Mantém UMA fonte pra: análise (template + qtds), snapshot agent_state, aviso
// pro preview de e-mail, resolução do e-mail do cliente, e as PROPOSTAS:
//   lancar_49 | email_sem_oc | email_mais_54 | lancar_55 | lancar_54_sem_email
// =============================================================================

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { type BastaoPendencia } from "./bastao-client.ts";

export const OCS_EXTRAVIO = new Set([6, 9, 16]);

export function normalizeNf(nf: string | null | undefined): string | null {
  if (!nf) return null;
  const t = String(nf).trim().replace(/^0+/, "");
  return t.length > 0 ? t : null;
}

function limparInstrucao(s: string): string {
  return s
    .replace(/\(SSWMOBILE\)/gi, " ")
    .replace(/GPS\s*\([^)]*\)/gi, " ")
    .replace(/\bGPS\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Quantos volumes faltam, a partir da instrução da oc 6/9/16. */
export function extrairQtdVolumes(
  instrucao: string | null | undefined,
): { total: true } | { qtd: number } | null {
  if (!instrucao) return null;
  const limpa = limparInstrucao(instrucao).toUpperCase();
  if (!limpa) return null;
  if (/\b(EXTRAVIO\s+TOTAL|PERDA\s+TOTAL|TOTAL)\b/.test(limpa)) return { total: true };
  const m = limpa.match(
    /(?:FALTA(?:M)?|QTDE?|QTD\.?)\s*(\d{1,3})|\b(\d{1,3})\s*(?:VOL|VOLUMES?|VOLS?)\b/,
  );
  if (m) {
    const qtd = parseInt(m[1] ?? m[2] ?? "", 10);
    if (qtd > 0 && qtd < 1000) return { qtd };
  }
  if (/^\d{1,3}\s*\.?\s*$/.test(limpa)) {
    const qtd = parseInt(limpa, 10);
    if (qtd > 0 && qtd < 1000) return { qtd };
  }
  return null;
}

export interface AnaliseExtravio {
  template: "EXTRAVIO_PARCIAL" | "EXTRAVIO_TOTAL_PEDIR_ROMANEIO";
  qtdExtraviados: string | null;
  qtdNf: string | null;
}

export function analisarExtravio(p: BastaoPendencia): AnaliseExtravio {
  const qtd = extrairQtdVolumes(p.instrucao_ultima_ocorrencia);
  const isTotal = !qtd || "total" in qtd ||
    (p.qtd_volumes != null && "qtd" in qtd && qtd.qtd >= p.qtd_volumes);
  const nVolFalta = qtd && "qtd" in qtd ? qtd.qtd : null;
  return {
    template: isTotal ? "EXTRAVIO_TOTAL_PEDIR_ROMANEIO" : "EXTRAVIO_PARCIAL",
    qtdExtraviados: nVolFalta != null ? String(nVolFalta) : null,
    qtdNf: p.qtd_volumes != null ? String(p.qtd_volumes) : null,
  };
}

/** aviso_alteracao_oc do extravio → preview_email_todo preenche {n_volumes_falta}/{qtde_volumes}. */
export function montarAvisoExtravio(ext: AnaliseExtravio): Record<string, unknown> {
  return {
    tipo: "extravio_email_sugerido",
    template_email_sugerido: ext.template,
    qtd_volumes_extraviados: ext.qtdExtraviados,
    qtd_volumes_nf: ext.qtdNf,
  };
}

export function snapshotExtravio(p: BastaoPendencia): Record<string, unknown> {
  return {
    origem: "extravio_perdas",
    bastao_pendencia_id: p.id,
    bastao_updated_at: p.updated_at,
    cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
    instrucao_ultima_ocorrencia: p.instrucao_ultima_ocorrencia,
    data_ultima_ocorrencia: p.data_ultima_ocorrencia,
    cnpj_remetente: p.cnpj_remetente,
    remetente: p.remetente,
    cnpj_pagador: p.cnpj_pagador,
    cnpj_destinatario: p.cnpj_destinatario,
    destinatario: p.destinatario,
    uf_destino: p.uf_destino,
    cidade_destino: p.cidade_destino,
    base_destino: p.base_destino,
    unidade_atual: p.unidade_atual,
    dias_atraso: p.atraso_original,
    previsao_entrega: p.previsao_entrega,
    segmento_cliente: p.segmento_cliente,
    qtde_volumes: p.qtd_volumes,
    bastao_synced_at: new Date().toISOString(),
  };
}

export interface AcaoExtravio {
  acao: string;
  descricao_todo: string;
  proposta_payload: Record<string, unknown>;
}

/**
 * Propostas do card de extravio. As de só-oc (49/55/54-sem-email) têm
 * meta.tinha_intencao_email=false → o front aprova direto (sem editor de e-mail).
 */
export function montarPropostas(
  p: BastaoPendencia,
  nf: string,
  emailDestino: string | null,
  template: string,
): AcaoExtravio[] {
  const cnpjRemetente = p.cnpj_remetente ?? p.cnpj_pagador ?? null;
  const metaBase = { origem: "extravio_cockpit" };

  return [
    {
      acao: "lancar_49",
      descricao_todo: 'Lançar oc 49 no SSW — "PRAZO DE PERDAS EXPIRADO"',
      proposta_payload: {
        tool: "lancar_oc_e_enviar_email",
        args: {
          codigo_ssw: 49,
          nf,
          cnpj_remetente: cnpjRemetente,
          descricao: "PRAZO DE PERDAS EXPIRADO",
          extras: { enviar_email: false, texto_descricao: "PRAZO DE PERDAS EXPIRADO" },
        },
        rationale: "Extravio sem localização: lançar oc 49 (prazo de perdas expirado) → segue pra Relacionamento.",
        texto: null,
        meta: { ...metaBase, tinha_intencao_email: false, modo: "sem_email", acao: "lancar_49" },
      },
    },
    {
      acao: "email_sem_oc",
      descricao_todo: "Notificar cliente por e-mail (sem lançar ocorrência)",
      proposta_payload: {
        tool: "lancar_oc_e_enviar_email",
        args: {
          nf,
          cnpj_remetente: cnpjRemetente,
          descricao: "Notificação de extravio ao cliente",
          template_id: template,
          email_destino: emailDestino,
          extras: { skip_oc: true },
        },
        rationale: "Extravio: notificar o cliente por e-mail, sem comprometer com oc 54.",
        texto: null,
        meta: { ...metaBase, tinha_intencao_email: true, modo: "completo", acao: "email_sem_oc" },
      },
    },
    {
      acao: "email_mais_54",
      descricao_todo: "Notificar cliente + lançar oc 54 (aguardar retorno: seguir parcial ou devolver)",
      proposta_payload: {
        tool: "lancar_oc_e_enviar_email",
        args: {
          codigo_ssw: 54,
          nf,
          chave_cte: null,
          cnpj_remetente: cnpjRemetente,
          descricao: "Extravio — cliente notificado, aguardando retorno",
          template_id: template,
          email_destino: emailDestino,
        },
        rationale: "Extravio (oc 6/9/16): notificar cliente e aguardar retorno (parcial/devolução).",
        texto: null,
        meta: { ...metaBase, tinha_intencao_email: true, modo: "completo", acao: "email_mais_54" },
      },
    },
    {
      acao: "lancar_55",
      descricao_todo: "Lançar oc 55 no SSW — autorizar seguir para entrega / entrega parcial",
      proposta_payload: {
        tool: "lancar_oc_e_enviar_email",
        args: {
          codigo_ssw: 55,
          nf,
          cnpj_remetente: cnpjRemetente,
          descricao: "Autorizado para seguir para entrega / entrega parcial",
          extras: { enviar_email: false, texto_descricao: "Autorizado para seguir para entrega / entrega parcial" },
        },
        rationale: "Extravio: operador autoriza seguir para entrega / entrega parcial (oc 55), direto no SSW, sem e-mail.",
        texto: null,
        meta: { ...metaBase, tinha_intencao_email: false, modo: "sem_email", acao: "lancar_55" },
      },
    },
    {
      // Caio 2026-06-18: correção de lançamento errado (mudança suspeita) — lança
      // 54 SEM e-mail, pra reposicionar o card sem disparar e-mail ao cliente.
      acao: "lancar_54_sem_email",
      descricao_todo: "Lançar oc 54 no SSW SEM e-mail (correção de lançamento)",
      proposta_payload: {
        tool: "lancar_oc_e_enviar_email",
        args: {
          codigo_ssw: 54,
          nf,
          cnpj_remetente: cnpjRemetente,
          descricao: "Aguardando retorno do cliente",
          extras: { enviar_email: false, texto_descricao: "Aguardando retorno do cliente" },
        },
        rationale: "Correção: lançar oc 54 sem e-mail (ex.: mudança suspeita / erro de lançamento).",
        texto: null,
        meta: { ...metaBase, tinha_intencao_email: false, modo: "sem_email", acao: "lancar_54_sem_email" },
      },
    },
  ];
}

/** E-mail do cliente cadastrado (mesma RPC das propostas de relacionamento). */
export async function resolverEmailDestino(
  supabase: SupabaseClient,
  cnpjPagador: string | null,
): Promise<string | null> {
  if (!cnpjPagador) return null;
  const { data } = await supabase.rpc("resolver_email_cobranca_cliente", {
    p_documento_cliente: cnpjPagador,
    p_tipo_uso: "logistico",
  });
  return typeof data === "string" ? data : null;
}

/** Cria as propostas do card de extravio (idempotente por meta.acao ativo). */
export async function upsertPropostas(
  supabase: SupabaseClient,
  cardId: string,
  p: BastaoPendencia,
  nf: string,
  emailDestino: string | null,
  template: string,
): Promise<void> {
  const { data: existing } = await supabase
    .from("todos").select("proposta_payload, status").eq("card_id", cardId);
  const STATUS_ATIVOS = new Set(["pendente", "aprovado"]);
  const acoesJa = new Set<string>();
  for (const t of (existing ?? []) as Array<Record<string, unknown>>) {
    const pp = t["proposta_payload"] as Record<string, unknown> | null;
    const meta = pp?.["meta"] as Record<string, unknown> | undefined;
    const acao = meta?.["acao"] as string | undefined;
    const st = t["status"] as string | undefined;
    if (acao && st && STATUS_ATIVOS.has(st)) acoesJa.add(acao);
  }
  for (const prop of montarPropostas(p, nf, emailDestino, template)) {
    if (acoesJa.has(prop.acao)) continue;
    await supabase.from("todos").insert({
      card_id: cardId,
      action_id: crypto.randomUUID(),
      descricao: prop.descricao_todo,
      status: "pendente",
      proposta_payload: prop.proposta_payload,
    });
  }
}
