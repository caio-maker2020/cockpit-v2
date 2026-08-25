// =============================================================================
// acao-autonoma-veto — IDENTIDADE do trilho "Ação Autônoma com Janela de Veto"
// (plano aprovado pelo Caio 25/08: toda sugestão elegível vira ação programada
// que executa em 60 minutos ÚTEIS; operador não faz nada / edita / cancela).
//
// Este módulo é a FONTE ÚNICA de: nomes de evento, tipo do agendamento, flag,
// janelas, escopo da onda 1 e o hash da proposta (risco 23 do plano — payload
// mutado durante a janela nunca executa às cegas).
//
// Nomes de evento são CONTRATO: a Auditoria, o front (aba 1/2) e os gatilhos
// de cancelamento filtram por essas strings. Mudar um nome = quebrar a
// linha do tempo — por isso os testes travam as strings literais.
// =============================================================================

/** Tipo novo em acoes_agendadas (CHECK estendido na mig 353). */
export const TIPO_EXECUTAR_ACAO_AUTONOMA = "executar_acao_autonoma";

/** Flag master (feature_flags, nasce OFF — mig 353). Kill-switch sem deploy. */
export const FLAG_VETO = "acao_autonoma_veto_enabled";

/** A janela de veto: 60 minutos ÚTEIS (08h–17h30 BRT, seg–sex, sem feriado). */
export const JANELA_VETO_MINUTOS_UTEIS = 60;

/** TTL duro (risco 31): venceu há mais que isso sem processar → expira pro
 *  humano. Rajada atrasada pós-outage NUNCA executa. */
export const TTL_EXECUCAO_ATRASADA_MIN = 30;

// ── Eventos do card (card_events.event_type) — strings congeladas ────────────
export const EVENTO_AGENDADA = "AcaoAutonomaAgendada";
export const EVENTO_SUBSTITUIDA = "AcaoAutonomaSubstituida"; // re-análise trocou a proposta (risco 17)
export const EVENTO_EDITADA = "AcaoAutonomaEditadaPeloOperador"; // edição legítima na janela (atualiza hash)
export const EVENTO_CANCELADA_OPERADOR = "AcaoAutonomaCanceladaPeloOperador"; // botão vermelho + formulário
export const EVENTO_DEVOLVIDA = "AcaoAutonomaDevolvidaProHumano"; // re-validação divergiu no vencimento
export const EVENTO_EXPIRADA = "AcaoAutonomaExpirada"; // TTL estourou (risco 31)
// Execução em si REUSA a trilha de produção: AutoAprovacaoPermitida (mig 021)
// → executor → confirmação real SSW. Nada de evento "executado" paralelo.

/**
 * Onda 1 (Caio 25/08): ações cuja proposta o agente JÁ gera completa hoje.
 * 21 (incl. variante com cancelamento de reentrega embutido — extra permitido),
 * 54/59 com e sem e-mail, 55 (texto do painel é opcional por construção).
 * A ativação REAL de cada uma é degrau da escada (acoes_autonomas_veto_config,
 * ativa=false por default) + flag master — esta lista é só o universo elegível.
 */
export const ACOES_ONDA_1: ReadonlySet<string> = new Set([
  "lancar_ocorrencia:21",
  "lancar_ocorrencia:55",
  "lancar_ocorrencia:54",
  "lancar_ocorrencia:59",
  "lancar_oc_e_enviar_email:54",
  "lancar_oc_e_enviar_email:59",
]);

// ── Hash da proposta (risco 23) ──────────────────────────────────────────────
// Estável por VALOR: mesma proposta com chaves em ordem diferente = mesmo hash;
// qualquer mutação de conteúdo = hash diferente → agendamento não executa e
// devolve pro humano. FNV-1a 64-bit sobre JSON canônico (chaves ordenadas).

function jsonCanonico(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jsonCanonico).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const chaves = Object.keys(obj).sort();
  return `{${chaves.map((k) => `${JSON.stringify(k)}:${jsonCanonico(obj[k])}`).join(",")}}`;
}

export function hashDaProposta(propostaPayload: unknown): string {
  const s = jsonCanonico(propostaPayload ?? null);
  // FNV-1a 64-bit em BigInt — determinístico, sem dependência externa
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}
