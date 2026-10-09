// =============================================================================
// Seletor compacto Operação | Relacionamento no header — SÓ para gestor (quem vê
// as duas áreas). Atalhos: g o (Operação), g r (Relacionamento), g i (Início).
// Também lembra a última área usada, para o hub saber qual destacar.
// =============================================================================
import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { areaDaRota, gravarUltimaArea, ROTA_INICIO, type Area } from "@/lib/inicio/hub";
import { OPERACAO_DEMO_V3 } from "@/lib/operacao/modoDemo";

const HREF_REL_DEMO = OPERACAO_DEMO_V3 ? "/relacionamento-cockpit/" : null;

function digitando(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function SeletorArea({ veRelacionamento, veOperacao }: { veRelacionamento: boolean; veOperacao: boolean }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const atual = areaDaRota(pathname);

  useEffect(() => {
    if (atual) gravarUltimaArea(atual);
  }, [atual]);

  const ir = (a: Area | "inicio") => {
    if (a === "inicio") return navigate(ROTA_INICIO);
    if (a === "relacionamento" && HREF_REL_DEMO) {
      window.location.href = HREF_REL_DEMO;
      return;
    }
    gravarUltimaArea(a);
    navigate(a === "operacao" ? "/operacao" : "/inbox");
  };

  // "g" seguido de o / r / i em até 1,2 s, fora de campos de texto.
  const ultimoG = useRef(0);
  const irRef = useRef(ir);
  irRef.current = ir;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || digitando(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "g") {
        ultimoG.current = Date.now();
        return;
      }
      if (Date.now() - ultimoG.current > 1200) return;
      ultimoG.current = 0;
      if (k === "o" && veOperacao) irRef.current("operacao");
      else if (k === "r" && veRelacionamento) irRef.current("relacionamento");
      else if (k === "i") irRef.current("inicio");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [veOperacao, veRelacionamento]);

  if (!veOperacao || !veRelacionamento) return null;

  const opcoes: { id: Area; rotulo: string; tecla: string }[] = [
    { id: "operacao", rotulo: "Operação", tecla: "g o" },
    { id: "relacionamento", rotulo: "Relacionamento", tecla: "g r" },
  ];
  return (
    <nav aria-label="Área" className="flex shrink-0 items-center rounded-[20px] p-[3px]" style={{ background: "var(--bg-subtle)" }}>
      {opcoes.map((o) => {
        const ativo = atual === o.id;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => ir(o.id)}
            aria-current={ativo ? "page" : undefined}
            title={`${o.rotulo} (${o.tecla})`}
            className={cn(
              "rounded-[17px] px-3 py-[5px] text-[12px] font-semibold transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--signal)]",
              ativo ? "shadow-[0_1px_2px_rgba(27,36,48,.12)]" : "hover:text-[var(--c-ink)]",
            )}
            style={ativo ? { background: "var(--bg-elevated)", color: "var(--c-ink)" } : { color: "var(--c-ink-soft)" }}
          >
            <span className="sm:hidden">{o.id === "operacao" ? "Op." : "Rel."}</span>
            <span className="hidden sm:inline">{o.rotulo}</span>
          </button>
        );
      })}
    </nav>
  );
}
