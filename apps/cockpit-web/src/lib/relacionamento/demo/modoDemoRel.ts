// Demonstração do Relacionamento: `vite build --mode demo-rel` (servida pelo site do
// roteirizador em /relacionamento-cockpit/). DADOS FICTÍCIOS, em memória: nada lê nem
// escreve no Cockpit real. `MODE` vira literal no build: no de produção a comparação é
// `"production" === "demo-rel"` e o ramo inteiro (e o import dinâmico) morre.
export const RELACIONAMENTO_DEMO: boolean = import.meta.env.MODE === "demo-rel";
export const AVISO_DEMO_REL = "🧪 DEMONSTRAÇÃO · dados fictícios · nada vai ao Relacionamento real nem ao SSW";
