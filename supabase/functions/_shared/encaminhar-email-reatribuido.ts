// =============================================================================
// encaminhar-email-reatribuido.ts — Caio 2026-07-21 (onboarding Karoline)
// =============================================================================
// Quando um card é REATRIBUÍDO a um novo operador (ex.: clientes da Larissa que
// passaram pra Karoline), as respostas dos clientes a threads ANTIGAS caem na
// caixa Gmail do dono ANTIGO (a Larissa, que enviou o e-mail original). O
// gmail-poll-inbox já captura e cola no card do NOVO dono. Este helper adiciona
// o passo que faltava: encaminhar uma CÓPIA da resposta pra caixa Gmail do novo
// dono, pra ele ver também no e-mail — não só no Cockpit.
//
// Como funciona (envio pela conta que capturou = dono antigo, via gmail.send que
// já existe — SEM escopo novo). Mensagem nova, standalone (sem threadId), então:
//   - não entra na thread do cliente na caixa do dono antigo;
//   - chega na caixa do novo dono SEM o label `cockpit-tracked` → o poll do novo
//     dono NÃO reprocessa (não duplica card, sem loop);
//   - o poll do dono antigo pula SENT → também não reprocessa.
//
// Idempotência: tabela emails_encaminhados_operador UNIQUE(gmail_message_id,
// para_email) — INSERT antes do envio reserva; conflito = já encaminhado, skip.
// Envio falhou → apaga a reserva (permite retry futuro).
//
// Blindado no caller: qualquer erro aqui é isolado e NUNCA derruba o poll.
// Flag: feature_flags('email_forward_reatribuido_ativo').
// =============================================================================
import type { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { sendGmailMessage } from "./gmail-sender.ts";

// Mesmo alias do gmail-sender.ts (ReturnType<typeof createClient>) pra casar o
// tipo de `supabase` esperado por sendGmailMessage — evita TS2322 do supabase-js.
type SupabaseClient = ReturnType<typeof createClient>;

const FLAG_KEY = "email_forward_reatribuido_ativo";

/**
 * Decisão PURA (testável): deve encaminhar?
 * Só quando: flag ligada + card tem dono + dono ≠ dono da caixa que capturou.
 */
export function deveEncaminhar(opts: {
  flagAtivo: boolean;
  pollingOperadorId: string;
  assignedOperadorId: string | null | undefined;
}): boolean {
  if (!opts.flagAtivo) return false;
  if (!opts.assignedOperadorId) return false;
  return opts.assignedOperadorId !== opts.pollingOperadorId;
}

/**
 * Assunto PURO e legível do forward (testável). Prefixa com [empresa · NF] pro novo
 * dono reconhecer na caixa (a cópia vem do endereço do dono antigo, então sem essa
 * tag fica difícil achar). Remove um "Fwd:/Fw:/Enc:" já existente antes de reprefixar.
 */
export function montarAssuntoForward(empresa: string, nf: string, subjectOriginal: string): string {
  const base = (subjectOriginal || "(sem assunto)").trim().replace(/^\s*(fwd|fw|enc):\s*/i, "");
  const tag = [empresa?.trim(), nf?.trim() ? `NF ${nf.trim()}` : ""].filter(Boolean).join(" · ");
  return tag ? `Fwd: [${tag}] ${base}` : `Fwd: ${base}`;
}

export interface EncaminharParams {
  supabase: SupabaseClient;
  /** operador dono da caixa Gmail que capturou (quem faz o poll) */
  pollingOperadorId: string;
  cardId: string;
  gmailMessageId: string;
  remetenteCliente: string;
  subjectOriginal: string;
  conteudo: string;
}

export interface EncaminharResult {
  encaminhado: boolean;
  motivo: string;
}

export async function encaminharRespostaSeReatribuido(
  p: EncaminharParams,
): Promise<EncaminharResult> {
  const { supabase } = p;

  // 1. flag
  const { data: flagRow } = await supabase
    .from("feature_flags").select("enabled").eq("key", FLAG_KEY).maybeSingle();
  const flagAtivo = (flagRow as { enabled?: boolean } | null)?.enabled === true;

  // 2. dono atual do card (+ empresa/nf pro assunto legível)
  const { data: cardRow } = await supabase
    .from("cards").select("assigned_operator_id, empresa_cliente, nf").eq("id", p.cardId).maybeSingle();
  const card = cardRow as
    | { assigned_operator_id?: string | null; empresa_cliente?: string | null; nf?: string | null }
    | null;
  const assignedOperadorId = card?.assigned_operator_id ?? null;
  const empresa = (card?.empresa_cliente ?? "").trim();
  const nf = (card?.nf ?? "").trim();

  if (!deveEncaminhar({ flagAtivo, pollingOperadorId: p.pollingOperadorId, assignedOperadorId })) {
    return { encaminhado: false, motivo: flagAtivo ? "card nao reatribuido" : "flag desligada" };
  }

  // 3. e-mail do novo dono (caixa de relacionamento; fallback login)
  const { data: dono } = await supabase
    .from("operadores")
    .select("email, email_relacionamento, nome, ativo")
    .eq("id", assignedOperadorId!)
    .maybeSingle();
  const d = dono as
    | { email?: string; email_relacionamento?: string; nome?: string; ativo?: boolean }
    | null;
  if (!d || d.ativo === false) return { encaminhado: false, motivo: "novo dono inativo/ausente" };
  const destino = (d.email_relacionamento || d.email || "").trim();
  if (!destino) return { encaminhado: false, motivo: "novo dono sem e-mail" };

  // 4. dedup — reserva ANTES de enviar
  const { error: dupErr } = await supabase
    .from("emails_encaminhados_operador")
    .insert({
      gmail_message_id: p.gmailMessageId,
      para_email: destino,
      card_id: p.cardId,
      de_operador_id: p.pollingOperadorId,
      para_operador_id: assignedOperadorId,
    });
  if (dupErr) return { encaminhado: false, motivo: "ja encaminhado (dedup)" };

  // 5. envia a cópia pela conta que capturou (dono antigo), mensagem standalone
  const subject = montarAssuntoForward(empresa, nf, p.subjectOriginal);
  // Nome do remetente = a empresa cliente, pra Karoline reconhecer na caixa (o
  // endereço continua sendo o do dono antigo, mas o display name é o que ela lê).
  const fromName = empresa ? `${empresa} · via Cockpit` : "Cliente · via Cockpit";
  const nota =
    `— Encaminhado automaticamente pelo Cockpit —\n` +
    `Cliente: ${empresa || p.remetenteCliente}${nf ? `  ·  NF ${nf}` : ""}\n` +
    `Respondido por: ${p.remetenteCliente}\n` +
    `Tratativa agora é de: ${d.nome ?? "você"}. Anexos e histórico completo ficam no card, no Cockpit.\n` +
    `------------------------------------------------------------\n\n`;

  const res = await sendGmailMessage({
    supabase,
    operadorId: p.pollingOperadorId,
    destinatario: destino,
    subject,
    texto: nota + (p.conteudo || ""),
    fromName,
    // sem threadId de propósito: mensagem nova, não entra na thread do cliente
  });

  if (!res.ok) {
    // libera a reserva pra permitir nova tentativa no futuro
    await supabase
      .from("emails_encaminhados_operador")
      .delete()
      .eq("gmail_message_id", p.gmailMessageId)
      .eq("para_email", destino);
    return { encaminhado: false, motivo: `envio falhou: ${res.error ?? "?"}` };
  }

  return { encaminhado: true, motivo: `enviado p/ ${destino}` };
}
