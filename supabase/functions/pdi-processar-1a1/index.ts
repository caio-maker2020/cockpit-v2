// =============================================================================
// pdi-processar-1a1 — áudio do 1:1 (iPhone) → transcrição → resumo → kanban.
// ADR 0029. Fluxo: Caio sobe o áudio no bucket privado pdi_1a1 e o front
// invoca esta edge com {sessao_id}. Aqui: baixa o áudio do Storage, transcreve
// na OpenAI (gpt-4o-mini-transcribe; fallback whisper-1 — ÚNICO uso de OpenAI
// no Cockpit, escopo estrito da ADR), resume no Sonnet (prompt em
// _shared/prompts/pdi-1a1.ts) e cria os compromissos da Isadora em pdi_todos.
// Reprocessável: apaga os todos de origem compromisso_1a1 da sessão antes de
// recriar. Falha NUNCA perde o áudio (fica no Storage; status='erro' + motivo).
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createAnthropicClient,
  readAnthropicEnvFromProcess,
} from "../_shared/anthropic-client.ts";
import { makeUsageRecorder } from "../_shared/anthropic-usage-logger.ts";
import { PDI_1A1_MODEL, PDI_1A1_SYSTEM_PROMPT } from "../_shared/prompts/pdi-1a1.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PARTICIPANTES = new Set([
  "caio@salexpress.com.br",
  "isadora.baldoni@salexpress.com.br",
]);

interface ResumoJson {
  pauta: string[];
  feedbacks: string[];
  compromissos: Array<{ titulo: string; responsavel?: string; prazo?: string | null }>;
  sinais: string[];
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Só os participantes do PDI invocam (defesa além do JWT válido).
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: userData } = await supabase.auth.getUser(jwt);
  const email = (userData?.user?.email ?? "").toLowerCase();
  if (!PARTICIPANTES.has(email)) return json(403, { ok: false, error: "acesso_negado" });

  let sessaoId: string;
  let transcricaoColada: string;
  try {
    const body = await req.json();
    sessaoId = String(body.sessao_id ?? "");
    // Caminho B (Caio 16/09): ele transcreve fora (iPhone/qualquer ferramenta)
    // e manda o texto pronto — aí pulamos a OpenAI e só resumimos no Sonnet.
    transcricaoColada = String(body.transcricao ?? "").trim();
  } catch (_e) {
    return json(400, { ok: false, error: "body inválido" });
  }
  if (!sessaoId) return json(400, { ok: false, error: "sessao_id obrigatório" });

  const { data: sessao, error: selErr } = await supabase
    .from("pdi_1a1").select("id, data, audio_path, transcricao").eq("id", sessaoId).maybeSingle();
  if (selErr || !sessao) return json(404, { ok: false, error: "sessão não encontrada" });
  const audioPath = (sessao as { audio_path: string | null }).audio_path;
  if (!audioPath && !transcricaoColada) {
    return json(400, { ok: false, error: "sessão sem áudio e sem transcrição colada" });
  }

  const falhar = async (motivo: string) => {
    await supabase.from("pdi_1a1")
      .update({ status: "erro", erro: motivo }).eq("id", sessaoId);
    return json(500, { ok: false, error: motivo });
  };

  await supabase.from("pdi_1a1").update({ status: "processando", erro: null }).eq("id", sessaoId);

  try {
    let transcricao = transcricaoColada;

    if (!transcricao && audioPath) {
      // 1. Áudio do Storage
      const { data: blob, error: dlErr } = await supabase.storage.from("pdi_1a1").download(audioPath);
      if (dlErr || !blob) return await falhar(`download do áudio falhou: ${dlErr?.message ?? "vazio"}`);
      if (blob.size > 25 * 1024 * 1024) {
        return await falhar(
          "áudio acima de 25MB (limite da transcrição). Grave em qualidade comprimida, divida a gravação — ou cole a transcrição pronta.",
        );
      }

      // 2. Transcrição (OpenAI — ADR 0029, escopo estrito desta edge)
      const openaiKey = Deno.env.get("OPENAI_API_KEY");
      if (!openaiKey) {
        return await falhar(
          "OPENAI_API_KEY não configurada. Alternativa imediata: cole a transcrição pronta (o iPhone transcreve no Notas de Voz) — o áudio segue salvo.",
        );
      }
      const nomeArquivo = audioPath.split("/").pop() ?? "audio.m4a";
      async function transcrever(modelo: string): Promise<Response> {
        const form = new FormData();
        form.append("file", blob!, nomeArquivo);
        form.append("model", modelo);
        form.append("language", "pt");
        return await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${openaiKey}` },
          body: form,
        });
      }
      let resp = await transcrever("gpt-4o-mini-transcribe");
      if (!resp.ok) resp = await transcrever("whisper-1"); // fallback
      if (!resp.ok) {
        const det = (await resp.text()).slice(0, 300);
        return await falhar(`transcrição falhou (HTTP ${resp.status}): ${det}`);
      }
      transcricao = String(((await resp.json()) as { text?: string }).text ?? "").trim();
    }
    if (!transcricao) return await falhar("transcrição veio vazia");

    // 3. Resumo estruturado (Claude Sonnet — prompt versionado)
    const anthropic = createAnthropicClient({
      env: readAnthropicEnvFromProcess(Deno.env.toObject()),
      onUsage: makeUsageRecorder(supabase, {
        functionName: "pdi-processar-1a1",
        agentName: "pdi-1a1",
      }),
    });
    const resumo = await anthropic.completeJson<ResumoJson>({
      model: PDI_1A1_MODEL,
      system: PDI_1A1_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content:
          `Data da reunião: ${(sessao as { data: string }).data}\n\nTranscrição:\n"""\n${transcricao.slice(0, 150_000)}\n"""`,
      }],
      maxTokens: 1500,
      temperature: 0.1,
    });

    // 4. Persiste e recria os compromissos da Isadora no kanban (idempotente)
    await supabase.from("pdi_1a1")
      .update({ transcricao, resumo, status: "resumido" }).eq("id", sessaoId);
    await supabase.from("pdi_todos")
      .delete().eq("origem", "compromisso_1a1").eq("origem_id", sessaoId);
    const compromissosIsadora = (resumo.compromissos ?? [])
      .filter((c) => (c.responsavel ?? "isadora").toLowerCase() !== "caio")
      .map((c) => ({
        titulo: c.titulo,
        detalhe: `Compromisso do 1:1 de ${(sessao as { data: string }).data}`,
        origem: "compromisso_1a1",
        origem_id: sessaoId,
        prazo: c.prazo ?? null,
        status: "a_fazer",
      }));
    if (compromissosIsadora.length > 0) {
      await supabase.from("pdi_todos").insert(compromissosIsadora);
    }

    return json(200, {
      ok: true,
      chars_transcricao: transcricao.length,
      compromissos_criados: compromissosIsadora.length,
    });
  } catch (err) {
    return await falhar(`erro inesperado: ${err instanceof Error ? err.message : String(err)}`);
  }
});
