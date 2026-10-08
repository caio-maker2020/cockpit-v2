// =============================================================================
// A confirmação do lançamento (ADR 0041 D7; INV-041/053/185: nunca às cegas).
// Mostra EXATAMENTE o que a prévia do servidor devolveu — CTRC, NF, código,
// descrição, texto que vai na Instrução do SSW e a conta — e só aí oferece o
// botão. O token da prévia vai junto; se algo mudou, o servidor recusa
// (`previa_desatualizada`) e esta janela mostra a prévia NOVA para conferir de novo.
// =============================================================================
import { AlertTriangle, Loader2, Send } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { OpPrevia } from "@/lib/operacao/tipos";

function Linha({ rotulo, children, mono = true }: { rotulo: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[124px,1fr] gap-3 border-b border-rule py-2 last:border-b-0">
      <dt className="text-[12px] text-ink-mute">{rotulo}</dt>
      <dd className={mono ? "tabular break-words text-[13.5px] font-medium text-ink-2" : "break-words text-[13.5px] text-ink-2"}>{children}</dd>
    </div>
  );
}

export function DialogoPreviaLancamento({
  aberto,
  previa,
  origem,
  aviso,
  erro,
  enviando,
  onConfirmar,
  onFechar,
}: {
  aberto: boolean;
  previa: OpPrevia | null;
  origem: "manual" | "sugestao";
  /** Ex.: a prévia mudou; confira de novo. */
  aviso: string | null;
  /** Falha que impede confirmar (o botão some). */
  erro: string | null;
  enviando: boolean;
  onConfirmar: () => void;
  onFechar: () => void;
}) {
  return (
    <Dialog open={aberto} onOpenChange={(o) => !o && !enviando && onFechar()}>
      <DialogContent
        className="max-w-[560px] rounded-[16px]"
        onKeyDown={(e) => {
          // Atalho: "c" confirma (nunca dentro de um campo de texto).
          if (e.key === "c" && !e.metaKey && !e.ctrlKey && !(e.target as HTMLElement).closest("input, textarea") && !erro && previa && !enviando) {
            e.preventDefault();
            onConfirmar();
          }
        }}
      >
        <DialogHeader>
          <div className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-ink-mute">Você confirma</div>
          <DialogTitle className="text-[19px]">Confira o que vai para o SSW</DialogTitle>
          <DialogDescription>
            {origem === "sugestao" ? "Você está aceitando a sugestão da torre. " : ""}
            Ao confirmar, o pedido entra na fila de lançamento e a conta de serviço lança exatamente isto no SSW.
          </DialogDescription>
        </DialogHeader>

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
          <dl data-testid="previa-lancamento" className="rounded-[12px] border border-rule bg-[var(--bg-subtle)] px-4 py-1">
            <Linha rotulo="Ocorrência" mono={false}>
              <span className="font-semibold">oc {previa.codigo_oc}</span> · {previa.descricao_oc}
            </Linha>
            <Linha rotulo="Texto no SSW" mono={false}>
              <span className="whitespace-pre-wrap">{previa.texto_ssw}</span>
            </Linha>
            <Linha rotulo="NF">{previa.nf ?? "—"}</Linha>
            <Linha rotulo="CTRC">{previa.ctrc}</Linha>
            <Linha rotulo="Ocorrência atual">{previa.oc_atual ?? "—"}</Linha>
            <Linha rotulo="Filial">{previa.unidade ?? "sem filial"}</Linha>
            <Linha rotulo="Conta no SSW">{previa.conta_ssw}</Linha>
          </dl>
        )}

        {erro && (
          <div
            role="alert"
            className="rounded-md border px-3 py-2 text-[12.5px]"
            style={{ background: "var(--signal-soft)", borderColor: "var(--signal-border)", color: "var(--signal-strong)" }}
          >
            {erro}
          </div>
        )}

        <p className="text-[11.5px] text-ink-mute">
          Atalhos: <kbd className="rounded border border-rule px-1">c</kbd> confirma · <kbd className="rounded border border-rule px-1">Esc</kbd> volta sem gravar.
        </p>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onFechar} disabled={enviando}>
            Voltar
          </Button>
          {!erro && previa && (
            <Button onClick={onConfirmar} disabled={enviando} className="bg-sal text-white hover:bg-sal/90">
              {enviando ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              Confirmar e lançar oc {previa.codigo_oc}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
