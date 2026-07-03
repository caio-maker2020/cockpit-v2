import { create } from "zustand";

interface CtrcOverrideState {
  /** cardId -> override ativo (forcar_lancamento_ctrc_baixado) */
  byCard: Record<string, boolean>;
  set: (cardId: string, value: boolean) => void;
  get: (cardId: string) => boolean;
  reset: (cardId: string) => void;
}

/**
 * Override local (não persistido) para a flag `forcar_lancamento_ctrc_baixado`
 * usada apenas no fluxo de recuperação após guard de "CTRC encerrado/baixado".
 */
export const useCtrcOverrideStore = create<CtrcOverrideState>((set, get) => ({
  byCard: {},
  set: (cardId, value) =>
    set((s) => ({ byCard: { ...s.byCard, [cardId]: value } })),
  get: (cardId) => !!get().byCard[cardId],
  reset: (cardId) =>
    set((s) => {
      const next = { ...s.byCard };
      delete next[cardId];
      return { byCard: next };
    }),
}));

/** Regex que identifica o guard de CTRC encerrado/baixado no acao_falhou_motivo. */
export const CTRC_BAIXADO_GUARD_RE =
  /guard trip|localiza[çc][ãa]o atual|CTRC encerrado|BAIXADO/i;
