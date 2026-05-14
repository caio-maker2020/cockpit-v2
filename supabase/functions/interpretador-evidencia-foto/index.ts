// =============================================================================
// interpretador-evidencia-foto — agente IA Vision que lê a foto da ocorrência
// no SSW e propõe a próxima tratativa (oc + template email) baseado no que
// vê (texto manuscrito, carimbos, assinaturas, motivo da recusa, etc).
//
// Caio 2026-05-13: descoberta no teste com NF 20761 (oc=10 manuscrita
// recusando bonificação que o hospital não usa). Larissa pode usar isso pra
// pré-popular tratativas em vez de transcrever manualmente.
//
// Input:  { card_id, codigo_oc }
// Output: {
//   ok, oc_descricao, confianca,
//   transcricao_manuscrita, partes_relevantes (carimbos, assinaturas, datas),
//   resumo_situacao,
//   oc_sugerida (33|44|54|21|55|56|41),
//   template_email_sugerido (RECUSA_TOTAL|...|null),
//   motivo_sugestao
// }
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { obterFotoDaOc, readSswInternalEnv } from "../_shared/ssw-internal-client.ts";

const MODEL = "claude-sonnet-4-6";
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const SYSTEM_PROMPT = `Você é o agente que analisa a FOTO da evidência de uma ocorrência do SSW (Sistema de Transportes) pra ajudar a operadora Sal Express (Larissa) a decidir o **primeiro passo** da tratativa.

A foto pode ser:
- Um documento (canhoto, carta de recusa, ressalva) fotografado pelo motorista via SSWMOBILE — costuma ter texto manuscrito do destinatário, carimbos, assinaturas, datas.
- Uma imagem da mercadoria (avaria, embalagem violada, volume faltando).
- Um relatório do sistema (ex: rastreamento veicular).

## REGRA DE NEGÓCIO IMPORTANTÍSSIMA (não viole)

**O PRIMEIRO PASSO de qualquer tratativa de problema na entrega é NOTIFICAR O CLIENTE PAGADOR** (lançar oc=54 + enviar email com template específico). Só DEPOIS que o cliente responde a Sal decide o passo seguinte (devolução=44, ressarcimento=33, reentrega=21, etc) — esses passos posteriores são tratados por OUTRO agente, não pelo seu output.

Você **NUNCA** deve sugerir oc=44, oc=33, oc=21, oc=55 ou oc=41 — esses só vêm pós-resposta do cliente. Seu universo de sugestão é restrito a 2 opções:

- **oc=54** (AGUARDANDO CLIENTE PAGADOR) + template_email_sugerido apropriado → cenário padrão. Use **APENAS quando** a foto for de ressalva/recusa/problema de entrega que exige consulta ao pagador **E o conteúdo manuscrito está LEGÍVEL** (claramente identificável: motivo da recusa, data, assinatura/carimbo visível).
- **oc=56** (FALTA INFO OPERACIONAL) + template=null → cenário em que **a Operação precisa revisar antes** de qualquer email. Use em 3 situações:
  1. **Foto é registro operacional interno** (foto da mercadoria mostrando avaria/extravio, custo extra registrado pelo motorista, problema interno de transferência, foto do veículo/galpão).
  2. **Foto é de papel manuscrito MAS o texto está ILEGÍVEL** — rasurado, fora de foco, cortado, parcialmente legível, ou onde você só consegue extrair fragmentos sem entender o motivo. **Regra crítica Caio 2026-05-14:** se enviarmos uma evidência ilegível pro cliente pagador, ele responde dizendo que não consegue ler e a Sal terá que lançar 56 mesmo depois — retrabalho garantido. Melhor já lançar 56 direto pra Operação providenciar foto legível. **Threshold:** se a transcrição_manuscrita ficar majoritariamente "[ilegível]" ou se o resumo_situacao não puder ser composto com confiança a partir do texto, classifique como ilegível.
  3. **Foto não documenta interação clara com o destinatário** (sem ressalva, sem assinatura, sem carimbo identificável).

## Catálogo de templates de email (uma opção, conforme contexto da foto)

- **RECUSA_TOTAL** — cliente recusou todos os volumes (recusa total da entrega).
- **RECUSA_PARCIAL** — cliente aceitou alguns volumes mas recusou outros.
- **PROBLEMAS_COM_ENDERECO** ou **ENDERECO_INCORRETO** — endereço errado, ausente, inacessível.
- **FALTA_DE_VOLUME** — cliente recebeu mas faltavam volumes do pedido.
- **EXTRAVIO_TOTAL_NOTIFICACAO** — extravio confirmado pelo time interno (não usado quando foto é de recusa).
- **COBRANCA_LEMBRETE** — follow-up (não usar em primeira análise).

## Sua tarefa

(a) **Transcrever fielmente** o texto manuscrito visível (ressalvas, motivos da recusa). Mantém o português escrito. Ilegível = "[ilegível]".

(b) **Identificar partes relevantes**: carimbos (empresa/CNPJ se visível), assinaturas (nome + matrícula se visíveis), datas. Listar sem interpretar.

(c) **Resumir** a situação em 1-2 frases pra Larissa.

(d) **oc_sugerida**: SEMPRE 54 (se há documento de cliente/destinatário) ou 56 (se Operação precisa revisar). Nada mais.

(e) **template_email_sugerido**: escolha do catálogo acima quando oc_sugerida=54. Null quando oc_sugerida=56.

(f) **corpo_email_sugerido**: rascunho do CORPO do email pro cliente pagador (~3-5 frases, tom formal Sal Express). Personalize com base no que você leu na foto (motivo da recusa, data, nome do destinatário, etc). Use placeholders {nf} e {ctrc} se quiser referenciar a carga — o backend substitui. Não inclui saudação inicial ("Prezados,") nem assinatura final — só o miolo do email. Se oc_sugerida=56, deixe **corpo_email_sugerido: null**.

(g) **motivo_sugestao**: 1 frase explicando por que escolheu oc=54 ou 56 e qual o próximo passo do fluxo.

(h) **confianca**: 0.0 a 1.0 — quão clara está a evidência.

## Formato de saída (JSON EXCLUSIVO, sem markdown fences, sem texto antes ou depois)

{
  "transcricao_manuscrita": "...",
  "partes_relevantes": {
    "carimbos": ["..."],
    "assinaturas": ["..."],
    "datas": ["..."]
  },
  "resumo_situacao": "...",
  "oc_sugerida": 54,
  "template_email_sugerido": "RECUSA_TOTAL",
  "corpo_email_sugerido": "Identificamos que a NF {nf} foi recusada totalmente pelo destinatário em 13/05/2026 sob a alegação de que os itens enviados (bonificação) não são utilizados na rotina do hospital. A ressalva foi formalizada pela colaboradora Bruna Cristina Barbosa (Almoxarifado HRJA). Solicitamos por gentileza orientação sobre o destino da mercadoria: prosseguir com retorno/devolução ou aguardar nova instrução de vocês.",
  "motivo_sugestao": "Recusa total documentada com ressalva manuscrita e carimbo do destinatário. Próximo passo: notificar pagador (oc=54 + RECUSA_TOTAL) e aguardar instrução pra decidir entre devolução (44), ressarcimento (33) ou outra tratativa.",
  "confianca": 0.9
}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== "POST") return json({ ok: false, error: "POST esperado" }, 405);

  const env = Deno.env.toObject();

  // Auth: operador (RLS). Se for chamada interna (cron/edge), service_role bypassa.
  const authHeader = req.headers.get("Authorization") ?? "";
  const supabaseUser = createClient(
    env["SUPABASE_URL"]!,
    env["SUPABASE_ANON_KEY"]!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const supabaseSvc = createClient(
    env["SUPABASE_URL"]!,
    env["SUPABASE_SERVICE_ROLE_KEY"]!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  let body: { card_id?: string; codigo_oc?: number };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "JSON inválido" }, 400);
  }
  if (!body.card_id || typeof body.codigo_oc !== "number") {
    return json({ ok: false, error: "{ card_id, codigo_oc } obrigatórios" }, 400);
  }

  // 1. Card via RLS + cache de análise IA
  const { data: card, error: cardErr } = await supabaseUser
    .from("cards")
    .select("id, nf, ctrc, ia_sugestao_evidencia")
    .eq("id", body.card_id)
    .maybeSingle();
  if (cardErr) return json({ ok: false, error: `SELECT card: ${cardErr.message}` }, 500);
  if (!card) return json({ ok: false, error: "card não encontrado ou sem acesso" }, 404);
  if (!card.nf) return json({ ok: false, error: "card sem NF" }, 400);

  // Cache lookup: se Larissa já clicou nessa oc nas últimas 24h, devolve o
  // resultado cacheado em vez de re-chamar SSW + Anthropic ($0.01/análise).
  // Caio 2026-05-14: refresh forçado é fazer override via query param ?force=1.
  const forcarRefresh = new URL(req.url).searchParams.get("force") === "1";
  const cache = (card.ia_sugestao_evidencia ?? {}) as Record<string, {
    analise?: Record<string, unknown>;
    atualizado_em?: string;
  }>;
  const cacheKey = String(body.codigo_oc);
  const cacheEntry = cache[cacheKey];
  if (
    !forcarRefresh &&
    cacheEntry?.analise &&
    cacheEntry.atualizado_em &&
    Date.now() - new Date(cacheEntry.atualizado_em).getTime() < 24 * 60 * 60 * 1000
  ) {
    return json({
      ok: true,
      card_id: card.id,
      nf: card.nf,
      codigo_oc: body.codigo_oc,
      cached: true,
      cache_atualizado_em: cacheEntry.atualizado_em,
      analise: cacheEntry.analise,
    }, 200);
  }

  // 2. Baixa a foto via SSW interno
  const startedAt = Date.now();
  const sswEnv = readSswInternalEnv(env);
  const fotoResult = await obterFotoDaOc(sswEnv, card.nf as string, body.codigo_oc, {
    ctrcEsperado: (card.ctrc as string | null) ?? null,
  });

  if (fotoResult.status !== "ok") {
    return json({
      ok: false,
      error: fotoResult.status,
      detalhe: fotoResult,
    }, fotoResult.status === "oc_sem_foto" ? 404 : 502);
  }

  const fotoMs = Date.now() - startedAt;

  // 3. Codifica binary em base64 pra Anthropic Vision API
  const base64 = uint8ArrayToBase64(fotoResult.binary);

  // 4. Chama Anthropic Vision (Sonnet 4.6 — descrita como capaz de leitura
  //    de texto manuscrito em testes anteriores Caio 2026-05-13)
  const apiKey = env["ANTHROPIC_API_KEY"];
  if (!apiKey) return json({ ok: false, error: "ANTHROPIC_API_KEY ausente" }, 500);

  const t1 = Date.now();
  let analise: Record<string, unknown> | null = null;
  try {
    const aResp = await fetch(ANTHROPIC_ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        temperature: 0.2,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: fotoResult.content_type,
                  data: base64,
                },
              },
              {
                type: "text",
                text: `Analise esta evidência da ocorrência ${body.codigo_oc} (${fotoResult.oc_descricao}) da NF ${card.nf}. Devolva o JSON estruturado.`,
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!aResp.ok) {
      const errText = await aResp.text();
      return json({ ok: false, error: `Anthropic ${aResp.status}: ${errText.slice(0, 300)}` }, 502);
    }
    const raw = await aResp.json() as Record<string, unknown>;
    const content = (raw["content"] as Array<Record<string, unknown>> | undefined) ?? [];
    const firstText = content.find((c) => c["type"] === "text");
    const text = firstText && typeof firstText["text"] === "string" ? firstText["text"] : "";
    analise = tryParseJson(text);
    if (!analise) {
      return json({
        ok: false,
        error: "Anthropic retornou texto não-JSON",
        raw_text: text.slice(0, 500),
      }, 502);
    }
  } catch (err) {
    return json({ ok: false, error: `Anthropic call: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }
  const iaMs = Date.now() - t1;

  const agora = new Date().toISOString();

  // 5. Persiste no cache 24h (cards.ia_sugestao_evidencia indexado por codigo_oc).
  // Caio 2026-05-14: evita re-clicar custar $0.01/análise se Larissa reabrir
  // o card no mesmo dia.
  const cacheAtualizado = {
    ...cache,
    [cacheKey]: {
      atualizado_em: agora,
      analise,
    },
  };
  await supabaseSvc
    .from("cards")
    .update({
      ia_sugestao_evidencia: cacheAtualizado,
      ia_sugestao_evidencia_atualizado_em: agora,
    })
    .eq("id", card.id);

  // 6. Audit em card_events
  await supabaseSvc.from("card_events").insert({
    card_id: card.id,
    event_type: "EvidenciaSugestaoIA",
    actor_type: "system",
    actor_id: "interpretador-evidencia-foto",
    payload: {
      codigo_oc: body.codigo_oc,
      oc_descricao: fotoResult.oc_descricao,
      modelo: MODEL,
      timings_ms: { foto: fotoMs, ia: iaMs },
      cached: false,
      analise,
    },
  });

  return json({
    ok: true,
    card_id: card.id,
    nf: card.nf,
    codigo_oc: body.codigo_oc,
    oc_descricao: fotoResult.oc_descricao,
    analise,
    timings_ms: { foto: fotoMs, ia: iaMs, total: Date.now() - startedAt },
  }, 200);
});

function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Deno tem btoa global, mas atob/btoa só trabalham em strings binárias.
  // Pra arrays grandes (até ~100KB), montar em chunks evita stack overflow.
  let bin = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode.apply(null, bytes.slice(i, i + chunkSize) as unknown as number[]);
  }
  return btoa(bin);
}

function tryParseJson(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t) return null;
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]!.trim() : t;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[\{\[]/);
    if (start === -1) return null;
    for (let end = candidate.length; end > start; end--) {
      try {
        return JSON.parse(candidate.slice(start, end));
      } catch { /* try smaller */ }
    }
    return null;
  }
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}
