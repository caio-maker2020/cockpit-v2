// =============================================================================
// ModalSemEmailSegregacao — o "painel do gêmeo sem e-mail" (Carlos 2026-10-06,
// Larissa/PRATI — ADR 0033 emendado, item (a)).
//
// A linha "🚫 SEM E-MAIL" aprovava num window.confirm. Para cliente que pode
// segregar (hoje só PRATI) e oc 54/59, ela passa a abrir ESTE painel: o mesmo
// aviso do confirm ("o cliente NÃO será notificado"), o CT-e do card À VISTA e
// a caixa "Segregar CTRC". Era o caminho que o próprio ADR 0033 deixou escrito:
// "dar painel ao gêmeo, não dar segregação ao confirm" — barrar carga é
// irreversível pelo Cockpit (retirada manual, opção 091) e não se decide num
// diálogo nativo do navegador, sem ver o CTRC.
//
// Demais clientes/ocs: este painel NÃO aparece — a linha segue no window.confirm
// de sempre. Quem decide se a segregação vale de verdade é o executor
// (segregacao-ctrc.ts): a tela só mostra.
// =============================================================================

import { useState } from "react";

export const TEXTO_CAIXA_SEGREGAR = "Segregar o CT-e no SSW junto com esta ocorrencia";

export function ModalSemEmailSegregacao({
  codigo,
  nf,
  ctrc,
  submitting,
  onClose,
  onConfirm,
}: {
  codigo: number;
  nf: string | null;
  ctrc: string | null;
  submitting: boolean;
  onClose: () => void;
  /** `segregar` é SEMPRE booleano (desmarcada = false), nunca omitido. */
  onConfirm: (segregar: boolean) => void;
}) {
  // Nasce DESMARCADA: segregar é escolha ativa da operadora, nunca padrão.
  const [segregar, setSegregar] = useState(false);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Lançar oc ${codigo} sem e-mail`}
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto border border-ink/20 bg-paper shadow-xl">
        <div className="flex items-center justify-between border-b border-ink/10 bg-amber-50 px-4 py-2.5">
          <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-amber-900">
            Lançar oc {codigo} — SEM e-mail
          </span>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Fechar"
            className="font-mono text-[12px] text-ink-soft hover:text-ink disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        <div className="space-y-3 px-4 py-3">
          {/* O MESMO aviso do window.confirm desta linha — nada some ao trocar de UI. */}
          <p className="text-[12px] leading-snug text-ink">
            Esta ação lança a oc {codigo} no SSW mas NÃO envia e-mail. O cliente NÃO será
            notificado.
          </p>

          <div className="border border-ink/15 bg-ink/[0.02] px-3 py-2 font-mono text-[11px] text-ink">
            <span className="text-ink-soft">CT-e do card: </span>
            <span className="font-semibold" data-testid="ctrc-do-card">{ctrc ?? "—"}</span>
            {nf && (
              <>
                <span className="text-ink-soft"> · NF </span>
                <span>{nf}</span>
              </>
            )}
          </div>

          <label className="flex cursor-pointer items-start gap-2 border-2 border-amber-400 bg-amber-50 px-2.5 py-2">
            <input
              type="checkbox"
              checked={segregar}
              onChange={(e) => setSegregar(e.target.checked)}
              disabled={submitting}
              className="mt-0.5 h-3.5 w-3.5 accent-amber-600"
            />
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[10px] font-bold uppercase tracking-wider text-amber-900">
                {TEXTO_CAIXA_SEGREGAR}
              </div>
              <div className="mt-0.5 font-mono text-[9px] leading-snug text-amber-900/80">
                Bloqueia a carga: nao segue, nao e romaneada e nao e entregue. Sai no
                mesmo lancamento da ocorrencia. A retirada da segregacao e manual no SSW
                (opcao 091) — o Cockpit nao desfaz. Fica registrado em auditoria.
              </div>
            </div>
          </label>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="border border-ink/30 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink disabled:opacity-40"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => onConfirm(segregar === true)}
              disabled={submitting}
              className="bg-ink px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-paper disabled:opacity-40"
            >
              {submitting ? "Lançando…" : "Confirmar lançamento sem e-mail"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
