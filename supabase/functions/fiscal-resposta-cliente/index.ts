// =============================================================================
// fiscal-resposta-cliente — 3ª camada do INV-067 (Caio 2026-08-11).
//
// Camadas, nesta ordem:
//   1. vinculador                  → aciona no caminho normal
//   2. reconciliador (cron 1min)   → conserta o que a 1 não pegou (mig 327)
//   3. FISCAL (este, cron 15min)   → o que sobrou vira AVISO PRO DONO DO CARD:
//        • linha em `alertas_operador` → barra inferior + conversa no Cockpit
//        • e-mail direto pro operador (Postmark)
//      O health-check segue avisando o Caio em paralelo (INV-042).
//
// Grace de 30min: maior que o do reconciliador (5min), então aqui só chega o
// que ele REALMENTE não resolveu. Fiscal nunca mexe em card — só avisa.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  type CasoFiscal,
  chaveAlerta,
  montarEmailTexto,
  montarRelatorio,
  montarTitulo,
} from "../_shared/fiscal-resposta-cliente.ts";

const FLAG = "fiscal_resposta_cliente_enabled";
const GRACE_MIN = 30;
const JANELA_DIAS = 90;
const MAX_POR_RUN = 25;
const FROM_EMAIL = "cockpit@salexpress.com.br";
const COCKPIT_URL = "https://cockpit-aisalexpress.vercel.app";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (_req) => {
  const t0 = Date.now();
  const env = Deno.env.toObject();
  const url = env["SUPABASE_URL"];
  const key = env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) return json({ ok: false, error: "env ausente" }, 500);
  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: flagRow } = await supabase
    .from("feature_flags").select("enabled").eq("key", FLAG).maybeSingle();
  if (!(flagRow as { enabled?: boolean } | null)?.enabled) {
    return json({ ok: true, skipped: "flag_off" });
  }

  // Detector = MESMA fonte da correção automática (mig 327). Se o fiscal usasse
  // query própria, ele e o reconciliador poderiam divergir — que é exatamente o
  // erro que originou o INV-042.
  const { data: pendentes, error: errDet } = await supabase.rpc(
    "cards_resposta_cliente_nao_acionada",
    { p_limit: MAX_POR_RUN, p_grace_minutos: GRACE_MIN, p_dias: JANELA_DIAS },
  );
  if (errDet) return json({ ok: false, error: `detector: ${errDet.message}` }, 500);

  const linhas = (pendentes ?? []) as Array<
    { id: string; nf: string | null; state: string; capturada_em: string }
  >;
  if (linhas.length === 0) {
    return json({ ok: true, casos: 0, duration_ms: Date.now() - t0 });
  }

  // Resolve o DONO de cada card (é ele quem precisa saber, não o gestor).
  const { data: cardsRaw } = await supabase
    .from("cards")
    .select("id, assigned_operator_id, responsavel_relacionamento")
    .in("id", linhas.map((l) => l.id));
  const donoPorCard = new Map<string, { opId: string | null; nome: string | null }>();
  for (
    const c of (cardsRaw ?? []) as Array<
      { id: string; assigned_operator_id: string | null; responsavel_relacionamento: string | null }
    >
  ) {
    donoPorCard.set(c.id, {
      opId: c.assigned_operator_id,
      nome: c.responsavel_relacionamento,
    });
  }

  const opIds = [...new Set([...donoPorCard.values()].map((d) => d.opId).filter(Boolean))] as string[];
  const { data: opsRaw } = opIds.length > 0
    ? await supabase.from("operadores").select("id, nome, email, email_relacionamento").in("id", opIds)
    : { data: [] };
  const emailPorOp = new Map<string, { nome: string; email: string | null }>();
  for (
    const o of (opsRaw ?? []) as Array<
      { id: string; nome: string; email: string | null; email_relacionamento: string | null }
    >
  ) {
    emailPorOp.set(o.id, { nome: o.nome, email: o.email_relacionamento ?? o.email });
  }

  const postmark = env["POSTMARK_SERVER_TOKEN"] ?? null;
  const agora = Date.now();
  const resultados: Array<Record<string, unknown>> = [];

  for (const l of linhas) {
    const dono = donoPorCard.get(l.id);
    const caso: CasoFiscal = {
      card_id: l.id,
      nf: l.nf,
      state: l.state,
      capturada_em: l.capturada_em,
      operador_id: dono?.opId ?? null,
      operador_nome: dono?.nome ?? null,
    };
    // Card sem dono: não há operador pra avisar. O health-check já cobre o Caio.
    if (!caso.operador_id) {
      resultados.push({ nf: l.nf, skip: "card_sem_operador" });
      continue;
    }

    const relatorio = montarRelatorio(caso, agora);
    const chave = chaveAlerta(caso);

    // Dedupe pela UNIQUE(chave): o mesmo caso não vira dois avisos, mesmo com o
    // cron rodando de 15 em 15min. Resposta NOVA gera chave nova (ciclo novo).
    const { data: inserido, error: errIns } = await supabase
      .from("alertas_operador")
      .insert({
        operador_id: caso.operador_id,
        card_id: caso.card_id,
        nf: caso.nf,
        tipo: "resposta_cliente_sem_acionamento",
        chave,
        titulo: montarTitulo(caso),
        relatorio,
      })
      .select("id")
      .maybeSingle();

    if (errIns) {
      // 23505 = já existe (caso já avisado). Silencioso de propósito.
      resultados.push({
        nf: l.nf,
        ja_avisado: (errIns as { code?: string }).code === "23505",
        error: (errIns as { code?: string }).code === "23505" ? undefined : errIns.message,
      });
      continue;
    }
    const alertaId = (inserido as { id?: string } | null)?.id ?? null;

    // Evento no card: o aviso faz parte do histórico (convenção 1).
    await supabase.from("card_events").insert({
      card_id: caso.card_id,
      event_type: "AlertaOperadorCriado",
      actor_type: "system",
      actor_id: "fiscal-resposta-cliente",
      payload: {
        alerta_id: alertaId,
        tipo: "resposta_cliente_sem_acionamento",
        nf: caso.nf,
        state: caso.state,
        capturada_em: caso.capturada_em,
        motivo: "INV-067: resposta de cliente sem acionamento sobreviveu ao reconciliador",
      },
    });

    // E-mail direto pro operador.
    const destino = caso.operador_id ? emailPorOp.get(caso.operador_id)?.email ?? null : null;
    let emailOk = false;
    if (postmark && destino) {
      try {
        const r = await fetch("https://api.postmarkapp.com/email", {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-Postmark-Server-Token": postmark,
          },
          body: JSON.stringify({
            From: `Cockpit <${FROM_EMAIL}>`,
            To: destino,
            Subject: `Cockpit · ${montarTitulo(caso)}`,
            TextBody: montarEmailTexto(caso, relatorio, `${COCKPIT_URL}/cards/${caso.card_id}`),
            MessageStream: "outbound",
            Tag: "cockpit-alerta-operador",
            Metadata: { tipo: "resposta_cliente_sem_acionamento", nf: caso.nf ?? "" },
            Headers: [
              { Name: "Auto-Submitted", Value: "auto-generated" },
              { Name: "X-Auto-Response-Suppress", Value: "All" },
            ],
          }),
        });
        emailOk = r.ok;
        if (!r.ok) console.error(`postmark ${r.status}: ${(await r.text()).slice(0, 200)}`);
      } catch (e) {
        console.error(`postmark falhou: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (emailOk && alertaId) {
      await supabase.from("alertas_operador")
        .update({ email_enviado_em: new Date().toISOString() }).eq("id", alertaId);
    }

    resultados.push({
      nf: l.nf,
      operador: caso.operador_nome,
      alerta_id: alertaId,
      email: emailOk ? "enviado" : (destino ? "falhou" : "sem_destino"),
    });
  }

  return json({ ok: true, casos: linhas.length, resultados, duration_ms: Date.now() - t0 });
});
