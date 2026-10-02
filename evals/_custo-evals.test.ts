// deno test evals/_custo-evals.test.ts
// Guard do INV-167: eval local nunca roda com a chave de produção e lote caro
// só passa com confirmação numérica ≥ estimativa.
import { assertEquals, assertMatch, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ContadorCusto,
  LIMITE_CHAMADAS_SEM_CONFIRMAR,
  lerChaveEvals,
  portaoDeCusto,
  VAR_CHAVE_EVALS,
  VAR_CHAVE_PRODUCAO,
} from "./_custo-evals.ts";

const env = (m: Record<string, string>) => ({ get: (k: string) => m[k] });

Deno.test("lerChaveEvals: usa a chave de evals quando existe", () => {
  assertEquals(lerChaveEvals(env({ [VAR_CHAVE_EVALS]: "sk-ant-evals" })), "sk-ant-evals");
});

Deno.test("lerChaveEvals: RECUSA quando só a chave de produção está no ambiente (cenário do incidente 02/10)", () => {
  assertThrows(
    () => lerChaveEvals(env({ [VAR_CHAVE_PRODUCAO]: "sk-ant-prod" })),
    Error,
    "INV-167",
  );
});

Deno.test("lerChaveEvals: com as duas no ambiente, ignora a de produção", () => {
  assertEquals(
    lerChaveEvals(env({ [VAR_CHAVE_PRODUCAO]: "sk-ant-prod", [VAR_CHAVE_EVALS]: "sk-ant-evals" })),
    "sk-ant-evals",
  );
});

Deno.test("lerChaveEvals: sem nenhuma, erro aponta a variável certa", () => {
  assertThrows(() => lerChaveEvals(env({})), Error, VAR_CHAVE_EVALS);
});

Deno.test("portaoDeCusto: lote pequeno passa sem confirmação", () => {
  assertEquals(portaoDeCusto("claude-sonnet-4-6", LIMITE_CHAMADAS_SEM_CONFIRMAR, undefined), null);
});

Deno.test("portaoDeCusto: lote caro sem confirmação é barrado com a estimativa", () => {
  // 1.083 chamadas = o ensaio de 02/10 → ~US$ 37 pela estimativa conservadora
  const msg = portaoDeCusto("claude-sonnet-4-6", 1083, undefined);
  assertMatch(msg ?? "", /1083 chamadas/);
  assertMatch(msg ?? "", /US\$ 3\d\.\d\d/);
  assertMatch(msg ?? "", /--confirmar-custo/);
});

Deno.test("portaoDeCusto: confirmação abaixo da estimativa NÃO libera; igual/acima libera", () => {
  assertMatch(portaoDeCusto("claude-sonnet-4-6", 1083, "5") ?? "", /abaixo da estimativa/);
  assertMatch(portaoDeCusto("claude-sonnet-4-6", 1083, "sim") ?? "", /--confirmar-custo/);
  assertEquals(portaoDeCusto("claude-sonnet-4-6", 1083, "40"), null);
});

Deno.test("ContadorCusto: soma usage e calcula US$ pelo modelo", () => {
  const c = new ContadorCusto("claude-sonnet-4-6");
  c.registrar({ input_tokens: 1_000_000, output_tokens: 100_000 });
  c.registrar(undefined); // resposta sem usage ainda conta a chamada
  assertEquals(c.chamadas, 2);
  assertEquals(c.usd, 3 + 1.5);
  assertMatch(c.relatorio(), /2 chamadas .* US\$ 4\.50/);
});
