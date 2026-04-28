/**
 * Regras determinísticas de vinculação de mensagem a card existente.
 *
 * 6 prioridades, na ordem (a primeira que casa vence):
 *   1. CTRC explícito na mensagem
 *   2. NF explícita na mensagem
 *   3. Domínio do e-mail bate com pagador (apenas canal=email)
 *   4. Contato cadastrado bate com empresa_cliente (apenas canal=whatsapp)
 *   5. Mesma thread (heurística IA, janela 48h) — TODO: mover pro vinculador-LLM
 *   6. Agrupamento rápido: mesmo remetente, últimos 4 minutos, aguardando resposta
 *
 * Funções puras: recebem um `CardLookup` que abstrai I/O de banco.
 * Isso deixa as regras testáveis sem Supabase e mantém a Edge Function fina.
 *
 * Origem do design: edge-functions/webhook/index.ts (v1), preservando ordem
 * que o time já viu funcionar em produção.
 */

import {
  extractCTRCs,
  extractEmailDomainBase,
  extractNFs,
} from "./extractors.js";

export type Canal = "whatsapp" | "email" | "sistema";

export interface MessageInput {
  canal: Canal;
  remetente: string;
  conteudo: string;
}

export interface MatchedCard {
  cardId: string;
  /** Snapshot leve do card achado — útil pra logging e auditoria. */
  nf: string | null;
  ctrc: string | null;
}

export interface ContactInfo {
  empresaCliente: string | null;
}

/**
 * Boundary de I/O. Cada implementação concreta (Supabase, in-memory pra teste)
 * fornece esses lookups. Todos retornam `null` se nada bater.
 */
export interface CardLookup {
  byCtrc(ctrc: string): Promise<MatchedCard | null>;
  byNf(nf: string): Promise<MatchedCard | null>;
  byEmailDomainBase(domainBase: string): Promise<MatchedCard | null>;
  byContactCompany(empresa: string): Promise<MatchedCard | null>;
  byRecentSender(
    remetente: string,
    withinMs: number
  ): Promise<MatchedCard | null>;
  /** Lookup do contato cadastrado pelo identificador (telefone / e-mail). */
  contactByIdentifier(identifier: string): Promise<ContactInfo | null>;
}

export type DedupReason =
  | "ctrc_match"
  | "nf_match"
  | "email_domain_match"
  | "contact_match"
  | "ai_thread_match"
  | "rapid_grouping_4min"
  | "no_match";

export interface DedupResult {
  card: MatchedCard | null;
  reason: DedupReason;
  /** Detalhes legíveis pra audit_log. */
  detail: string;
}

const FOUR_MINUTES_MS = 4 * 60 * 1000;

/**
 * Aplica as 6 prioridades em ordem. Para na primeira que casa.
 */
export async function findExistingCard(
  msg: MessageInput,
  lookup: CardLookup
): Promise<DedupResult> {
  const ctrcs = extractCTRCs(msg.conteudo);
  const nfs = extractNFs(msg.conteudo);

  // Prioridade 1 — CTRC explícito
  for (const ctrc of ctrcs) {
    const card = await lookup.byCtrc(ctrc);
    if (card) {
      return { card, reason: "ctrc_match", detail: `CTRC ${ctrc}` };
    }
  }

  // Prioridade 2 — NF explícita
  for (const nf of nfs) {
    const card = await lookup.byNf(nf);
    if (card) {
      return { card, reason: "nf_match", detail: `NF ${nf}` };
    }
  }

  // Prioridade 3 — domínio do e-mail bate com pagador
  if (msg.canal === "email") {
    const domainBase = extractEmailDomainBase(msg.remetente);
    if (domainBase) {
      const card = await lookup.byEmailDomainBase(domainBase);
      if (card) {
        return {
          card,
          reason: "email_domain_match",
          detail: `domínio ${domainBase}`,
        };
      }
    }
  }

  // Prioridade 4 — contato (WhatsApp) bate com empresa
  if (msg.canal === "whatsapp") {
    const contact = await lookup.contactByIdentifier(msg.remetente);
    if (contact?.empresaCliente) {
      const card = await lookup.byContactCompany(contact.empresaCliente);
      if (card) {
        return {
          card,
          reason: "contact_match",
          detail: `empresa ${contact.empresaCliente}`,
        };
      }
    }
  }

  // Prioridade 5 — AI thread match (48h, mesma conversa, problemas correlatos)
  // TODO(fase-1): mover pro vinculador-LLM (Haiku 4.5) com prompt dedicado
  // em prompts/vinculador.md. Por ora, deixamos passar para a regra 6 — o
  // vinculador-LLM ainda não existe e o atalho do v1 com Sonnet inline foi
  // removido para evitar custo + variância sem prompt versionado.

  // Prioridade 6 — agrupamento rápido (mesmo remetente, últimos 4min)
  const recent = await lookup.byRecentSender(msg.remetente, FOUR_MINUTES_MS);
  if (recent) {
    return {
      card: recent,
      reason: "rapid_grouping_4min",
      detail: `mesmo remetente em <4min`,
    };
  }

  return { card: null, reason: "no_match", detail: "nenhuma regra casou" };
}
