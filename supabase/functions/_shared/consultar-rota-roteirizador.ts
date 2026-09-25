// =============================================================================
// consultar_rota_roteirizador(ctrc) — ferramenta DETERMINÍSTICA dos agentes de
// RASTREAMENTO (redator, card tipo=rastreamento) e EXTRAVIO (IA da oc 49).
// ADR 0034.
//
// Os agentes do Cockpit não fazem tool_use (completeJson puro): "tool-first"
// aqui = o código consulta a ponte ANTES da chamada ao modelo e injeta o
// resultado como bloco de contexto (mesmo padrão do `estadoBloco` da oc 49).
// LLM decide o que dizer; código decide o que é fato.
//
// Regras:
//   - CTRC vem SEMPRE do card (regra crítica do CLAUDE.md) — este módulo só
//     aceita `card.ctrc`, nunca um CTRC achado por busca de NF.
//   - Flag `roteirizador_ponte_consulta_enabled` OFF (ou linha ausente, ou erro
//     de leitura) = null = prompt de hoje, byte a byte.
//   - Env da ponte ausente = null. Falha da ponte = null (+ log). NUNCA lança:
//     o agente segue sem a ponte.
// =============================================================================

import {
  createRoteirizadorPonteClientFromEnv,
  type NotaPonte,
  type RoteirizadorPonteClient,
} from "./roteirizador-ponte-client.ts";

export const FLAG_PONTE_CONSULTA = "roteirizador_ponte_consulta_enabled" as const;

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

export interface RotaRoteirizadorConsultada {
  ctrc: string;
  nota: NotaPonte;
  /** Bloco pronto pro prompt (pt-BR, ≤ ~600 chars). */
  bloco: string;
}

const SITUACAO_EXECUCAO: Record<string, string> = {
  pendente: "ainda não baixada (em rota ou aguardando saída)",
  seguida: "entregue conforme o plano",
  removida: "retirada da rota",
  nao_coube: "não coube no carro",
  fora_da_doca: "não saiu da doca",
};

function dataBr(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso ?? "?");
}

/** Pura: resposta da ponte → bloco de contexto pro prompt do agente. */
export function montarBlocoRotaRoteirizador(ctrc: string, nota: NotaPonte): string {
  const linhas: string[] = [
    `ROTA DO DIA (Roteirizador — fato verificado pela ponte, CTRC ${ctrc}):`,
  ];
  if (!nota.noPlano) {
    linhas.push("- A nota NÃO está em nenhum plano de rota do Roteirizador.");
  } else {
    const aprovada = nota.statusAprovacao === "aprovada";
    linhas.push(
      `- Plano de ${dataBr(nota.dataRef)}, rota ${nota.rotaNome} (${aprovada ? "aprovada" : `status ${nota.statusAprovacao} — pode não sair`}).`,
    );
    if (nota.carro) {
      const c = nota.carro;
      const partes = [c.perfil, c.placa ? `placa ${c.placa}` : null, c.motorista ? `motorista ${c.motorista}` : null]
        .filter(Boolean).join(", ");
      linhas.push(`- Carro ${c.indice}${partes ? ` (${partes})` : ""}${nota.ordem != null ? `, parada nº ${nota.ordem}` : ""}${nota.cidade ? ` em ${nota.cidade}` : ""}.`);
    }
    const sit = SITUACAO_EXECUCAO[String(nota.statusExecucao)] ?? String(nota.statusExecucao);
    linhas.push(`- Situação: ${sit}${nota.motivoExecucao ? ` — motivo: ${nota.motivoExecucao}` : ""}.`);
    if (nota.fotoEvidenciaUrl) linhas.push("- Há foto de evidência do motorista.");
    if (nota.linkRastreio) {
      linhas.push(`- Link de rastreio do destinatário (pode ser enviado ao cliente): ${nota.linkRastreio}`);
    }
  }
  if (nota.compromissos.length > 0) {
    linhas.push(`- Compromissos já registrados no Roteirizador: ${nota.compromissos.length}.`);
  }
  // Dado operacional interno (telefone do motorista) fica de fora de propósito:
  // o bloco vai pra um prompt que redige texto ao cliente.
  return linhas.join("\n").slice(0, 900);
}

async function flagLigada(supabase: SupabaseClient): Promise<boolean> {
  try {
    const { data } = await supabase.from("feature_flags")
      .select("enabled").eq("key", FLAG_PONTE_CONSULTA).maybeSingle();
    return (data as { enabled?: boolean } | null)?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * consultar_rota_roteirizador(card.ctrc). Null = sem contexto de rota (flag
 * OFF, env ausente, card sem CTRC, ponte falhou) — o chamador segue igual a hoje.
 */
export async function consultarRotaRoteirizador(
  supabase: SupabaseClient,
  card: { id?: string | null; ctrc?: string | null },
  opts: {
    client?: RoteirizadorPonteClient;
    env?: Record<string, string | undefined>;
    agente: string;
  },
): Promise<RotaRoteirizadorConsultada | null> {
  try {
    const ctrc = (card.ctrc ?? "").trim().toUpperCase();
    if (!ctrc) return null;
    if (!(await flagLigada(supabase))) return null;
    const client = opts.client ??
      createRoteirizadorPonteClientFromEnv(opts.env ?? Deno.env.toObject(), { maxTentativas: 2 });
    if (!client.ligado) return null;
    const r = await client.consultarNota(ctrc);
    if (!r.ok) {
      console.warn(`[consultar_rota_roteirizador] ${opts.agente} card=${card.id ?? "?"} ctrc=${ctrc}: ${r.erro.tipo} ${r.erro.mensagem}`);
      return null;
    }
    return { ctrc, nota: r.dados, bloco: montarBlocoRotaRoteirizador(ctrc, r.dados) };
  } catch (e) {
    console.warn(`[consultar_rota_roteirizador] ${opts.agente}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
