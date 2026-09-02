// =============================================================================
// email-interno-devolucao — manda o CT-e de devolução ORIGINAL pro setor de
// Devolução, em MENSAGEM NOVA E SEPARADA, sem tocar na conversa do cliente.
//
// Decisão nº 10 do Caio (2026-09-01): e-mail NOVO, fora da thread do cliente.
// No caso AGV real a operadora respondeu DENTRO da conversa do cliente
// adicionando o Leonel — a decisão substitui isso de propósito.
//
// POR QUE ISTO NÃO PODE ENTRAR EM `cards_emails_outbound` (risco R5, INV-125).
// Três estragos concretos, todos medidos no código:
//   1. `cobrar-cliente-aguardando` cobra em REPLY do ÚLTIMO outbound do card
//      (index.ts:113) ⇒ a cobrança do CT-e iria PRO LEONEL, não pro cliente;
//   2. `carregarThreadDaTratativaAtual` põe o próximo e-mail ao cliente na
//      conversa interna ⇒ o cliente recebe a thread do setor de Devolução;
//   3. `gmail-poll-inbox` casa resposta por thread/In-Reply-To contra
//      `cards_emails_outbound` (index.ts:364/543/665) ⇒ a resposta do Leonel
//      viraria "CLIENTE RESPONDEU" e acionaria a IA.
// A isolação é ESTRUTURAL: `sendGmailMessage` não escreve em
// `cards_emails_outbound` (quem escreve são os chamadores). Basta NÃO escrever.
// Guard: `email-interno-devolucao.test.ts` falha se este arquivo passar a
// mencionar a tabela.
//
// POR QUE A IDEMPOTÊNCIA É PRÓPRIA. `verificarEmailJaEnviado` procura em
// `cards_emails_outbound` por `todo_id` — e este e-mail nunca está lá, então
// aquele guard é CEGO aqui. A trava é o UNIQUE de
// `devolucoes_cte.email_interno_gmail_message_id` (mig 373), reivindicado ANTES
// do envio — mesmo padrão do envelope `lancarSswPortal`, que insere em
// `acoes_executadas_ssw` antes de chamar o SSW. Sem isso, a 2ª entrega do PGMQ
// reenviaria o documento fiscal (caso-âncora do reenvio: NF 156022, 4 e-mails
// idênticos por retry).
//
// POR QUE FALHA ALTO QUANDO O ANEXO NÃO VEM. `carregarAnexosParaEnvio` pula
// anexo ausente com `continue` SILENCIOSO (anexos-storage.ts:46-49) — devolve
// `[]` e o e-mail sai dizendo "CT-e em anexo" SEM anexo. Aqui isso é ABORTO,
// nunca envio. Mesmo princípio do ADR 0014 ("falha explícita > sucesso
// silencioso") e do `veto-agendamento.ts` ("nunca sobe pro SSW com anexo
// faltando").
//
// E POR QUE NUNCA CHAMA `finalizarAnexosPosEnvio`: ela apaga o arquivo do
// bucket e marca `deletado_em` (anexos-storage.ts:70-88). O CT-e é prova fiscal
// de ciclo aberto — este módulo faz o oposto, marca `preservar = true` ANTES de
// enviar (INV-124).
// =============================================================================

import type { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { carregarAnexosParaEnvio } from "./anexos-storage.ts";
import { sendGmailMessage } from "./gmail-sender.ts";

type SupabaseClient = ReturnType<typeof createClient>;

/** Marca o e-mail como interno. Qualquer consumidor futuro pode ignorá-lo por aqui. */
export const HEADER_INTERNO = "X-Cockpit-Interno";
export const HEADER_INTERNO_VALOR = "devolucao-cte";

/** Prefixo da reivindicação: ocupa o UNIQUE antes do envio. */
export const PREFIXO_CLAIM = "pendente:";
/** Reivindicação mais velha que isto é considerada órfã (processo morreu). */
export const CLAIM_VENCE_MS = 15 * 60 * 1000;

// -----------------------------------------------------------------------------
// PARTE PURA — decide, formata e valida. Testável sem rede e sem banco.
// -----------------------------------------------------------------------------

export interface DadosEmailInterno {
  nf: string;
  /** CTRC onde o CT-e foi anexado no SSW — é o que o setor precisa pra achar. */
  ctrc: string;
  nomeCliente?: string | null;
  quantidadeVolumes?: number | string | null;
  motivo?: string | null;
  filial?: string | null;
  nomeArquivoCte?: string | null;
}

/**
 * Assunto e corpo. O assunto segue o padrão que a operadora já usa à mão
 * (medido no vídeo: "Devolução - NF 239883") — não inventar formato novo, o
 * setor de Devolução já filtra a caixa por ele.
 */
export function montarEmailInternoDevolucao(
  d: DadosEmailInterno,
): { subject: string; texto: string } {
  const linhas: string[] = [
    "Boa tarde,",
    "",
    "Segue o CT-e de Devolução recebido do cliente, em anexo (arquivo original).",
    "",
    `NF: ${d.nf}`,
    `CTRC onde o CT-e foi anexado: ${d.ctrc}`,
  ];
  if (d.nomeCliente) linhas.push(`Cliente: ${d.nomeCliente}`);
  if (d.quantidadeVolumes != null && String(d.quantidadeVolumes).trim() !== "") {
    linhas.push(`Volumes a devolver: ${d.quantidadeVolumes}`);
  }
  if (d.motivo) linhas.push(`Motivo: ${d.motivo}`);
  if (d.filial) linhas.push(`Unidade onde estão os volumes: ${d.filial}`);
  if (d.nomeArquivoCte) linhas.push(`Arquivo: ${d.nomeArquivoCte}`);
  linhas.push(
    "",
    "A ocorrência 044 já foi lançada no SSW com o documento anexado.",
    "",
    "Obrigada.",
  );
  return {
    subject: `Devolução - NF ${d.nf}`,
    texto: linhas.join("\n"),
  };
}

/**
 * FAIL-CLOSED do anexo. Devolve o motivo do aborto, ou `null` se está tudo bem.
 *
 * Existe porque `carregarAnexosParaEnvio` pula anexo ausente em silêncio: sem
 * esta conferência, `carregados.length === 0` viraria e-mail sem anexo dizendo
 * "em anexo".
 */
export function motivoAbortoAnexo(
  esperadoId: string | null | undefined,
  carregados: ReadonlyArray<{ meta_id: string; content_base64: string; filename: string }>,
): string | null {
  if (!esperadoId) return "ciclo_sem_cte_anexo_id";
  if (carregados.length === 0) {
    return `anexo_nao_carregou:${esperadoId} (ausente no bucket ou já deletado)`;
  }
  if (carregados.length > 1) {
    return `anexo_ambiguo:${carregados.length} arquivos para 1 id`;
  }
  const a = carregados[0];
  if (!a || a.meta_id !== esperadoId) {
    return `anexo_trocado: esperado ${esperadoId}, veio ${a?.meta_id ?? "(nada)"}`;
  }
  if (!a.content_base64 || a.content_base64.length === 0) {
    return `anexo_vazio:${esperadoId}`;
  }
  if (!a.filename || a.filename.trim().length === 0) {
    return `anexo_sem_nome:${esperadoId}`;
  }
  return null;
}

/** Reivindicação órfã? (processo morreu entre reivindicar e enviar) */
export function ehClaimVencido(valor: string | null | undefined, agoraMs: number): boolean {
  if (typeof valor !== "string" || !valor.startsWith(PREFIXO_CLAIM)) return false;
  const iso = valor.slice(PREFIXO_CLAIM.length);
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return true; // reivindicação malformada é órfã
  return agoraMs - t > CLAIM_VENCE_MS;
}

/** O valor guardado é um id real do Gmail (e não uma reivindicação)? */
export function ehEnvioConcluido(valor: string | null | undefined): boolean {
  return typeof valor === "string" && valor.length > 0 && !valor.startsWith(PREFIXO_CLAIM);
}

/**
 * O e-mail interno só pode sair DEPOIS da oc 44. Espelha em código o CHECK
 * `devcte_email_depois_da_44` da mig 373 — para dar erro legível em vez de
 * violação de constraint.
 */
export function motivoAbortoOrdem(
  ciclo: { oc44_lancada_em?: string | null; cte_convertido_ok?: boolean | null },
): string | null {
  if (!ciclo.oc44_lancada_em) return "oc44_ainda_nao_lancada";
  if (ciclo.cte_convertido_ok !== true) return "conversao_do_cte_nao_confirmada";
  return null;
}

// -----------------------------------------------------------------------------
// PARTE COM EFEITO — envia. Toda decisão vem das funções puras acima.
// -----------------------------------------------------------------------------

export interface CicloParaEmail {
  id: string;
  card_id: string | null;
  nf: string;
  ctrc_origem: string;
  cte_anexo_id: string | null;
  cte_convertido_ok: boolean | null;
  oc44_lancada_em: string | null;
  email_interno_gmail_message_id: string | null;
}

export type ResultadoEmailInterno =
  | { ok: true; enviado: true; gmailMessageId: string | null }
  | { ok: true; enviado: false; motivo: "ja_enviado" | "reivindicado_por_outro" }
  | { ok: false; motivo: string };

/**
 * Manda o CT-e original pro setor de Devolução.
 *
 * Ordem deliberada (cada passo existe por um motivo):
 *   1. ordem do fluxo (44 antes do e-mail)     → aborta com erro legível
 *   2. reivindica o UNIQUE                     → mata o reenvio do retry do PGMQ
 *   3. marca `preservar` no anexo              → cleanup não leva a prova fiscal
 *   4. carrega e CONFERE o anexo               → aborta se não veio (fail-closed)
 *   5. envia SEM threadId                      → conversa nova (decisão nº 10)
 *   6. grava o id real + evento                → rastro em card_events
 * Falha em qualquer passo LIBERA a reivindicação, pra retry legítimo funcionar.
 */
export async function enviarEmailInternoDevolucao(params: {
  supabase: SupabaseClient;
  operadorId: string;
  ciclo: CicloParaEmail;
  destinatario: string;
  copia?: string[] | null;
  dados: Omit<DadosEmailInterno, "nf" | "ctrc">;
  fromName?: string | null;
  agoraMs?: number;
}): Promise<ResultadoEmailInterno> {
  const { supabase, operadorId, ciclo, destinatario, copia, dados, fromName } = params;
  const agoraMs = params.agoraMs ?? Date.now();

  // (1) ordem do fluxo
  const abortoOrdem = motivoAbortoOrdem(ciclo);
  if (abortoOrdem) return { ok: false, motivo: abortoOrdem };

  // (2) já enviado?
  if (ehEnvioConcluido(ciclo.email_interno_gmail_message_id)) {
    return { ok: true, enviado: false, motivo: "ja_enviado" };
  }

  // (2b) reivindica. Só vence quem achar o campo NULL — ou uma reivindicação
  // órfã. O UNIQUE do banco garante que dois envios simultâneos não passem.
  const claim = `${PREFIXO_CLAIM}${new Date(agoraMs).toISOString()}`;
  const anterior = ciclo.email_interno_gmail_message_id;
  const podeReivindicar = anterior == null || ehClaimVencido(anterior, agoraMs);
  if (!podeReivindicar) {
    return { ok: true, enviado: false, motivo: "reivindicado_por_outro" };
  }
  const { data: reivindicado, error: errClaim } = await supabase
    .from("devolucoes_cte")
    .update({ email_interno_gmail_message_id: claim })
    .eq("id", ciclo.id)
    .eq("email_interno_gmail_message_id", anterior as never) // null-safe: casa NULL com NULL
    .select("id")
    .maybeSingle();
  if (errClaim) return { ok: false, motivo: `claim_falhou:${errClaim.message}` };
  if (!reivindicado) return { ok: true, enviado: false, motivo: "reivindicado_por_outro" };

  const liberarClaim = async () => {
    await supabase
      .from("devolucoes_cte")
      .update({ email_interno_gmail_message_id: anterior })
      .eq("id", ciclo.id)
      .eq("email_interno_gmail_message_id", claim);
  };

  // (3) preserva a prova fiscal ANTES de qualquer coisa poder apagá-la
  if (ciclo.cte_anexo_id) {
    await supabase
      .from("email_anexos")
      .update({ preservar: true })
      .eq("id", ciclo.cte_anexo_id);
  }

  // (4) carrega e CONFERE
  const carregados = ciclo.cte_anexo_id
    ? await carregarAnexosParaEnvio(supabase, [ciclo.cte_anexo_id])
    : [];
  const abortoAnexo = motivoAbortoAnexo(ciclo.cte_anexo_id, carregados);
  if (abortoAnexo) {
    await liberarClaim();
    await registrarEvento(supabase, ciclo, "EmailInternoDevolucaoAbortado", {
      motivo: abortoAnexo,
      destinatario,
    });
    return { ok: false, motivo: abortoAnexo };
  }
  const anexo = carregados[0]!;

  // (5) envia — SEM threadId, logo conversa NOVA (decisão nº 10)
  const { subject, texto } = montarEmailInternoDevolucao({
    ...dados,
    nf: ciclo.nf,
    ctrc: ciclo.ctrc_origem,
    nomeArquivoCte: dados.nomeArquivoCte ?? anexo.filename,
  });

  const envio = await sendGmailMessage({
    supabase,
    operadorId,
    destinatario,
    cc: copia ?? null,
    subject,
    texto,
    fromName: fromName ?? null,
    attachments: [{
      filename: anexo.filename,
      mime_type: anexo.mime_type,
      content_base64: anexo.content_base64,
    }],
    extraHeaders: { [HEADER_INTERNO]: HEADER_INTERNO_VALOR },
    threadId: null,
  });

  if (!envio.ok) {
    await liberarClaim();
    await registrarEvento(supabase, ciclo, "EmailInternoDevolucaoAbortado", {
      motivo: `gmail:${envio.error}`,
      destinatario,
    });
    return { ok: false, motivo: `gmail:${envio.error}` };
  }

  // (6) grava o id real. NÃO escreve em cards_emails_outbound — ver cabeçalho.
  const idReal = envio.messageId ?? `enviado-sem-id:${new Date(agoraMs).toISOString()}`;
  await supabase
    .from("devolucoes_cte")
    .update({
      email_interno_gmail_message_id: idReal,
      email_interno_enviado_em: new Date(agoraMs).toISOString(),
    })
    .eq("id", ciclo.id)
    .eq("email_interno_gmail_message_id", claim);

  await registrarEvento(supabase, ciclo, "EmailInternoDevolucaoEnviado", {
    destinatario,
    copia: copia ?? [],
    gmail_message_id: envio.messageId,
    gmail_thread_id: envio.threadId,
    anexo_filename: anexo.filename,
    anexo_id: ciclo.cte_anexo_id,
    subject,
  });

  return { ok: true, enviado: true, gmailMessageId: envio.messageId };
}

/**
 * `card_events` é a verdade (convenção nº 1); `devolucoes_cte` é projeção.
 * Best-effort: falha aqui não desfaz um e-mail que já saiu.
 */
async function registrarEvento(
  supabase: SupabaseClient,
  ciclo: CicloParaEmail,
  tipo: "EmailInternoDevolucaoEnviado" | "EmailInternoDevolucaoAbortado",
  payload: Record<string, unknown>,
): Promise<void> {
  if (!ciclo.card_id) return;
  try {
    await supabase.from("card_events").insert({
      card_id: ciclo.card_id,
      event_type: tipo,
      actor_type: "system",
      actor_id: "email-interno-devolucao",
      payload: { ...payload, devolucao_cte_id: ciclo.id, nf: ciclo.nf, ctrc: ciclo.ctrc_origem },
    });
  } catch (_e) {
    // best-effort
  }
}
