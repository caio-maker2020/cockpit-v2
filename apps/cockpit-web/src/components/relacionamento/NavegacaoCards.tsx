// "3 de 90 ‹ ›" no card aberto: a mesma fila que o Inbox mostrava, na ordem do fluxo
// (sessionStorage gravado pelo Inbox ao abrir o card). Atalhos j/k fora de campos e janelas.
// Sem a ordem (card aberto por link direto), não aparece nada: o card fica como sempre.
import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { CHAVE_ORDEM_CARDS } from "@/lib/relacionamento/torre";

function lerOrdem(): string[] {
  try {
    const v = JSON.parse(window.sessionStorage.getItem(CHAVE_ORDEM_CARDS) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function NavegacaoCards({ cardId }: { cardId: string }) {
  const navigate = useNavigate();
  const ordem = useMemo(() => lerOrdem(), []);
  const i = ordem.indexOf(cardId);
  const ant = i > 0 ? ordem[i - 1]! : null;
  const prox = i >= 0 && i < ordem.length - 1 ? ordem[i + 1]! : null;

  useEffect(() => {
    if (i < 0) return;
    const h = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const alvo = e.target as HTMLElement | null;
      if (alvo?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector("[role='dialog'], [role='alertdialog']")) return;
      if (e.key === "j" && prox) navigate(`/cards/${prox}`);
      else if (e.key === "k" && ant) navigate(`/cards/${ant}`);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [i, ant, prox, navigate]);

  if (i < 0) return null;
  const botao = "grid h-7 w-7 place-items-center rounded-[8px] text-ink-soft-2 hover:bg-[var(--bg-subtle)] disabled:opacity-30";
  return (
    <span className="inline-flex items-center gap-0.5" data-testid="navegacao-cards">
      <span className="tabular mr-1 text-[12px] text-ink-mute">
        {i + 1} de {ordem.length}
      </span>
      <button type="button" className={botao} disabled={!ant} onClick={() => ant && navigate(`/cards/${ant}`)} aria-label="Card anterior (k)">
        <ChevronLeft className="h-4 w-4" />
      </button>
      <button type="button" className={botao} disabled={!prox} onClick={() => prox && navigate(`/cards/${prox}`)} aria-label="Próximo card (j)">
        <ChevronRight className="h-4 w-4" />
      </button>
    </span>
  );
}
