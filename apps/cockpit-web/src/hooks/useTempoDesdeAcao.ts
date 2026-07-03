import { useEffect, useState } from "react";

export function useTempoDesdeAcao(acaoExecutadaEm: string | null | undefined) {
  const [agora, setAgora] = useState(Date.now());
  useEffect(() => {
    if (!acaoExecutadaEm) return;
    const id = setInterval(() => setAgora(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [acaoExecutadaEm]);

  if (!acaoExecutadaEm) return null;
  const ms = agora - new Date(acaoExecutadaEm).getTime();
  const min = Math.max(0, Math.floor(ms / 60_000));
  const horas = Math.floor(min / 60);
  return {
    minutos: min,
    label: horas >= 1 ? `há ${horas}h${(min % 60).toString().padStart(2, "0")}min` : `há ${min}min`,
    bastaoAtrasado: min >= 60,
  };
}
