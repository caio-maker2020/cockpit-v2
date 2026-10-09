import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
// `vite build --mode demo-v3`: a tela da Operação em DEMONSTRAÇÃO, servida pelo site do
// roteirizador v3 em /operacao-cockpit/ (base). A fila vem da API do v3 (GET
// /v3/cockpit-demo/fila, com a sessão do v3); nada de dado real no bundle. Ver
// src/lib/operacao/carregarOpApi.ts e docs/OPERACAO-TELA.md.
export default defineConfig(({ mode }) => ({
  // `--mode demo-rel`: o Relacionamento em demonstração com dados FICTÍCIOS, em /relacionamento-cockpit/.
  ...(mode === "demo-rel" ? { base: "/relacionamento-cockpit/" } : { base: mode === "demo-v3" ? "/operacao-cockpit/" : "/" }),
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
  },
}));
