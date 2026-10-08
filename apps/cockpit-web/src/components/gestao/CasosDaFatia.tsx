import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { buscarCiclosDosCards, posicaoDoPar, rotuloCiclo } from "@/lib/ciclosTratativa";

// "VER CASOS" (Caio 24/08): todas as NFs que formam o número da linha do
// drill — pra estudar as divergências caso a caso com o time. Busca sob
// demanda na fonte única (agent_feedback, leitura de gestor), NF abre o card.
export function CasosDaFatia({ agente, ocCard, ocSugerida, ocExecutada, veredito, diaInicio, operadorId }: {
  agente: string;
  ocCard: number | null;
  ocSugerida: number | null;
  /** drill de corrigidas: a linha é UMA troca exata — filtrar também pelo que
   *  o operador fez (Caio 24/08: "só os casos daquela troca"). */
  ocExecutada?: number | null;
  veredito: "seguida" | "corrigida";
  diaInicio: string;
  /** respeita o filtro de operador da página — a lista TEM que bater com o n da linha */
  operadorId: string | null;
}) {
  const casos = useQuery({
    queryKey: ["gestao-ag-casos", agente, ocCard, ocSugerida, ocExecutada ?? "x", veredito, diaInicio, operadorId],
    queryFn: async () => {
      let q = supabase
        .from("agent_feedback")
        .select("card_id, oc_executada, created_at, cards(nf)")
        .eq("agent_name", agente)
        .eq("veredito", veredito)
        .gte("created_at", `${diaInicio}T00:00:00-03:00`)
        .order("created_at", { ascending: false })
        .limit(1000);
      q = ocCard == null ? q.is("oc_card", null) : q.eq("oc_card", ocCard);
      q = ocSugerida == null ? q.is("oc_sugerida", null) : q.eq("oc_sugerida", ocSugerida);
      if (veredito === "corrigida" && ocExecutada != null) q = q.eq("oc_executada", ocExecutada);
      if (operadorId) q = q.eq("operador_id", operadorId);
      const { data, error } = await q;
      if (error) throw error;
      return ((data ?? []) as unknown as Array<{
        card_id: string; oc_executada: number | null; created_at: string;
        cards: { nf: string | null } | null;
      }>);
    },
    staleTime: 60_000,
    retry: false,
  });

  // CICLOS (Caio 25/08, definição validada): posição do par na HISTÓRIA do
  // card — em qual passagem (ciclo) e decisão (etapa) a divergência aconteceu.
  const ciclos = useQuery({
    queryKey: ["gestao-ag-casos-ciclos", agente, ocCard, ocSugerida, ocExecutada ?? "x", veredito, diaInicio, operadorId],
    enabled: (casos.data ?? []).length > 0,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => buscarCiclosDosCards(supabase, [...new Set((casos.data ?? []).map((c) => c.card_id))]),
  });

  if (casos.isLoading) return <p className="px-3 py-2 text-[12px] text-ink-mute">carregando casos…</p>;
  if (casos.isError) return <p className="px-3 py-2 text-[12px] text-ink-mute">não consegui carregar os casos.</p>;
  const lista = casos.data ?? [];
  return (
    <div className="mt-1.5 rounded-[10px] border border-rule bg-surface px-3 py-2.5">
      <p className="mb-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-ink-mute">
        {lista.length} caso{lista.length === 1 ? "" : "s"} — clique na NF pra abrir o card
      </p>
      <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
        {lista.map((c) => (
          <Link
            key={c.card_id}
            to={`/cards/${c.card_id}`}
            className="inline-flex items-center gap-1.5 rounded-[6px] bg-muted-2 px-2 py-1 font-mono text-[11px] text-ink-2 transition-colors hover:bg-signal-soft hover:text-signal"
            title={new Date(c.created_at).toLocaleDateString("pt-BR")}
          >
            NF {c.cards?.nf ?? "—"}
            {veredito === "corrigida" && c.oc_executada != null && (
              <span className="text-[10px] text-ink-mute">→ fez {c.oc_executada}</span>
            )}
            {(() => {
              const pos = posicaoDoPar(ciclos.data, c.card_id, c.created_at);
              return pos ? (
                <span className="text-[9.5px] text-ink-mute">· {rotuloCiclo(pos)}</span>
              ) : null;
            })()}
          </Link>
        ))}
        {lista.length === 0 && <span className="text-[12px] text-ink-mute">nenhum caso na janela.</span>}
      </div>
    </div>
  );
}
