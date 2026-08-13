import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/lib/supabase";
import { proximaVarreduraWurth } from "@/lib/wurthAgenda";

// Indicador da última/próxima varredura do robô-intranet Würth (Caio 2026-08-12).
// "Última" vem do RPC ultima_rodada_wurth (formatado em BRT no servidor); a
// "próxima" é computada no front pelo cron 08h/16h. Só aparece em card Würth.

interface UltimaRodada {
  started_at: string | null;
  started_at_fmt: string | null;
  origem: string | null;
  retornos_aplicados: number | null;
  erros: number | null;
  minutos: number | null;
}

export function WurthRodadaChip() {
  const { data } = useQuery({
    queryKey: ["wurth", "ultima-rodada"],
    enabled: !!supabase,
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data } = await supabase!.rpc("ultima_rodada_wurth");
      return (data ?? null) as UltimaRodada | null;
    },
  });

  const proxima = proximaVarreduraWurth(new Date()).label;
  const n = data?.retornos_aplicados ?? 0;
  const ultima = data?.started_at_fmt
    ? `${data.started_at_fmt} (${n} retorno${n === 1 ? "" : "s"})`
    : "ainda sem varredura registrada";

  return (
    <p
      className="px-1 text-[11px] leading-tight text-ink-soft"
      title="Varredura automática do robô da intranet Würth (08h/16h BRT). Use o botão acima pra consultar esta NF agora."
    >
      🤖 Robô intranet · última: {ultima} · próxima: {proxima}
    </p>
  );
}
