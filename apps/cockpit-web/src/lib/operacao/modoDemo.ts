// Modo demonstração da Operação. Dois jeitos, e nenhum chega ao build de produção normal:
//  - `vite dev` com VITE_OPERACAO_DEMO=true (`import.meta.env.DEV` é `false` literal no build);
//  - `vite build --mode demo-v3`: a tela servida pelo site do roteirizador v3 em
//    /operacao-cockpit/, com a fila real lida da API do v3 (só leitura). `MODE` vira literal no
//    build: no modo de produção a comparação é `"production" === "demo-v3"` e o ramo morre.
export const OPERACAO_DEMO_V3: boolean = import.meta.env.MODE === "demo-v3";

export const OPERACAO_DEMO: boolean =
  (import.meta.env.DEV && import.meta.env.VITE_OPERACAO_DEMO === "true") || OPERACAO_DEMO_V3;

/** Faixa da demonstração no v3 (pedido do dono). */
export const AVISO_DEMO_V3 = "Dados reais do SSW (só leitura) · nada é lançado no SSW nem enviado ao Relacionamento";

// De onde a demonstração tirou a fila (a faixa do topo só diz "dados reais" quando são).
export type OrigemDemo = "carregando" | "v3" | "fixture" | "ficticio";
let origemAtual: OrigemDemo = "carregando";
const ouvintes = new Set<() => void>();
export function definirOrigemDemo(o: OrigemDemo): void {
  origemAtual = o;
  ouvintes.forEach((f) => f());
}
export const origemDemo = (): OrigemDemo => origemAtual;
export function ouvirOrigemDemo(f: () => void): () => void {
  ouvintes.add(f);
  return () => ouvintes.delete(f);
}
