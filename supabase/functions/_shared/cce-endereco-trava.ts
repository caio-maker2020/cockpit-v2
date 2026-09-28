// =============================================================================
// cce-endereco-trava — reentrega (oc 21) NÃO sai pela janela de veto enquanto o
// card tiver CCE de ENDEREÇO recebida por e-mail sem uma 21 lançada depois.
//
// Por que existe (Carlos 2026-09-28, âncora NF 40484 / FELIPE / TSD): o cliente
// mandou "Segue carta de correção em anexo" e a 21 saiu sozinha 1h depois, sem
// ninguém corrigir o endereço no SSW. NF 3907402: a CCE veio em 18/09 e uma
// cobrança SEM CCE em 24/09 soltou a 21 — e a entrega falhou de novo.
//
// Decisões do Carlos (28/09): (1) só CCE de ENDEREÇO — CCE de volume, pedido ou
// produto segue no automático; (2) vale até a reentrega sair (21 com sucesso em
// acoes_executadas_ssw depois da CCE); (3) cobre 3 portas — leitura do e-mail,
// rede de segurança (propostas-pos-resposta) e reanálise (agente-sugere). NÃO
// cobre robo-intranet-wurth, agente-oc13-autonomo nem
// scripts/backfill-veto-agendamentos.ts (resíduo documentado no ADR 0035);
// (4) caso duvidoso (CCE sem sinal de endereço) segue no automático.
//
// Nada é gravado para "lembrar" da CCE: a vigência é DERIVADA dos e-mails do
// card a cada tentativa de armar uma 21. O único registro novo é o evento
// CceEnderecoSegurouAutonomo, e só quando a trava de fato segurou uma 21 que
// podia sair sozinha (flag master + degrau + operador no piloto).
//
// Armadilhas medidas (60 dias): o template PROBLEMAS_COM_ENDERECO diz
// "solicitamos também o envio de uma CCe" e volta citado na resposta — ler o
// e-mail inteiro gerava 11 falsos positivos; o regex antigo não via "cc-e" nem
// CCE só no anexo. Nome do evento NÃO começa com "Acao": a função SQL
// reconciliar_execucoes_presas trata `event_type LIKE 'Acao%'` como execução.
// =============================================================================

import {
  agendarAcaoAutonomaSeElegivel,
  type EntradaAgendamentoVeto,
  type ResultadoAgendamento,
} from "./veto-agendamento.ts";
import { FLAG_VETO } from "./acao-autonoma-veto.ts";
import { separarTextoDoCliente } from "./texto-citado-email.ts";

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

export const EVENTO_CCE_SEGUROU = "CceEnderecoSegurouAutonomo" as const;
export const MOTIVO_CCE_ENDERECO = "cce_endereco_recebida" as const;
export const MOTIVO_VERIFICACAO_FALHOU = "cce_verificacao_falhou" as const;

/** Chaves da reentrega. A variante com e-mail não existe na escada hoje; entra
 *  aqui para uma ativação futura não reabrir o buraco. */
export const CHAVES_REENTREGA: ReadonlySet<string> = new Set([
  "lancar_ocorrencia:21",
  "lancar_oc_e_enviar_email:21",
]);

/** Quantas mensagens recentes do card são relidas (as mais novas primeiro). */
export const LIMITE_MENSAGENS = 50;

const FRASE_TEMPLATE_PEDE_CCE =
  /caso\s+necess[aá]rio,?\s+solicitamos\s+tamb[eé]m\s+o\s+envio\s+de\s+uma\s+cc-?e\.?/gi;

const CCE_NO_TEXTO: readonly RegExp[] = [
  /\bcce\b/i,
  /carta\s+(de\s+)?corre[cç][aã]o/i,
  /\bcc\s?-\s?e\b/i,
  /\bc\.c\.e\b/i,
];

const CCE_NO_NOME_DO_ANEXO =
  /(^|[^a-z0-9])(cc-?e|dacce|cce)([^a-z]|$)|carta[\s_-]*(de[\s_-]*)?corre[cç][aã]o/i;

// Sem "rua"/"av."/"CEP": aparecem em assinatura e marcariam CCE de volume como
// de endereço.
const ENDERECO_NO_TEXTO_DO_CLIENTE =
  /endere[cç]o|maps\.app\.goo\.gl|goo\.gl\/maps|google\.[a-z.]+\/maps|local\s+de\s+entrega|n[uú]mero\s+da\s+casa|logradouro/i;

// "Insucesso na entrega" é o assunto do template PROBLEMAS_COM_ENDERECO.
const ENDERECO_NO_ASSUNTO = /insucesso\s+na\s+entrega|endere[cç]o|di[vr]i?e?rg[eê]ncia\s+(de\s+)?cidade/i;

export function ehChaveDeReentrega(acaoKey: string | null | undefined): boolean {
  return !!acaoKey && CHAVES_REENTREGA.has(acaoKey);
}

/** O que o cliente escreveu, sem a citação do nosso e-mail e sem a frase do
 *  template que pede CCE. A frase sai SEMPRE: quando o cliente repassa o nosso
 *  e-mail ela fica ACIMA do marcador de citação (NF 29819, 1 em 2.115). */
export function textoEscritoPeloCliente(conteudo: string | null | undefined): string {
  return separarTextoDoCliente(conteudo).textoCliente.replace(FRASE_TEMPLATE_PEDE_CCE, " ");
}

export interface CceDetectada {
  origem: "texto" | "anexo";
  trecho: string;
}

export function detectarCceNoEmail(p: {
  conteudo: string | null | undefined;
  anexos: readonly string[];
}): CceDetectada | null {
  const texto = textoEscritoPeloCliente(p.conteudo);
  for (const re of CCE_NO_TEXTO) {
    const m = re.exec(texto);
    if (m) {
      const ini = Math.max(0, m.index - 80);
      return { origem: "texto", trecho: texto.slice(ini, m.index + 120).replace(/\s+/g, " ").trim() };
    }
  }
  const anexo = p.anexos.find((f) => CCE_NO_NOME_DO_ANEXO.test(f ?? ""));
  return anexo ? { origem: "anexo", trecho: anexo.slice(0, 200) } : null;
}

export function temContextoDeEndereco(p: {
  textoCliente: string;
  assuntoMensagem: string | null | undefined;
  assuntoNossoEmailAnterior: string | null | undefined;
}): boolean {
  return ENDERECO_NO_TEXTO_DO_CLIENTE.test(p.textoCliente) ||
    ENDERECO_NO_ASSUNTO.test(p.assuntoMensagem ?? "") ||
    ENDERECO_NO_ASSUNTO.test(p.assuntoNossoEmailAnterior ?? "");
}

export interface MensagemDoCard {
  id: string;
  recebidoEm: string;
  conteudo: string | null;
  assunto: string | null;
  anexos: readonly string[];
}

export interface EmailNossoEnviado {
  enviadoEm: string;
  assunto: string | null;
}

export interface CceEnderecoVigente extends CceDetectada {
  mensagemId: string;
  recebidaEm: string;
}

/**
 * Pura. A CCE de endereço mais recente recebida DEPOIS da última 21 com
 * sucesso (ou em qualquer momento, se nunca houve 21). null = nada vigente.
 */
export function decidirCceEnderecoVigente(p: {
  mensagens: readonly MensagemDoCard[];
  enviados: readonly EmailNossoEnviado[];
  ultima21SucessoEm: string | null;
}): CceEnderecoVigente | null {
  const corte = p.ultima21SucessoEm ? Date.parse(p.ultima21SucessoEm) : Number.NEGATIVE_INFINITY;
  const enviados = [...p.enviados]
    .filter((e) => Number.isFinite(Date.parse(e.enviadoEm)))
    .sort((a, b) => Date.parse(b.enviadoEm) - Date.parse(a.enviadoEm));
  const candidatas = [...p.mensagens]
    .filter((m) => Date.parse(m.recebidoEm) > corte)
    .sort((a, b) => Date.parse(b.recebidoEm) - Date.parse(a.recebidoEm));
  for (const m of candidatas) {
    const cce = detectarCceNoEmail({ conteudo: m.conteudo, anexos: m.anexos });
    if (!cce) continue;
    const recebida = Date.parse(m.recebidoEm);
    const anterior = enviados.find((e) => Date.parse(e.enviadoEm) < recebida) ?? null;
    const ctx = temContextoDeEndereco({
      textoCliente: textoEscritoPeloCliente(m.conteudo),
      assuntoMensagem: m.assunto,
      assuntoNossoEmailAnterior: anterior?.assunto ?? null,
    });
    if (ctx) return { ...cce, mensagemId: m.id, recebidaEm: m.recebidoEm };
  }
  return null;
}

function mensagemDeErro(error: unknown): string {
  return (error as { message?: string } | null)?.message ?? String(error);
}

function falhou(tabela: string, error: unknown): never {
  throw new Error(`consulta ${tabela} falhou: ${mensagemDeErro(error)}`);
}

/** Lê os e-mails do card e decide. Lança em erro de consulta (quem chama
 *  segura a 21 — fail-safe). */
export async function carregarCceEnderecoVigente(
  supabase: SupabaseClient,
  cardId: string,
): Promise<CceEnderecoVigente | null> {
  const ult = await supabase
    .from("acoes_executadas_ssw")
    .select("iniciado_em")
    .eq("card_id", cardId)
    .eq("codigo_oc", 21)
    .eq("sucesso", true)
    .order("iniciado_em", { ascending: false })
    .limit(1);
  if (ult.error) falhou("acoes_executadas_ssw", ult.error);
  const ultima21SucessoEm = ((ult.data ?? []) as Array<{ iniciado_em: string | null }>)[0]?.iniciado_em ?? null;

  const msgs = await supabase
    .from("messages_inbox")
    .select("id, recebido_em, conteudo, assunto:raw_payload->>subject")
    .eq("card_id", cardId)
    .eq("canal", "email")
    .order("recebido_em", { ascending: false })
    .limit(LIMITE_MENSAGENS);
  if (msgs.error) falhou("messages_inbox", msgs.error);
  const linhas = (msgs.data ?? []) as Array<{
    id: string;
    recebido_em: string;
    conteudo: string | null;
    assunto: string | null;
  }>;
  if (linhas.length === 0) return null;

  const anx = await supabase
    .from("email_anexos")
    .select("message_inbox_id, filename")
    .in("message_inbox_id", linhas.map((l) => l.id))
    .eq("origem", "inbound");
  if (anx.error) falhou("email_anexos", anx.error);
  const anexosPorMsg = new Map<string, string[]>();
  for (const a of (anx.data ?? []) as Array<{ message_inbox_id: string | null; filename: string | null }>) {
    if (!a.message_inbox_id || !a.filename) continue;
    const lista = anexosPorMsg.get(a.message_inbox_id) ?? [];
    lista.push(a.filename);
    anexosPorMsg.set(a.message_inbox_id, lista);
  }

  const env = await supabase
    .from("cards_emails_outbound")
    .select("subject, sent_at")
    .eq("card_id", cardId)
    .order("sent_at", { ascending: false })
    .limit(100);
  if (env.error) falhou("cards_emails_outbound", env.error);

  return decidirCceEnderecoVigente({
    ultima21SucessoEm,
    mensagens: linhas.map((l) => ({
      id: l.id,
      recebidoEm: l.recebido_em,
      conteudo: l.conteudo,
      assunto: l.assunto,
      anexos: anexosPorMsg.get(l.id) ?? [],
    })),
    enviados: ((env.data ?? []) as Array<{ subject: string | null; sent_at: string | null }>)
      .filter((e) => !!e.sent_at)
      .map((e) => ({ enviadoEm: e.sent_at as string, assunto: e.subject })),
  });
}

/**
 * A 21 PODERIA sair sozinha? Mesmas três cercas de sistema do agendador (flag
 * master, degrau da escada, dono do card no piloto). false = o agendador já
 * recusaria — a trava nem consulta os e-mails e o fluxo fica idêntico ao de hoje.
 */
async function autonomiaPodeAgir(supabase: SupabaseClient, cardId: string, acaoKey: string): Promise<boolean> {
  const flag = await supabase.from("feature_flags").select("enabled").eq("key", FLAG_VETO).maybeSingle();
  if (flag.error) falhou("feature_flags", flag.error);
  if ((flag.data as { enabled?: boolean } | null)?.enabled !== true) return false;

  const degrau = await supabase
    .from("acoes_autonomas_veto_config").select("ativa").eq("acao_key", acaoKey).maybeSingle();
  if (degrau.error) falhou("acoes_autonomas_veto_config", degrau.error);
  if ((degrau.data as { ativa?: boolean } | null)?.ativa !== true) return false;

  const card = await supabase.from("cards").select("assigned_operator_id").eq("id", cardId).maybeSingle();
  if (card.error) falhou("cards", card.error);
  const donoId = (card.data as { assigned_operator_id?: string | null } | null)?.assigned_operator_id ?? null;
  if (!donoId) return false;

  const piloto = await supabase
    .from("acoes_autonomas_veto_operadores").select("ativo").eq("operador_id", donoId).maybeSingle();
  if (piloto.error) falhou("acoes_autonomas_veto_operadores", piloto.error);
  return (piloto.data as { ativo?: boolean } | null)?.ativo === true;
}

/** Best-effort e sem duplicar: uma linha por (CCE, chave). Nunca lança. O
 *  supabase-js devolve { error } em vez de lançar — sem o aviso, o log diria
 *  "21 SEGURADA" com o card sem registro. */
async function registrarSegurou(
  supabase: SupabaseClient,
  i: EntradaAgendamentoVeto,
  cce: CceEnderecoVigente,
): Promise<void> {
  try {
    const { data: recentes, error } = await supabase
      .from("card_events")
      .select("payload")
      .eq("card_id", i.cardId)
      .eq("event_type", EVENTO_CCE_SEGUROU)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) {
      console.warn(`[cce-trava] evento não registrado (card ${i.cardId}): checagem de duplicidade falhou: ${mensagemDeErro(error)}`);
      return;
    }
    const jaTem = ((recentes ?? []) as Array<{ payload: Record<string, unknown> | null }>).some((e) =>
      e.payload?.["mensagem_cce_id"] === cce.mensagemId && e.payload?.["acao_key"] === i.acaoKey
    );
    if (jaTem) return;
    const { error: erroInsert } = await supabase.from("card_events").insert({
      card_id: i.cardId,
      event_type: EVENTO_CCE_SEGUROU,
      actor_type: "system",
      actor_id: i.agentName,
      payload: {
        motivo: MOTIVO_CCE_ENDERECO,
        acao_key: i.acaoKey,
        mensagem_cce_id: cce.mensagemId,
        cce_recebida_em: cce.recebidaEm,
        origem: cce.origem,
        trecho: cce.trecho,
        oc_sugerida: i.ocSugerida,
        confianca: i.confianca,
        explicacao: "CCE de endereço recebida e nenhuma oc 21 lançada depois dela: a reentrega " +
          "fica para o operador aprovar (corrigir o endereço no SSW antes).",
      },
    });
    if (erroInsert) console.warn(`[cce-trava] registro do evento falhou (card ${i.cardId}): ${mensagemDeErro(erroInsert)}`);
  } catch (e) {
    console.warn(`[cce-trava] registro do evento falhou (card ${i.cardId}): ${e instanceof Error ? e.message : e}`);
  }
}

export interface DependenciasTrava {
  agendar: (supabase: SupabaseClient, i: EntradaAgendamentoVeto) => Promise<ResultadoAgendamento>;
}

/**
 * Substitui a chamada direta a agendarAcaoAutonomaSeElegivel nas 3 portas.
 * Qualquer chave que não seja 21 → delega sem nenhuma consulta a mais.
 */
export async function agendarComTravaCce(
  supabase: SupabaseClient,
  i: EntradaAgendamentoVeto,
  deps: DependenciasTrava = { agendar: agendarAcaoAutonomaSeElegivel },
): Promise<ResultadoAgendamento> {
  if (!ehChaveDeReentrega(i.acaoKey)) return deps.agendar(supabase, i);

  let cce: CceEnderecoVigente | null;
  try {
    if (!(await autonomiaPodeAgir(supabase, i.cardId, i.acaoKey as string))) return deps.agendar(supabase, i);
    cce = await carregarCceEnderecoVigente(supabase, i.cardId);
  } catch (e) {
    console.warn(
      `[cce-trava] verificação falhou (card ${i.cardId}) — 21 fica para o operador: ${e instanceof Error ? e.message : e}`,
    );
    return { agendou: false, motivo: MOTIVO_VERIFICACAO_FALHOU };
  }
  if (!cce) return deps.agendar(supabase, i);

  await registrarSegurou(supabase, i, cce);
  console.log(`[cce-trava] 21 SEGURADA card=${i.cardId} msg=${cce.mensagemId} origem=${cce.origem}`);
  return { agendou: false, motivo: MOTIVO_CCE_ENDERECO };
}
