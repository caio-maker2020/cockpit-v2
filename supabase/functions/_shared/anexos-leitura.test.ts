// =============================================================================
// INV-154 — os cortes de QUAIS anexos o interpretador abre.
// Função pura: roda sem banco, sem rede.
// =============================================================================
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  anexosJaAbertosDosEventos,
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

Deno.test("INV-154 anexos: arquivo que o DOSSIE ja cita entra na frente (caso NF 117119)", () => {
  // Dados reais do card: 2 PDFs grandes disputam as 2 vagas e o "152847.pdf",
  // que o dossie ja reconhece como VALOR, era cortado pelo teto.
  const cand = [
    anexo({ id: "boleto", filename: "SAL EXPRESS - BOLETO 152847.pdf", size_bytes: 451 * KB, recebido_em: "2026-08-20T00:00:00Z" }),
    anexo({ id: "minuta", filename: "Minuta.pdf", size_bytes: 52 * KB, recebido_em: "2026-08-12T00:00:00Z" }),
    anexo({ id: "nota", filename: "152847.pdf", size_bytes: 35 * KB, recebido_em: "2026-08-12T00:00:00Z" }),
  ];

  // SEM prioridade: o boleto vence pelo tamanho e a nota certa fica de fora.
  const semPrio = escolherAnexosParaLeitura(cand);
  assertEquals(semPrio.escolhidos.map((e) => e.id), ["boleto", "minuta"]);
  assert(semPrio.ignorados.some((i) => i.id === "nota" && i.motivo === "teto_de_pdfs"));

  // COM prioridade (o dossie cita 152847.pdf como valor e Minuta.pdf como
  // romaneio): a nota certa entra, e o boleto — que o prompt proibe usar como
  // valor a indenizar — fica de fora.
  const comPrio = escolherAnexosParaLeitura(cand, { prioritarios: ["152847.pdf", "Minuta.pdf", null] });
  // A ordem DENTRO do grupo prioritario nao importa — importa QUEM entra.
  assertEquals([...comPrio.escolhidos.map((e) => e.id)].sort(), ["minuta", "nota"]);
  assert(comPrio.ignorados.some((i) => i.id === "boleto" && i.motivo === "teto_de_pdfs"));
});

Deno.test("INV-154 anexos: prioridade casa sem diferenciar caixa e espaco", () => {
  const cand = [
    anexo({ id: "outro", filename: "zzz.pdf", size_bytes: 400 * KB }),
    anexo({ id: "alvo", filename: "NFE-433174 (1).pdf", size_bytes: 103 * KB }),
  ];
  const r = escolherAnexosParaLeitura(cand, { prioritarios: ["  nfe-433174 (1).PDF  "] });
  assertEquals(r.escolhidos[0]!.id, "alvo");
});

Deno.test("INV-154 anexos: prioritarios vazio ou ausente nao muda nada (nao-regressao)", () => {
  const cand = [
    anexo({ id: "a", filename: "a.pdf", size_bytes: 400 * KB }),
    anexo({ id: "b", filename: "b.pdf", size_bytes: 100 * KB }),
  ];
  const base = escolherAnexosParaLeitura(cand).escolhidos.map((e) => e.id);
  assertEquals(escolherAnexosParaLeitura(cand, {}).escolhidos.map((e) => e.id), base);
  assertEquals(escolherAnexosParaLeitura(cand, { prioritarios: [] }).escolhidos.map((e) => e.id), base);
  assertEquals(
    escolherAnexosParaLeitura(cand, { prioritarios: [null, undefined, "  "] }).escolhidos.map((e) => e.id),
    base,
  );
});

// -----------------------------------------------------------------------------
// NF 1115331 (Carlos 07/10): o arquivo JA ABERTO vai para o fim da fila.
// Nomes de arquivo FICTICIOS (repo publico); tamanhos e ordem de chegada iguais
// aos do card. O romaneio e a carta de debito ja aceitos ocupavam as 2 vagas
// de PDF em toda leitura e a nota de devolucao (a menor, com a descricao dos
// itens) nunca era aberta.
// -----------------------------------------------------------------------------
const romaneio = anexo({ id: "rom", filename: "romaneio-coleta.pdf", size_bytes: 181445, message_inbox_id: "msg-2109", recebido_em: "2026-09-21T12:47:00Z" });
const notaDevolucao = anexo({ id: "nfd", filename: "nota-devolucao.pdf", size_bytes: 40035, message_inbox_id: "msg-0510a", recebido_em: "2026-10-05T13:37:00Z" });
const cartaDebito = anexo({ id: "cd", filename: "carta-debito.pdf", size_bytes: 256787, message_inbox_id: "msg-0510a", recebido_em: "2026-10-05T13:37:00Z" });
const listaProdutos = anexo({ id: "lista", filename: "lista-produtos.pdf", size_bytes: 112660, message_inbox_id: "msg-0510a", recebido_em: "2026-10-05T13:37:00Z" });
const cartaAssinada = anexo({ id: "scan", filename: "carta-assinada-scan.pdf", size_bytes: 146165, message_inbox_id: "msg-0510b", recebido_em: "2026-10-05T18:36:00Z" });
const pdfsEscolhidos = (r: ReturnType<typeof escolherAnexosParaLeitura>) =>
  r.escolhidos.filter((e) => e.mime_type === "application/pdf").map((e) => e.id).sort();

Deno.test("NF 1115331 anexos: 2a leitura abre a nota de devolucao em vez de reler romaneio e valor ja aceitos", () => {
  // 05/10 15:38: o dossie cita romaneio e carta (ja aceitos) e os dois ja foram
  // abertos antes, junto com a lista. Antes: abria romaneio + carta de novo.
  const r = escolherAnexosParaLeitura(
    [romaneio, notaDevolucao, cartaDebito, listaProdutos, cartaAssinada],
    {
      prioritarios: ["carta-debito.pdf", null, "romaneio-coleta.pdf"],
      jaAbertos: [
        { id: "rom", filename: "romaneio-coleta.pdf", size: 181445 },
        { id: "cd", filename: "carta-debito.pdf", size: 256787 },
        { id: "lista", filename: "lista-produtos.pdf", size: 112660 },
      ],
    },
  );
  assertEquals(pdfsEscolhidos(r), ["nfd", "scan"], "os 2 PDFs NUNCA abertos tomam as 2 vagas");
  assertEquals(motivoDe(r, "rom"), "teto_de_pdfs");
  assertEquals(motivoDe(r, "cd"), "teto_de_pdfs");
});

Deno.test("NF 1115331 anexos: 1a leitura do e-mail novo prefere os PDFs novos ao romaneio ja lido", () => {
  // 05/10 10:39: so o romaneio tinha sido aberto. Limite continua 2: entram
  // os dois maiores NUNCA abertos; o romaneio ja lido fica para quando houver vaga.
  const r = escolherAnexosParaLeitura(
    [romaneio, notaDevolucao, cartaDebito, listaProdutos],
    {
      prioritarios: [null, null, "romaneio-coleta.pdf"],
      jaAbertos: [{ id: "rom", filename: "romaneio-coleta.pdf", size: 181445 }],
    },
  );
  assertEquals(pdfsEscolhidos(r), ["cd", "lista"]);
  assertEquals(motivoDe(r, "rom"), "teto_de_pdfs");
});

Deno.test("NF 1115331 anexos: com vaga sobrando o arquivo ja lido ENTRA igual (nao-regressao)", () => {
  const r = escolherAnexosParaLeitura([romaneio, notaDevolucao], {
    prioritarios: ["romaneio-coleta.pdf"],
    jaAbertos: [{ id: "rom", filename: "romaneio-coleta.pdf", size: 181445 }],
  });
  assertEquals(pdfsEscolhidos(r), ["nfd", "rom"]);
  assertEquals(r.ignorados, []);
});

Deno.test("NF 1115331 anexos: entre os nunca abertos, o citado pelo dossie continua na frente (caso NF 117119)", () => {
  const r = escolherAnexosParaLeitura(
    [
      anexo({ id: "boleto", filename: "boleto-cobranca.pdf", size_bytes: 451 * KB }),
      anexo({ id: "nota", filename: "nota-itens.pdf", size_bytes: 35 * KB }),
      anexo({ id: "extra", filename: "outro-documento.pdf", size_bytes: 200 * KB }),
      anexo({ id: "lido", filename: "ja-lido.pdf", size_bytes: 300 * KB }),
    ],
    {
      prioritarios: ["nota-itens.pdf"],
      jaAbertos: [{ id: "lido", filename: "ja-lido.pdf", size: 300 * KB }],
    },
  );
  assert(pdfsEscolhidos(r).includes("nota"), "o citado pelo dossie nao pode perder a vaga");
  assertEquals(pdfsEscolhidos(r), ["boleto", "nota"]);
});

Deno.test("NF 1115331 anexos: reenvio do mesmo arquivo (outro id, mesmo nome e tamanho) conta como ja aberto", () => {
  const reenviado = anexo({ id: "rom-reenvio", filename: "Romaneio-Coleta.PDF", size_bytes: 181445, recebido_em: "2026-10-05T13:37:00Z" });
  const r = escolherAnexosParaLeitura([reenviado, notaDevolucao, listaProdutos], {
    jaAbertos: [{ id: "rom", filename: "romaneio-coleta.pdf", size: 181445 }],
  });
  assertEquals(pdfsEscolhidos(r), ["lista", "nfd"]);
});

Deno.test("NF 1115331 anexos: jaAbertos vazio ou ausente = ordem de antes (nao-regressao)", () => {
  const conjuntos = [
    [romaneio, notaDevolucao, cartaDebito, listaProdutos, cartaAssinada],
    [romaneio, cartaDebito],
    [notaDevolucao],
  ];
  for (const cand of conjuntos) {
    for (const prioritarios of [undefined, ["romaneio-coleta.pdf"], ["carta-debito.pdf", "romaneio-coleta.pdf"]]) {
      const base = escolherAnexosParaLeitura(cand, { prioritarios });
      for (const jaAbertos of [undefined, []]) {
        const novo = escolherAnexosParaLeitura(cand, { prioritarios, jaAbertos });
        assertEquals(novo.escolhidos.map((e) => e.id), base.escolhidos.map((e) => e.id));
        assertEquals(novo.ignorados, base.ignorados);
      }
    }
  }
});

Deno.test("NF 1115331 anexos: le os 'abertos' dos eventos e ignora payload torto", () => {
  const lidos = anexosJaAbertosDosEventos([
    { abertos: [{ id: "a1", filename: "x.pdf", size: 10, mime: "application/pdf" }] },
    { abertos: [{ id: "a2", filename: "y.jpg" }, null, "lixo", 7] },
    { ignorados: [{ id: "a3", motivo: "teto_de_pdfs" }] }, // ignorado NAO e aberto
    null,
    "texto",
    { abertos: "nao-e-lista" },
  ]);
  assertEquals(lidos, [
    { id: "a1", filename: "x.pdf", size: 10 },
    { id: "a2", filename: "y.jpg", size: null },
  ]);
});
