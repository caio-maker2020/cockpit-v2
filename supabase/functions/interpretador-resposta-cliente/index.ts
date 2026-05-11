// =============================================================================
// interpretador-resposta-cliente — agente IA que lê a resposta do cliente após
// a Sal ter lançado oc=54 (aguardando cliente) e sugere qual a próxima oc lançar.
//
// Caso de uso real: cliente Vale (NF 196537) recebeu email da Sal sobre recusa
// total (oc=10) → Sal lançou oc=54 → cliente respondeu. Larissa precisa decidir:
// lançar oc=44 (devolução) se cliente autorizou, oc=21 (reentrega) se quer
// reentrega, oc=56 (falta info) se inconclusivo, ou re-lançar oc=54 se resposta
// pede esperar mais.
//
// O resultado fica em cards.ia_sugestao_oc_resposta — front mostra banner indigo
// acima das 4 propostas, mas Larissa pode aprovar qualquer uma das 4 (a IA é
// sugestão, não decisão).
//
// Input:  { card_id, message_id }
// Output: { ok, oc_sugerida, confianca, motivo }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createAnthropicClient,
  readAnthropicEnvFromProcess,
} from "../_shared/anthropic-client.ts";

const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `Você é o agente que interpreta a resposta de um cliente farmacêutico depois que a Sal Express lançou oc=54 ("aguardando posicionamento do cliente pagador") sobre uma NF com problema (recusa total/parcial, problema endereço, falta volume, etc).

Sua tarefa: ler o texto da resposta do cliente e sugerir qual a próxima ocorrência o operador deve lançar no SSW. Opções possíveis:

- **44 (RETORNO DE CARGA)**: cliente autorizou devolução / disse "pode devolver" / "estamos abrindo NFD" / "encaminhe pra devolução" / similar.
- **21 (REENTREGA SOLICITADA)**: cliente pediu reentrega / "podem tentar de novo" / "vamos receber" / "reentrega no mesmo endereço" / "novo endereço para entrega".
- **56 (FALTA INFO OPERACIONAL)**: cliente questionou evidência/foto/embalagem ou pediu informação que precisa Operação revisar antes (ex: "a foto não mostra a recusa", "como foi a entrega?", "preciso ver o que aconteceu").
- **54 (RE-LANÇAR — manter aguardando)**: resposta foi inconclusiva / cliente pediu prazo / "vou verificar e retorno" / não decidiu nada concreto.

Retorne EXCLUSIVAMENTE um JSON válido neste schema:
{
  "oc_sugerida": 44 | 21 | 56 | 54,
  "confianca": 0.0 a 1.0 (quão certo está da sugestão),
  "motivo": "1-2 frases explicando por que essa oc — em português, voltado pra Larissa entender rápido",
  "instrucao_reentrega_sugerida": "Caio 2026-05-11: APENAS quando oc_sugerida=21 — texto curto (até 250 chars) com informações úteis pra Operação executar a reentrega: novo endereço, contato/telefone novo, melhor horário, observação específica. Tudo extraído do texto do cliente. Se o cliente NÃO mencionou nada novo (só pediu reentrega genérica), retorna string vazia ''. Se oc_sugerida ≠ 21, OMITE este campo do JSON."
}

Regras:
- Confiança alta (>=0.8) só quando o cliente é EXPLÍCITO (autorizou, recusou, pediu reentrega).
- Confiança baixa (<0.5) quando texto é ambíguo — nesse caso prefira oc=54 (re-lançar) ou oc=56 (Operação revisar).
- Se cliente reclamou de algo novo (ex: "outro pedido também não chegou"), trate como oc=56 (Operação investigar) ou oc=54.
- NÃO invente outras ocs além das 4 listadas acima.
- Português direto, sem ornamentação. Sem cumprimentos.
- instrucao_reentrega_sugerida: sintetiza, NÃO copia. Ex: cliente disse "podem entregar na Rua das Flores 123, falar com Maria 11999999999" → "Novo endereço: Rua das Flores 123. Contato: Maria 11999999999". Se cliente só falou "pode reentregar" sem novidades → string vazia.`;

interface InputBody {
  card_id?: string;
  message_id?: string;
}

interface IaSugestao {
  oc_sugerida: number;
  confianca: number;
  motivo: string;
  instrucao_reentrega_sugerida?: string;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  try {
    const env = Deno.env.toObject();
    const supabase = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const anthropic = createAnthropicClient({ env: readAnthropicEnvFromProcess(env) });

    const body = await req.json().catch(() => null) as InputBody | null;
    if (!body?.card_id || !body?.message_id) {
      return json({ ok: false, error: "card_id e message_id obrigatórios" }, 400);
    }

    // Carrega card pra contexto (NF + oc atual + nome cliente)
    const { data: card } = await supabase
      .from("cards")
      .select("id, nf, empresa_cliente, cod_ultima_ocorrencia, agent_state")
      .eq("id", body.card_id)
      .maybeSingle();
    if (!card) return json({ ok: false, error: "card não encontrado" }, 404);

    // Carrega texto da mensagem inbound
    const { data: msg } = await supabase
      .from("messages_inbox")
      .select("conteudo, remetente, recebido_em")
      .eq("id", body.message_id)
      .maybeSingle();
    if (!msg) return json({ ok: false, error: "message não encontrada" }, 404);

    const conteudo = (msg.conteudo as string | null) ?? "";
    if (!conteudo.trim()) {
      return json({ ok: false, error: "mensagem sem conteúdo" }, 400);
    }

    const agentState = (card.agent_state ?? {}) as Record<string, unknown>;
    const userPrompt = [
      `Cliente: ${card.empresa_cliente ?? "?"}`,
      `NF: ${card.nf ?? "?"}`,
      `Última oc registrada antes da resposta: ${card.cod_ultima_ocorrencia ?? "?"}`,
      `Contexto da NF: ${(agentState["instrucao_ultima_ocorrencia"] as string | null) ?? "(sem contexto)"}`,
      "",
      "TEXTO DA RESPOSTA DO CLIENTE:",
      "---",
      conteudo.slice(0, 3000),
      "---",
      "",
      "Decida qual oc sugerir e responda só JSON.",
    ].join("\n");

    let sugestao: IaSugestao;
    try {
      sugestao = await anthropic.completeJson<IaSugestao>({
        model: MODEL,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
        maxTokens: 400,
        temperature: 0.2,
      });
    } catch (err) {
      const msgErr = err instanceof Error ? err.message : String(err);
      console.error("interpretador IA falhou:", msgErr);
      // Falha do LLM não bloqueia: log no card e retorna sem sugestão
      await supabase.from("card_events").insert({
        card_id: body.card_id,
        event_type: "InterpretadorRespostaClienteFalhou",
        actor_type: "agent",
        actor_id: "interpretador-resposta-cliente",
        payload: { message_id: body.message_id, motivo: msgErr },
      });
      return json({ ok: false, error: msgErr }, 200);
    }

    // Validação leve do output
    const ocsValidas = new Set([21, 44, 54, 56]);
    if (!ocsValidas.has(sugestao.oc_sugerida)) {
      return json({ ok: false, error: `oc_sugerida ${sugestao.oc_sugerida} fora da lista válida` }, 200);
    }
    const confianca = Math.max(0, Math.min(1, Number(sugestao.confianca) || 0));

    // Salva no card
    const instrucaoReentrega =
      sugestao.oc_sugerida === 21 && typeof sugestao.instrucao_reentrega_sugerida === "string"
        ? sugestao.instrucao_reentrega_sugerida.slice(0, 250).trim()
        : "";
    const sugestaoFull = {
      oc_sugerida: sugestao.oc_sugerida,
      confianca,
      motivo: sugestao.motivo.slice(0, 500),
      sugerido_em: new Date().toISOString(),
      message_id: body.message_id,
      instrucao_reentrega_sugerida: instrucaoReentrega,
    };

    await supabase
      .from("cards")
      .update({ ia_sugestao_oc_resposta: sugestaoFull })
      .eq("id", body.card_id);

    await supabase.from("card_events").insert({
      card_id: body.card_id,
      event_type: "InterpretadorRespostaClienteConcluido",
      actor_type: "agent",
      actor_id: "interpretador-resposta-cliente",
      payload: sugestaoFull,
    });

    return json({ ok: true, ...sugestaoFull }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("interpretador-resposta-cliente fatal:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
