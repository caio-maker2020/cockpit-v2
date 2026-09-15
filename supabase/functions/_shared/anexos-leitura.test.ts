// =============================================================================
// INV-154 — os cortes de QUAIS anexos o interpretador abre.
// Função pura: roda sem banco, sem rede.
// =============================================================================
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  escolherAnexosParaLeitura,
  MAX_ARQUIVOS,
  MAX_PDFS,
  PISO_BYTES_IMAGEM,
} from "./anexos-leitura.ts";

const KB = 1024;

function anexo(over: Partial<Parameters<typeof escolherAnexosParaLeitura>[0][number]> = {}) {
  return {
    id: "id-1",
    filename: "arquivo.pdf",
    mime_type: "application/pdf",
    size_bytes: 100 * KB,
    storage_path: "inbound/x/arquivo.pdf",
    message_inbox_id: "msg-1",
    recebido_em: "2026-09-10T00:00:00.000Z",
    ...over,
  };
}

const motivoDe = (r: ReturnType<typeof escolherAnexosParaLeitura>, id: string) =>
  r.ignorados.find((i) => i.id === id)?.motivo ?? null;

Deno.test("INV-154 anexos: o caso-ancora da NF 431734 — o PDF ANTIGO entra", () => {
  // 07/08: a NF de ressarcimento (tem o valor). 10/09: so PNGs do reenvio.
  const r = escolherAnexosParaLeitura([
    anexo({ id: "pdf-antigo", filename: "NFE-433174 (1).pdf", size_bytes: 103 * KB, message_inbox_id: "msg-0708", recebido_em: "2026-08-07T19:36:54.594Z" }),
    anexo({ id: "png-a", filename: "imagem (50).png", mime_type: "image/png", size_bytes: 471 * KB, message_inbox_id: "msg-1009", recebido_em: "2026-09-10T20:52:32.399Z" }),
    anexo({ id: "png-b", filename: "imagem (51).png", mime_type: "image/png", size_bytes: 474 * KB, message_inbox_id: "msg-1009", recebido_em: "2026-09-10T20:52:32.399Z" }),
  ]);
  assertEquals(r.escolhidos[0]!.id, "pdf-antigo", "o PDF tem de vir PRIMEIRO, nao o mais recente");
  assertEquals(r.escolhidos.length, 3);
});

Deno.test("INV-154 anexos: assinatura de e-mail nao entra (piso de imagem)", () => {
  const r = escolherAnexosParaLeitura([
    anexo({ id: "logo", filename: "image001.png", mime_type: "image/png", size_bytes: 8 * KB }),
    anexo({ id: "nota", filename: "Descricao.png", mime_type: "image/png", size_bytes: 59 * KB }),
  ]);
  assertEquals(r.escolhidos.map((e) => e.id), ["nota"]);
  assertEquals(motivoDe(r, "logo"), `imagem_pequena_demais:${8 * KB}`);
});

Deno.test("INV-154 anexos: PDF pequeno NAO cai no piso (nota de uma pagina)", () => {
  const r = escolherAnexosParaLeitura([
    anexo({ id: "pdf-mini", filename: "nota.pdf", size_bytes: 5 * KB }),
  ]);
  assertEquals(r.escolhidos.map((e) => e.id), ["pdf-mini"]);
});

Deno.test("INV-154 anexos: formato fora desta rodada fica de fora, com motivo", () => {
  const r = escolherAnexosParaLeitura([
    anexo({ id: "xls", filename: "itens.xlsx", mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size_bytes: 40 * KB }),
    anexo({ id: "gif", filename: "logo.gif", mime_type: "image/gif", size_bytes: 40 * KB }),
  ]);
  assertEquals(r.escolhidos.length, 0);
  assert(motivoDe(r, "xls")!.startsWith("formato_fora_desta_rodada:"));
  assert(motivoDe(r, "gif")!.startsWith("formato_fora_desta_rodada:"));
});

Deno.test("INV-154 anexos: copia repetida no card fica com a MAIS ANTIGA", () => {
  const r = escolherAnexosParaLeitura([
    anexo({ id: "novo", filename: "imagem (50).png", mime_type: "image/png", size_bytes: 471 * KB, message_inbox_id: "msg-1009", recebido_em: "2026-09-10T20:52:32.399Z" }),
    anexo({ id: "velho", filename: "imagem (50).png", mime_type: "image/png", size_bytes: 471 * KB, message_inbox_id: "msg-0708", recebido_em: "2026-08-07T19:36:54.594Z" }),
  ]);
  assertEquals(r.escolhidos.map((e) => e.id), ["velho"]);
  assertEquals(motivoDe(r, "novo"), "copia_repetida_no_card");
});

Deno.test("INV-154 anexos: sem arquivo no balde nao entra (download falharia)", () => {
  const r = escolherAnexosParaLeitura([anexo({ id: "apagado", storage_path: null })]);
  assertEquals(r.escolhidos.length, 0);
  assertEquals(motivoDe(r, "apagado"), "sem_arquivo_no_balde");
});

Deno.test("INV-154 anexos: tetos de quantidade e de PDF sao respeitados", () => {
  const muitos = Array.from({ length: 10 }, (_, i) =>
    anexo({ id: `pdf-${i}`, filename: `n${i}.pdf`, size_bytes: (100 + i) * KB }));
  const r = escolherAnexosParaLeitura(muitos);
  assertEquals(r.escolhidos.length, MAX_PDFS, "so MAX_PDFS PDFs entram");
  assert(r.ignorados.some((i) => i.motivo === "teto_de_pdfs"));

  const mistos = [
    ...Array.from({ length: 3 }, (_, i) => anexo({ id: `p-${i}`, filename: `n${i}.pdf`, size_bytes: 100 * KB })),
    ...Array.from({ length: 8 }, (_, i) =>
      anexo({ id: `i-${i}`, filename: `f${i}.jpg`, mime_type: "image/jpeg", size_bytes: (100 + i) * KB })),
  ];
  const r2 = escolherAnexosParaLeitura(mistos);
  assertEquals(r2.escolhidos.length, MAX_ARQUIVOS);
  assertEquals(r2.escolhidos.filter((e) => e.mime_type === "application/pdf").length, MAX_PDFS);
  assert(r2.ignorados.some((i) => i.motivo === "teto_de_arquivos"));
});

Deno.test("INV-154 anexos: arquivo grande demais fica de fora", () => {
  const r = escolherAnexosParaLeitura([
    anexo({ id: "gordo", filename: "scan.pdf", size_bytes: 9 * 1024 * KB }),
    anexo({ id: "ok", filename: "nota.pdf", size_bytes: 200 * KB }),
  ]);
  assertEquals(r.escolhidos.map((e) => e.id), ["ok"]);
  assert(motivoDe(r, "gordo")!.startsWith("arquivo_grande_demais:"));
});

Deno.test("INV-154 anexos: teto de bytes da chamada corta o excedente", () => {
  const grandes = Array.from({ length: 6 }, (_, i) =>
    anexo({ id: `img-${i}`, filename: `f${i}.jpg`, mime_type: "image/jpeg", size_bytes: 3 * 1024 * KB }));
  const r = escolherAnexosParaLeitura(grandes);
  assert(r.escolhidos.length < 6, "o teto total tem de cortar alguem");
  assert(r.ignorados.some((i) => i.motivo === "teto_de_bytes_da_chamada"));
  const soma = r.escolhidos.reduce((s, e) => s + e.size_bytes, 0);
  assert(soma <= 12 * 1024 * KB);
});

Deno.test("INV-154 anexos: lista vazia nao quebra", () => {
  const r = escolherAnexosParaLeitura([]);
  assertEquals(r.escolhidos, []);
  assertEquals(r.ignorados, []);
});

Deno.test("INV-154 anexos: o piso vale em bytes, nao em KB arredondado", () => {
  const r = escolherAnexosParaLeitura([
    anexo({ id: "limite", filename: "x.png", mime_type: "image/png", size_bytes: PISO_BYTES_IMAGEM }),
    anexo({ id: "abaixo", filename: "y.png", mime_type: "image/png", size_bytes: PISO_BYTES_IMAGEM - 1 }),
  ]);
  assertEquals(r.escolhidos.map((e) => e.id), ["limite"]);
});
