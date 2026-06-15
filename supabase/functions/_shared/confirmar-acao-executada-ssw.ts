// =============================================================================
// confirmar-acao-executada-ssw — helper compartilhado pra confirmar saída de
// state=ACAO_EXECUTADA via SSW interno (opção 101).
//
// Caio 2026-05-13 (Fase 2 do plano "hoje-usamos-o-bastao"):
//   Substitui a dependência do Bastão pra confirmar oc lançada com sucesso.
//   Antes: Pass G espera Bastão refletir a oc (latência RPA 15-60min) +
//   janela 30min de proteção contra "RPA piscar". Agora: consulta SSW interno
//   on-time (2-3s), decide na hora — sem janela necessária.
//
// Usado em:
//   - executor (após emitir AcaoExecutada com sucesso) — best-effort, se
//     SSW falhar mantém ACAO_EXECUTADA e Pass H pega depois.
//   - sync-bastao Pass H (periódico, varre cards ACAO_EXECUTADA > 2min).
//
// Decisão baseada na última oc real do SSW (não no Bastão):
//   - oc=54        → AGUARDANDO_CLIENTE
//   - oc 1/30/32   → RESOLVIDO
//   - oc com regra → AGUARDANDO_VALIDACAO_HUMANA + lock + propostas via
//                    proporAutoAcaoSeAplicavel (NOTA: SE oc=oc lançada, NÃO
//                    re-cria propostas — o lançamento já foi feito)
//   - oc s/regra   → AGUARDANDO_AGENTE
//   - outras       → TRANSFERIDO
//
// Pass G (Bastão+30min) continua rodando como BACKUP nos próximos 14 dias
// (rollout fase 3). Plano completo: ~/.claude/plans/hoje-usamos-o-bast-o-whimsical-charm.md
// =============================================================================

// deno-lint-ignore-file no-explicit-any
import {
  buscarNFInterno,
  listarOcorrenciasNF,
  obterSessao,
  readSswInternalEnv,
} from "./ssw-internal-client.ts";
import { stateFinalAposBastao } from "./bastao-rules.ts";
import { REGRAS_AUTO_ACAO } from "./regras-auto-acao.ts";

export type ConfirmacaoSswResultado =
  | {
    confirmado: true;
    cenario: "mesma_oc" | "oc_avancou";
    oc_ssw: number;
    oc_card_anterior: number | null;
    state_novo: string;
    lock_novo: boolean;
  }
  | {
    confirmado: false;
    motivo:
      | "card_nao_acao_executada"
      | "ssw_sem_oc"
      | "ssw_erro"
      | "env_ausente"
      // Caio 2026-06-15: SSW acessível mas a oc que tentamos lançar NÃO está
      // lá (não foi lançada de fato). Card foi revertido pro operador.
      | "oc_nao_lancada";
    detalhe?: string;
  };

export interface ConfirmacaoSswOpts {
  /** "executor_inline" (chamada best-effort logo após lançamento) ou "pass_h" (varredura periódica). Vai pro evento. */
  origem: "executor_inline" | "pass_h";
  /** Operadora pode passar o env já lido pra evitar re-ler em loop. */
  envOverride?: Record<string, string | undefined>;
}

/**
 * Consulta SSW interno pra decidir se o card pode sair de ACAO_EXECUTADA.
 *
 * Idempotente: se card não estiver em ACAO_EXECUTADA, retorna no_op.
 *
 * Não bloqueante: erros de SSW (timeout, login bloqueado, etc) retornam
 * `confirmado: false` com motivo, sem throw. O caller decide se loga.
 */
export async function confirmarAcaoExecutadaViaSsw(
  supabase: any,
  cardId: string,
  opts: ConfirmacaoSswOpts,
): Promise<ConfirmacaoSswResultado> {
  const { data: card } = await supabase
    .from("cards")
    .select("id, nf, ctrc, state, cod_ultima_ocorrencia, acao_executada_em, responsavel_relacionamento")
    .eq("id", cardId)
    .maybeSingle();

  if (!card || card.state !== "ACAO_EXECUTADA") {
    return { confirmado: false, motivo: "card_nao_acao_executada" };
  }
  if (!card.nf) {
    return { confirmado: false, motivo: "ssw_erro", detalhe: "card sem NF" };
  }

  let ocSsw: number;
  let ocsSnapshot: Awaited<ReturnType<typeof listarOcorrenciasNF>> = [];
  try {
    const env = opts.envOverride ?? (typeof Deno !== "undefined" ? Deno.env.toObject() : {});
    // Caio 2026-05-15 (multi-operador): credenciais SSW do operador do card.
    const sswEnv = readSswInternalEnv(env, (card.responsavel_relacionamento as string | null) ?? null);
    const sessao = await obterSessao(sswEnv);
    const detalhe = await buscarNFInterno(sessao, card.nf as string, {
      ctrcEsperado: (card.ctrc as string | null) ?? null,
    });
    ocsSnapshot = await listarOcorrenciasNF(sessao, detalhe);
    const primeiraReal = ocsSnapshot.find((o) => o.codigo != null);
    if (primeiraReal?.codigo == null) {
      return {
        confirmado: false,
        motivo: "ssw_sem_oc",
        detalhe: `SSW retornou ${ocsSnapshot.length} entradas sem código`,
      };
    }
    ocSsw = primeiraReal.codigo;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // env_ausente é distinto pra debug — não conta como falha de scrape
    if (msg.includes("SSW_INTERNAL_") && msg.includes("env vars")) {
      return { confirmado: false, motivo: "env_ausente", detalhe: msg };
    }
    return { confirmado: false, motivo: "ssw_erro", detalhe: msg };
  }

  const ocCard = (card.cod_ultima_ocorrencia as number | null) ?? null;

  // ───────────────────────────────────────────────────────────────────────
  // Caio 2026-06-15: GUARD "ocorrência realmente foi lançada no SSW".
  //
  // O executor seta cards.cod_ultima_ocorrencia = oc lançada ANTES de chamar
  // esta confirmação. Aqui `ocCard` é, portanto, a oc que o Cockpit AFIRMA ter
  // lançado (`intended`). A confirmação é o próprio SSW: se a oc pretendida NÃO
  // aparece no histórico do SSW com timestamp >= momento do lançamento, então
  // ela NÃO foi lançada de fato (caso âncora NF 345523: idempotent_skip da mig
  // 194 retornava "sucesso" sem chamar o SSW). Nunca afirmar que lançou quando
  // não lançou → reverter pro operador com aviso explícito.
  //
  // Sinal positivo (confirma lançamento), por ordem de robustez:
  //   1. a oc pretendida é a MAIS RECENTE do SSW (caso normal: acabou de entrar);
  //   2. existe alguma ocorrência da oc pretendida com data >= acao_executada_em
  //      (cobre "lançou e o SSW já avançou pra outra oc em seguida").
  // Sem timestamp parseável, cai pra regra (1). SSW inacessível NÃO chega aqui
  // (cai no catch acima → mantém ACAO_EXECUTADA, Pass H tenta de novo).
  const intended = ocCard;
  if (intended != null) {
    const acaoMs = card.acao_executada_em
      ? new Date(card.acao_executada_em as string).getTime()
      : null;
    const SKEW_MS = 5 * 60_000; // tolerância p/ truncagem de minuto + clock skew
    const ocorrenciasIntended = ocsSnapshot.filter((o) => o.codigo === intended);
    const algumComData = ocorrenciasIntended.some((o) => parseDataSswBrt(o.data) != null);

    let lancamentoConfirmado: boolean;
    if (acaoMs != null && algumComData) {
      lancamentoConfirmado = ocorrenciasIntended.some((o) => {
        const t = parseDataSswBrt(o.data);
        return t != null && t >= acaoMs - SKEW_MS;
      });
    } else {
      lancamentoConfirmado = ocSsw === intended;
    }

    if (!lancamentoConfirmado) {
      return await reverterPorOcNaoLancada(supabase, card, intended, ocSsw, opts.origem);
    }
  }

  const cenario: "mesma_oc" | "oc_avancou" = ocSsw === ocCard ? "mesma_oc" : "oc_avancou";

  // Decide state final pelo helper canônico
  const ocTemRegra = REGRAS_AUTO_ACAO[ocSsw] != null;
  const stateFinal = stateFinalAposBastao(ocSsw, ocTemRegra);

  // UPDATE card → libera de ACAO_EXECUTADA
  //
  // Caio 2026-05-14 (NF 1075381 + cenário Operação re-tratativa):
  // PRESERVAR `bastao_oc_no_lancamento` E `bastao_updated_at_no_lancamento`.
  // Esses 2 campos compõem a referência do snapshot Bastão NO momento do
  // lançamento. Pass A do sync-bastao usa a TUPLA pra distinguir:
  //   - "mesmo snapshot que originou o card" (oc + updated_at iguais) → NÃO reabrir
  //   - "nova atualização do Bastão" (updated_at diferente, mesmo se oc igual) → REABRIR
  //
  // Cenário típico que motivou a guarda combinada (Caio 2026-05-14):
  //   - 14h14: Bastão oc=49 → card criado em AGUARDANDO_VOCE
  //   - Larissa lança oc=56 → executor grava (49, 14h14) e card vai pra TRANSFERIDO via Pass H
  //   - 14h15-16h: sync re-importa MESMO snapshot (49, 14h14) → guard bloqueia (correto)
  //   - 16h14: Operação devolve com 49 nova → Bastão atualiza (49, 16h14)
  //   - sync importa (49, 16h14) → guard libera (oc igual mas updated_at diff) → REABRE
  //
  // `acao_executada_em` continua sendo limpo (sinaliza saída de ACAO_EXECUTADA).
  const update: Record<string, unknown> = {
    state: stateFinal.state,
    lock_aguardando_validacao: stateFinal.lock,
    cod_ultima_ocorrencia: ocSsw,
    acao_executada_em: null,
    // bastao_oc_no_lancamento mantido — guarda referência histórica pro Pass A
    bastao_synced_at: new Date().toISOString(),
  };

  await supabase.from("cards").update(update).eq("id", cardId);

  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "AcaoExecutadaConfirmadaPeloSsw",
    actor_type: "system",
    actor_id: opts.origem === "pass_h" ? "sync-bastao-passH" : "executor-inline",
    payload: {
      origem: opts.origem,
      cenario,
      oc_ssw: ocSsw,
      oc_card_anterior: ocCard,
      state_novo: stateFinal.state,
      lock_novo: stateFinal.lock,
      fonte_oc: "ssw_internal",
      observacao:
        "Caio 2026-05-13 (Fase 2 plano hoje-usamos-o-bastao): " +
        "card liberado via SSW interno on-time, sem esperar Bastão.",
    },
  });

  return {
    confirmado: true,
    cenario,
    oc_ssw: ocSsw,
    oc_card_anterior: ocCard,
    state_novo: stateFinal.state,
    lock_novo: stateFinal.lock,
  };
}

// ---------------------------------------------------------------------------
// parseDataSswBrt — converte "DD/MM/YY HH:MM" (timestamp de inclusão do SSW,
// horário de Brasília) pra epoch ms UTC. Retorna null se não casar o formato.
// SSW serve horário BRT fixo (-03, sem DST). Caio 2026-06-15.
// ---------------------------------------------------------------------------
function parseDataSswBrt(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const dd = Number(m[1]), mm = Number(m[2]), yy = Number(m[3]);
  const hh = Number(m[4]), mi = Number(m[5]);
  // BRT (-03) → UTC: soma 3h ao montar o epoch.
  return Date.UTC(2000 + yy, mm - 1, dd, hh + 3, mi);
}

// ---------------------------------------------------------------------------
// reverterPorOcNaoLancada — caso "Cockpit afirma que lançou mas o SSW não tem
// a oc". Reverte o card pro operador via RPC `reverter_acao_falhou` (ressuscita
// as opções primárias + state=AGUARDANDO_VALIDACAO_HUMANA + lock +
// acao_falhou_motivo) e grava card_event próprio. NUNCA segue pro fluxo normal
// (nunca afirma sucesso). Caio 2026-06-15 (caso âncora NF 345523).
//
// INV-002: este caminho NÃO toca `bastao_oc_no_lancamento` nem
// `bastao_updated_at_no_lancamento` — só limpa `acao_executada_em` (sinaliza
// saída de ACAO_EXECUTADA) além do que a RPC já faz.
// ---------------------------------------------------------------------------
async function reverterPorOcNaoLancada(
  supabase: any,
  card: any,
  intended: number,
  ocSswReal: number,
  origem: "executor_inline" | "pass_h",
): Promise<ConfirmacaoSswResultado> {
  const cardId = card.id as string;
  const motivo =
    `ÚLTIMA OCORRÊNCIA (oc=${intended}) NÃO LANÇADA — o SSW não confirma o ` +
    `lançamento (oc atual no SSW = ${ocSswReal}). Reaprove a ação pra relançar.`;

  // Acha o todo da ação em voo (status='executando' = lançamento desta rodada).
  const { data: todoEmVoo } = await supabase
    .from("todos")
    .select("id")
    .eq("card_id", cardId)
    .eq("status", "executando")
    .order("approved_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let revertViaRpc = false;
  if (todoEmVoo?.id) {
    const { error: rpcErr } = await supabase.rpc("reverter_acao_falhou", {
      p_todo_id: todoEmVoo.id as string,
      p_motivo: motivo,
    });
    revertViaRpc = !rpcErr;
    if (rpcErr) {
      console.error(`[confirmar-ssw] reverter_acao_falhou (card=${cardId}): ${rpcErr.message}`);
    }
  }

  // Fallback (sem todo 'executando' ou RPC falhou): reverte direto. NÃO mexe
  // nos campos de snapshot Bastão (INV-002).
  if (!revertViaRpc) {
    await supabase
      .from("cards")
      .update({
        state: "AGUARDANDO_VALIDACAO_HUMANA",
        lock_aguardando_validacao: true,
        acao_falhou_motivo: motivo.slice(0, 500),
        acao_executada_em: null,
      })
      .eq("id", cardId);
  } else {
    // RPC já setou state/lock/motivo; só sinaliza saída de ACAO_EXECUTADA.
    await supabase.from("cards").update({ acao_executada_em: null }).eq("id", cardId);
  }

  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "AcaoNaoConfirmadaPeloSsw",
    actor_type: "system",
    actor_id: origem === "pass_h" ? "sync-bastao-passH" : "executor-inline",
    payload: {
      origem,
      oc_pretendida: intended,
      oc_ssw_real: ocSswReal,
      revert_via: revertViaRpc ? "reverter_acao_falhou" : "update_direto",
      motivo:
        "Cockpit afirmou lançamento mas o SSW não confirma a oc pretendida — " +
        "card revertido pro operador (nunca afirmar sucesso sem confirmação do SSW).",
    },
  });

  return { confirmado: false, motivo: "oc_nao_lancada", detalhe: motivo };
}

// Stub do Deno global pra type-checking fora do runtime Deno (deploy-time
// resolve via Deno runtime; tsconfig do root não tem types Deno).
declare const Deno: { env: { toObject(): Record<string, string | undefined> } };
