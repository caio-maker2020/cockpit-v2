// =============================================================================
// CiclosChip — "Ciclo N · etapa M" no painel da sugestão (Caio 05/10, INV-168).
// Clique abre um pop-up pequeno com a história do card por ciclo: o que trouxe
// o card, o que o agente sugeriu (ou que não sugeriu) e o que foi lançado.
// Autocontido (query própria, só card_events). Sem dado → não renderiza nada.
// =============================================================================

import { useQuery } from "@tanstack/react-query";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { supabase } from "@/lib/supabase";
import {
  EVENTOS_HISTORICO_CICLOS,
  SELECT_HISTORICO_CICLOS,
  montarHistoricoCiclos,
  type EtapaHistorico,
  type EventoCiclo,
} from "@/lib/historicoCiclos";

const fmtDia = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });
const dia = (ms: number | null | undefined) => (ms == null ? "" : fmtDia.format(new Date(ms)));

function textoGatilho(e: EtapaHistorico): string {
  if (!e.gatilho) return "Seguimento da tratativa";
  if (e.gatilho.tipo === "resposta_cliente") return "Cliente respondeu";
  return e.gatilho.oc != null ? `Entrou com oc ${e.gatilho.oc}` : "Entrou no Cockpit";
}

function textoSugestao(e: EtapaHistorico): { texto: string; fraco: boolean } {
  if (e.sugestao === undefined) return { texto: "sem sugestão do agente", fraco: true };
  if (e.sugestao.oc == null) return { texto: "agente não destacou ação", fraco: true };
  return { texto: `agente sugeriu ${e.sugestao.oc}`, fraco: false };
}

function LinhaEtapa({ e }: { e: EtapaHistorico }) {
  const sug = textoSugestao(e);
  return (
    <li className="flex gap-2 py-1">
      <span className="w-4 shrink-0 pt-px text-right font-mono text-[10.5px] font-semibold text-ink-mute">{e.etapa}</span>
      <div className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink-2">
        <div>
          {textoGatilho(e)}
          <span className="text-ink-mute"> · {dia(e.gatilho?.em ?? e.lancado?.em)}</span>
        </div>
        <div className="text-ink-mute">
          <span className={sug.fraco ? "" : "text-ink-2"}>{sug.texto}</span>
          {" → "}
          {e.lancado ? (
            <span className="text-ink-2">
              lançado <span className="font-mono font-semibold">{e.lancado.oc ?? "—"}</span>
              {e.lancado.automatico && <span className="text-ink-mute"> (automático)</span>}
            </span>
          ) : (
            <span>aguardando decisão</span>
          )}
        </div>
      </div>
    </li>
  );
}

export function CiclosChip({ cardId }: { cardId: string }) {
  const { data } = useQuery({
    queryKey: ["card", cardId, "historico-ciclos"],
    enabled: !!supabase && !!cardId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      // desc + limite: card em vai-e-volta (classe oc 57) não pode perder o fim da história
      const { data, error } = await supabase!
        .from("card_events")
        .select(SELECT_HISTORICO_CICLOS)
        .eq("card_id", cardId)
        .in("event_type", [...EVENTOS_HISTORICO_CICLOS])
        .order("created_at", { ascending: false })
        .limit(1000);
      if (error) throw error;
      return montarHistoricoCiclos((data ?? []) as unknown as EventoCiclo[]);
    },
  });

  if (!data) return null;
  const ciclos = [...data.ciclos].reverse(); // mais recente primeiro

  return (
    <div className="mx-6 mt-2 flex justify-end">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            title="Ver os ciclos deste card"
            className="border border-ink/20 bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-soft hover:border-ink hover:text-ink"
          >
            Ciclo {data.cicloAtual} · etapa {data.etapaAtual}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 rounded-none border-rule p-0">
          <div className="max-h-80 overflow-y-auto px-3.5 py-2.5">
            {ciclos.map((c, i) => (
              <section key={c.n} className={i > 0 ? "mt-2.5 border-t border-rule pt-2.5" : ""}>
                <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-ink-mute">
                  Ciclo {c.n}
                  {c.abertoEm != null && <span className="font-normal"> · aberto em {dia(c.abertoEm)}</span>}
                  {c.n === data.cicloAtual && <span className="font-normal"> · atual</span>}
                </div>
                {c.etapas.length === 0 ? (
                  <p className="mt-1 text-[12.5px] text-ink-mute">nenhuma ação ainda</p>
                ) : (
                  <ul className="mt-0.5">
                    {c.etapas.map((e) => <LinhaEtapa key={`${c.n}-${e.etapa}`} e={e} />)}
                  </ul>
                )}
              </section>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
