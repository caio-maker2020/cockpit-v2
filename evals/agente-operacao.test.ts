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
