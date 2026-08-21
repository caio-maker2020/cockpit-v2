// =============================================================================
// email-interno — FONTE ÚNICA de e-mail administrativo (Postmark) pro time.
// Fase 4 da máquina de visão (Caio 21/08). Antes o mesmo fetch estava copiado
// em 10 functions; novos envios internos usam este helper.
//
// Best-effort por contrato: sem POSTMARK_SERVER_TOKEN ou com erro → false,
// nunca lança (e-mail interno jamais derruba o fluxo que o dispara).
// =============================================================================

const FROM_PADRAO = "Cockpit <relacionamento.farmaceutico@salexpress.com.br>";
const TO_PADRAO = "caio@salexpress.com.br";

export async function enviarEmailInterno(i: {
  subject: string;
  body: string;
  to?: string;
  tag?: string;
}): Promise<boolean> {
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
        From: FROM_PADRAO,
        To: i.to ?? TO_PADRAO,
        Subject: i.subject,
        TextBody: i.body,
        MessageStream: "outbound",
        Tag: i.tag ?? "cockpit-interno",
        Headers: [{ Name: "Auto-Submitted", Value: "auto-generated" }],
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// E-mail de APROVAÇÃO DE PR — o padrão que o Caio definiu (21/08):
// "O que era · O que mudou · Taxa antes · Taxa projetada · o que fazer".
// ---------------------------------------------------------------------------

export function montarEmailAprovacaoPR(i: {
  agenteAmigavel: string;
  titulo: string;
  oQueEra: string;
  oQueMudou: string;
  taxaAntesPct: number | null;
  taxaProjetadaPct: number | null;
  nCasos: number | null;
  prUrl: string;
}): { subject: string; body: string } {
  const antes = i.taxaAntesPct != null ? `${i.taxaAntesPct}%` : "sem medição";
  const depois = i.taxaProjetadaPct != null ? `~${i.taxaProjetadaPct}%` : "sem projeção";
  return {
    subject: `PR liberada pra sua aprovação — ${i.agenteAmigavel}: ${antes} → ${depois}`,
    body:
      `Tem uma melhoria de agente pronta, verificada no replay, esperando SÓ a sua aprovação.\n\n` +
      `═══ O QUE ERA ═══\n${i.oQueEra}\n\n` +
      `═══ O QUE MUDOU ═══\n${i.oQueMudou.slice(0, 600)}\n\n` +
      `═══ TAXA DE ACERTO ═══\n` +
      `Antes (hoje em produção): ${antes}\n` +
      `Se a melhoria já estivesse rodando: ${depois}` +
      `${i.nCasos ? ` (testado em ${i.nCasos} casos históricos reais)` : ""}\n\n` +
      `═══ O QUE VOCÊ FAZ (passo a passo) ═══\n` +
      `1. Abra a PR: ${i.prUrl}\n` +
      `2. Confira o diff (a regra nova) e o laudo do replay no corpo da PR.\n` +
      `3. Se concordar: clique em "Merge pull request" → "Confirm merge".\n` +
      `4. Pronto — o deploy pra produção é AUTOMÁTICO após o merge, e o\n` +
      `   antes×depois real passa a aparecer na aba Gestão Agentes (D5).\n` +
      `Se não concordar: feche a PR com um comentário — vira aprendizado.\n\n` +
      `— agente-chefe · ${i.titulo}`,
  };
}
