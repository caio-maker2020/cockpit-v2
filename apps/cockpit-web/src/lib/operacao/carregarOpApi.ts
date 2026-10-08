// =============================================================================
// Escolhe a OpApi. Os adaptadores de demonstração só existem em dois modos, e a
// condição está ESCRITA AQUI, no próprio import dinâmico, de propósito: no build
// de produção as duas condições viram literais falsos, o ramo morre e o Rollup nem
// gera os chunks (conferido no dist — ver docs/OPERACAO-TELA.md):
//  - `vite build --mode demo-v3`: a demonstração servida pelo site do roteirizador
//    v3 em /operacao-cockpit/. A fila REAL vem da API do v3 (GET
//    /v3/cockpit-demo/fila, com a sessão do v3); o arquivo local NUNCA entra;
//  - `vite dev` com VITE_OPERACAO_DEMO=true: fixture local opcional
//    (demo/fila-real.json, fora do git) ou os fictícios.
// =============================================================================
import type { OpApi } from "./api";

let promessa: Promise<OpApi> | null = null;

export function carregarOpApi(): Promise<OpApi> {
  if (!promessa) {
    if (import.meta.env.MODE === "demo-v3") {
      promessa = import("./demo/filaDoV3").then((m) => m.criarAdaptadorDemoDoV3());
    } else if (import.meta.env.DEV && import.meta.env.VITE_OPERACAO_DEMO === "true") {
      promessa = import("./demo/fixtureLocal").then((m) => m.criarAdaptadorDemoComFixture());
    } else {
      promessa = import("./apiSupabase").then((m) => m.criarOpApiSupabase());
    }
  }
  return promessa;
}
