// =============================================================================
// replay-chat-core.ts — replay COMPACTO pro chat do agente-chefe (Fase 2).
//
// Mesma metodologia do evals/replay-regras.ts v3 (braço de controle: o MESMO
// juiz decide sem e com a regra; efeito = com − sem), reduzida pra rodar
// DENTRO de um turno de conversa (~20-40s): 12 casos do padrão + 6 de
// controle, juiz Sonnet, chamadas em paralelo.
//
// Lições herdadas do v1→v3 (03-04/08): juiz cego reprova regra boa (recebe o
// e-mail do cliente + decisão completa); comparar juiz-com-regra contra o
// AGENTE mede juiz≠agente, não o efeito (braço sem-regra obrigatório).
// =============================================================================

import { type SupabaseClient as SupabaseClientGeneric } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export const REPLAY_JUIZ_MODEL = "claude-sonnet-4-6";
const CATALOGO_OCS =
  "10=recusa total | 11=problema endereço | 13=limitação cliente | 19=falta volumes | " +
  "20=extravio localizado | 21=reentrega solicitada | 33=reversão perdas | 35=recusa parcial | " +
  "41=acareação | 44=retorno de carga | 49=tratativa relacionamento | 54=aguardando cliente | " +
  "55=seguir entrega/parcial | 56=falta info operacional | 59=pendência indenização";

interface CasoReplay {
  nf: string | null;
  gabarito: number;
  oc_sugerida: number | null;
  contexto: Record<string, unknown>;
}

export interface ResultadoReplay {
  n_padrao: number;
  n_controle: number;
  agente_pct: number;
  sem_pct: number;
  com_pct: number;
  efeito_padrao: number;
  controle_sem_pct: number | null;
  controle_com_pct: number | null;
  efeito_colateral: number | null;
  veredito: "MELHORA" | "PIORA" | "EMPATE" | "MELHORA_COM_DANO";
}

export function decidirVereditoReplay(
  efeitoPadrao: number,
  efeitoColateral: number | null,
): ResultadoReplay["veredito"] {
  // tolerância maior no controle: n pequeno (6) = 1 caso ≈ 17 pts
  const danoso = efeitoColateral !== null && efeitoColateral < -20;
  if (efeitoPadrao > 0 && !danoso) return "MELHORA";
  if (efeitoPadrao > 0 && danoso) return "MELHORA_COM_DANO";
  if (efeitoPadrao < 0) return "PIORA";
  return "EMPATE";
}

export function formatarResultadoReplay(r: ResultadoReplay): string {
  const linhas = [
    `Teste em ${r.n_padrao} casos reais do padrão + ${r.n_controle} de controle:`,
    `- hoje o agente acerta ${r.agente_pct}% neste padrão`,
    `- juiz SEM a regra: ${r.sem_pct}% | juiz COM a regra: ${r.com_pct}% → efeito da regra: ${r.efeito_padrao >= 0 ? "+" : ""}${r.efeito_padrao} pts`,
    r.controle_sem_pct !== null
      ? `- controle (casos que já davam certo): ${r.controle_sem_pct}% → ${r.controle_com_pct}% (${r.efeito_colateral! >= 0 ? "+" : ""}${r.efeito_colateral} pts)`
      : "- controle: casos insuficientes",
    `VEREDITO: ${r.veredito}`,
  ];
  return linhas.join("\n");
}

function parseChave(chave: string): { agente: string; ocSug: number | null } | null {
  const m = /^(.+):sug(\d+|sem)$/.exec(chave);
  if (!m) return null;
  return { agente: m[1], ocSug: m[2] === "sem" ? null : Number(m[2]) };
}

const RUIDO = new Set([
  "corpo_email_sugerido",
  "template_email_sugerido",
  "proposta_destacada_acao",
  "sugerido_em",
  "message_id",
]);

async function carregarCasos(
  supabase: SupabaseClient,
  agente: string,
  ocSug: number | null,
  modo: "padrao" | "controle",
  limite: number,
  ocCard?: number | null,
): Promise<CasoReplay[]> {
  let q = supabase
    .from("v_sinal_ouro_casos")
    .select("nf, veredito, oc_card, oc_sugerida, oc_executada, decisao_ia")
    .eq("agent_name", agente)
    .order("decidido_em", { ascending: false })
    .limit(limite);
  if (modo === "padrao") {
    q = q.in("veredito", ["seguida", "corrigida"]);
    if (ocSug !== null) q = q.eq("oc_sugerida", ocSug);
    if (typeof ocCard === "number") q = q.eq("oc_card", ocCard);
  } else {
    q = q.eq("veredito", "seguida");
    if (ocSug !== null) q = q.neq("oc_sugerida", ocSug);
    // controle no MESMO contexto de card (senão compara laranja com maçã)
    if (typeof ocCard === "number") q = q.eq("oc_card", ocCard);
  }
  const { data } = await q;
  const rows = (data ?? []) as Array<Record<string, unknown>>;

  // e-mails do cliente (fundamentais pro interpretador — lição do juiz cego)
  const ids = [
    ...new Set(rows
      .map((r) => ((r["decisao_ia"] ?? {}) as Record<string, unknown>)["message_id"])
      .filter((v): v is string => typeof v === "string" && v.length === 36)),
  ];
  const emails = new Map<string, string>();
  if (ids.length > 0) {
    const { data: msgs } = await supabase
      .from("messages_inbox")
      .select("id, conteudo")
      .in("id", ids);
    for (const m of (msgs ?? []) as Array<{ id: string; conteudo: string | null }>) {
      if (m.conteudo) emails.set(m.id, m.conteudo.replace(/\s+/g, " ").slice(0, 2500));
    }
  }

  return rows.flatMap((r) => {
    const gabarito = r["veredito"] === "seguida"
      ? r["oc_sugerida"] as number | null
      : r["oc_executada"] as number | null;
    if (typeof gabarito !== "number") return [];
    const d = { ...((r["decisao_ia"] ?? {}) as Record<string, unknown>) };
    const mid = d["message_id"];
    for (const k of RUIDO) delete d[k];
    return [{
      nf: (r["nf"] as string) ?? null,
      gabarito,
      oc_sugerida: (r["oc_sugerida"] as number) ?? null,
      contexto: {
        ocorrencia_atual_do_card: r["oc_card"],
        email_do_cliente: typeof mid === "string" ? emails.get(mid) ?? "(sem e-mail)" : "(sem e-mail)",
        evidencia_e_leitura_do_agente: d,
      },
    }];
  });
}

async function julgar(
  anthropicKey: string,
  caso: CasoReplay,
  regra: string | null,
): Promise<number | null> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: REPLAY_JUIZ_MODEL,
      max_tokens: 50,
      system:
        "Você decide qual ocorrência SSW lançar num card de transportadora. " +
        (regra ? "Aplique RIGOROSAMENTE a REGRA fornecida; se não se aplicar, decida pelo bom senso. " : "Decida pelo bom senso operacional e pela evidência. ") +
        `Responda APENAS o número. Ocorrências: ${CATALOGO_OCS}`,
      messages: [{
        role: "user",
        content: (regra ? `REGRA (aprovada pela gestão):\n${regra}\n\n` : "") +
          `CASO:\n${JSON.stringify(caso.contexto)}\n\nQual ocorrência? Só o número.`,
      }],
    }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const num = /\d+/.exec(j?.content?.[0]?.text ?? "")?.[0];
  return num ? Number(num) : null;
}

/**
 * Quando o filtro não acha casos, conta as alternativas e devolve a dica —
 * é o que impede o agente de concluir "falta capacidade" quando na verdade
 * mirou a coluna errada (oc do card × oc sugerida pela IA).
 */
async function diagnosticarFiltro(
  supabase: SupabaseClient,
  agente: string,
  ocSug: number | null,
  ocCard: number | null,
): Promise<string> {
  try {
    const contar = async (col: "oc_sugerida" | "oc_card", valor: number) => {
      const { count } = await supabase
        .from("v_sinal_ouro_casos")
        .select("nf", { count: "exact", head: true })
        .eq("agent_name", agente)
        .eq(col, valor)
        .in("veredito", ["seguida", "corrigida"]);
      return count ?? 0;
    };
    const partes: string[] = [];
    if (ocSug !== null && ocCard === null) {
      const comoCard = await contar("oc_card", ocSug);
      if (comoCard >= 5) {
        partes.push(
          `ATENÇÃO: existem ${comoCard} casos com oc ${ocSug} como OCORRÊNCIA DO CARD. ` +
          `Você provavelmente quis dizer oc_do_card=${ocSug} — repita o teste informando oc_do_card ` +
          `e a oc que a IA SUGERE nesse padrão (ex: oc_sugerida_pela_ia).`,
        );
      }
    }
    if (ocCard !== null && ocSug !== null) {
      const soCard = await contar("oc_card", ocCard);
      partes.push(`Com oc_do_card=${ocCard} sozinho existem ${soCard} casos — talvez a oc sugerida (${ocSug}) esteja errada.`);
    }
    if (partes.length === 0) partes.push("Confira o agente e as ocorrências informadas, ou tente uma janela maior.");
    return partes.join(" ");
  } catch {
    return "";
  }
}

const pct = (n: number, total: number): number => total > 0 ? Math.round((100 * n) / total) : 0;

/** Roda o replay compacto. ~20-40s com os defaults. */
export async function rodarReplayCompacto(
  supabase: SupabaseClient,
  anthropicKey: string,
  chave: string,
  regra: string,
  opts?: { nPadrao?: number; nControle?: number; ocCard?: number | null },
): Promise<ResultadoReplay | { erro: string }> {
  const parsed = parseChave(chave);
  if (!parsed) return { erro: `chave inválida: ${chave}` };
  const ocCard = opts?.ocCard ?? null;
  const [casosPadrao, casosControle] = await Promise.all([
    carregarCasos(supabase, parsed.agente, parsed.ocSug, "padrao", opts?.nPadrao ?? 12, ocCard),
    carregarCasos(supabase, parsed.agente, parsed.ocSug, "controle", opts?.nControle ?? 6, ocCard),
  ]);
  if (casosPadrao.length < 5) {
    // A ferramenta ENSINA o uso certo em vez de só falhar (incidente 08/08:
    // o agente passou a oc do CARD como oc sugerida, achou 0 casos e concluiu
    // "falta capacidade" — quando havia 172 casos disponíveis).
    const diag = await diagnosticarFiltro(supabase, parsed.agente, parsed.ocSug, ocCard);
    return { erro: `só ${casosPadrao.length} casos com este filtro (mínimo 5). ${diag}` };
  }

  // 2 julgamentos por caso (sem/com), tudo em paralelo
  const julgamentos = await Promise.all(
    [...casosPadrao, ...casosControle].map(async (c) => {
      const [sem, com] = await Promise.all([
        julgar(anthropicKey, c, null),
        julgar(anthropicKey, c, regra),
      ]);
      return { c, sem, com };
    }),
  );

  const stats = (grupo: CasoReplay[]) => {
    let n = 0, agenteOk = 0, semOk = 0, comOk = 0;
    for (const j of julgamentos) {
      if (!grupo.includes(j.c) || j.sem === null || j.com === null) continue;
      n += 1;
      if (j.c.oc_sugerida === j.c.gabarito) agenteOk += 1;
      if (j.sem === j.c.gabarito) semOk += 1;
      if (j.com === j.c.gabarito) comOk += 1;
    }
    return { n, agenteOk, semOk, comOk };
  };
  const p = stats(casosPadrao);
  const ctl = stats(casosControle);
  if (p.n < 5) return { erro: "julgamentos insuficientes (falhas na API)" };

  const semP = pct(p.semOk, p.n);
  const comP = pct(p.comOk, p.n);
  const efeitoPadrao = comP - semP;
  const ctlSem = ctl.n >= 4 ? pct(ctl.semOk, ctl.n) : null;
  const ctlCom = ctl.n >= 4 ? pct(ctl.comOk, ctl.n) : null;
  const efeitoColateral = ctlSem !== null && ctlCom !== null ? ctlCom - ctlSem : null;

  return {
    n_padrao: p.n,
    n_controle: ctl.n,
    agente_pct: pct(p.agenteOk, p.n),
    sem_pct: semP,
    com_pct: comP,
    efeito_padrao: efeitoPadrao,
    controle_sem_pct: ctlSem,
    controle_com_pct: ctlCom,
    efeito_colateral: efeitoColateral,
    veredito: decidirVereditoReplay(efeitoPadrao, efeitoColateral),
  };
}

// ---------------------------------------------------------------------------
// E-mail pro Caio quando a melhoria fecha com número (formato pedido 08/08)
// ---------------------------------------------------------------------------

export function montarEmailMelhoria(i: {
  agenteAmigavel: string;
  regra: string;
  agentePct: number;
  projetadoPct: number;
  nCasos: number;
  vereditoControle: string;
}): { subject: string; body: string } {
  return {
    subject: `Melhoria desenhada com a Isadora — ${i.agenteAmigavel}: ${i.agentePct}% → ~${i.projetadoPct}%`,
    body:
      `Após conversa com a Isadora, entendemos e temos uma melhoria desenhada para aprovarmos.\n\n` +
      `Agente: ${i.agenteAmigavel}\n` +
      `Hoje acerta: ${i.agentePct}% neste padrão\n` +
      `Passaria a: ~${i.projetadoPct}% (testado em ${i.nCasos} casos históricos reais; controle: ${i.vereditoControle})\n\n` +
      `A regra ensinada:\n"${i.regra.slice(0, 500)}"\n\n` +
      `Abra o Cockpit → aba Aprendizado → a melhoria está na fila pra sua aprovação.\n` +
      `Aprovando, o fluxo de PR entra em ação — nada muda sem o seu merge.\n\n` +
      `— agente-chefe · conversa registrada no módulo Aprendizado`,
  };
}

export async function enviarEmailMelhoriaCaio(email: { subject: string; body: string }): Promise<boolean> {
  const token = Deno.env.get("POSTMARK_SERVER_TOKEN");
  if (!token) return false;
  try {
    const r = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": token,
      },
      body: JSON.stringify({
        From: "Cockpit <relacionamento.farmaceutico@salexpress.com.br>",
        To: "caio@salexpress.com.br",
        Subject: email.subject,
        TextBody: email.body,
        MessageStream: "outbound",
        Tag: "cockpit-aprendizado-chat",
        Headers: [{ Name: "Auto-Submitted", Value: "auto-generated" }],
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
