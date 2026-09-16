// =============================================================================
// PdiDemanda — Mapa de Demanda da Frente 1, em DOIS momentos (boa prática):
//   1. captura no calor (meta ≤20s): SÓ os 2 campos de texto são livres; tipo,
//      canal, tempo e classe são SELEÇÃO travada (Caio 16/09);
//   2. endereçamento no ritual semanal → 4 destinos com consequência
//      (conhecimento/projeto/execução geram card no kanban; alçada alimenta a
//      Matriz de Alçada). Indicadores semanais no fim (a curva que o Caio lê).
// Visual: idioma do Cockpit via pdi-ui (ticket-card, botões sal, chips).
// =============================================================================
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { Chip } from "@/components/cockpit/Chip";
import { Input } from "@/components/ui/input";
import {
  BotaoSal,
  Callout,
  Cartao,
  ChipCodigo,
  Escolha,
  Rotulo,
} from "./pdi-ui";
import {
  PDI_CANAIS,
  PDI_CLASSES_CAUSA,
  PDI_DESTINOS,
  PDI_TEMPOS_MIN,
  PDI_TIPOS_REGISTRO,
  resumoDemandaSemanal,
  rotuloCanal,
  rotuloClasse,
  type PdiDemandaRow,
} from "@/lib/pdi";

export default function PdiDemanda() {
  const qc = useQueryClient();
  const [tipoRegistro, setTipoRegistro] = useState<string>("acionamento");
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
      toast.error(
        tipoRegistro === "acionamento"
          ? "Faltou: quem acionou, o que pediu ou a classe de causa."
          : "Faltou: o que você executou, o motivo ou a classe de causa.",
      );
      return;
    }
    setSalvando(true);
    const { error } = await supabase!.from("pdi_demanda_log").insert({
      tipo_registro: tipoRegistro, ator: ator.trim(), pedido: pedido.trim(),
      canal, tempo_min: tempo, classe_causa: classe,
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

  const LinhaEscolha = ({ rotulo, children }: { rotulo: string; children: React.ReactNode }) => (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-14 shrink-0 font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
        {rotulo}
      </span>
      {children}
    </div>
  );

  return (
    <div className="mx-auto max-w-[880px] space-y-5">
      {/* momento 1 — captura no calor */}
      <Cartao spineSal>
        <div className="flex items-baseline justify-between">
          <Rotulo>Captura rápida</Rotulo>
          <span className="font-mono text-[10px] text-ink-mute">data preenche sozinha · meta 20s</span>
        </div>
        <div className="mt-3 space-y-2.5">
          <LinhaEscolha rotulo="registro">
            {PDI_TIPOS_REGISTRO.map((t) => (
              <Escolha key={t.v} ativo={tipoRegistro === t.v} onClick={() => setTipoRegistro(t.v)}>
                {t.l}
              </Escolha>
            ))}
          </LinhaEscolha>
          <div className="grid gap-2 md:grid-cols-2">
            <div>
              <Input list="pdi-atores"
                placeholder={tipoRegistro === "acionamento" ? "Quem acionou (pessoa/área)" : "O que você executou"}
                value={ator} onChange={(e) => setAtor(e.target.value)} />
              <datalist id="pdi-atores">
                {atoresRecentes.map((a) => <option key={a} value={a} />)}
              </datalist>
            </div>
            <Input
              placeholder={tipoRegistro === "acionamento" ? "O que pediu (curto)" : "Por que caiu em você (curto)"}
              value={pedido} onChange={(e) => setPedido(e.target.value)} />
          </div>
          <LinhaEscolha rotulo="canal">
            {PDI_CANAIS.map((c) => (
              <Escolha key={c.v} ativo={canal === c.v} onClick={() => setCanal(c.v)}>{c.l}</Escolha>
            ))}
          </LinhaEscolha>
          <LinhaEscolha rotulo="tempo">
            {PDI_TEMPOS_MIN.map((t) => (
              <Escolha key={t} ativo={tempo === t} onClick={() => setTempo(t)}>{t === 60 ? "60+ min" : `${t} min`}</Escolha>
            ))}
          </LinhaEscolha>
          <LinhaEscolha rotulo="causa">
            {PDI_CLASSES_CAUSA.map((c) => (
              <Escolha key={c.v} ativo={classe === c.v} onClick={() => setClasse(c.v)}>{c.l}</Escolha>
            ))}
          </LinhaEscolha>
        </div>
        <div className="mt-4">
          <BotaoSal onClick={registrar} disabled={salvando}>Registrar</BotaoSal>
        </div>
      </Cartao>

      {/* momento 2 — fila de endereçamento */}
      <Cartao>
        <div className="flex items-baseline justify-between">
          <Rotulo>Endereçamento — ritual semanal</Rotulo>
          <span className={`font-mono text-[12px] font-bold tabular ${pendentes.length > 0 ? "text-signal" : "text-positive"}`}>
            {pendentes.length}
          </span>
        </div>
        {pendentes.length === 0 ? (
          <p className="mt-3 text-center text-[13px] text-ink-mute">✦ Fila zerada — tudo endereçado.</p>
        ) : (
          <ul className="mt-3 space-y-2.5">
            {pendentes.map((r) => (
              <li key={r.id} className="ticket-card border-l-2 border-l-sal p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <ChipCodigo>
                    {new Date(r.criado_em).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}
                  </ChipCodigo>
                  <Chip tone={r.tipo_registro === "acao_executada" ? "warning" : "crit"}>
                    {r.tipo_registro === "acao_executada" ? "Execução" : "Acionamento"}
                  </Chip>
                  <Chip tone="neutral">{rotuloCanal(r.canal)}</Chip>
                  <Chip tone="neutral">{r.tempo_min} min</Chip>
                  <Chip tone="neutral">{rotuloClasse(r.classe_causa)}</Chip>
                </div>
                <div className="mt-1.5 text-[14px] font-semibold leading-snug text-ink-2">{r.ator}</div>
                <div className="text-[13px] text-ink-soft">{r.pedido}</div>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  {PDI_DESTINOS.map((d) => (
                    <Escolha key={d.v} ativo={destinoEscolhido[r.id] === d.v}
                      onClick={() => setDestinoEscolhido((m) => ({ ...m, [r.id]: d.v }))}>
                      {d.l}
                    </Escolha>
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
                  <div className="mt-2">
                    <BotaoSal onClick={() => void enderecar(r)}>Confirmar destino</BotaoSal>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Cartao>

      {/* indicadores — o que o Caio mede */}
      <Cartao>
        <Rotulo>Indicadores por semana</Rotulo>
        <p className="mt-1 text-[12px] text-ink-mute">
          Sucesso da Frente 1 = "conhecimento" e "processo" caindo semana a semana.
        </p>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-rule text-left font-mono text-[9.5px] uppercase tracking-[0.1em] text-ink-mute">
                <th className="py-1.5 pr-3">Semana de</th>
                <th className="py-1.5 pr-3 text-right">Acion.</th>
                <th className="py-1.5 pr-3 text-right">Tempo</th>
                <th className="py-1.5 pr-3">Mix por classe</th>
                <th className="py-1.5 text-right">Sem destino</th>
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
                    {s.pendentes > 0 ? <span className="font-bold text-signal">{s.pendentes}</span> : "0"}
                  </td>
                </tr>
              ))}
              {semanas.length === 0 && (
                <tr><td colSpan={5} className="py-4 text-center text-ink-mute">✦ Sem registros ainda — a primeira captura inaugura o mapa.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Cartao>
    </div>
  );
}
