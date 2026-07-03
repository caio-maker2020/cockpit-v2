import { useEffect, useState, useCallback } from "react";

/**
 * Preferência GLOBAL do operador (vale pra todos os cards):
 * recolhe os blocos pesados do topo do detalhe do card e traz as abas pra cima.
 *
 * Chave: cockpit:cardDetalhe:modoFoco  ('1' | '0')
 *
 * Propaga mudanças entre componentes da mesma aba via CustomEvent
 * 'cockpit:modoFoco:change' (useState não é compartilhado).
 */

const STORAGE_KEY = "cockpit:cardDetalhe:modoFoco";
const EVENT_NAME = "cockpit:modoFoco:change";

function readInitial(): boolean {
  // Default: LIGADO (colapsado) — operador prioriza ver as abas (Histórico SSW).
  if (typeof window === "undefined") return true;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v == null) return true;
    return v === "1";
  } catch {
    return true;
  }
}

export function useModoFoco(): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(readInitial);

  useEffect(() => {
    function onChange(e: Event) {
      const ce = e as CustomEvent<boolean>;
      setValue(!!ce.detail);
    }
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setValue(e.newValue === "1");
    }
    window.addEventListener(EVENT_NAME, onChange as EventListener);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT_NAME, onChange as EventListener);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setModoFoco = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* ignore quota */
    }
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: next }));
  }, []);

  return [value, setModoFoco];
}
