// =============================================================================
// PdiKanban — o quadro de demandas da Isadora, no MESMO idioma do kanban do
// Inbox (CockpitBoard/Column com pílula colorida + ticket-card).
// Colunas: A FAZER → FAZENDO → ENTREGUE → VALIDADO PELO CAIO.
// Isadora move até "entregue"; o carimbo final é do Caio (RPC pdi_validar_todo).
// =============================================================================
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { CockpitBoard, CockpitColumn } from "@/components/cockpit";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { BotaoLinha, BotaoSal, ChipCodigo } from "./pdi-ui";
import { ehCaioPdi, type PdiTodoRow } from "@/lib/pdi";

const ORIGEM_ROTULO: Record<string, string> = {
  entrega: "entrega",
  compromisso_1a1: "1:1",
  demanda: "demanda",
  manual: "manual",
};

export default function PdiKanban() {
  const { user } = useAuth();
  const caio = ehCaioPdi(user?.email);
  const qc = useQueryClient();
  const [novo, setNovo] = useState(false);
  const [titulo, setTitulo] = useState("");
  const [detalhe, setDetalhe] = useState("");
  const [prazo, setPrazo] = useState("");

  const { data: todos = [] } = useQuery({
    queryKey: ["pdi-todos"],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!.from("pdi_todos").select("*")
        .order("prazo", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as PdiTodoRow[];
    },
  });

  const recarregar = () => void qc.invalidateQueries({ queryKey: ["pdi-todos"] });
  const mover = async (id: string, status: string) => {
    const { error } = await supabase!.from("pdi_todos")
      .update({ status, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) { toast.error(error.message); return; }
    recarregar();
  };
  const validar = async (id: string) => {
    const { error } = await supabase!.rpc("pdi_validar_todo", { p_id: id });
    if (error) { toast.error(error.message); return; }
    toast.success("Validado.");
    recarregar();
  };
  const criar = async () => {
    if (!titulo.trim()) return;
    const { error } = await supabase!.from("pdi_todos")
      .insert({ titulo, detalhe: detalhe || null, prazo: prazo || null, origem: "manual" });
    if (error) { toast.error(error.message); return; }
    setNovo(false); setTitulo(""); setDetalhe(""); setPrazo("");
    recarregar();
  };

  const hoje = new Date().toISOString().slice(0, 10);

  const BotaoMini = ({ onClick, children, sal }: {
    onClick: () => void; children: React.ReactNode; sal?: boolean;
  }) => (
    <button
      type="button"
      onClick={onClick}
      className={
        sal
          ? "rounded-[6px] bg-sal px-2 py-1 font-mono text-[9.5px] font-semibold uppercase tracking-wider text-paper transition-colors hover:bg-ink"
          : "rounded-[6px] border border-rule px-2 py-1 font-mono text-[9.5px] font-semibold uppercase tracking-wider text-ink-soft transition-colors hover:border-ink hover:text-ink"
      }
    >
      {children}
    </button>
  );

  const Coluna = ({ status, title, tone, acoes }: {
    status: string; title: string; tone: "slate" | "sky" | "amber" | "emerald";
    acoes: (t: PdiTodoRow) => React.ReactNode;
  }) => {
    const itens = todos.filter((t) => t.status === status);
    return (
      <CockpitColumn tone={tone} title={title} count={itens.length}>
        {itens.map((t) => {
          const atrasado = t.prazo != null && t.prazo < hoje && status !== "validado";
          return (
            <article key={t.id} className={`ticket-card border-l-2 p-3 ${atrasado ? "border-l-sal" : "border-l-transparent"}`}>
              <div className="text-[13.5px] font-semibold leading-snug text-ink-2">{t.titulo}</div>
              {t.detalhe && <p className="mt-1 text-[12px] leading-snug text-ink-mute">{t.detalhe}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <ChipCodigo>{ORIGEM_ROTULO[t.origem] ?? t.origem}</ChipCodigo>
                {t.prazo && (
                  <ChipCodigo>
                    <span className={atrasado ? "text-signal" : undefined}>
                      {t.prazo.slice(8, 10)}/{t.prazo.slice(5, 7)}{atrasado ? " · ATRASADO" : ""}
                    </span>
                  </ChipCodigo>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">{acoes(t)}</div>
            </article>
          );
        })}
      </CockpitColumn>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-1 pb-3">
        <p className="text-[12.5px] text-ink-mute">
          Cards nascem das entregas, dos compromissos de 1:1 e das demandas endereçadas.
        </p>
        <BotaoLinha onClick={() => setNovo((v) => !v)}>+ novo card</BotaoLinha>
      </div>
      {novo && (
        <div className="ticket-card mb-3 space-y-2 p-3">
          <Input placeholder="Título" value={titulo} onChange={(e) => setTitulo(e.target.value)} />
          <Textarea rows={2} placeholder="Detalhe (opcional)" value={detalhe} onChange={(e) => setDetalhe(e.target.value)} />
          <div className="flex items-center gap-2">
            <Input type="date" className="max-w-[180px]" value={prazo} onChange={(e) => setPrazo(e.target.value)} />
            <BotaoSal onClick={criar}>Criar</BotaoSal>
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <CockpitBoard>
          <Coluna status="a_fazer" title="Para fazer" tone="slate"
            acoes={(t) => <BotaoMini onClick={() => void mover(t.id, "fazendo")}>começar →</BotaoMini>} />
          <Coluna status="fazendo" title="Fazendo" tone="sky"
            acoes={(t) => (
              <>
                <BotaoMini onClick={() => void mover(t.id, "a_fazer")}>← voltar</BotaoMini>
                <BotaoMini sal onClick={() => void mover(t.id, "entregue")}>entregar →</BotaoMini>
              </>
            )} />
          <Coluna status="entregue" title="Entregue" tone="amber"
            acoes={(t) => (
              <>
                <BotaoMini onClick={() => void mover(t.id, "fazendo")}>← voltar</BotaoMini>
                {caio && <BotaoMini sal onClick={() => void validar(t.id)}>validar ✓</BotaoMini>}
              </>
            )} />
          <Coluna status="validado" title="Validado pelo Caio" tone="emerald" acoes={() => null} />
        </CockpitBoard>
      </div>
    </div>
  );
}
