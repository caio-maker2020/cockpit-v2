// =============================================================================
// Contexto da Operação: a OpApi (real ou demo), a sessão `op_minha_sessao()` e
// a decisão de áreas (Relacionamento × Operação — ADR 0041 D2, INV-180).
// =============================================================================
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import type { OpApi } from "@/lib/operacao/api";
import { carregarOpApi } from "@/lib/operacao/carregarOpApi";
import { decidirAreas, type Areas } from "@/lib/operacao/areas";
import type { OpSessao } from "@/lib/operacao/tipos";

const OpApiContext = createContext<OpApi | null>(null);

/** `api` só é passada em teste; no app a OpApi é carregada (real ou demo) por `carregarOpApi`. */
export function OpApiProvider({ api, children }: { api?: OpApi; children: ReactNode }) {
  const [carregada, setCarregada] = useState<OpApi | null>(api ?? null);
  useEffect(() => {
    if (api) {
      setCarregada(api);
      return;
    }
    let vivo = true;
    carregarOpApi()
      .then((a) => vivo && setCarregada(a))
      .catch((e) => console.error("[operacao] não carregou a OpApi:", e));
    return () => {
      vivo = false;
    };
  }, [api]);
  return <OpApiContext.Provider value={carregada}>{children}</OpApiContext.Provider>;
}

/** null enquanto a OpApi carrega. */
export function useOpApi(): OpApi | null {
  return useContext(OpApiContext);
}

export const chaveSessaoOp = (userId: string | null | undefined) => ["op", "sessao", userId ?? "anon"] as const;

export function useOpSessao(): { sessao: OpSessao | null; carregada: boolean } {
  const api = useOpApi();
  const { user } = useAuth();
  const { data, isFetched, isError } = useQuery({
    queryKey: chaveSessaoOp(user?.id),
    enabled: !!api && !!user,
    staleTime: 60_000,
    retry: 1,
    queryFn: () => api!.minhaSessao(),
  });
  // Sem usuário não há sessão a carregar: "carregada" com null (o ProtectedRoute cuida do login).
  return { sessao: data ?? null, carregada: !user || isFetched || isError };
}

export function useAreas(): Areas {
  const { operador, operadorCarregado } = useAuth();
  const { sessao, carregada } = useOpSessao();
  return decidirAreas({ operador, operadorCarregado, sessao, sessaoCarregada: carregada });
}
