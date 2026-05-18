// =============================================================================
// interpretador-resposta-cliente — agente IA Sonnet que lê resposta do cliente
// + email da Larissa pré-resposta + lista de anexos enviados, e sugere a
// próxima oc + detecta pendências (cliente respondeu parcial?) + identifica
// padrão de ressarcimento (combo 33+44).
//
// v3 (Caio 2026-05-12 NF 920161): IA agora compara perguntas Larissa vs
// respostas cliente. Detecta casos como "Larissa pediu romaneio mas cliente
// respondeu sem anexar". Sugere combo 33+44 quando cliente autorizou
// devolução E Larissa pediu romaneio (= caso ressarcimento).
//
// Input:  { card_id, message_id }
// Output: { ok, oc_sugerida, confianca, motivo, instrucao_reentrega_sugerida?,
//          pendencias_resposta_cliente, sugere_combo_33_44, motivo_combo? }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createAnthropicClient,
  readAnthropicEnvFromProcess,
} from "../_shared/anthropic-client.ts";

const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `Você é o agente que interpreta a resposta de um cliente farmacêutico depois que a Sal Express lançou oc=54 ("aguardando posicionamento do cliente pagador") sobre uma NF com problema (recusa total/parcial, problema endereço, falta volume, etc).

Você recebe 3 informações:
1. **Email enviado pela operadora pré-resposta** (perguntas/solicitações feitas ao cliente). O nome real da operadora vem no campo OPERADORA do contexto — use-o se precisar referenciar a operadora no output.
2. **Texto da resposta do cliente** (o que ele devolveu).
3. **Lista de anexos enviados pelo cliente** (filenames/mime types — pode ser vazio).

Sua tarefa: comparar o que a operadora pediu vs. o que o cliente respondeu, e produzir:

(a) **Sugestão de próxima oc** — uma de 5 opções:
- **44 (RETORNO DE CARGA / DEVOLUÇÃO)**: cliente autorizou devolução / "pode devolver" / "abre NFD" / "gentileza devolver" / similar. **Inclui o caso em que cliente envia anexo (ex: romaneio) e autoriza devolução — o anexo NÃO move pra oc=56, ele resolve a pendência. A oc principal continua sendo 44.**
- **33 (REVERSÃO DE PERDAS / INDENIZAÇÃO — SEM devolução)**: usado em casos de **extravio total** ou outro cenário em que NÃO existe volume físico pra devolver pro cliente. Cliente envia o romaneio e/ou autoriza prosseguir, mas como não há devolução, só faz sentido iniciar o processo de indenização (33), SEM encadear 44. Detectar pelo email da operadora: se assunto/corpo menciona "extravio total" / "perda total" / "extravio de toda a carga" / "100% extraviada" / similar, esse é o cenário.
- **21 (REENTREGA SOLICITADA)**: cliente pediu reentrega / "podem tentar de novo" / "novo endereço pra entrega". **Caso especial — REENTREGA SEM PAGAR**: se cliente autoriza reentrega MAS se nega explicitamente a pagar pela nova viagem (ex: "podem tentar de novo mas não vou pagar essa viagem", "ok pode reentregar sem cobrar", "vocês que erraram, refaçam sem custo"), continua oc_sugerida=21 + marca o flag cliente_autorizou_reentrega_sem_pagar=true e preenche motivo_cliente_recusa_pagar avaliando se o argumento do cliente é razoável (ver bloco (d) abaixo).
- **56 (FALTA INFO OPERACIONAL)**: cliente **QUESTIONOU evidência/foto** OU pediu informação que **Operação precisa revisar** antes de qualquer decisão. Ex: "a foto não mostra a recusa", "preciso ver como foi a entrega", "esse pedido nem é nosso, podem verificar?". **NÃO use 56 quando cliente JÁ enviou o documento que a operadora pediu** — nesse caso a pendência foi resolvida pelo cliente; a próxima ação é seguir o processo (44, 33-solo ou combo 33+44).
- **54 (RE-LANÇAR — manter aguardando)**: resposta inconclusiva / cliente pediu prazo / não decidiu.

(b) **Pendências** — lista descritiva (até 3 itens) do que a operadora pediu mas o cliente NÃO respondeu / NÃO anexou. Cada item curto (≤120 chars). Use termo neutro ("a operadora", "Sal Express") OU o nome real vindo do campo OPERADORA — NUNCA cite outro nome. Exemplos:
- "Cliente não anexou o romaneio de coleta assinado que a operadora pediu"
- "Cliente não respondeu se autoriza a devolução"
- "Faltou confirmar o novo endereço pra reentrega"

Se cliente respondeu TUDO que a operadora pediu, retorna array vazio [].

(c) **Indenização — combo 33+44 OU oc=33 SOLO** (escolha 1, mutuamente exclusivos):

**Significado das ocs no processo Sal Express:**
- **oc=33** = INÍCIO do processo de INDENIZAÇÃO pelo time de Perdas. A operadora só consegue abrir esse processo COM o romaneio assinado pelo cliente em mãos.
- **oc=44** = autorização de devolução do volume físico (o que está com a Sal) ao cliente.

**REGRA CRÍTICA — extravio total**: Se o email da operadora indica **extravio total** (assunto/corpo com "extravio total", "perda total", "extravio de toda a carga", "100% extraviada", ou contexto equivalente), **NÃO EXISTE volume pra devolver pro cliente** — então NUNCA sugira combo 33+44 (oc=44 não faz sentido). Use oc=33 solo. Detalhe: em extravio total, a operadora pede o romaneio APENAS pra iniciar a indenização, não pra autorizar devolução.

**Quando sugerir cada uma:**

- Operadora pediu romaneio/ressarcimento E cliente autorizou devolução E NÃO é extravio total → sugere_combo_33_44=true e oc_sugerida=44.
- Operadora pediu romaneio/ressarcimento E cliente forneceu E **É extravio total** → sugere_oc33_solo=true e oc_sugerida=33.
- Nenhuma das condições acima → ambos false; oc_sugerida segue a regra (a).

Combo precisa AMBAS as condições:
- (i) Operadora pediu romaneio de coleta assinado OU mencionou "ressarcimento" / "análise de perdas" / "indenização" no email
- (ii) Cliente autorizou devolução (texto explícito OU envio do romaneio anexo confirma autorização)
- (iii) **NÃO é extravio total** (se for, vira oc33_solo)

oc=33 solo precisa:
- (i) Email da operadora indica extravio total
- (ii) Cliente forneceu romaneio OU autorizou prosseguir

**Caso âncora combo**: Operadora pede "encaminhe o romaneio para iniciar ressarcimento" (recusa parcial / falta volume) + Cliente envia romaneio + "podem prosseguir" → combo 33+44.

**Caso âncora oc33_solo**: Operadora manda email com assunto "EXTRAVIO TOTAL NF 607458 — XPTO" + Cliente responde com romaneio → oc=33 solo. NUNCA combo (não há devolução possível).

NUNCA marcar sugere_combo_33_44=true E sugere_oc33_solo=true ao mesmo tempo — mutuamente exclusivos.

(d) **Reentrega sem cobrança ao cliente** (Caio 2026-05-18) — marque cliente_autorizou_reentrega_sem_pagar=true somente quando AMBAS as condições forem atendidas:
- (i) Cliente autorizou reentrega de forma explícita (ex: "podem tentar de novo", "ok pode reentregar", "manda de novo", "pode reenviar")
- (ii) Cliente se nega de forma explícita a pagar a nova viagem (ex: "não vou pagar", "sem cobrar/custo", "vocês que erraram", "é responsabilidade de vocês", "essa viagem é por conta da transportadora")

Quando flag=true:
- oc_sugerida deve ser **21** (não 54, não combo, não 33)
- Preencha motivo_cliente_recusa_pagar com 1-2 frases avaliando se o argumento do cliente é razoável. Exemplos:
  - "Argumento procede: insucesso documentado como erro Sal (entrega no endereço errado / sem tentativa) — cliente justifica recusa de pagamento."
  - "Argumento procede parcialmente: cliente alega erro Sal mas evidência sugere ausência do destinatário; vale negociação."
  - "Argumento NÃO procede claramente: cliente recusou entrega legítima, recusa de pagamento parece tentativa de transferir custo."
- O Cockpit vai usar essa flag pra pré-marcar checkbox no modal "Cancelar reentrega automaticamente em 24h". O motivo da IA pode virar a descrição usada no cancelamento SSW.

NÃO marque essa flag quando: (1) cliente só pediu reentrega sem mencionar pagamento; (2) cliente reclama de custo mas não autoriza reentrega; (3) qualquer ambiguidade — prefere flag=false.

Retorne EXCLUSIVAMENTE um JSON válido neste schema:
{
  "oc_sugerida": 44 | 33 | 21 | 56 | 54,
  "confianca": 0.0 a 1.0,
  "motivo": "1-2 frases — português direto",
  "instrucao_reentrega_sugerida": "se oc_sugerida=21: até 250 chars com novo endereço/contato/horário do cliente. Senão omite.",
  "pendencias_resposta_cliente": ["string ≤120 chars", ...] (array, vazio se sem pendências),
  "sugere_combo_33_44": true | false,
  "sugere_oc33_solo": true | false,
  "motivo_combo": "1 frase — por que combo 33+44 OU por que oc=33 solo (só se um dos dois booleans é true; senão omite)",
  "cliente_autorizou_reentrega_sem_pagar": true | false,
  "motivo_cliente_recusa_pagar": "1-2 frases avaliando se o argumento do cliente procede (só preencha quando cliente_autorizou_reentrega_sem_pagar=true; senão omite)"
}

Regras:
- Confiança alta (≥0.8) só com cliente explícito.
- Confiança baixa (<0.5) → prefere oc=54 ou 56.
- Cliente reclama de algo novo → oc=56 ou 54.
- NÃO inventa outras ocs.
- Português direto, sem ornamentação.
- Pendências: só do que a operadora REALMENTE pediu no email. Não inventa.
- Se IA não tem o email da operadora (campo ausente), pendencias = [] e sugere_combo_33_44 = false (não dá pra inferir).
- **Nome da operadora**: NUNCA invente um nome (ex: "Larissa", "Duilio"). Se precisar referenciar a pessoa, use o nome real do campo OPERADORA no contexto, ou termos neutros ("a operadora", "Sal Express"). Cada card tem uma operadora diferente — citar nome errado é erro grave.`;

interface InputBody {
  card_id?: string;
  message_id?: string;
}

interface IaSugestao {
  oc_sugerida: number;
  confianca: number;
  motivo: string;
  instrucao_reentrega_sugerida?: string;
  pendencias_resposta_cliente?: string[];
  sugere_combo_33_44?: boolean;
  sugere_oc33_solo?: boolean;
  motivo_combo?: string;
  /** Caio 2026-05-18: cliente autorizou reentrega mas se nega a pagar. */
  cliente_autorizou_reentrega_sem_pagar?: boolean;
  /** Avaliação IA se o argumento do cliente procede. Só preenchido quando flag acima = true. */
  motivo_cliente_recusa_pagar?: string;
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

    const { data: card } = await supabase
      .from("cards")
      .select("id, nf, empresa_cliente, cod_ultima_ocorrencia, agent_state, responsavel_relacionamento")
      .eq("id", body.card_id)
      .maybeSingle();
    if (!card) return json({ ok: false, error: "card não encontrado" }, 404);

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

    // Caio 2026-05-12: carrega último email outbound da operadora pra contexto.
    const { data: ultimoOutbound } = await supabase
      .from("cards_emails_outbound")
      .select("corpo_renderizado, subject, sent_at")
      .eq("card_id", body.card_id)
      .lt("sent_at", msg.recebido_em as string)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const emailOperadora = (ultimoOutbound as { corpo_renderizado?: string | null } | null)?.corpo_renderizado ?? "";
    const operadoraNome = (card.responsavel_relacionamento as string | null) ?? "a operadora";

    // Anexos inbound dessa mensagem
    const { data: anexosRaw } = await supabase
      .from("email_anexos")
      .select("filename, mime_type, size_bytes")
      .eq("message_inbox_id", body.message_id)
      .eq("origem", "inbound");
    const anexos = (anexosRaw ?? []) as Array<{ filename: string; mime_type: string; size_bytes: number }>;
    const anexosDescritos = anexos.length === 0
      ? "(nenhum anexo)"
      : anexos.map((a) => `- ${a.filename} (${a.mime_type}, ${Math.round(a.size_bytes / 1024)}KB)`).join("\n");

    const agentState = (card.agent_state ?? {}) as Record<string, unknown>;
    const userPrompt = [
      `OPERADORA: ${operadoraNome}`,
      `Cliente: ${card.empresa_cliente ?? "?"}`,
      `NF: ${card.nf ?? "?"}`,
      `Última oc registrada antes da resposta: ${card.cod_ultima_ocorrencia ?? "?"}`,
      `Contexto da NF: ${(agentState["instrucao_ultima_ocorrencia"] as string | null) ?? "(sem contexto)"}`,
      "",
      `EMAIL DA OPERADORA (${operadoraNome}, pré-resposta):`,
      "---",
      emailOperadora ? emailOperadora.slice(0, 2000) : "(email da operadora não disponível — sem contexto pré-resposta)",
      "---",
      "",
      "TEXTO DA RESPOSTA DO CLIENTE:",
      "---",
      conteudo.slice(0, 3000),
      "---",
      "",
      "ANEXOS ENVIADOS PELO CLIENTE:",
      anexosDescritos,
      "",
      "Decida oc + pendências + combo 33+44. Responda só JSON.",
    ].join("\n");

    let sugestao: IaSugestao;
    try {
      sugestao = await anthropic.completeJson<IaSugestao>({
        model: MODEL,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
        maxTokens: 700,
        temperature: 0.2,
      });
    } catch (err) {
      const msgErr = err instanceof Error ? err.message : String(err);
      console.error("interpretador IA falhou:", msgErr);
      await supabase.from("card_events").insert({
        card_id: body.card_id,
        event_type: "InterpretadorRespostaClienteFalhou",
        actor_type: "agent",
        actor_id: "interpretador-resposta-cliente",
        payload: { message_id: body.message_id, motivo: msgErr },
      });
      return json({ ok: false, error: msgErr }, 200);
    }

    const ocsValidas = new Set([21, 33, 44, 54, 56]);
    if (!ocsValidas.has(sugestao.oc_sugerida)) {
      return json({ ok: false, error: `oc_sugerida ${sugestao.oc_sugerida} fora da lista válida` }, 200);
    }
    const confianca = Math.max(0, Math.min(1, Number(sugestao.confianca) || 0));

    // Normaliza output
    const instrucaoReentrega =
      sugestao.oc_sugerida === 21 && typeof sugestao.instrucao_reentrega_sugerida === "string"
        ? sugestao.instrucao_reentrega_sugerida.slice(0, 250).trim()
        : "";

    const pendencias = Array.isArray(sugestao.pendencias_resposta_cliente)
      ? sugestao.pendencias_resposta_cliente
          .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
          .map((p) => p.slice(0, 120).trim())
          .slice(0, 3)
      : [];

    // Caio 2026-05-12: combo e oc33_solo são mutuamente exclusivos.
    // Se IA marcar os dois, dá preferência ao oc33_solo (extravio total —
    // mais conservador, evita lançar oc=44 num caso onde não há volume).
    let sugereCombo = sugestao.sugere_combo_33_44 === true;
    let sugereOc33Solo = sugestao.sugere_oc33_solo === true;
    if (sugereCombo && sugereOc33Solo) sugereCombo = false;

    const motivoCombo =
      (sugereCombo || sugereOc33Solo) && typeof sugestao.motivo_combo === "string"
        ? sugestao.motivo_combo.slice(0, 300).trim()
        : "";

    const sugestaoFull = {
      oc_sugerida: sugestao.oc_sugerida,
      confianca,
      motivo: sugestao.motivo.slice(0, 500),
      sugerido_em: new Date().toISOString(),
      message_id: body.message_id,
      instrucao_reentrega_sugerida: instrucaoReentrega,
      pendencias_resposta_cliente: pendencias,
      sugere_combo_33_44: sugereCombo,
      sugere_oc33_solo: sugereOc33Solo,
      motivo_combo: motivoCombo,
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
