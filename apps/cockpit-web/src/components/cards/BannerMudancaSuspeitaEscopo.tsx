import { useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";

import { ModalForcarAtualizacao } from "./ModalForcarAtualizacao";
import { useModoFoco } from "@/hooks/useModoFoco";

interface MudancaSuspeita {
  tipo?: string;
  de_oc?: number | null;
  para_oc?: number | null;
  vista_em?: string | null;
}

interface Props {
  cardId: string;
  mudanca: MudancaSuspeita | null | undefined;
}

function scrollToHistorico() {
  const el = document.getElementById("historico-ssw");
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const candidates = Array.from(document.querySelectorAll("h2,h3,[role=tab]"));
  const alvo = candidates.find((n) =>
    (n.textContent ?? "").toLowerCase().includes("ssw"),
  );
  alvo?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function BannerMudancaSuspeitaEscopo({ cardId, mudanca }: Props) {
  const [modalOpen, setModalOpen] = useState(false);
  const [modoFoco] = useModoFoco();
  // Override só dentro deste card: null = segue Modo Foco global
  const [overrideExpanded, setOverrideExpanded] = useState<boolean | null>(null);
  // Quando Modo Foco global muda, descarta o override pra seguir a preferência
  useEffect(() => {
    setOverrideExpanded(null);
  }, [modoFoco]);

  if (!mudanca || mudanca.tipo !== "saiu_de_escopo" || mudanca.vista_em) return null;

  const collapsed = overrideExpanded == null ? modoFoco : !overrideExpanded;

  if (collapsed) {
    return (
      <>
        <div className="mx-6 mt-3 flex items-center gap-3 border-l-[3px] border-sal bg-sal/10 px-3 py-2">
          <AlertTriangle className="h-4 w-4 shrink-0 text-sal" />
          <div className="min-w-0 flex-1 truncate font-mono text-[11px] uppercase tracking-wider text-ink">
            <strong>⚠ oc {mudanca.de_oc ?? "—"} → {mudanca.para_oc ?? "—"}</strong>
            <span className="ml-2 text-ink-mute">· não-relacionamento</span>
          </div>
          <button
            type="button"
            onClick={scrollToHistorico}
            className="border border-ink/30 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink hover:border-ink"
          >
            Histórico
          </button>
          <button
            type="button"
            aria-label="Expandir alerta de conflito"
            onClick={() => setOverrideExpanded(true)}
            className="text-ink-mute hover:text-ink"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>
        <ModalForcarAtualizacao cardId={cardId} open={modalOpen} onOpenChange={setModalOpen} />
      </>
    );
  }

  return (
    <>
      <div className="mx-6 mt-3 border-2 border-sal bg-sal/10 px-4 py-3">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-sal" />
          <div className="flex-1">
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-display text-[15px] font-semibold uppercase tracking-wider text-sal-deep">
                ⚠️ Última ocorrência se alterou na última atualização
              </h3>
              <button
                type="button"
                aria-label="Recolher alerta de conflito"
                onClick={() => setOverrideExpanded(false)}
                className="shrink-0 text-ink-mute hover:text-ink"
              >
                <ChevronUp className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink">
              A ocorrência deste card mudou de{" "}
              <strong className="font-mono">oc {mudanca.de_oc ?? "—"}</strong> →{" "}
              <strong className="font-mono">oc {mudanca.para_oc ?? "—"}</strong>.
              Essa nova ocorrência <strong>não é de relacionamento</strong>.
              Verifique o histórico e decida.
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={scrollToHistorico}
                className="border-2 border-ink bg-paper px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink hover:bg-paper-deep"
              >
                Ver histórico SSW
              </button>
              <button
                type="button"
                onClick={() => setModalOpen(true)}
                className="border-2 border-ink bg-sal px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-paper hover:bg-sal-deep"
              >
                ↻ Forçar atualização
              </button>
            </div>
          </div>
        </div>
      </div>

      <ModalForcarAtualizacao
        cardId={cardId}
        open={modalOpen}
        onOpenChange={setModalOpen}
      />
    </>
  );
}
