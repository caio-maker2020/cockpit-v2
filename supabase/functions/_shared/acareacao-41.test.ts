// deno-lint-ignore-file no-explicit-any -- payloads de todo lidos campo a campo nas asserções
// Guard INV-192 (09/10, NF 1119123): a 41 da acareação sobrevive à limpeza
// pós-resposta e só leva o texto pronto quando a 49 é PEDIDO (opção "a").
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ehTodo41Acareacao,
  MARCA_41_ACAREACAO,
  ORIGEM_TEXTO_41_ACAREACAO,
  pareceResultadoAcareacao,
  planejarMarcacao41Acareacao,
  textoOverride41Acareacao,
} from "./acareacao-41.ts";
import { TEXTO_OC41_ACAREACAO } from "./oc49-casos-time.ts";

// Textos REAIS de 49 que a R1 reconheceu entre 01/09 e 09/10 (instrução SSW).
const PEDIDOS = [
  "ACAREACAO",
  "AG ACAREACAO",
  "AGA ACAREACAO",
  "AG. ACAREACAO",
  "AG . ACAREACAO",
  "AG. ROMANEIO / DESCRICAO / ACAREACAO",
  "ACAREACAO SOLICITADA?",
  "ACAREACAO / FAVOR VERIFICAR",
  "APENAS ACAREACAO",
  "ROMANEIO E ACAREACAO",
  "ACAREACAO E ROMANEIO",
  // pergunta, sem palavra de resultado → segue como pedido (operadora revisa)
  "ACAREACAO DOQUE? VOLUMES ESTA NA BASE AGUARDANDO AGENDAMENTO",
  // o próprio texto da 41 é pedido: "REALIZAR" não é "REALIZADA"
  "Realizar acareação",
];
const RESULTADOS = [
  "ACAREACAO REALIZADA ( IMAGEM JA ANEXADA )",
  "ACAREACAO NAO ASSINADA",
  "ACAREACAO NAO ASSINADA. CLIENTE NAO RECEBEU MERCADORIA",
  "CLIENTE INFORMOU QUE NAO RECEBEU A MERCADORIA - ACAREACAO NAO ASSINADA",
  "CLIENTE NAO ASSINOU A ACAREACAO POR NAO TER RECEBIDO VOLUME",
  "INSERINDO ACAREACAO / NF NAO ENTREGUE",
  "INSERINDO ACAREACAO / NAO ENTREGUE",
  "ACAREACAO RESSALVA",
  "RESSALVA REFERENTE A ACAREACAO",
  "ACAREACAO // ENTREGUE ATRAVES DE OUTRA TRANSPORTADORA",
  // pedido com "ENTREGUE" cai no lado seguro: sem texto pronto, operadora escreve
  "ENTREGUE NO CTE CANCELADO VOU MANDAR PRA ACAREACAO",
  // acento e caixa não escapam
  "Acareação realizada",
  "acareação não assinada",
];

Deno.test("INV-192: 49 de PEDIDO não parece resultado (textos reais)", () => {
  for (const t of PEDIDOS) assertEquals(pareceResultadoAcareacao(t), false, t);
});

Deno.test("INV-192: 49 que informa RESULTADO é reconhecida (textos reais)", () => {
  for (const t of RESULTADOS) assertEquals(pareceResultadoAcareacao(t), true, t);
});

Deno.test("INV-192: texto vazio/ausente não é resultado", () => {
  assertEquals(pareceResultadoAcareacao(""), false);
  assertEquals(pareceResultadoAcareacao(null), false);
  assertEquals(pareceResultadoAcareacao(undefined), false);
});

Deno.test("INV-192: ehTodo41Acareacao — marca nova OU origem antiga da R1; nunca outro código", () => {
  assertEquals(ehTodo41Acareacao({ args: { codigo_ssw: 41 }, meta: { [MARCA_41_ACAREACAO]: true } }), true);
  assertEquals(
    ehTodo41Acareacao({ args: { codigo_ssw: 41, extras: { origem: ORIGEM_TEXTO_41_ACAREACAO } } }),
    true,
  );
  assertEquals(ehTodo41Acareacao({ args: { codigo_ssw: 41 } }), false);
  assertEquals(ehTodo41Acareacao({ args: { codigo_ssw: 41 }, meta: { [MARCA_41_ACAREACAO]: "sim" } }), false);
  assertEquals(ehTodo41Acareacao({ args: { codigo_ssw: 56 }, meta: { [MARCA_41_ACAREACAO]: true } }), false);
  assertEquals(ehTodo41Acareacao({ args: { codigo_ssw: "41" }, meta: { [MARCA_41_ACAREACAO]: true } }), false);
  assertEquals(ehTodo41Acareacao(null), false);
  assertEquals(ehTodo41Acareacao(undefined), false);
});

Deno.test("INV-192: override de criação — pedido leva texto, resultado não, resto igual a antes", () => {
  const base = { proposta_destacada: 41, caso_oc49: "acareacao", texto_ssw_sugerido: TEXTO_OC41_ACAREACAO };
  assertEquals(textoOverride41Acareacao({ ...base, motivo_extraido: "AG ACAREACAO" }), TEXTO_OC41_ACAREACAO);
  assertEquals(textoOverride41Acareacao({ ...base, motivo_extraido: "ACAREACAO REALIZADA" }), null);
  // destaque que não é 41 → null (igual ao código antigo)
  assertEquals(textoOverride41Acareacao({ ...base, proposta_destacada: 54, motivo_extraido: "AG ACAREACAO" }), null);
  // 41 vinda de outro caso → texto do agente passa intacto (igual ao código antigo)
  assertEquals(
    textoOverride41Acareacao({ proposta_destacada: 41, caso_oc49: "outro", texto_ssw_sugerido: "X", motivo_extraido: "ENTREGUE" }),
    "X",
  );
  assertEquals(textoOverride41Acareacao({ proposta_destacada: 41, caso_oc49: "acareacao", motivo_extraido: "AG ACAREACAO" }), null);
});

const t41 = (id: string, extra: Record<string, unknown> = {}, status = "pendente") => ({
  id,
  status,
  proposta_payload: {
    tool: "lancar_ocorrencia",
    acao_key: "lancar_ocorrencia:41",
    args: { nf: "1119123", codigo_ssw: 41, ...extra },
    meta: { modo: "sem_email" },
  },
});

Deno.test("INV-192: 41 genérica + 49 de PEDIDO → marca + texto pronto + origem", () => {
  const [m] = planejarMarcacao41Acareacao([t41("a")], "AGA ACAREACAO");
  assertEquals(m.id, "a");
  assertEquals(m.preencheu_texto, true);
  const pp = m.proposta_payload as Record<string, any>;
  assertEquals(pp.meta[MARCA_41_ACAREACAO], true);
  assertEquals(pp.meta.texto_ssw_sugerido, TEXTO_OC41_ACAREACAO);
  assertEquals(pp.meta.modo, "sem_email"); // preserva o resto do meta
  assertEquals(pp.args.extras.texto_descricao, TEXTO_OC41_ACAREACAO);
  assertEquals(pp.args.extras.origem, ORIGEM_TEXTO_41_ACAREACAO);
  assertEquals(pp.args.nf, "1119123"); // preserva o resto dos args
  assertEquals(pp.acao_key, "lancar_ocorrencia:41");
  assertEquals(ehTodo41Acareacao(pp), true);
});

Deno.test("INV-192: 41 genérica + 49 de RESULTADO → só a marca, SEM texto e sem mexer nos args", () => {
  const [m] = planejarMarcacao41Acareacao([t41("a")], "ACAREACAO NAO ASSINADA");
  assertEquals(m.preencheu_texto, false);
  const pp = m.proposta_payload as Record<string, any>;
  assertEquals(pp.meta[MARCA_41_ACAREACAO], true);
  assertEquals(pp.meta.texto_ssw_sugerido, undefined);
  assertEquals(pp.args, { nf: "1119123", codigo_ssw: 41 });
  assertEquals(ehTodo41Acareacao(pp), true);
});

Deno.test("INV-192: nunca troca texto que a 41 já tem", () => {
  const [m] = planejarMarcacao41Acareacao(
    [t41("a", { extras: { texto_descricao: "TEXTO DE OUTRA ORIGEM" } })],
    "AG ACAREACAO",
  );
  const pp = m.proposta_payload as Record<string, any>;
  assertEquals(m.preencheu_texto, false);
  assertEquals(pp.args.extras.texto_descricao, "TEXTO DE OUTRA ORIGEM");
  assertEquals(pp.meta[MARCA_41_ACAREACAO], true);
});

Deno.test("INV-192: só PENDENTE e só código 41 — aprovado/em execução/outros ficam intactos", () => {
  const outros = [
    t41("aprovado", {}, "aprovado"),
    t41("executando", {}, "executando"),
    t41("cancelado", {}, "cancelado"),
    { id: "56", status: "pendente", proposta_payload: { args: { codigo_ssw: 56 } } },
    { id: "sem-payload", status: "pendente", proposta_payload: null },
  ];
  assertEquals(planejarMarcacao41Acareacao(outros, "AG ACAREACAO"), []);
});

Deno.test("INV-192: idempotente — rodar de novo sobre o resultado não gera nova escrita", () => {
  for (const texto49 of ["AG ACAREACAO", "ACAREACAO REALIZADA"]) {
    const [m] = planejarMarcacao41Acareacao([t41("a")], texto49);
    const segunda = planejarMarcacao41Acareacao(
      [{ id: "a", status: "pendente", proposta_payload: m.proposta_payload }],
      texto49,
    );
    assertEquals(segunda, [], texto49);
  }
});

Deno.test("INV-192: 41 criada pela R1 antiga (texto+origem, sem marca) só ganha a marca", () => {
  const [m] = planejarMarcacao41Acareacao(
    [t41("a", { extras: { texto_descricao: TEXTO_OC41_ACAREACAO, origem: ORIGEM_TEXTO_41_ACAREACAO } })],
    "AG ACAREACAO",
  );
  assertEquals(m.preencheu_texto, false);
  assertEquals((m.proposta_payload as Record<string, any>).meta[MARCA_41_ACAREACAO], true);
});

// ---------------- fiação (o módulo puro só vale se estiver ligado) ----------------

Deno.test("INV-192 fiação: a limpeza pós-resposta preserva a 41 da acareação", async () => {
  const src = await Deno.readTextFile(new URL("./propostas-pos-resposta-cliente.ts", import.meta.url));
  assertEquals(src.includes('import { ehTodo41Acareacao } from "./acareacao-41.ts";'), true);
  assertEquals(src.includes("const ehAcareacao41 = ehTodo41Acareacao(payload);"), true);
  assertEquals(src.includes("if (ehDaListaNova || ehAcareacao41) {"), true);
});

Deno.test("INV-192 fiação: o agente usa o override da opção a e marca a 41 existente", async () => {
  const src = await Deno.readTextFile(
    new URL("../agente-sugere-ocs-padrao/index.ts", import.meta.url),
  );
  assertEquals(src.includes("textoSsw41Override: textoOverride41Acareacao(decisao),"), true);
  // o override antigo (texto cru da decisão) não pode voltar
  assertEquals(
    /textoSsw41Override:\s*decisao\.proposta_destacada === 41/.test(src),
    false,
  );
  assertEquals(
    src.includes('if (decisao.caso_oc49 === "acareacao" && decisao.proposta_destacada === 41) {'),
    true,
  );
  assertEquals(src.includes("planejarMarcacao41Acareacao("), true);
  // grava só se ainda estiver pendente (nunca mexe em 41 já aprovada no meio do caminho)
  assertEquals(src.includes('.eq("id", m.id).eq("status", "pendente");'), true);
});

Deno.test("INV-192 anti-deriva: a origem da R1 em regras-auto-acao é a mesma da marca antiga", async () => {
  const src = await Deno.readTextFile(new URL("./regras-auto-acao.ts", import.meta.url));
  assertEquals(src.includes(`extrasOc41["origem"] = "${ORIGEM_TEXTO_41_ACAREACAO}";`), true);
});
