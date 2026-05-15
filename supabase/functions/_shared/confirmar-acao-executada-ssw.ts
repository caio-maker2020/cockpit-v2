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
    motivo: "card_nao_acao_executada" | "ssw_sem_oc" | "ssw_erro" | "env_ausente";
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
  try {
    const env = opts.envOverride ?? (typeof Deno !== "undefined" ? Deno.env.toObject() : {});
    // Caio 2026-05-15 (multi-operador): credenciais SSW do operador do card.
    const sswEnv = readSswInternalEnv(env, (card.responsavel_relacionamento as string | null) ?? null);
    const sessao = await obterSessao(sswEnv);
    const detalhe = await buscarNFInterno(sessao, card.nf as string, {
      ctrcEsperado: (card.ctrc as string | null) ?? null,
    });
    const ocs = await listarOcorrenciasNF(sessao, detalhe);
    const primeiraReal = ocs.find((o) => o.codigo != null);
    if (primeiraReal?.codigo == null) {
      return {
        confirmado: false,
        motivo: "ssw_sem_oc",
        detalhe: `SSW retornou ${ocs.length} entradas sem código`,
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

// Stub do Deno global pra type-checking fora do runtime Deno (deploy-time
// resolve via Deno runtime; tsconfig do root não tem types Deno).
declare const Deno: { env: { toObject(): Record<string, string | undefined> } };
