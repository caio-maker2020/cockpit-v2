// Modo demonstração da Operação: só em `vite dev` e só com VITE_OPERACAO_DEMO=true.
// No `vite build` `import.meta.env.DEV` é `false` literal: em produção isto é
// sempre false, sem depender de quem configura as env vars da Vercel.
export const OPERACAO_DEMO: boolean =
  import.meta.env.DEV && import.meta.env.VITE_OPERACAO_DEMO === "true";
