// evals/chat-agente-chefe-smoke.ts — teste de integração do chat (Fase 1).
//
// Roda EXATAMENTE o loop da function (executarTurnoChat) contra dados REAIS
// de produção (ferramentas de leitura) e a Anthropic REAL — sem deploy, sem
// flag, sem gravar nada no banco (cenários não confirmam regra, então
// registrar_aprendizado não dispara; e o script não insere mensagens).
//
// Uso: set -a && source .env.local && set +a
//      deno run --allow-net --allow-env evals/chat-agente-chefe-smoke.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  executarTurnoChat,
  historicoParaMensagens,
  montarSnapshotMetricas,
  montarSystemPrompt,
  type MsgChatRow,
} from "../supabase/functions/_shared/aprendizado-chat.ts";
import { lerChaveEvals } from "./_custo-evals.ts"; // INV-167

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// INV-167 (02/10): chave PRÓPRIA de eval — nunca a de produção. Este smoke faz
// 1-4 turnos (poucas chamadas); o custo deles sai no console da Anthropic
// separado, na chave de evals.
let ANTHROPIC_KEY: string;
try {
  ANTHROPIC_KEY = lerChaveEvals(Deno.env);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  Deno.exit(1);
}
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  Deno.exit(1);
}

const svc = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const historico: MsgChatRow[] = [];

async function turno(fala: string): Promise<void> {
  historico.push({ papel: "gestor", conteudo: fala });
  const t0 = Date.now();
  const snapshot = await montarSnapshotMetricas(svc);
  const system = montarSystemPrompt({
    nomeGestor: "Isadora",
    snapshotMetricas: snapshot,
    tipoSessao: "isadora_iniciou",
  });
  const r = await executarTurnoChat({
    supabase: svc,
    anthropicKey: ANTHROPIC_KEY,
    system,
    mensagens: historicoParaMensagens(historico),
    contextoRegistro: {
      sessaoId: "smoke-test",
      nomeGestor: "Isadora",
      supabaseUrl: SUPABASE_URL,
      serviceKey: SERVICE_KEY,
    },
  });
  const seg = ((Date.now() - t0) / 1000).toFixed(1);
  historico.push({ papel: "agente", conteudo: r.resposta });
  console.log("=".repeat(70));
  console.log(`ISADORA: ${fala}`);
  console.log(`[${seg}s | ferramentas: ${r.ferramentas_usadas.join(", ") || "nenhuma"}]`);
  console.log(`AGENTE-CHEFE: ${r.resposta}`);
}

const cenarios = (Deno.env.get("SMOKE_CENARIOS") ?? "completo");
if (cenarios === "oc11") {
  await turno("Me mostra 3 casos recentes da oc 11 em que o time corrigiu a sugestão do agente de recusas.");
} else {
  await turno("Oi! Como está o agente de recusas este mês?");
  await turno("Me mostra 3 casos recentes da oc 11 em que o time corrigiu a sugestão.");
  await turno("O que você sabe da NF 139908?");
  await turno("Entendi. Você lança essa ocorrência pra mim agora?");
}
