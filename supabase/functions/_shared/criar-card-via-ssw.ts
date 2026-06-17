// =============================================================================
// criar-card-via-ssw.ts
//
// Criação ANTECIPADA de card a partir do e-mail automático do SSW
// (sswemail@ssw.inf.br), antes de a NF vencer prazo e aparecer no Bastão.
// Caio 2026-06-16. Ver plano e CLAUDE.md (regra de ouro do CTRC).
//
// Chamado pelo gmail-poll-inbox no ponto em que uma mensagem não casa com
// nenhum card existente. TODO o fluxo é gated e try/catch isolado: nunca pode
// derrubar o polling de produção.
//
// Gates cumulativos (qualquer um OFF → no-op):
//   1. feature_flags('card_via_email_ssw_enabled') = true
//   2. operador dono da caixa == COCKPIT (operadorEmail)
//   3. remetente == sswemail@ssw.inf.br
//   4. ocorrência ∈ OCS_ALVO (começa em {6} extravio)
//   5. NF ∈ email_ssw_test_nfs (ativo) — gate primário
//
// Dedup: a identidade do card é a NF normalizada (uniq_cards_nf_active). Se já
// existe card ativo → não cria (deixa o Bastão/ciclo existente dono). Idempotência
// de reprocessamento via email_ssw_eventos UNIQUE(gmail_message_id, nf).
// =============================================================================

import type { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  buscarNFInterno,
  listarCTRCsDaNF,
  listarOcorrenciasNF,
  loginInternoSSW,
  readSswInternalEnv,
  type CtrcRow,
} from "./ssw-internal-client.ts";
import {
  ehRemetenteSsw,
  htmlToText,
  parseEmailSswRastreamento,
} from "./parser-email-ssw-rastreamento.ts";
import { proporAutoAcaoSeAplicavel } from "./regras-auto-acao.ts";
import { verificarEvidenciaESinalizar } from "./verificar-evidencia.ts";

type SupabaseClient = ReturnType<typeof createClient>;

const FLAG_KEY = "card_via_email_ssw_enabled";
const OPERADOR_COCKPIT_EMAIL = "cockpit@salexpress.com.br";
// Ocorrências do e-mail SSW que disparam criação antecipada.
// FASE 1 (Caio 2026-06-17): só ocorrências de RELACIONAMENTO {49,10,11,19,35} —
// nascem em AGUARDANDO_VALIDACAO_HUMANA + lock e entram no agente-sugere-ocs-padrao.
// Extravio (oc=6) fica pra FASE 2, com aba própria nova (não pode cair em
// "AGUARDANDO VOCÊ" — conflita com as regras de relacionamento).
const OCS_ALVO: ReadonlySet<number> = new Set([49, 10, 11, 19, 35]);

export interface TentarCriarCardOpts {
  operadorId: string;
  operadorEmail: string | null;
  gmailMessageId: string;
  gmailThreadId: string | null;
  fromHeader: string | null;
  corpo: string;
  env: Record<string, string | undefined>;
}

export interface TentarCriarCardResult {
  /** true se era e-mail do SSW reconhecido (caller deve marcar como lida). */
  handled: boolean;
  cardsCriados: number;
}

const NAO_TRATADO: TentarCriarCardResult = { handled: false, cardsCriados: 0 };

/**
 * Ponto de entrada chamado pelo gmail-poll-inbox. Resolve SEMPRE (não lança) —
 * em qualquer erro, loga em email_ssw_eventos e retorna handled:true (a msg era
 * do SSW e foi consumida) ou false (não era nossa).
 */
export async function tentarCriarCardViaSswEmail(
  supabase: SupabaseClient,
  opts: TentarCriarCardOpts,
): Promise<TentarCriarCardResult> {
  // Gate 2 (mais barato primeiro): só a caixa do COCKPIT.
  if ((opts.operadorEmail ?? "").toLowerCase() !== OPERADOR_COCKPIT_EMAIL) {
    return NAO_TRATADO;
  }
  // Gate 3: remetente do SSW.
  if (!ehRemetenteSsw(opts.fromHeader)) return NAO_TRATADO;

  // Gate 1: feature flag.
  const { data: flagRow } = await supabase
    .from("feature_flags")
    .select("enabled")
    .eq("key", FLAG_KEY)
    .maybeSingle();
  if (!(flagRow as { enabled?: boolean } | null)?.enabled) {
    // É e-mail do SSW mas a feature está desligada → não toca (no-op).
    return NAO_TRATADO;
  }

  // A partir daqui é nosso: qualquer erro é logado, nunca propaga.
  try {
    const parsed = parseEmailSswRastreamento(opts.corpo);
    const oc = parsed.ocorrencia?.codigo ?? null;
    // Guarda o texto JÁ LIMPO (HTML→texto) pra diagnóstico — o corpo cru é HTML
    // com bloco <style> grande que não ajuda a depurar o parser.
    const snippet = htmlToText(opts.corpo).slice(0, 1500);

    // Gate 4: ocorrência alvo.
    if (oc == null || !OCS_ALVO.has(oc)) {
      await logEvento(supabase, opts, {
        nf: null, oc, card_acao: "ignorado_oc", snippet,
      });
      return { handled: true, cardsCriados: 0 };
    }

    if (parsed.notas.length === 0) {
      await logEvento(supabase, opts, {
        nf: null, oc, card_acao: "erro", erro: "nenhuma NF no corpo", snippet,
      });
      return { handled: true, cardsCriados: 0 };
    }

    // Resolve operador nome (responsavel_relacionamento) uma vez.
    const { data: opRow } = await supabase
      .from("operadores")
      .select("nome")
      .eq("id", opts.operadorId)
      .maybeSingle();
    const operadorNome = (opRow as { nome?: string } | null)?.nome ?? "COCKPIT";

    let criados = 0;
    // Cada NF é independente — uma ambígua/sem-CTRC não bloqueia a outra.
    for (const nota of parsed.notas) {
      const nf = nota.numero;
      try {
        const r = await processarNf(supabase, opts, { nf, oc, parsed, operadorNome, snippet });
        if (r === "criado") criados++;
      } catch (errNf) {
        const erro = errNf instanceof Error ? errNf.message : String(errNf);
        await logEvento(supabase, opts, { nf, oc, card_acao: "erro", erro, snippet });
      }
    }
    return { handled: true, cardsCriados: criados };
  } catch (err) {
    const erro = err instanceof Error ? err.message : String(err);
    await logEvento(supabase, opts, {
      nf: null, oc: null, card_acao: "erro", erro, snippet: opts.corpo.slice(0, 500),
    }).catch(() => {});
    // Foi reconhecido como e-mail do SSW; consome a msg pra não reprocessar em loop.
    return { handled: true, cardsCriados: 0 };
  }
}

type AcaoNf =
  | "criado"
  | "ctrc_ambiguo"
  | "ignorado_whitelist"
  | "card_ja_existe_corrida"
  | "sem_ctrc_ativo"
  | "duplicado";

async function processarNf(
  supabase: SupabaseClient,
  opts: TentarCriarCardOpts,
  ctx: {
    nf: string;
    oc: number;
    parsed: ReturnType<typeof parseEmailSswRastreamento>;
    operadorNome: string;
    snippet: string;
  },
): Promise<AcaoNf> {
  const { nf, oc, parsed, operadorNome, snippet } = ctx;

  // Idempotência de reprocessamento: claim na tabela de eventos.
  // UNIQUE(gmail_message_id, nf) — se já existe, essa NF desse e-mail já rodou.
  const { error: claimErr } = await supabase.from("email_ssw_eventos").insert({
    gmail_message_id: opts.gmailMessageId,
    gmail_thread_id: opts.gmailThreadId,
    operador_id: opts.operadorId,
    remetente_email: opts.fromHeader,
    nf,
    oc,
    raw_email_snippet: snippet,
    card_acao: "processando",
  });
  if (claimErr) {
    // 23505 = unique_violation → já processado antes. Skip silencioso.
    if ((claimErr as { code?: string }).code === "23505") return "duplicado";
    throw new Error(`claim email_ssw_eventos: ${claimErr.message}`);
  }

  // Gate 5: whitelist de NF.
  const { data: wlRow } = await supabase
    .from("email_ssw_test_nfs")
    .select("nf")
    .eq("nf", nf)
    .eq("ativo", true)
    .maybeSingle();
  if (!wlRow) {
    await atualizarEvento(supabase, opts.gmailMessageId, nf, { card_acao: "ignorado_whitelist" });
    return "ignorado_whitelist";
  }

  // Já existe card ATIVO pra essa NF? (Bastão chegou antes, ou run anterior.)
  const { data: cardExistente } = await supabase
    .from("cards")
    .select("id, state")
    .eq("nf", nf)
    .not("state", "in", "(RESOLVIDO,CANCELADO)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (cardExistente) {
    await atualizarEvento(supabase, opts.gmailMessageId, nf, {
      card_acao: "card_ja_existe_corrida",
      card_id: (cardExistente as { id: string }).id,
    });
    return "card_ja_existe_corrida";
  }

  // Resolve CTRC via SSW interno (creds compartilhadas AI.SALEX via fallback).
  // Desambiguação (algoritmo do Caio 2026-06-17): a NF pode ter vários CTes;
  // filtra pelos que têm o MESMO remetente E o MESMO destinatário do e-mail.
  // Depois confere que a última ocorrência do CTe bate com a "Nova Situação".
  const sswEnv = readSswInternalEnv(opts.env, operadorNome);
  const sessao = await loginInternoSSW(sswEnv);
  const ctrcs = await listarCTRCsDaNF(sessao, nf);
  const escolha = escolherCtrc(ctrcs, {
    remetente: parsed.remetente,
    destinatario: parsed.destinatario,
  });

  if (escolha.tipo === "sem_ctrc_ativo") {
    await atualizarEvento(supabase, opts.gmailMessageId, nf, {
      card_acao: "sem_ctrc_ativo",
      cnpj_pagador: null,
    });
    return "sem_ctrc_ativo";
  }

  let ambiguo = escolha.tipo === "ambiguo";
  let ctrc = ambiguo ? null : escolha.ctrc!.ctrc;
  const pagador = ambiguo ? null : (escolha.ctrc!.pagador || null);
  let motivoAmbiguo = ambiguo ? "multiplos_ctrcs_remetente_destinatario" : null;

  // Conferência final: a última ocorrência do CTe escolhido tem que bater com a
  // "Nova Situação" do e-mail. Se divergir, não confiamos no CTRC → vira review.
  if (!ambiguo && ctrc) {
    try {
      const detalhe = await buscarNFInterno(sessao, nf, { ctrcEsperado: ctrc });
      const ocs = await listarOcorrenciasNF(sessao, detalhe);
      const ultimaOc = ocs.find((o) => o.codigo != null)?.codigo ?? null;
      if (ultimaOc != null && ultimaOc !== oc) {
        ambiguo = true;
        ctrc = null;
        motivoAmbiguo = `ultima_oc_ssw_${ultimaOc}_diverge_do_email_${oc}`;
      }
    } catch (_e) {
      // best-effort: falha na conferência não bloqueia (CTRC já passou no filtro
      // remetente+destinatário). Segue com o CTRC escolhido.
    }
  }

  // Monta agent_state espelhando snapshotFromPendencia (sync-bastao:2667).
  // origem='email_ssw' é o marcador que o guard anti-reabertura do sync-bastao usa.
  const agora = new Date().toISOString();
  const agentState: Record<string, unknown> = {
    origem: "email_ssw",
    bastao_pendencia_id: null,
    bastao_updated_at: agora, // executor usa p/ bastao_updated_at_no_lancamento
    cod_ultima_ocorrencia: oc, // executor usa p/ bastao_oc_no_lancamento
    instrucao_ultima_ocorrencia: parsed.ocorrencia?.descricao ?? null,
    data_ultima_ocorrencia: parsed.dataHora,
    remetente: parsed.remetente,
    destinatario: parsed.destinatario,
    cnpj_pagador: pagador,
    cnpj_remetente: pagador,
    base_destino: parsed.unidade,
    qtde_volumes: null,
    ssw_email_recebido_em: agora,
    gmail_message_id: opts.gmailMessageId,
    ctrc_ambiguo: ambiguo,
    motivo_ambiguo: motivoAmbiguo,
    ctrcs_ativos_email_ssw: escolha.ativos.map((c) => ({
      ctrc: c.ctrc, tipo: c.tipo, remetente: c.remetente, destinatario: c.destinatario,
    })),
  };

  // INSERT do card espelhando o shape do sync-bastao (index.ts:1428).
  // Atribuição EXPLÍCITA ao operador dono da caixa (COCKPIT) — não via resolver
  // por CNPJ — pra o card de teste sempre aparecer pro operador.
  let cardId: string;
  try {
    const { data: ins, error: insErr } = await supabase
      .from("cards")
      .insert({
        nf,
        ctrc,
        canal_origem: "sistema",
        empresa_cliente: parsed.remetente,
        pagador,
        base_destino: parsed.unidade,
        responsavel_relacionamento: operadorNome,
        state: "AGUARDANDO_VALIDACAO_HUMANA",
        lock_aguardando_validacao: true,
        tipo: null,
        risco: "baixo",
        assigned_agent: null,
        assigned_operator_id: opts.operadorId,
        bastao_pendencia_id: null,
        cod_ultima_ocorrencia: oc,
        bastao_data_ultima_ocorrencia: null,
        bastao_synced_at: null,
        qtde_volumes: null,
        agent_state: agentState,
      })
      .select("id")
      .single();
    if (insErr) {
      // 23505 = corrida com sync-bastao (uniq_cards_nf_active). Card já existe.
      if ((insErr as { code?: string }).code === "23505") {
        await atualizarEvento(supabase, opts.gmailMessageId, nf, {
          card_acao: "card_ja_existe_corrida",
        });
        return "card_ja_existe_corrida";
      }
      throw new Error(`INSERT cards: ${insErr.message}`);
    }
    cardId = (ins as { id: string }).id;
  } catch (e) {
    throw e;
  }

  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "CardCriadoViaEmailSsw",
    actor_type: "system",
    actor_id: "gmail-poll-inbox",
    payload: {
      nf,
      oc,
      ctrc,
      ctrc_ambiguo: ambiguo,
      gmail_message_id: opts.gmailMessageId,
      gmail_thread_id: opts.gmailThreadId,
      remetente: parsed.remetente,
      destinatario: parsed.destinatario,
      unidade: parsed.unidade,
      ssw_email_recebido_em: agora,
      ctrcs_ativos: escolha.ativos.map((c) => ({ ctrc: c.ctrc, tipo: c.tipo, cancelado: c.cancelado })),
    },
  });

  if (ambiguo) {
    // Regra de ouro: nunca chutar CTRC pela NF. Card nasce em validação humana
    // com aviso, SEM ação autônoma.
    await supabase
      .from("cards")
      .update({
        aviso_alteracao_oc: {
          tipo: "ctrc_ambiguo_email_ssw",
          mensagem: "Não foi possível identificar o CTRC certo desta NF automaticamente (remetente+destinatário não isolaram 1 CTe) — escolher manualmente antes de qualquer lançamento.",
          motivo: motivoAmbiguo,
          ctrcs: escolha.ativos.map((c) => ({
            ctrc: c.ctrc, tipo: c.tipo, remetente: c.remetente, destinatario: c.destinatario,
          })),
          criado_em: agora,
        },
      })
      .eq("id", cardId);
    await atualizarEvento(supabase, opts.gmailMessageId, nf, {
      card_acao: "ctrc_ambiguo", card_id: cardId, ctrc_ambiguo: true, cnpj_pagador: pagador,
    });
    return "ctrc_ambiguo";
  }

  // Ocorrência de relacionamento (49/10/11/19/35): replica EXATAMENTE o que o
  // sync-bastao faz no INSERT de card novo (index.ts:1481-1500), pra o card-email
  // entrar no mesmo fluxo de propostas/IA de um card-Bastão:
  //   1. verificarEvidenciaESinalizar — checa foto no SSW (ocs 10/11/35) e grava
  //      evidencia_status (banner). Passa o CTRC (INV-011: NF com múltiplos CTRCs).
  //   2. proporAutoAcaoSeAplicavel — cria as propostas base de REGRAS_AUTO_ACAO.
  // Depois, o agente-sugere-ocs-padrao (cron 5min) refina com a sugestão da IA
  // (pega cards por oc IN (10,11,19,35,49) + state AGUARDANDO_VALIDACAO_HUMANA).
  await verificarEvidenciaESinalizar(
    supabase,
    cardId,
    nf,
    pagador,
    oc,
    ctrc,
    operadorNome,
  );
  await proporAutoAcaoSeAplicavel(supabase, {
    cardId,
    cardNf: nf,
    cardCtrc: ctrc,
    codUltimaOc: oc,
    agentState,
    cardState: "AGUARDANDO_VALIDACAO_HUMANA",
    cardLock: true,
    actorId: "criar-card-via-ssw",
  });

  await atualizarEvento(supabase, opts.gmailMessageId, nf, {
    card_acao: "criado", card_id: cardId, ctrc_escolhido: ctrc, cnpj_pagador: pagador,
  });
  return "criado";
}

// ---------------------------------------------------------------------------
// Escolha de CTRC (regra de ouro: nunca chutar pela NF; ambíguo → humano)
// ---------------------------------------------------------------------------
interface EscolhaCtrc {
  tipo: "unico" | "ambiguo" | "sem_ctrc_ativo";
  ctrc: CtrcRow | null;
  ativos: CtrcRow[];
}

/** Normaliza nome p/ comparação: maiúsc, sem acento, espaços colapsados. */
function normNome(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/\s+/g, " ").trim();
}

/** Mesmo nome? Tolera truncamento do SSW (um é prefixo do outro). */
function mesmoNome(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normNome(a), nb = normNome(b);
  if (!na || !nb) return false;
  // remove sufixo de truncamento tipo "(A.)"/"(C.)" antes de comparar prefixo
  const ca = na.replace(/\s*\([A-Z]\.?\)\s*$/, "").trim();
  const cb = nb.replace(/\s*\([A-Z]\.?\)\s*$/, "").trim();
  return ca === cb || ca.startsWith(cb) || cb.startsWith(ca);
}

export interface EscolherCtrcOpts {
  remetente?: string | null;
  destinatario?: string | null;
}

export function escolherCtrc(ctrcs: CtrcRow[], opts: EscolherCtrcOpts = {}): EscolhaCtrc {
  const ativos = ctrcs.filter((c) => !c.cancelado);
  if (ativos.length === 0) return { tipo: "sem_ctrc_ativo", ctrc: null, ativos };

  // Desambiguação por remetente + destinatário (algoritmo do Caio 2026-06-17):
  // entre os ativos, fica só quem tem o MESMO remetente E o MESMO destinatário
  // do e-mail. Reduz drasticamente a ambiguidade quando a NF colide com CTes de
  // outros clientes. Só aplica quando temos ambos os nomes do e-mail.
  let candidatos = ativos;
  if (opts.remetente && opts.destinatario) {
    const filtrados = ativos.filter(
      (c) => mesmoNome(c.remetente, opts.remetente) && mesmoNome(c.destinatario, opts.destinatario),
    );
    if (filtrados.length > 0) candidatos = filtrados;
  }

  // tipo "NORMAL" = CT-e original. tipo "" (complementar/reentrega) e "REVERSA"
  // (devolução) nunca são o principal isolado.
  const principais = candidatos.filter((c) => c.tipo.toUpperCase() === "NORMAL");
  if (principais.length === 1) return { tipo: "unico", ctrc: principais[0]!, ativos };
  if (principais.length === 0 && candidatos.length === 1) {
    return { tipo: "unico", ctrc: candidatos[0]!, ativos };
  }
  return { tipo: "ambiguo", ctrc: null, ativos };
}

// ---------------------------------------------------------------------------
// Logging em email_ssw_eventos
// ---------------------------------------------------------------------------
async function logEvento(
  supabase: SupabaseClient,
  opts: TentarCriarCardOpts,
  fields: {
    nf: string | null;
    oc: number | null;
    card_acao: string;
    erro?: string;
    snippet?: string;
  },
): Promise<void> {
  await supabase.from("email_ssw_eventos").insert({
    gmail_message_id: opts.gmailMessageId,
    gmail_thread_id: opts.gmailThreadId,
    operador_id: opts.operadorId,
    remetente_email: opts.fromHeader,
    nf: fields.nf,
    oc: fields.oc,
    card_acao: fields.card_acao,
    erro: fields.erro ?? null,
    raw_email_snippet: fields.snippet ?? null,
    processado_em: new Date().toISOString(),
  });
}

async function atualizarEvento(
  supabase: SupabaseClient,
  gmailMessageId: string,
  nf: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await supabase
    .from("email_ssw_eventos")
    .update({ ...fields, processado_em: new Date().toISOString() })
    .eq("gmail_message_id", gmailMessageId)
    .eq("nf", nf);
}
