// Helper compartilhado pra registrar runs dos agentes IA em `agent_runs`.
//
// Motivação: triador e redator já logam, mas agente-sugere-ocs-padrao e
// agente-oc13-autonomo não. Sem log nessas duas, a Triagem Noturna
// (Managed Agent externo, ver prompts/managed-agent-triagem-noturna.md)
// não consegue detectar falhas/timeouts/regressões nelas.
//
// Caio 2026-06-10: padronizar instrumentação. Falha no logging NUNCA
// derruba o run principal — try/catch interno.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export interface AgentRunHandle {
  agentName: string;
  stepName?: string;
  cardId?: string;
  input?: Record<string, unknown>;
  startedAt: string;
  startedAtMs: number;
}

export interface FinishAgentRunInput {
  status: "success" | "error" | "timeout";
  output?: Record<string, unknown>;
  errorMessage?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
}

export function startAgentRun(opts: {
  agentName: string;
  stepName?: string;
  cardId?: string;
  input?: Record<string, unknown>;
}): AgentRunHandle {
  const now = new Date();
  return {
    agentName: opts.agentName,
    stepName: opts.stepName,
    cardId: opts.cardId,
    input: opts.input,
    startedAt: now.toISOString(),
    startedAtMs: now.getTime(),
  };
}

export async function finishAgentRun(
  supabase: SupabaseClient,
  handle: AgentRunHandle,
  result: FinishAgentRunInput,
): Promise<void> {
  try {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - handle.startedAtMs;

    await supabase.from("agent_runs").insert({
      agent_name: handle.agentName,
      step_name: handle.stepName ?? null,
      card_id: handle.cardId ?? null,
      input: handle.input ?? null,
      output: result.output ?? null,
      model: result.model ?? null,
      tokens_in: result.tokensIn ?? null,
      tokens_out: result.tokensOut ?? null,
      duration_ms: durationMs,
      status: result.status,
      error_message: result.errorMessage ?? null,
      started_at: handle.startedAt,
      finished_at: finishedAt.toISOString(),
    });
  } catch (logErr) {
    // Logging falhou — NÃO propagar. Run principal não pode quebrar por
    // causa de telemetria. Só console pra alguém ver.
    const msg = logErr instanceof Error ? logErr.message : String(logErr);
    console.error(`[agent-runs-logger] falha ao gravar run de ${handle.agentName}:`, msg);
  }
}

// Helper categorizar timeout vs erro genérico.
export function classifyStatus(err: unknown): "error" | "timeout" {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (msg.includes("timeout") || msg.includes("aborterror") || msg.includes("excedeu")) {
    return "timeout";
  }
  return "error";
}
