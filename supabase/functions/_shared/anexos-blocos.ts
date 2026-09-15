// =============================================================================
// anexos-blocos.ts — baixa o anexo do balde e monta o bloco que vai ao modelo.
//
// PDF vira bloco `document` NATIVO (a própria API renderiza e lê a página);
// foto vira `image`, igual ao que interpretador-evidencia-foto já faz.
//
// Por que NÃO usamos a edge converter-anexo-pdf: ela GRAVA linha nova em
// email_anexos com origem='outbound' (converter-anexo-pdf/index.ts:137-147),
// não é idempotente (63 linhas para 57 caminhos em produção) e cada linha
// queima uma vaga do teto de 20 anexos do operador naquele card
// (_shared/limite-anexos.ts:52-60, a falha da NF 719250). Ler não pode ter
// efeito colateral no card.
//
// BEST-EFFORT por arquivo: download que falha NÃO derruba a leitura — o card
// segue pelo texto, exatamente como hoje.
// =============================================================================

import type { AnthropicContentBlock } from "./anthropic-client.ts";
import type { AnexoCandidato } from "./anexos-leitura.ts";

const BUCKET = "email_anexos";

/**
 * base64 em pedaços de 32KB de propósito: `String.fromCharCode(...bytes)` com o
 * array inteiro estoura a pilha em arquivo grande.
 */
export function bytesParaBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function blocoDoMime(
  mime: string,
  base64: string,
): AnthropicContentBlock | null {
  const m = (mime ?? "").trim().toLowerCase();
  if (m === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } };
  }
  if (m === "image/jpeg" || m === "image/jpg") {
    return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } };
  }
  if (m === "image/png") {
    return { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } };
  }
  return null;
}

/** Rótulo que precede cada arquivo. O nome tem de ser LITERAL: a validação
 *  determinística do dossiê descarta a evidência se o nome não bater com um
 *  anexo real (acharAnexoInbound em modo exato). */
export function rotuloDoArquivo(filename: string): string {
  return `ARQUIVO ANEXADO PELO CLIENTE: "${filename}"`;
}

export interface BlocosDeAnexos {
  blocos: AnthropicContentBlock[];
  abertos: AnexoCandidato[];
  falhas: Array<{ id: string; filename: string; motivo: string }>;
}

// deno-lint-ignore no-explicit-any
export async function carregarBlocosDeAnexos(
  supabase: any,
  anexos: readonly AnexoCandidato[],
): Promise<BlocosDeAnexos> {
  const blocos: AnthropicContentBlock[] = [];
  const abertos: AnexoCandidato[] = [];
  const falhas: BlocosDeAnexos["falhas"] = [];

  for (const a of anexos) {
    try {
      const { data: blob, error } = await supabase.storage.from(BUCKET).download(a.storage_path);
      if (error || !blob) {
        falhas.push({ id: a.id, filename: a.filename, motivo: `download:${error?.message ?? "vazio"}` });
        continue;
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.byteLength === 0) {
        falhas.push({ id: a.id, filename: a.filename, motivo: "arquivo_vazio" });
        continue;
      }
      const bloco = blocoDoMime(a.mime_type, bytesParaBase64(bytes));
      if (!bloco) {
        falhas.push({ id: a.id, filename: a.filename, motivo: `sem_bloco:${a.mime_type}` });
        continue;
      }
      blocos.push({ type: "text", text: rotuloDoArquivo(a.filename) });
      blocos.push(bloco);
      abertos.push(a);
    } catch (e) {
      falhas.push({ id: a.id, filename: a.filename, motivo: e instanceof Error ? e.message : String(e) });
    }
  }

  return { blocos, abertos, falhas };
}
