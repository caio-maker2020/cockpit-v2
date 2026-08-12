// =============================================================================
// cce-wurth — detecção da Carta de Correção Eletrônica (Würth/Ingrid, 11/08).
//
// Fluxo real (vídeo "Carta de Correção"): problema de endereço → notificamos →
// a intranet marca Obs "CCE ENVIADA" → a carta chega num E-MAIL NOVO (porta
// thread-nova) com o PDF do evento SEFAZ anexo.
//
// Decisão do Caio: correção de endereço é MANUAL por enquanto — o agente
// detecta a CCE, o anexo já fica no card (inbound), e SUGERE a oc 21 com o
// aviso "corrigir o endereço no SSW antes de reentregar". Automação da
// correção vem depois (vídeo prometido) — a estrutura já fica pronta.
// =============================================================================

/** E-mail é uma CCE? (assunto OU corpo). Palavra CCE isolada ou por extenso. */
export function ehEmailCce(subject: string | null | undefined, corpo: string | null | undefined): boolean {
  const texto = `${subject ?? ""}\n${corpo ?? ""}`;
  return /\bCCE\b/i.test(texto) || /carta\s+de\s+corre[cç][aã]o/i.test(texto);
}

/** A Obs da intranet Würth indica CCE enviada? (gatilho, Caio 2026-08-12). */
export function obsIndicaCce(obs: string | null | undefined): boolean {
  const t = obs ?? "";
  return /\bCCE\b/i.test(t) || /carta\s+de\s+corre[cç][aã]o/i.test(t);
}

export const AVISO_CCE =
  "⚠️ CCE recebida (carta de correção do endereço, anexa no card) — CORRIGIR O " +
  "ENDEREÇO NO SSW antes de aprovar a reentrega. Correção é manual por enquanto.";

/**
 * As DUAS mensagens que o Caio pediu (2026-08-12) quando a CCE é detectada na
 * intranet: (1) lembrar de trocar o endereço, (2) confirmar que a carta já
 * está anexada no card. `anexada=false` avisa que não achou o e-mail.
 */
export function montarAvisosCce(nf: string | null, anexada: boolean): { trocarEndereco: string; anexo: string } {
  const nfTxt = nf ?? "(sem NF)";
  return {
    trocarEndereco:
      `📍 A Würth enviou a Carta de Correção do endereço da NF ${nfTxt} (apareceu na ` +
      `intranet). CORRIJA O ENDEREÇO no SSW e depois aprove a reentrega (oc 21).`,
    anexo: anexada
      ? `📎 Já anexei a carta de correção (PDF) neste card — abra a aba de anexos para conferir o endereço novo.`
      : `⚠️ A intranet indicou CCE para a NF ${nfTxt}, mas eu NÃO localizei o e-mail com a carta ` +
        `na caixa. Procure a CCE manualmente e anexe no card.`,
  };
}

type SupabaseLike = {
  from: (t: string) => {
    // deno-lint-ignore no-explicit-any
    [k: string]: any;
  };
};

/**
 * Se a mensagem é CCE e o card é de cliente com intranet Würth: cria a
 * proposta 21 RECOMENDADA com o aviso (idempotente) + card_event.
 * Retorna true quando criou.
 */
export async function criarPropostaCceSeAplicavel(
  supabaseClient: unknown,
  p: { cardId: string; messageId: string | null; subject: string | null; corpo: string | null },
): Promise<boolean> {
  if (!ehEmailCce(p.subject, p.corpo)) return false;
  const supabase = supabaseClient as SupabaseLike;

  // Só cliente com retorno via intranet Würth (config, nunca hardcode).
  const { data: card } = await supabase
    .from("cards")
    .select("nf, agent_state")
    .eq("id", p.cardId)
    .maybeSingle();
  if (!card) return false;
  const pag = String(
    ((card as { agent_state?: Record<string, unknown> | null }).agent_state?.["cnpj_pagador"]) ?? "",
  ).replace(/\D/g, "");
  if (!pag) return false;
  const { data: cfg } = await supabase
    .from("cliente_config")
    .select("intranet_wurth")
    .eq("cnpj_pagador", pag)
    .eq("ativo", true)
    .maybeSingle();
  if (!(cfg as { intranet_wurth?: boolean } | null)?.intranet_wurth) return false;

  // Idempotência: uma proposta CCE pendente por card.
  const { data: todos } = await supabase
    .from("todos")
    .select("id, status, proposta_payload")
    .eq("card_id", p.cardId);
  const jaTem = ((todos ?? []) as Array<{ status: string; proposta_payload: { meta?: { origem?: string } } | null }>)
    .some((t) =>
      ["pendente", "aguardando_aprovacao"].includes(t.status) &&
      t.proposta_payload?.meta?.origem === "cce-wurth"
    );
  if (jaTem) return false;

  const nf = (card as { nf?: string | null }).nf ?? null;
  await supabase.from("todos").insert({
    card_id: p.cardId,
    action_id: crypto.randomUUID(),
    descricao: "Lançar oc 21 — CCE recebida (CORRIGIR ENDEREÇO no SSW antes)",
    status: "pendente",
    proposta_payload: {
      tool: "lancar_ocorrencia",
      acao_key: "lancar_ocorrencia:21",
      recomendada: true,
      aviso: AVISO_CCE,
      args: {
        codigo_ssw: 21,
        nf,
        descricao: "Reentrega após CCE — endereço corrigido pelo cliente via carta de correção",
      },
      rationale:
        "Cliente Würth enviou a Carta de Correção Eletrônica (e-mail novo, PDF anexo no card). " +
        "Padrão do processo: corrigir o endereço no SSW e lançar a 21 pra base seguir com a entrega.",
      texto: null,
      meta: { origem: "cce-wurth", tinha_intencao_email: false, modo: "sem_email" },
    },
  });

  await supabase.from("card_events").insert({
    card_id: p.cardId,
    event_type: "CceWurthDetectada",
    actor_type: "system",
    actor_id: "vinculador",
    payload: {
      message_id: p.messageId,
      subject: p.subject,
      aviso: AVISO_CCE,
      correcao_endereco: "manual (automação futura — vídeo do Caio)",
    },
  });
  return true;
}
