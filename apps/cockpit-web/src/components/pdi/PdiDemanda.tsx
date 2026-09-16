// =============================================================================
// PdiDemanda — Mapa de Demanda da Frente 1, em DOIS momentos (boa prática):
//   1. captura no calor (meta ≤20s, quase tudo em chips);
//   2. endereçamento no ritual semanal → 4 destinos com consequência:
//      conhecimento/projeto/execução geram card no kanban; alçada alimenta a
//      Matriz de Alçada (registro de quem decide + regra).
// Indicadores por semana no fim (o que o Caio mede: a curva das classes).
// =============================================================================
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { Chip } from "@/components/cockpit/Chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  PDI_CANAIS,
  PDI_CLASSES_CAUSA,
  PDI_DESTINOS,
  PDI_TEMPOS_MIN,
  resumoDemandaSemanal,
  rotuloCanal,
  rotuloClasse,
  type PdiDemandaRow,
} from "@/lib/pdi";

function ChipEscolha({ ativo, onClick, children }: {
  ativo: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 font-mono text-[11px] uppercase tracking-wide transition ${
        ativo ? "border-ink bg-ink text-white" : "border-rule bg-paper text-ink-mute hover:border-ink/40"
      }`}
    >
      {children}
    </button>
  );
}

export default function PdiDemanda() {
  const qc = useQueryClient();
  const [ator, setAtor] = useState("");
  const [pedido, setPedido] = useState("");
  const [canal, setCanal] = useState<string>("whatsapp");
  const [tempo, setTempo] = useState<number>(15);
  const [classe, setClasse] = useState<string>("");
  const [salvando, setSalvando] = useState(false);
  const [detDraft, setDetDraft] = useState<Record<string, string>>({});
  const [destinoEscolhido, setDestinoEscolhido] = useState<Record<string, string>>({});

  const { data: log = [], refetch } = useQuery({
    queryKey: ["pdi-demanda"],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!.from("pdi_demanda_log").select("*")
        .order("criado_em", { ascending: false }).limit(500);
      if (error) throw error;
      return (data ?? []) as PdiDemandaRow[];
    },
  });

  const atoresRecentes = useMemo(
    () => [...new Set(log.map((r) => r.ator))].slice(0, 8),
    [log],
  );
  const pendentes = log.filter((r) => !r.destino);
  const semanas = useMemo(() => resumoDemandaSemanal(log).slice(0, 8), [log]);

  const registrar = async () => {
    if (!ator.trim() || !pedido.trim() || !classe) {
      toast.error("Faltou: quem/o quê, o pedido ou a classe de causa.");
      return;
    }
    setSalvando(true);
    const { error } = await supabase!.from("pdi_demanda_log").insert({
      ator: ator.trim(), pedido: pedido.trim(), canal, tempo_min: tempo, classe_causa: classe,
    });
    setSalvando(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Registrado. Volta pro trabalho — o endereçamento é no ritual.");
    setAtor(""); setPedido(""); setClasse("");
    void refetch();
  };

  const enderecar = async (r: PdiDemandaRow) => {
    const destino = destinoEscolhido[r.id];
    if (!destino) { toast.error("Escolha um destino."); return; }
    const det = (detDraft[r.id] ?? "").trim();
    if (destino !== "fica_execucao" && det.length < 3) {
      toast.error(
        destino === "vira_alcada"
          ? "Diga QUEM recebe a alçada e qual a regra."
          : destino === "vira_projeto"
            ? "Nomeie a causa raiz que o projeto ataca."
            : "Diga o que precisa ser documentado/treinado.",
      );
      return;
    }
    const { error } = await supabase!.from("pdi_demanda_log")
      .update({ destino, destino_det: det || null, enderecada_em: new Date().toISOString() })
      .eq("id", r.id);
    if (error) { toast.error(error.message); return; }

    // consequência rastreável: 3 dos 4 destinos viram card no kanban
    const cardPorDestino: Record<string, string | null> = {
      vira_conhecimento: `Documentar/treinar: ${det}`,
      vira_projeto: `Projeto — ${det}`,
      fica_execucao: `Executar: ${r.pedido}`,
      vira_alcada: null, // alimenta a Matriz de Alçada, não o kanban
    };
    const titulo = cardPorDestino[destino];
    if (titulo) {
      await supabase!.from("pdi_todos").insert({
        frente_id: 1, titulo, detalhe: `Origem: demanda de ${r.ator} (${rotuloCanal(r.canal)}) — "${r.pedido}"`,
        origem: "demanda", origem_id: r.id, status: "a_fazer",
      });
      void qc.invalidateQueries({ queryKey: ["pdi-todos"] });
    }
    if (destino === "vira_alcada") {
      toast.success("Endereçada. Agora registre a regra na Matriz de Alçada (Frente 1 → Frameworks).");
    } else {
      toast.success("Endereçada — virou card no kanban.");
    }
    void refetch();
  };

  return (
    <div className="space-y-6">
      {/* momento 1 — captura no calor */}
      <section className="rounded-lg border border-rule bg-paper p-4">
        <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-mute">
          Captura rápida (meta: 20 segundos) — data preenche sozinha
        </h3>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <div>
            <Input list="pdi-atores" placeholder="Quem acionou / o que você executou"
              value={ator} onChange={(e) => setAtor(e.target.value)} />
            <datalist id="pdi-atores">
              {atoresRecentes.map((a) => <option key={a} value={a} />)}
            </datalist>
          </div>
          <Input placeholder="O que pediu (curto)" value={pedido} onChange={(e) => setPedido(e.target.value)} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase text-ink-mute">canal</span>
          {PDI_CANAIS.map((c) => (
            <ChipEscolha key={c.v} ativo={canal === c.v} onClick={() => setCanal(c.v)}>{c.l}</ChipEscolha>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase text-ink-mute">tempo</span>
          {PDI_TEMPOS_MIN.map((t) => (
            <ChipEscolha key={t} ativo={tempo === t} onClick={() => setTempo(t)}>{t === 60 ? "60+ min" : `${t} min`}</ChipEscolha>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase text-ink-mute">causa</span>
          {PDI_CLASSES_CAUSA.map((c) => (
            <ChipEscolha key={c.v} ativo={classe === c.v} onClick={() => setClasse(c.v)}>{c.l}</ChipEscolha>
          ))}
        </div>
        <div className="mt-3">
          <Button onClick={registrar} disabled={salvando}>Registrar</Button>
        </div>
      </section>

      {/* momento 2 — fila de endereçamento */}
      <section className="rounded-lg border border-rule bg-paper p-4">
        <div className="flex items-baseline justify-between">
          <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-mute">
            Endereçamento (ritual semanal) — {pendentes.length} pendente{pendentes.length === 1 ? "" : "s"}
          </h3>
        </div>
        {pendentes.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-mute">Fila zerada — tudo endereçado. ✓</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {pendentes.map((r) => (
              <li key={r.id} className="rounded-md border border-rule p-3">
                <div className="flex flex-wrap items-baseline gap-2 text-[13.5px]">
                  <span className="font-mono text-[11px] text-ink-mute tabular">
                    {new Date(r.criado_em).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}
                  </span>
                  <b className="text-ink-2">{r.ator}</b>
                  <span className="text-ink-mute">— {r.pedido}</span>
                  <Chip tone="neutral">{rotuloCanal(r.canal)}</Chip>
                  <Chip tone="neutral">{r.tempo_min} min</Chip>
                  <Chip tone="warning">{rotuloClasse(r.classe_causa)}</Chip>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {PDI_DESTINOS.map((d) => (
                    <ChipEscolha key={d.v} ativo={destinoEscolhido[r.id] === d.v}
                      onClick={() => setDestinoEscolhido((m) => ({ ...m, [r.id]: d.v }))}>
                      {d.l}
                    </ChipEscolha>
                  ))}
                </div>
                {destinoEscolhido[r.id] && destinoEscolhido[r.id] !== "fica_execucao" && (
                  <Input className="mt-2" value={detDraft[r.id] ?? ""}
                    placeholder={
                      destinoEscolhido[r.id] === "vira_alcada"
                        ? "Quem passa a decidir + qual a regra da alçada"
                        : destinoEscolhido[r.id] === "vira_projeto"
                          ? "Causa raiz que o projeto vai atacar"
                          : "O que documentar/treinar (e pra quem)"
                    }
                    onChange={(e) => setDetDraft((m) => ({ ...m, [r.id]: e.target.value }))} />
                )}
                {destinoEscolhido[r.id] && (
                  <Button size="sm" className="mt-2" onClick={() => void enderecar(r)}>Confirmar destino</Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* indicadores — o que o Caio mede */}
      <section className="rounded-lg border border-rule bg-paper p-4">
        <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-mute">
          Indicadores por semana — sucesso = "conhecimento" e "processo" caindo
        </h3>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-rule text-left font-mono text-[10px] uppercase text-ink-mute">
                <th className="py-1 pr-3">Semana de</th>
                <th className="py-1 pr-3 text-right">Acion.</th>
                <th className="py-1 pr-3 text-right">Tempo</th>
                <th className="py-1 pr-3">Mix por classe</th>
                <th className="py-1 text-right">Sem destino</th>
              </tr>
            </thead>
            <tbody>
              {semanas.map((s) => (
                <tr key={s.semana} className="border-b border-rule/60">
                  <td className="py-1.5 pr-3 font-mono text-[12px] tabular">
                    {s.semana.slice(8, 10)}/{s.semana.slice(5, 7)}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono tabular">{s.acionamentos}</td>
                  <td className="py-1.5 pr-3 text-right font-mono tabular">
                    {s.tempoMin >= 60 ? `${Math.floor(s.tempoMin / 60)}h${String(s.tempoMin % 60).padStart(2, "0")}` : `${s.tempoMin}min`}
                  </td>
                  <td className="py-1.5 pr-3">
                    {Object.entries(s.porClasse).map(([k, n]) => (
                      <span key={k} className="mr-2 font-mono text-[11px] text-ink-mute">
                        {rotuloClasse(k).split(" ")[0].toLowerCase()} {n}
                      </span>
                    ))}
                  </td>
                  <td className="py-1.5 text-right font-mono tabular">
                    {s.pendentes > 0 ? <span className="text-signal">{s.pendentes}</span> : "0"}
                  </td>
                </tr>
              ))}
              {semanas.length === 0 && (
                <tr><td colSpan={5} className="py-3 text-ink-mute">Sem registros ainda — a primeira captura inaugura o mapa.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
