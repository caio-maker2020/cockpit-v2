// =============================================================================
// Escolhe a OpApi. O adaptador de demonstração só existe em `vite dev` com
// VITE_OPERACAO_DEMO=true. A condição está ESCRITA AQUI, no próprio import
// dinâmico, de propósito: no `vite build` `import.meta.env.DEV` vira `false`
// literal, o ramo morre e o Rollup nem gera o chunk do adaptador (conferido
// no dist — ver docs/OPERACAO-TELA.md).
// =============================================================================
import type { OpApi } from "./api";

let promessa: Promise<OpApi> | null = null;

export function carregarOpApi(): Promise<OpApi> {
  if (!promessa) {
    if (import.meta.env.DEV && import.meta.env.VITE_OPERACAO_DEMO === "true") {
      promessa = import("./demo/adaptadorDemo").then((m) => m.criarAdaptadorDemoComFixture());
    } else {
      promessa = import("./apiSupabase").then((m) => m.criarOpApiSupabase());
    }
  }
  return promessa;
}
