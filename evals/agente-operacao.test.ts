// deno test --no-check --allow-read evals/agente-operacao.test.ts
// Guard do eval offline do agente da Operação (ADR 0041 D10; INV-188; INV-167):
// o modo seco não chama API nenhuma e reprova se um código proibido virar sugestão.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { avaliarSeco, calcularPlacar, type CasoEval, lerCasos } from "./agente-operacao.ts";

const casos = lerCasos(await Deno.readTextFile(new URL("./agente-operacao/casos-sinteticos.json", import.meta.url)), false);

Deno.test("fixtures sintéticas: todo status esperado bate e NENHUM proibido passa", () => {
  const p = calcularPlacar(avaliarSeco(casos));
  assertEquals(p.divergencias, []);
  assertEquals(p.proibidos_que_passaram, 0);
  assert(p.casos >= 10);
  assert(casos.some((c) => c.gabarito.acao === "encaminhar_relacionamento"), "faltam casos de encaminhar");
  assert(casos.some((c) => c.id.includes("injecao")), "falta o caso adversarial de injeção");
});

Deno.test("o placar acusa proibido que passasse (a métrica não é decorativa)", () => {
  const p = calcularPlacar([{
    id: "x", status: "ok", gabarito: { acao: "sem_sugestao" },
    sugestao: { codigo: 49, acao: "lancar_ocorrencia" } as never,
  }]);
  assertEquals(p.proibidos_que_passaram, 1);
});

Deno.test("JSONL de casos reais é lido linha a linha (sem banco)", () => {
  const c: CasoEval = casos[0]!;
  const lidos = lerCasos(`${JSON.stringify(c)}\n\n${JSON.stringify({ ...c, id: "b" })}\n`, true);
  assertEquals(lidos.map((x) => x.id), [c.id, "b"]);
});

Deno.test("o script só usa a chave de evals (INV-167) e não abre banco", async () => {
  const src = await Deno.readTextFile(new URL("./agente-operacao.ts", import.meta.url));
  assert(src.includes("lerChaveEvals(Deno.env)") && src.includes("portaoDeCusto(") && src.includes("ContadorCusto"));
  assert(!/ANTHROPIC_API_KEY["']|createClient|SUPABASE_/.test(src.replace(/\/\/.*$/gm, "")));
});

Deno.test("1.1.0: fixtures cobrem aguardar (oc 41 no malote), 01 e a regressão do 1.0.0 é acusada pelo placar", () => {
  const p = calcularPlacar(avaliarSeco(casos));
  assert(casos.some((c) => c.gabarito.acao === "aguardar" && /malote/i.test(c.item.instrucao_ultima_ocorrencia ?? "")));
  assertEquals(p.encaminhou_o_que_era_aguardar, 1); // s14: a resposta antiga do 1.0.0
  const s15 = avaliarSeco(casos.filter((c) => c.id.startsWith("s15")))[0]!;
  assertEquals([s15.status, s15.sugestao], ["descartada", null]);
});

Deno.test("eval ao vivo usa o mesmo modelo padrão do agente (Haiku 5.5) e a mesma lista fechada", async () => {
  const { resolverModeloAgente } = await import("../supabase/functions/_shared/operacao-agente-sugestao.ts");
  assertEquals(resolverModeloAgente(undefined), "claude-haiku-5-5");
  const src = await Deno.readTextFile(new URL("./agente-operacao.ts", import.meta.url));
  assert(src.includes('resolverModeloAgente(args.get("modelo"))'), "o eval tem de resolver o modelo pela mesma lista da edge");
});
