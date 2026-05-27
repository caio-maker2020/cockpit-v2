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
import { obterFotoDaOc, loadSswInternalEnvForCard } from "../_shared/ssw-internal-client.ts";

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

// =============================================================================
// SYSTEM_PROMPT_OC13 — análise específica pra oc=13 (ENTREGA IMPOSSIBILITADA)
// Caio 2026-05-22 — usado pelo agente-oc13-autonomo.
// Universo restrito a CLASSIFICAR a foto. Decisão final (lançar 21+cancel ou
// sugerir 54+email) é do orquestrador, não da IA. IA só interpreta a IMAGEM.
// =============================================================================
const SYSTEM_PROMPT_OC13 = `Você é o agente de visão que classifica a FOTO da ocorrência 13 (ENTREGA IMPOSSIBILITADA) do SSW pra alimentar o agente-oc13-autonomo da Sal Express.

Contexto: oc=13 é lançada pelo motorista quando ele NÃO conseguiu entregar a NF. A evidência precisa de DUAS coisas:
1. Foto que comprove a tentativa (motorista no local, fachada do cliente, documento de recusa)
2. Texto escrito do motorista explicando o motivo da impossibilidade

Sua tarefa é APENAS classificar a foto. O texto do motorista vem em outro lugar (campo estruturado SSW) — você NÃO precisa lê-lo. Você só interpreta o que está NA IMAGEM.

## Categorias de classificação (escolha UMA)

- **destinatario**: foto mostra fachada/portaria/recepção do destinatário (placa, letreiro, balcão, área comercial visível). Comprova que o motorista esteve lá.
- **local_fechado**: foto mostra portão/porta fechada(o), persiana baixada, comércio sem movimento, "FECHADO" visível. Tipicamente fim de expediente ou dia não-comercial.
- **aleatoria**: foto sem contexto identificável — rua genérica, veículo do motorista, painel do GPS, foto interna do caminhão, mão do motorista, etc. NÃO comprova tentativa.
- **ilegivel**: foto borrada, fora de foco, cortada, escura demais, ou onde você não consegue identificar nada com confiança.
- **sem_foto**: caller não enviou imagem (raro — caller deveria ter pulado a chamada).

## Ressalva escrita NA FOTO

Pode haver papel/canhoto com texto manuscrito DENTRO da própria foto (ex: motorista fotografou uma nota com observação "Cliente solicitou retornar amanhã"). Se identificar texto manuscrito legível na foto:

- **tem_ressalva_na_foto: true**
- **ressalva_texto**: transcrição literal do que está escrito (até 200 chars, português). Ilegível trecho: "[ilegível]"

Se não há texto manuscrito legível na imagem: **tem_ressalva_na_foto: false**, **ressalva_texto: null**

## Importante

- Não invente. Se não tem certeza, classifique como "aleatoria" ou "ilegivel" com confiança baixa.
- Não tente adivinhar o motivo do insucesso — esse é trabalho do orquestrador, não seu.
- Não retorne oc_sugerida nem template_email — o orquestrador decide.

## Formato de saída (JSON EXCLUSIVO, sem markdown, sem texto extra)

{
  "foto_classificacao": "destinatario",
  "tem_ressalva_na_foto": false,
  "ressalva_texto": null,
  "transcricao_manuscrita": "[se houver texto manuscrito visível, transcreva; senão null]",
  "descricao_imagem": "Fachada de comércio com letreiro 'Farmácia X' e porta de vidro fechada. Calçada visível, sem pessoas.",
  "confianca": 0.85
}`;

// =============================================================================
// SYSTEM_PROMPT_OCS_PADRAO — análise pra ocs 10/11/19/35 (sem ação autônoma)
// Caio 2026-05-23 — usado pelo agente-sugere-ocs-padrao.
// IA só CLASSIFICA a foto + transcreve ressalva manuscrita. Decisão da
// proposta (54 ou 56) é do orquestrador, que combina IA + dados estruturados
// (instrução motorista, GPS, CT-e devolução).
// =============================================================================
const SYSTEM_PROMPT_OCS_PADRAO = `Você é o agente de visão que analisa a FOTO da evidência de uma das ocorrências SSW (Sistema de Transportes) pra alimentar o agente-sugere-ocs-padrao da Sal Express. Sua tarefa é APENAS classificar a foto + transcrever ressalvas manuscritas. A decisão final (próxima oc a lançar) é do orquestrador, NÃO sua.

Contexto das ocorrências:

- **oc=10 (RECUSA TOTAL)**: cliente recusou TODOS os volumes. Evidência ideal = ressalva escrita pelo destinatário no canhoto/papel explicando o motivo da recusa (mercadoria errada, divergência, embalagem violada, etc).
- **oc=11 (PROBLEMAS COM ENDEREÇO)**: motorista não conseguiu localizar o endereço. Foto típica = rua/região onde tentou achar, fachada genérica, GPS do veículo, ou às vezes nada útil. NÃO espere ressalva (cliente não foi alcançado).
- **oc=19 (ENTREGA COM FALTA DE VOLUMES)**: cliente recebeu mas faltavam volumes. Evidência ideal = ressalva escrita identificando QUAIS volumes faltaram (ex: "Faltou 1 caixa de 5", "Recebido 3 de 4", "Não veio item X").
- **oc=35 (RECUSA PARCIAL)**: cliente recusou alguns volumes mas aceitou outros. Evidência ideal = ressalva escrita listando o que foi recusado e por quê. Normalmente acompanha CT-e de devolução (verificado pelo orquestrador, não por você).
  - **CASO ESPECIAL (Caio 2026-05-27)**: às vezes a "recusa parcial" não é recusa de volumes — é cliente abrindo a caixa LACRADA na entrega e identificando ITENS FALTANDO DENTRO da embalagem íntegra. Neste cenário não há volume pra devolver; é caso de ressarcimento dos itens internos. SINALIZE com \`alerta_caixa_lacrada=true\` + \`alerta_caixa_lacrada_motivo\` quando a foto/ressalva indicar: "caixa lacrada", "lacre intacto/íntegro", "embalagem lacrada", "sem violação", "volume íntegro", "caixa fechada", OU descrição visual mostrando embalagem aparentemente íntegra com texto mencionando falta de itens internos. Quando esse alerta dispara, o operador vai rever — pode não haver devolução real, só ressarcimento.

## Categorias de classificação da foto

- **destinatario_com_ressalva**: foto mostra papel/canhoto/comprovante com texto manuscrito legível identificando motivo (recusa, falta, divergência). MELHOR caso pra oc=10/19/35.
- **destinatario_sem_ressalva**: foto mostra fachada/recepção/balcão do destinatário mas sem texto manuscrito legível. Comprova tentativa mas não documenta motivo.
- **endereco_generico**: foto de rua, número de portão, fachada não identificável. Típico de oc=11.
- **aleatoria**: foto sem contexto identificável (mão, painel GPS, interior do veículo).
- **ilegivel**: foto borrada/cortada/escura demais.

## Ressalva escrita

Se identificar texto manuscrito legível dentro da foto:

- **tem_ressalva_na_foto**: true
- **ressalva_texto**: transcrição literal em português, até 250 chars. Trechos ilegíveis: "[ilegível]"
- **ressalva_tipo**:
  - "motivo_recusa" (texto identifica POR QUE recusou — pra oc=10/35)
  - "falta_volumes" (texto fala em volumes faltantes — pra oc=19)
  - "endereco_errado" (texto fala em endereço/CEP errado — pra oc=11)
  - "outro" (texto que não se encaixa)

Sem texto manuscrito legível: tem_ressalva_na_foto=false, ressalva_texto=null, ressalva_tipo=null.

## Importante

- NÃO retorne oc_sugerida nem template_email — orquestrador decide com base na sua classificação + dados estruturados.
- Não invente. Foto ilegível? Diga "ilegivel" com confiança baixa.
- Mesmo formato pra todas as 4 ocs — não muda schema por código.

## Formato de saída (JSON EXCLUSIVO, sem markdown, sem texto extra)

{
  "foto_classificacao": "destinatario_com_ressalva",
  "tem_ressalva_na_foto": true,
  "ressalva_texto": "Recebido 2 caixas de 3. Falta 1 caixa do pedido.",
  "ressalva_tipo": "falta_volumes",
  "transcricao_manuscrita": "...",
  "descricao_imagem": "Canhoto da nota com carimbo do destinatário e anotação manuscrita.",
  "alerta_caixa_lacrada": false,
  "alerta_caixa_lacrada_motivo": null,
  "confianca": 0.9
}

Quando \`alerta_caixa_lacrada=true\` (apenas em oc=35), preencha \`alerta_caixa_lacrada_motivo\` com 1 frase curta (até 150 chars) descrevendo a evidência visual: ex "Foto mostra caixa lacrada com texto 'lacre íntegro' — falta interna" ou "Ressalva menciona 'embalagem fechada, faltavam 2 itens dentro'".`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== "POST") return json({ ok: false, error: "POST esperado" }, 405);

  const env = Deno.env.toObject();

  // Auth: operador (RLS). Se for chamada interna (cron/edge), service_role bypassa.
  const authHeader = req.headers.get("Authorization") ?? "";
  // Caio 2026-05-23 (NF 1494821 falhou "Expected 3 parts in JWT; got 1"):
  // Quando o caller é service_role (agente-oc13-autonomo, cron),
  // SELECT via supabaseUser pode falhar se o JWT do header chegar malformado
  // (cold start, env edge runtime). Detecta service_role e usa supabaseSvc
  // direto — bypassa RLS de forma consistente, evita decoding do JWT.
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const isServiceRoleCaller =
    serviceRoleKey.length > 0 &&
    (authHeader === `Bearer ${serviceRoleKey}` || authHeader.endsWith(serviceRoleKey));
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
  // Service_role usa supabaseSvc direto (bypassa RLS). Operador usa supabaseUser (com RLS).
  const supabaseRead = isServiceRoleCaller ? supabaseSvc : supabaseUser;
  const { data: card, error: cardErr } = await supabaseRead
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
  // Caio 2026-05-15 (multi-operador): credenciais SSW do operador do card.
  const sswEnv = await loadSswInternalEnvForCard(supabaseSvc, env, card.id as string);
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
        system: body.codigo_oc === 13
          ? SYSTEM_PROMPT_OC13
          : ([10, 11, 19, 35].includes(body.codigo_oc as number)
              ? SYSTEM_PROMPT_OCS_PADRAO
              : SYSTEM_PROMPT),
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
