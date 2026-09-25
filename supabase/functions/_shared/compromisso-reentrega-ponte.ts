// =============================================================================
// compromisso-reentrega-ponte — depois da oc 21 lançada com SUCESSO, avisa o
// Roteirizador da data (e janela) combinada com o cliente: POST /compromissos.
// ADR 0034.
//
// Fronteira: o Cockpit continua lançando a 21 no SSW (sistema de registro);
// o compromisso só acrescenta restrição ao plano do Roteirizador. Este módulo
// roda DEPOIS do envelope lancarSswPortal e não encosta nele.
//
// De onde vem a data: SÓ de campos ESTRUTURADOS nos extras da proposta —
//   extras.data_reentrega  "YYYY-MM-DD"   (obrigatório)
//   extras.janela_inicio   "HH:MM"        (opcional)
//   extras.janela_fim      "HH:MM"        (opcional)
//   extras.observacao_reentrega           (opcional, ≤200)
// Nunca inferir data de texto livre (instrucao_reentrega_sugerida etc.). Sem
// data estruturada = não envia nada. Esses campos NÃO entram na Instrução do
// SSW: a whitelist EXTRAS_PRA_DESCRICAO_SSW não os lista (regra crítica nº 5).
//
// Idempotência: idempotencyKey = `${card_id}:reentrega:${data}` (determinística
// pelo card). Reexecução do mesmo todo → a ponte responde 200 (não duplica).
// Mesma data com janela nova NÃO atualiza (mesma chave) — limitação aceita.
//
// Falha da ponte NUNCA bloqueia a tratativa: registra (audit_log + card_event)
// e segue. Nunca lança.
// =============================================================================

import {
  type CompromissoPonte,
  createRoteirizadorPonteClientFromEnv,
  type RoteirizadorPonteClient,
} from "./roteirizador-ponte-client.ts";

export const FLAG_PONTE_COMPROMISSOS = "roteirizador_ponte_compromissos_enabled" as const;
export const EVENTO_COMPROMISSO_ENVIADO = "CompromissoEnviadoAoRoteirizador" as const;
export const EVENTO_COMPROMISSO_FALHOU = "CompromissoRoteirizadorFalhou" as const;

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

export type ExtracaoCompromisso =
  | { tipo: "sem_data" }
  | { tipo: "invalido"; motivo: string }
  | { tipo: "ok"; compromisso: CompromissoPonte };

const RE_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

function dataValida(s: string): boolean {
  const m = RE_DATA.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 &&
    d.getUTCDate() === Number(m[3]);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Pura: extras da proposta + card → compromisso da ponte (ou por que não). */
export function extrairCompromissoReentrega(
  extras: Record<string, unknown> | null | undefined,
  card: { id: string; ctrc: string | null },
): ExtracaoCompromisso {
  const data = str(extras?.["data_reentrega"]);
  if (!data) return { tipo: "sem_data" };
  if (!dataValida(data)) return { tipo: "invalido", motivo: `data_reentrega inválida: ${data}` };
  const ctrc = (card.ctrc ?? "").trim().toUpperCase();
  if (!ctrc) return { tipo: "invalido", motivo: "card sem CTRC" };

  const ini = str(extras?.["janela_inicio"]);
  const fim = str(extras?.["janela_fim"]);
  if (ini && !RE_HORA.test(ini)) return { tipo: "invalido", motivo: `janela_inicio inválida: ${ini}` };
  if (fim && !RE_HORA.test(fim)) return { tipo: "invalido", motivo: `janela_fim inválida: ${fim}` };
  if (ini && fim && fim <= ini) return { tipo: "invalido", motivo: `janela_fim (${fim}) não é depois de janela_inicio (${ini})` };
  const obs = str(extras?.["observacao_reentrega"]);

  return {
    tipo: "ok",
    compromisso: {
      ctrc,
      tipo: "reentrega",
      data,
      ...(ini ? { janelaInicio: ini } : {}),
      ...(fim ? { janelaFim: fim } : {}),
      ...(obs ? { observacao: obs.slice(0, 200) } : {}),
      cardId: card.id,
      idempotencyKey: `${card.id}:reentrega:${data}`,
    },
  };
}

async function flagLigada(supabase: SupabaseClient): Promise<boolean> {
  try {
    const { data } = await supabase.from("feature_flags")
      .select("enabled").eq("key", FLAG_PONTE_COMPROMISSOS).maybeSingle();
    return (data as { enabled?: boolean } | null)?.enabled === true;
  } catch {
    return false;
  }
}

export interface ResultadoEnvioCompromisso {
  enviado: boolean;
  motivo:
    | "nao_e_21"
    | "flag_off"
    | "ponte_desligada"
    | "sem_data"
    | "invalido"
    | "criado"
    | "repetido"
    | "falhou";
  detalhe?: string;
}

/**
 * Chamado pelo executor DEPOIS do sucesso do lançamento. Nunca lança.
 * `ctrc` = card.ctrc (regra crítica: CTRC sempre do card).
 */
export async function enviarCompromissoReentregaSeCombinado(
  supabase: SupabaseClient,
  input: {
    cardId: string;
    ctrc: string | null;
    codigoSsw: number | null;
    extras: Record<string, unknown> | null | undefined;
    todoId?: string | null;
  },
  opts: { client?: RoteirizadorPonteClient; env?: Record<string, string | undefined> } = {},
): Promise<ResultadoEnvioCompromisso> {
  try {
    if (input.codigoSsw !== 21) return { enviado: false, motivo: "nao_e_21" };
    if (!(await flagLigada(supabase))) return { enviado: false, motivo: "flag_off" };
    const extr = extrairCompromissoReentrega(input.extras, { id: input.cardId, ctrc: input.ctrc });
    if (extr.tipo === "sem_data") return { enviado: false, motivo: "sem_data" };
    const client = opts.client ??
      createRoteirizadorPonteClientFromEnv(opts.env ?? Deno.env.toObject(), { maxTentativas: 2 });
    if (!client.ligado) return { enviado: false, motivo: "ponte_desligada" };

    if (extr.tipo === "invalido") {
      await registrar(supabase, input, null, { ok: false, tipo: "invalido_local", mensagem: extr.motivo });
      return { enviado: false, motivo: "invalido", detalhe: extr.motivo };
    }

    const r = await client.registrarCompromisso(extr.compromisso);
    if (r.ok) {
      await registrar(supabase, input, extr.compromisso, { ok: true, criado: r.dados.criado, corpo: r.dados.corpo });
      return { enviado: true, motivo: r.dados.criado ? "criado" : "repetido" };
    }
    await registrar(supabase, input, extr.compromisso, { ok: false, tipo: r.erro.tipo, mensagem: r.erro.mensagem, status: r.erro.status });
    return { enviado: false, motivo: "falhou", detalhe: `${r.erro.tipo}: ${r.erro.mensagem}` };
  } catch (e) {
    console.warn(`[compromisso-reentrega-ponte] card=${input.cardId}: ${e instanceof Error ? e.message : String(e)}`);
    return { enviado: false, motivo: "falhou", detalhe: e instanceof Error ? e.message : String(e) };
  }
}

type Desfecho =
  | { ok: true; criado: boolean; corpo: unknown }
  | { ok: false; tipo: string; mensagem: string; status?: number | null };

/** audit_log (efeito externo) + card_event. Best-effort: erro só vira log. */
async function registrar(
  supabase: SupabaseClient,
  input: { cardId: string; ctrc: string | null; todoId?: string | null },
  compromisso: CompromissoPonte | null,
  desfecho: Desfecho,
): Promise<void> {
  const chave = compromisso?.idempotencyKey ?? `${input.cardId}:reentrega:invalido`;
  try {
    const { error } = await supabase.from("audit_log").insert({
      card_id: input.cardId,
      action_type: "registrar_compromisso_roteirizador",
      actor_type: "system",
      actor_id: "executor",
      external_system: "roteirizador",
      // Sucesso: chave estável (reexecução colide = já registrado). Falha: chave
      // com carimbo, pra uma nova tentativa não ser engolida pelo UNIQUE.
      idempotency_key: desfecho.ok
        ? `roteirizador_compromisso:${chave}`
        : `roteirizador_compromisso:${chave}:falha:${Date.now()}`,
      request_payload: compromisso ?? { ctrc: input.ctrc },
      response_payload: desfecho.ok ? { criado: desfecho.criado, corpo: desfecho.corpo } : desfecho,
      status: desfecho.ok ? "success" : "failed",
      external_id: null,
    });
    if (error && !String(error.message).includes("duplicate key")) {
      console.warn(`[compromisso-reentrega-ponte] audit_log card=${input.cardId}: ${error.message}`);
    }
  } catch (e) {
    console.warn(`[compromisso-reentrega-ponte] audit_log: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await supabase.from("card_events").insert({
      card_id: input.cardId,
      event_type: desfecho.ok ? EVENTO_COMPROMISSO_ENVIADO : EVENTO_COMPROMISSO_FALHOU,
      actor_type: "system",
      actor_id: "executor",
      payload: {
        origem: "ponte_roteirizador",
        todo_id: input.todoId ?? null,
        ctrc: compromisso?.ctrc ?? input.ctrc,
        tipo: compromisso?.tipo ?? "reentrega",
        data: compromisso?.data ?? null,
        janela_inicio: compromisso?.janelaInicio ?? null,
        janela_fim: compromisso?.janelaFim ?? null,
        idempotency_key: compromisso?.idempotencyKey ?? null,
        ...(desfecho.ok
          ? { repetido: !desfecho.criado }
          : { erro_tipo: desfecho.tipo, erro: desfecho.mensagem.slice(0, 300) }),
      },
    });
  } catch (e) {
    console.warn(`[compromisso-reentrega-ponte] card_event: ${e instanceof Error ? e.message : String(e)}`);
  }
}
