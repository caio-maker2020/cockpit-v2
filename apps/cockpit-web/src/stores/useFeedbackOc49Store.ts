import { create } from "zustand";

/**
 * Feedback OBRIGATÓRIO da 49 não-reconhecida (Caio 27/08).
 * A RPC aprovar_e_executar recusa com FEEDBACK_OC49_OBRIGATORIO; o wrapper
 * (lib/aprovarComFeedback.ts) abre este modal-singleton, e ao registrar o
 * feedback a aprovação é re-tentada — jornada única, sem válvula de escape.
 */
interface FeedbackOc49State {
  pedido: { cardId: string; nf: string } | null;
  resolver: ((registrou: boolean) => void) | null;
  abrir: (cardId: string, nf: string) => Promise<boolean>;
  fechar: (registrou: boolean) => void;
}

export const useFeedbackOc49Store = create<FeedbackOc49State>((set, get) => ({
  pedido: null,
  resolver: null,
  abrir: (cardId, nf) =>
    new Promise<boolean>((resolve) => {
      // se já há um pedido aberto, resolve o anterior como cancelado
      get().resolver?.(false);
      set({ pedido: { cardId, nf }, resolver: resolve });
    }),
  fechar: (registrou) => {
    get().resolver?.(registrou);
    set({ pedido: null, resolver: null });
  },
}));
