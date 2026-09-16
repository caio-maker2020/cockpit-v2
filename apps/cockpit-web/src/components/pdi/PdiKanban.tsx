// =============================================================================
// PdiKanban — o quadro de demandas da Isadora.
// Colunas: A FAZER → FAZENDO → ENTREGUE → VALIDADO PELO CAIO.
// Isadora move até "entregue"; o carimbo final é do Caio (RPC pdi_validar_todo).
// Cards nascem de: entregas, compromissos de 1:1, demandas endereçadas, manual.
// =============================================================================
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { CockpitBoard, CockpitColumn } from "@/components/cockpit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
            <div key={t.id} className="rounded-md border border-rule bg-paper p-3 shadow-sm">
              <div className="text-[13.5px] font-semibold leading-snug text-ink-2">{t.titulo}</div>
              {t.detalhe && <p className="mt-1 text-[12px] text-ink-mute">{t.detalhe}</p>}
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] uppercase text-ink-mute">
                  {ORIGEM_ROTULO[t.origem] ?? t.origem}
                  {t.prazo && (
                    <span className={atrasado ? "ml-2 font-semibold text-signal" : "ml-2"}>
                      · {t.prazo.slice(8, 10)}/{t.prazo.slice(5, 7)}{atrasado ? " ATRASADO" : ""}
                    </span>
                  )}
                </span>
                <div className="flex gap-1">{acoes(t)}</div>
              </div>
            </div>
          );
        })}
      </CockpitColumn>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-1 pb-3">
        <p className="text-[12.5px] text-ink-mute">
          Cards nascem das entregas, dos compromissos de 1:1 e das demandas endereçadas — ou manualmente.
        </p>
        <Button size="sm" variant="outline" onClick={() => setNovo((v) => !v)}>+ novo card</Button>
      </div>
      {novo && (
        <div className="mb-3 space-y-2 rounded-md border border-rule bg-paper p-3">
          <Input placeholder="Título" value={titulo} onChange={(e) => setTitulo(e.target.value)} />
          <Textarea rows={2} placeholder="Detalhe (opcional)" value={detalhe} onChange={(e) => setDetalhe(e.target.value)} />
          <div className="flex items-center gap-2">
            <Input type="date" className="max-w-[180px]" value={prazo} onChange={(e) => setPrazo(e.target.value)} />
            <Button size="sm" onClick={criar}>Criar</Button>
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <CockpitBoard>
          <Coluna status="a_fazer" title="A FAZER" tone="slate"
            acoes={(t) => <Button size="sm" variant="ghost" onClick={() => void mover(t.id, "fazendo")}>começar →</Button>} />
          <Coluna status="fazendo" title="FAZENDO" tone="sky"
            acoes={(t) => (
              <>
                <Button size="sm" variant="ghost" onClick={() => void mover(t.id, "a_fazer")}>←</Button>
                <Button size="sm" variant="ghost" onClick={() => void mover(t.id, "entregue")}>entregar →</Button>
              </>
            )} />
          <Coluna status="entregue" title="ENTREGUE" tone="amber"
            acoes={(t) => (
              <>
                <Button size="sm" variant="ghost" onClick={() => void mover(t.id, "fazendo")}>←</Button>
                {caio && <Button size="sm" onClick={() => void validar(t.id)}>validar ✓</Button>}
              </>
            )} />
          <Coluna status="validado" title="VALIDADO PELO CAIO" tone="emerald" acoes={() => null} />
        </CockpitBoard>
      </div>
    </div>
  );
}
