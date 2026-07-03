import { create } from "zustand";
import { persist } from "zustand/middleware";

interface FiltroOperadorState {
  operadorId: string | null;
  operadorNome: string | null;
  setFiltro: (id: string | null, nome: string | null) => void;
  limpar: () => void;
}

/**
 * Filtro global de operador (visão gestor).
 * Quando operadorId != null, todas as queries de cards filtram por
 * assigned_operator_id = operadorId. Persistido em localStorage com a
 * key 'cockpit:filtro_operador' (sobrevive refresh).
 */
export const useFiltroOperadorStore = create<FiltroOperadorState>()(
  persist(
    (set) => ({
      operadorId: null,
      operadorNome: null,
      setFiltro: (id, nome) => set({ operadorId: id, operadorNome: nome }),
      limpar: () => set({ operadorId: null, operadorNome: null }),
    }),
    { name: "cockpit:filtro_operador" },
  ),
);
