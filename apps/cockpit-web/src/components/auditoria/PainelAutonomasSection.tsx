// =============================================================================
// PainelAutonomasSection — "o robô agiu" (Caio 28/08).
// Visão unificada das ações autônomas EXECUTADAS: janela de veto + agente
// oc43 + agente de extravio (relançar-54 fora: dormente). Permissão na RPC
// (painel_acoes_autonomas, mig 367): operador vê SÓ os seus; gestor
// (Caio/João/Isadora) vê todos com filtro de operador.
// =============================================================================
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

interface PainelResp {
  papel: string;
  placar: Record<string, number>;
  acoes: Array<{
    nf: string; card_id: string; fonte: string; operador: string | null;
    em: string; detalhe: string | null;
  }>;
  operadores: Array<{ id: string; nome: string }>;
}

const FONTE_ROTULO: Record<string, string> = {
  janela_veto: "⏱ Janela de veto",
  agente_oc43: "🧊 Agente oc 43 (perecível)",
  agente_extravio: "📦 Agente de extravio",
};

export function PainelAutonomasSection() {
  const [dias, setDias] = useState(7);
  const [operadorId, setOperadorId] = useState<string>("");
  const [fonte, setFonte] = useState<string>("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["painel-autonomas", dias, operadorId],
    enabled: !!supabase,
    refetchInterval: 120_000,
    queryFn: async (): Promise<PainelResp> => {
      const { data, error } = await supabase!.rpc("painel_acoes_autonomas", {
        p_operador_id: operadorId || null,
        p_dias: dias,
        p_limit: 300,
      } as never);
      if (error) throw new Error(error.message);
      return data as PainelResp;
    },
  });

  if (isLoading) return <p className="font-mono text-[11px] text-ink-soft">Carregando…</p>;
  if (error) return <p className="font-mono text-[11px] text-sal">Erro: {(error as Error).message}</p>;
  if (!data) return null;

  const ehGestor = data.papel === "gestor";
  const acoes = (data.acoes ?? []).filter((a) => !fonte || a.fonte === fonte);
  const total = Object.values(data.placar ?? {}).reduce((s, n) => s + n, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select value={dias} onChange={(e) => setDias(Number(e.target.value))}
          className="border-2 border-ink bg-paper px-2 py-1 font-mono text-[11px] uppercase tracking-wider">
          <option value={1}>Hoje/ontem</option>
          <option value={7}>7 dias</option>
          <option value={30}>30 dias</option>
        </select>
        {ehGestor && (
          <select value={operadorId} onChange={(e) => setOperadorId(e.target.value)}
            className="border-2 border-ink bg-paper px-2 py-1 font-mono text-[11px] uppercase tracking-wider">
            <option value="">Todos os operadores</option>
            {(data.operadores ?? []).map((o) => (
              <option key={o.id} value={o.id}>{o.nome}</option>
            ))}
          </select>
        )}
        <select value={fonte} onChange={(e) => setFonte(e.target.value)}
          className="border-2 border-ink bg-paper px-2 py-1 font-mono text-[11px] uppercase tracking-wider">
          <option value="">Todas as fontes</option>
          {Object.entries(FONTE_ROTULO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      {/* placar por fonte */}
      <div className="flex flex-wrap gap-3">
        <div className="border-2 border-ink bg-paper px-4 py-2">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Total executadas</p>
          <p className="font-display text-[22px] font-bold tabular-nums">{total}</p>
        </div>
        {Object.entries(FONTE_ROTULO).map(([k, rotulo]) => (
          <div key={k} className="border border-rule bg-paper px-4 py-2">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">{rotulo}</p>
            <p className="font-display text-[22px] font-bold tabular-nums">{data.placar?.[k] ?? 0}</p>
          </div>
        ))}
      </div>

      {/* lista */}
      <div className="overflow-x-auto border-2 border-ink bg-paper">
        <table className="w-full table-dense text-left text-[12px]">
          <thead>
            <tr className="border-b-2 border-ink font-mono text-[10px] uppercase tracking-widest text-ink-soft">
              <th>Quando</th><th>NF</th><th>Fonte</th><th>Ação</th>{ehGestor && <th>Operador</th>}
            </tr>
          </thead>
          <tbody>
            {acoes.length === 0 && (
              <tr><td colSpan={5} className="py-4 text-center font-mono text-[11px] text-ink-mute">
                Nenhuma ação autônoma no período.
              </td></tr>
            )}
            {acoes.map((a, i) => (
              <tr key={a.card_id + a.em + i}
                className={cn("cursor-pointer border-b border-rule hover:bg-subtle")}
                onClick={() => window.open(`/cards/${a.card_id}`, "_blank")}>
                <td className="whitespace-nowrap font-mono tabular-nums">{a.em}</td>
                <td className="font-mono font-semibold">{a.nf}</td>
                <td className="whitespace-nowrap">{FONTE_ROTULO[a.fonte] ?? a.fonte}</td>
                <td className="max-w-[280px] truncate font-mono text-[11px]" title={a.detalhe ?? ""}>{a.detalhe ?? "—"}</td>
                {ehGestor && <td className="whitespace-nowrap font-mono text-[11px]">{a.operador ?? "—"}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
