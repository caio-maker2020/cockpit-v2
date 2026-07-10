import { QueryClient } from "@tanstack/react-query";

/**
 * QueryClient único do app. Fica num módulo próprio (não dentro de App.tsx)
 * pra poder ser importado pelo AuthContext no logout SEM criar ciclo de
 * import App ↔ AuthContext.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      // Pausa polling/refetch quando aba não está visível (default do RQ é false aqui já)
      refetchOnWindowFocus: false,
      refetchIntervalInBackground: false,
      // Evita refetch agressivo quando vários componentes pedem a mesma query —
      // mantém em cache por 30s; realtime invalida quando há mudança de verdade.
      staleTime: 30_000,
      gcTime: 5 * 60_000,
    },
  },
});
