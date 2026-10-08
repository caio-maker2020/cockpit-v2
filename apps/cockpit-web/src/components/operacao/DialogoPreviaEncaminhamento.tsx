// =============================================================================
// Confirmação do ENCAMINHAMENTO ao Relacionamento (ADR 0041 D11). Mostra o
// destino, o texto e o texto EXATO da 49 que vai ao SSW; só então o botão.
// O token da prévia vai junto; se algo mudou, a janela mostra a prévia nova.
// =============================================================================
import { AlertTriangle, Forward, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { OpPreviaEncaminhamento } from "@/lib/operacao/tipos";

function Linha({ rotulo, children, mono = true }: { rotulo: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[120px,1fr] gap-3 border-b border-rule py-2 last:border-b-0">
      <dt className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-mute">{rotulo}</dt>
      <dd className={mono ? "break-words font-mono text-[13px] text-ink-2" : "break-words text-[13px] text-ink-2"}>{children}</dd>
    </div>
  );
}

export function DialogoPreviaEncaminhamento({
  aberto,
  previa,
  aviso,
  erro,
  enviando,
  onConfirmar,
  onFechar,
}: {
  aberto: boolean;
  previa: OpPreviaEncaminhamento | null;
  aviso: string | null;
  erro: string | null;
  enviando: boolean;
  onConfirmar: () => void;
  onFechar: () => void;
}) {
  // Sem `modo` (mig 436) = real. Mig 438: padrão 'espelho' — nada vai ao Relacionamento real.
  const espelho = previa?.modo === "espelho";
  return (
    <Dialog open={aberto} onOpenChange={(o) => !o && !enviando && onFechar()}>
      <DialogContent className="max-w-[580px]">
        <DialogHeader>
          <DialogTitle>{espelho ? "Encaminhar ao ESPELHO do Relacionamento" : "Encaminhar ao Relacionamento"}</DialogTitle>
          <DialogDescription>
            {espelho
              ? "A nota sai da fila da Operação e fica registrada no espelho. Não vira card no Relacionamento e a 49 não vai ao SSW."
              : "A nota sai da fila da Operação e vira card no Cockpit do Relacionamento. Confira o texto da 49 que vai ao SSW."}
          </DialogDescription>
        </DialogHeader>

        {espelho && (
          <div
            data-testid="destino-espelho"
            className="rounded-md border-2 px-3 py-2 text-[13px] font-semibold"
            style={{ borderColor: "#6D28D9", background: "rgba(109,40,217,0.08)", color: "#5B21B6" }}
          >
            Destino: ESPELHO do Relacionamento (não chega ao Cockpit real)
          </div>
        )}

        {aviso && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-md border px-3 py-2 text-[12.5px]"
            style={{ background: "var(--warning-soft)", borderColor: "var(--warning)", color: "var(--c-ink)" }}
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--warning)" }} aria-hidden />
            {aviso}
          </div>
        )}

        {previa && (
          <dl data-testid="previa-encaminhamento" className="rounded-lg border border-rule px-4 py-1">
            <Linha rotulo="CTRC">{previa.ctrc}</Linha>
            <Linha rotulo="NF">{previa.nf ?? "—"}</Linha>
            <Linha rotulo="Oc atual">{previa.oc_atual ?? "—"}</Linha>
            <Linha rotulo="Destino" mono={false}>
              {previa.destino}
            </Linha>
            <Linha rotulo={espelho ? `Texto da ${previa.codigo_oc_ssw} (não vai ao SSW)` : `Texto da ${previa.codigo_oc_ssw}`} mono={false}>
              <span className="whitespace-pre-wrap">{previa.texto_ssw_49}</span>
            </Linha>
            <Linha rotulo="Unidade">{previa.unidade ?? "sem unidade"}</Linha>
          </dl>
        )}
        {previa?.observacao && <p className="text-[11.5px] text-ink-mute">{previa.observacao}</p>}

        {erro && (
          <div
            role="alert"
            className="rounded-md border px-3 py-2 text-[12.5px]"
            style={{ background: "var(--signal-soft)", borderColor: "var(--signal-border)", color: "var(--signal-strong)" }}
          >
            {erro}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onFechar} disabled={enviando}>
            Voltar
          </Button>
          {!erro && previa && (
            <Button onClick={onConfirmar} disabled={enviando} style={{ background: espelho ? "#6D28D9" : "#2F6BC4", color: "#fff" }}>
              {enviando ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Forward className="mr-2 h-4 w-4" />}
              {espelho ? "Confirmar e enviar ao espelho" : "Confirmar e encaminhar"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
