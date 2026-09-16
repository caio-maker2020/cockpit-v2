// =============================================================================
// PdiIsadora — Plano de Desenvolvimento da Isadora (Caio 16/09, mig 399).
// Visível SÓ pra Isadora e Caio (gate por e-mail + RLS no banco). A Isadora
// mantém todas as visões normais do Cockpit; isto é uma aba a mais.
// =============================================================================
import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { ehParticipantePdi } from "@/lib/pdi";
import PdiVisaoGeral from "@/components/pdi/PdiVisaoGeral";
import PdiDemanda from "@/components/pdi/PdiDemanda";
import PdiKanban from "@/components/pdi/PdiKanban";
import Pdi1a1 from "@/components/pdi/Pdi1a1";

const ABAS = [
  { v: "frentes", l: "Visão geral" },
  { v: "demanda", l: "Mapa de Demanda" },
  { v: "kanban", l: "Kanban" },
  { v: "umaum", l: "1:1" },
] as const;
type Aba = (typeof ABAS)[number]["v"];

export default function PdiIsadora() {
  const { user, loading } = useAuth();
  const [aba, setAba] = useState<Aba>("frentes");

  if (!loading && !ehParticipantePdi(user?.email)) {
    return <Navigate to="/inbox" replace />;
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-rule px-7 pb-4 pt-5">
        <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
          Desenvolvimento de liderança
        </div>
        <h1 className="mt-1 text-[30px] font-semibold text-ink-2">
          Plano de Desenvolvimento — Isadora
        </h1>
        <nav className="mt-3 flex flex-wrap gap-2">
          {ABAS.map((a) => (
            <button
              key={a.v}
              onClick={() => setAba(a.v)}
              className={`rounded-full border px-4 py-1.5 text-[13px] font-medium transition ${
                aba === a.v
                  ? "border-ink bg-ink text-white"
                  : "border-rule bg-paper text-ink-mute hover:border-ink/40"
              }`}
            >
              {a.l}
            </button>
          ))}
        </nav>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto bg-paper p-6">
        {aba === "frentes" && <PdiVisaoGeral onIrParaDemanda={() => setAba("demanda")} />}
        {aba === "demanda" && <PdiDemanda />}
        {aba === "kanban" && <PdiKanban />}
        {aba === "umaum" && <Pdi1a1 />}
      </div>
    </div>
  );
}
