// =============================================================================
// converter-anexo-pdf — conversão PDF→JPEG NO SERVIDOR (Caio 26/08: "tudo que
// é PDF já ser regra converter, visto que o SSW não aceita de nenhuma forma").
//
// Motor: PDFium (o engine de PDF do Chrome, via WASM) — decodifica JBIG2
// nativamente, a causa-raiz do bug NF-135724 que o pdf.js do modal tinha.
// Guard portado (pdf-conversao-guard): página <2% de pixels não-brancos
// NUNCA sobe. Prova real 26/08: DANFE Würth de produção convertido nítido
// (fração 8,4%).
//
// Edge DEDICADA (wasm ~5MB fica fora dos bundles críticos). Chamada por:
//   - veto-agendamento (33 autônoma com romaneio em PDF);
//   - qualquer fluxo futuro que precise de anexo SSW-ready.
//
// POST (service role): { card_id, anexo_ids: string[] }
// → { ok, convertidos: [{ anexo_id, novos_ids, paginas }], falhas: [{ anexo_id, motivo }] }
// Anexo que não é PDF volta em `falhas` com motivo 'nao_e_pdf' (caller decide).
// Cada conversão vira card_event AnexoPdfConvertidoServidor (auditoria).
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { PDFiumLibrary } from "npm:@hyzyla/pdfium@2.1.4";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";
import { avaliarPaginaServidor } from "../_shared/pdf-conversao-guard.ts";

const MAX_PAGINAS_POR_PDF = 8; // romaneio real tem poucas páginas; teto anti-abuso
const SCALE = 2.5; // paridade com o modal (convertPdfBlobToJpegFiles)
const JPEG_QUALITY = 92;

serve(async (req) => {
  const auth = req.headers.get("Authorization") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!auth.includes(serviceKey)) {
    return new Response(JSON.stringify({ ok: false, error: "service role only" }), { status: 401 });
  }
  let body: { card_id?: string; anexo_ids?: string[] };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "body inválido" }), { status: 400 });
  }
  const cardId = body.card_id;
  const anexoIds = (body.anexo_ids ?? []).filter((x) => typeof x === "string");
  if (!cardId || anexoIds.length === 0) {
    return new Response(JSON.stringify({ ok: false, error: "card_id e anexo_ids obrigatórios" }), { status: 400 });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const convertidos: Array<{ anexo_id: string; novos_ids: string[]; paginas: number }> = [];
  const falhas: Array<{ anexo_id: string; motivo: string }> = [];

  const { data: rows } = await supabase
    .from("email_anexos")
    .select("id, storage_path, filename, mime_type, card_id")
    .in("id", anexoIds)
    .is("deletado_em", null);

  let lib: Awaited<ReturnType<typeof PDFiumLibrary.init>> | null = null;
  try {
    for (const anexoId of anexoIds) {
      const row = ((rows ?? []) as Array<{ id: string; storage_path: string; filename: string; mime_type: string; card_id: string }>)
        .find((r) => r.id === anexoId);
      if (!row) { falhas.push({ anexo_id: anexoId, motivo: "anexo_nao_encontrado_ou_deletado" }); continue; }
      if (row.mime_type !== "application/pdf") { falhas.push({ anexo_id: anexoId, motivo: "nao_e_pdf" }); continue; }

      try {
        const { data: blob, error: dlErr } = await supabase.storage
          .from("email_anexos").download(row.storage_path);
        if (dlErr || !blob) { falhas.push({ anexo_id: anexoId, motivo: `download_falhou:${dlErr?.message ?? "?"}` }); continue; }
        const pdfBytes = new Uint8Array(await blob.arrayBuffer());

        lib = lib ?? await PDFiumLibrary.init();
        const doc = await lib.loadDocument(pdfBytes);
        const nPaginas = doc.getPageCount();
        if (nPaginas > MAX_PAGINAS_POR_PDF) {
          doc.destroy();
          falhas.push({ anexo_id: anexoId, motivo: `pdf_com_${nPaginas}_paginas_acima_do_teto_${MAX_PAGINAS_POR_PDF}` });
          continue;
        }

        const novosIds: string[] = [];
        let guardEstourou: string | null = null;
        const uploads: Array<{ path: string; jpeg: Uint8Array; filename: string }> = [];

        for (let p = 0; p < nPaginas; p++) {
          const page = doc.getPage(p);
          const render = await page.render({ scale: SCALE, render: "bitmap" });
          const veredito = avaliarPaginaServidor(render.data);
          if (veredito.quebrada) {
            guardEstourou = `pagina_${p + 1}_quase_branca(${veredito.fracaoNaoBranca.toFixed(4)})`;
            break;
          }
          const totalPx = render.width * render.height;
          const img = new Image(render.width, render.height);
          const d = render.data; // BGRA → RGBA
          for (let px = 0, i = 0; px < totalPx; px++, i += 4) {
            img.bitmap[i] = d[i + 2]!;
            img.bitmap[i + 1] = d[i + 1]!;
            img.bitmap[i + 2] = d[i]!;
            img.bitmap[i + 3] = 255;
          }
          const jpeg = await img.encodeJPEG(JPEG_QUALITY);
          const safeBase = row.filename.replace(/\.pdf$/i, "").replace(/[^\w.-]+/g, "_");
          const filename = `${safeBase}_p${p + 1}.jpg`;
          uploads.push({
            path: `conversao/${row.card_id}/${anexoId}_p${p + 1}.jpg`,
            jpeg,
            filename,
          });
        }
        doc.destroy();

        if (guardEstourou) {
          await supabase.from("card_events").insert({
            card_id: row.card_id,
            event_type: "ConversaoPdfBloqueadaGuard",
            actor_type: "system",
            actor_id: "converter-anexo-pdf",
            payload: { anexo_id: anexoId, filename: row.filename, motivo: guardEstourou },
          });
          falhas.push({ anexo_id: anexoId, motivo: `guard:${guardEstourou}` });
          continue;
        }

        // upload + metadata só com TODAS as páginas válidas (nunca meio-PDF)
        for (const u of uploads) {
          const { error: upErr } = await supabase.storage
            .from("email_anexos")
            .upload(u.path, u.jpeg, { contentType: "image/jpeg", upsert: true });
          if (upErr) { guardEstourou = `upload_falhou:${upErr.message}`; break; }
          const { data: novo, error: insErr } = await supabase
            .from("email_anexos")
            .insert({
              card_id: row.card_id,
              storage_path: u.path,
              filename: u.filename,
              mime_type: "image/jpeg",
              size_bytes: u.jpeg.length,
              origem: "outbound",
            })
            .select("id").single();
          if (insErr || !novo) { guardEstourou = `insert_falhou:${insErr?.message ?? "?"}`; break; }
          novosIds.push((novo as { id: string }).id);
        }
        if (guardEstourou) { falhas.push({ anexo_id: anexoId, motivo: guardEstourou }); continue; }

        await supabase.from("card_events").insert({
          card_id: row.card_id,
          event_type: "AnexoPdfConvertidoServidor",
          actor_type: "system",
          actor_id: "converter-anexo-pdf",
          payload: { anexo_id: anexoId, filename: row.filename, paginas: uploads.length, novos_ids: novosIds },
        });
        convertidos.push({ anexo_id: anexoId, novos_ids: novosIds, paginas: uploads.length });
      } catch (e) {
        falhas.push({ anexo_id: anexoId, motivo: `erro:${e instanceof Error ? e.message : String(e)}` });
      }
    }
  } finally {
    lib?.destroy();
  }

  return new Response(JSON.stringify({ ok: true, convertidos, falhas }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
