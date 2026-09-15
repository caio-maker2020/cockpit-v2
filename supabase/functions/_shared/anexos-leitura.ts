// =============================================================================
// anexos-leitura.ts — QUAIS anexos do card o interpretador abre para o modelo.
//
// Causa raiz (Carlos 2026-09-15, âncora NF 431734): em
// interpretador-resposta-cliente/index.ts os anexos iam ao modelo só como
// "filename, mime_type, size_bytes" — o CONTEÚDO nunca era lido — e a consulta
// filtrava .eq("message_inbox_id", body.message_id), então anexo de mensagem
// ANTERIOR era invisível. O PDF "NFE-433174 (1).pdf" (105KB, tem o valor)
// chegou em 2026-08-07; a resposta reprocessada em 2026-09-10 só trouxe PNGs; o
// valor segue presente=false, o to-do nasce com gate_oc33.bloqueada=true e a
// trava da RPC aprovar_e_executar recusa a oc 33.
//
// PURO de propósito (sem supabase, sem fetch): dá para testar os cortes sem
// banco. Rodar:
//   deno test --no-check --allow-all supabase/functions/_shared/anexos-leitura.test.ts
// =============================================================================

/** Formatos desta rodada (Carlos 15/09: PDF, JPG e PNG). Planilha ficou fora. */
export const MIMES_LEGIVEIS: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
]);

/**
 * Teto de arquivos por leitura. Medido em 15/09: a mediana dos cards travados
 * tem 3 anexos elegíveis, mas o pior tem dezenas. Sem teto, uma rodada tenta
 * abrir o card inteiro e estoura tempo e custo.
 */
export const MAX_ARQUIVOS = 6;

/**
 * PDF conta por PÁGINA no custo (cada página vira imagem para o modelo), então
 * tem teto próprio e baixo — é o único jeito de estourar orçamento sem estourar
 * bytes.
 */
export const MAX_PDFS = 2;

export const MAX_BYTES_PDF = Math.round(2.5 * 1024 * 1024);
export const MAX_BYTES_IMAGEM = 4 * 1024 * 1024;

/**
 * Teto do request inteiro. A API aceita 32MB e o base64 infla ~33%: 12MB crus
 * ≈ 16MB no pedido — folga de 2x de propósito.
 */
export const MAX_BYTES_TOTAL = 12 * 1024 * 1024;

/**
 * Piso para IMAGEM: abaixo disso é assinatura/logo de e-mail (image001.png,
 * ícone do Outlook). Medido no rebanho travado: 2.413 dos 4.807 anexos estão
 * abaixo de 20KB. Sem o piso o modelo recebe 4 logos e nenhuma nota.
 * NÃO se aplica a PDF: PDF pequeno costuma ser a nota de uma página.
 */
export const PISO_BYTES_IMAGEM = 20 * 1024;

export interface AnexoCandidato {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string | null;
  message_inbox_id: string | null;
  /** Quando a mensagem-mãe chegou. Decide qual cópia repetida fica. */
  recebido_em?: string | null;
}

export interface EscolhaAnexos {
  escolhidos: AnexoCandidato[];
  ignorados: Array<{ id: string; filename: string; motivo: string }>;
}

export function ehLegivel(mime: string | null | undefined): boolean {
  return MIMES_LEGIVEIS.has((mime ?? "").trim().toLowerCase());
}

function ehPdf(mime: string | null | undefined): boolean {
  return (mime ?? "").trim().toLowerCase() === "application/pdf";
}

/**
 * Decide quais anexos do card vão ser abertos, e registra POR QUE cada um ficou
 * de fora (o motivo vai pro card_event de auditoria — silêncio aqui viraria
 * "não achou" sem ninguém saber que o arquivo sequer foi considerado).
 */
export function escolherAnexosParaLeitura(
  candidatos: readonly AnexoCandidato[],
): EscolhaAnexos {
  const ignorados: EscolhaAnexos["ignorados"] = [];
  const elegiveis: AnexoCandidato[] = [];

  for (const a of candidatos) {
    const mime = (a.mime_type ?? "").trim().toLowerCase();
    if (!a.storage_path) {
      ignorados.push({ id: a.id, filename: a.filename, motivo: "sem_arquivo_no_balde" });
      continue;
    }
    if (!ehLegivel(mime)) {
      ignorados.push({ id: a.id, filename: a.filename, motivo: `formato_fora_desta_rodada:${mime || "?"}` });
      continue;
    }
    const teto = ehPdf(mime) ? MAX_BYTES_PDF : MAX_BYTES_IMAGEM;
    if (a.size_bytes > teto) {
      ignorados.push({ id: a.id, filename: a.filename, motivo: `arquivo_grande_demais:${a.size_bytes}` });
      continue;
    }
    if (!ehPdf(mime) && a.size_bytes < PISO_BYTES_IMAGEM) {
      ignorados.push({ id: a.id, filename: a.filename, motivo: `imagem_pequena_demais:${a.size_bytes}` });
      continue;
    }
    elegiveis.push(a);
  }

  // DEDUP obrigatório: 39% dos cards com anexo têm o mesmo nome de arquivo em
  // mais de uma mensagem (cliente reenvia). Fica a cópia MAIS ANTIGA — é ela
  // que tem a data real de chegada e a procedência verdadeira.
  const porChave = new Map<string, AnexoCandidato>();
  for (const a of elegiveis) {
    const chave = `${a.filename.trim().toLowerCase()}|${a.size_bytes}`;
    const atual = porChave.get(chave);
    if (!atual) {
      porChave.set(chave, a);
      continue;
    }
    const maisAntigo = (a.recebido_em ?? "") < (atual.recebido_em ?? "") ? a : atual;
    const descartado = maisAntigo === a ? atual : a;
    if (maisAntigo !== atual) porChave.set(chave, maisAntigo);
    ignorados.push({ id: descartado.id, filename: descartado.filename, motivo: "copia_repetida_no_card" });
  }

  // ORDEM: PDF primeiro (a NF de ressarcimento carrega descrição E valor),
  // depois maior, depois mais recente como desempate.
  // NUNCA "mais recente primeiro": na NF 431734 a evidência do valor é o anexo
  // MAIS ANTIGO (07/08) e a resposta nova (10/09) só trouxe PNG — ordenar por
  // data jogaria justamente a evidência para fora do teto.
  const ordenados = [...porChave.values()].sort((x, y) => {
    const px = ehPdf(x.mime_type) ? 0 : 1;
    const py = ehPdf(y.mime_type) ? 0 : 1;
    if (px !== py) return px - py;
    if (y.size_bytes !== x.size_bytes) return y.size_bytes - x.size_bytes;
    return String(y.recebido_em ?? "").localeCompare(String(x.recebido_em ?? ""));
  });

  const escolhidos: AnexoCandidato[] = [];
  let pdfs = 0;
  let soma = 0;
  for (const a of ordenados) {
    if (escolhidos.length >= MAX_ARQUIVOS) {
      ignorados.push({ id: a.id, filename: a.filename, motivo: "teto_de_arquivos" });
      continue;
    }
    if (ehPdf(a.mime_type) && pdfs >= MAX_PDFS) {
      ignorados.push({ id: a.id, filename: a.filename, motivo: "teto_de_pdfs" });
      continue;
    }
    if (soma + a.size_bytes > MAX_BYTES_TOTAL) {
      ignorados.push({ id: a.id, filename: a.filename, motivo: "teto_de_bytes_da_chamada" });
      continue;
    }
    escolhidos.push(a);
    soma += a.size_bytes;
    if (ehPdf(a.mime_type)) pdfs++;
  }

  return { escolhidos, ignorados };
}
