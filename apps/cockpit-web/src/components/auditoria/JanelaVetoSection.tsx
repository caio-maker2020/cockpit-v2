// =============================================================================
// JanelaVetoSection — a seção da JANELA DE VETO na aba Auditoria
// (Etapa F do plano 25/08). 4 blocos:
//   1. Placar por ação (% sem toque × editado × cancelado + tempo até o veto)
//   2. Linha do tempo (evento a evento, com NF e motivo)
//   3. Cancelamentos com o formulário completo + correção capturada
//   4. Edições (antes/depois)
// Todas as buscas são RESILIENTES: antes das migs 353-355 nada existe e a
// seção mostra o estado vazio honesto (nada quebra).
// =============================================================================

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { relativeShort } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  EVENTOS_TRILHO_VETO,
  pctSemToque,
  placarVeto,
  ROTULO_EVENTO_VETO,
  type EventoVetoCru,
} from "@/lib/auditoriaVeto";

const th = "px-2 py-1.5 text-left font-mono text-[9px] uppercase tracking-wider text-ink-soft";
const td = "px-2 py-1.5 text-[11.5px] text-ink align-top";

export function JanelaVetoSection({ desdeISO }: { desdeISO: string | null }) {
  const { data: eventos = [] } = useQuery({
    queryKey: ["auditoria-veto-eventos", desdeISO],
    enabled: !!supabase,
    queryFn: async (): Promise<Array<EventoVetoCru & { nf: string | null }>> => {
      try {
        let q = supabase!
          .from("card_events")
          .select("id, card_id, event_type, actor_id, payload, created_at")
          .in("event_type", [...EVENTOS_TRILHO_VETO])
          .order("created_at", { ascending: false })
          .limit(500);
        if (desdeISO) q = q.gte("created_at", desdeISO);
        const { data, error } = await q;
        if (error) return [];
        const evs = (data ?? []) as EventoVetoCru[];
        // só o trilho: AutoAprovacaoPermitida de outras origens fica fora
        const doTrilho = evs.filter(
          (e) => e.event_type !== "AutoAprovacaoPermitida" || e.actor_id === "veto-janela",
        );
        const ids = [...new Set(doTrilho.map((e) => e.card_id))];
        const nfs = new Map<string, string | null>();
        for (let i = 0; i < ids.length; i += 100) {
          const { data: cards } = await supabase!
            .from("cards").select("id, nf").in("id", ids.slice(i, i + 100));
          for (const c of (cards ?? []) as Array<{ id: string; nf: string | null }>) {
            nfs.set(c.id, c.nf);
          }
        }
        return doTrilho.map((e) => ({ ...e, nf: nfs.get(e.card_id) ?? null }));
      } catch {
        return [];
      }
    },
  });

  const { data: cancelamentos = [] } = useQuery({
    queryKey: ["auditoria-veto-cancelamentos", desdeISO],
    enabled: !!supabase,
    queryFn: async () => {
      try {
        let q = supabase!
          .from("cancelamentos_acao_autonoma")
          .select("id, card_id, agent_name, acao_key, ciclo, respostas, correcao_capturada, created_at, operador:operadores(nome), card:cards(nf)")
          .order("created_at", { ascending: false })
          .limit(100);
        if (desdeISO) q = q.gte("created_at", desdeISO);
        const { data, error } = await q;
        return error ? [] : (data ?? []);
      } catch {
        return [];
      }
    },
  });

  const { data: edicoes = [] } = useQuery({
    queryKey: ["auditoria-veto-edicoes", desdeISO],
    enabled: !!supabase,
    queryFn: async () => {
      try {
        let q = supabase!
          .from("edicoes_acao_autonoma")
          .select("id, card_id, acao_key, campo, valor_antes, valor_depois, created_at, operador:operadores(nome), card:cards(nf)")
          .order("created_at", { ascending: false })
          .limit(100);
        if (desdeISO) q = q.gte("created_at", desdeISO);
        const { data, error } = await q;
        return error ? [] : (data ?? []);
      } catch {
        return [];
      }
    },
  });

  const placar = placarVeto(eventos);

  return (
    <div className="space-y-6">
      {/* 1 — Placar por ação */}
      <section>
        <h3 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest text-ink">
          Placar da janela de veto
        </h3>
        {placar.length === 0 ? (
          <p className="text-[11.5px] text-ink-mute">
            Nenhuma ação autônoma programada ainda — o trilho está desligado ou sem degrau ativo.
          </p>
        ) : (
          <div className="overflow-x-auto border border-ink/10">
            <table className="w-full">
              <thead className="border-b border-ink/10 bg-ink/[0.02]">
                <tr>
                  <th className={th}>ação</th>
                  <th className={th}>programadas</th>
                  <th className={th}>exec. sem toque</th>
                  <th className={th}>exec. editada</th>
                  <th className={th}>canceladas</th>
                  <th className={th}>devolvidas</th>
                  <th className={th}>expiradas</th>
                  <th className={th}>% sem toque</th>
                  <th className={th}>tempo até veto</th>
                </tr>
              </thead>
              <tbody>
                {placar.map((l) => (
                  <tr key={l.acaoKey} className="border-b border-ink/5">
                    <td className={cn(td, "font-mono text-[10.5px]")}>{l.acaoKey}</td>
                    <td className={td}>{l.programadas}</td>
                    <td className={cn(td, "text-emerald-700")}>{l.executadasSemToque}</td>
                    <td className={td}>{l.executadasComEdicao}</td>
                    <td className={cn(td, "text-red-700")}>{l.canceladas}</td>
                    <td className={td}>{l.devolvidas}</td>
                    <td className={td}>{l.expiradas}</td>
                    <td className={cn(td, "font-mono")}>
                      {pctSemToque(l) == null ? "—" : `${pctSemToque(l)}%`}
                    </td>
                    <td className={td}>
                      {l.tempoMedioAteVetoMin == null ? "—" : `${l.tempoMedioAteVetoMin} min`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 2 — Linha do tempo */}
      <section>
        <h3 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest text-ink">
          Linha do tempo do trilho autônomo
        </h3>
        {eventos.length === 0 ? (
          <p className="text-[11.5px] text-ink-mute">Sem eventos no período.</p>
        ) : (
          <div className="max-h-96 overflow-y-auto border border-ink/10">
            {eventos.map((e) => (
              <div key={e.id} className="flex items-center gap-2 border-b border-ink/5 px-2 py-1.5">
                <span className="w-24 shrink-0 font-mono text-[10px] text-ink-mute">
                  {relativeShort(e.created_at)}
                </span>
                <Link to={`/card/${e.card_id}`} className="w-20 shrink-0 font-mono text-[11px] text-ink underline-offset-2 hover:underline">
                  {e.nf ?? "—"}
                </Link>
                <span
                  className={cn(
                    "shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wide",
                    e.event_type === "AcaoAutonomaCanceladaPeloOperador"
                      ? "text-red-700"
                      : e.event_type === "AutoAprovacaoPermitida"
                        ? "text-emerald-700"
                        : "text-ink-soft",
                  )}
                >
                  {ROTULO_EVENTO_VETO[e.event_type] ?? e.event_type}
                </span>
                <span className="truncate text-[11px] text-ink-soft">
                  {typeof e.payload?.["acao_key"] === "string" ? String(e.payload["acao_key"]) : ""}
                  {typeof e.payload?.["motivo"] === "string" ? ` · ${String(e.payload["motivo"])}` : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 3 — Cancelamentos (o dado de treino) */}
      <section>
        <h3 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest text-ink">
          Cancelamentos — o que o time ensinou ao robô
        </h3>
        {cancelamentos.length === 0 ? (
          <p className="text-[11.5px] text-ink-mute">Nenhum cancelamento no período.</p>
        ) : (
          <div className="space-y-2">
            {(cancelamentos as Array<Record<string, any>>).map((c) => (
              <div key={c.id} className="border border-ink/10 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <Link to={`/card/${c.card_id}`} className="font-mono font-semibold text-ink underline-offset-2 hover:underline">
                    NF {c.card?.nf ?? "—"}
                  </Link>
                  <span className="font-mono text-[10px] text-ink-mute">{c.acao_key}</span>
                  <span className="text-ink-soft">ciclo {c.ciclo ?? "?"}</span>
                  <span className="text-ink-soft">· {c.operador?.nome ?? "?"}</span>
                  <span className="text-ink-mute">· {relativeShort(c.created_at)}</span>
                </div>
                <div className="mt-1 text-[11.5px] text-ink">
                  <span className="text-ink-soft">Leu errado: </span>
                  {c.respostas?.o_que_leu_errado ?? "—"}
                </div>
                <div className="mt-0.5 text-[11px] text-ink-soft">
                  Olhou em: {(c.respostas?.onde_olhou ?? []).join(", ") || "—"} · info no Cockpit:{" "}
                  {c.respostas?.info_existe_no_cockpit === "sim_interpretou_errado"
                    ? "sim (interpretou errado)"
                    : `não (${c.respostas?.onde_fora ?? "fora"})`}
                  {c.respostas?.excecao_cliente === true && (
                    <span className="text-amber-700"> · EXCEÇÃO do cliente: {c.respostas?.excecao_qual}</span>
                  )}
                </div>
                <div className="mt-0.5 text-[11px]">
                  <span className="text-ink-soft">Correção capturada: </span>
                  {c.correcao_capturada ? (
                    <span className="font-mono text-emerald-700">
                      {c.correcao_capturada.acao_key ?? c.correcao_capturada.tool ?? "ação aprovada"}
                    </span>
                  ) : (
                    <span className="text-ink-mute">aguardando a próxima ação do operador</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 4 — Edições (antes/depois) */}
      <section>
        <h3 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest text-ink">
          Edições na janela — antes / depois
        </h3>
        {edicoes.length === 0 ? (
          <p className="text-[11.5px] text-ink-mute">Nenhuma edição no período.</p>
        ) : (
          <div className="space-y-2">
            {(edicoes as Array<Record<string, any>>).map((e) => (
              <div key={e.id} className="border border-ink/10 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <Link to={`/card/${e.card_id}`} className="font-mono font-semibold text-ink underline-offset-2 hover:underline">
                    NF {e.card?.nf ?? "—"}
                  </Link>
                  <span className="font-mono text-[10px] text-ink-mute">{e.acao_key}</span>
                  <span className="text-ink-soft">{e.campo}</span>
                  <span className="text-ink-soft">· {e.operador?.nome ?? "?"}</span>
                  <span className="text-ink-mute">· {relativeShort(e.created_at)}</span>
                </div>
                <div className="mt-1 grid grid-cols-2 gap-2 text-[11px]">
                  <div className="border-l-2 border-red-300 pl-2">
                    <div className="font-mono text-[9px] uppercase text-ink-mute">antes</div>
                    <div className="text-ink-soft">{JSON.stringify(e.valor_antes?.descricao ?? e.valor_antes)?.slice(0, 200)}</div>
                  </div>
                  <div className="border-l-2 border-emerald-300 pl-2">
                    <div className="font-mono text-[9px] uppercase text-ink-mute">depois</div>
                    <div className="text-ink">{JSON.stringify(e.valor_depois?.descricao ?? e.valor_depois)?.slice(0, 200)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
