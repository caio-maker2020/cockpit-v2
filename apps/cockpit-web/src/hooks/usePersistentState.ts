import { useEffect, useState } from "react";

/** Persiste estado em localStorage por chave. SSR-safe (lazy init). */
export function usePersistentState<T>(key: string, initial: T) {
  const [state, setState] = useState<T>(() => {
    if (typeof window === "undefined") return initial;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw == null) return initial;
      return JSON.parse(raw) as T;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(state));
    } catch {
      /* ignore quota errors */
    }
  }, [key, state]);

  return [state, setState] as const;
}
