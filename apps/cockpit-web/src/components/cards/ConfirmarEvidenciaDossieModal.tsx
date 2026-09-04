// =============================================================================
// ConfirmarEvidenciaDossieModal — a SAÍDA que faltava no gate da oc 33.
//
// Carlos/Caio 2026-09-04, âncora NF 632603 / DUILIO. O cliente ANEXOU o
// documento e escreveu "segue minuta"; a IA registrou por escrito "falta
// confirmação se o anexo PDF é o romaneio de coleta assinado". O documento
// estava no card — só não havia como um humano dizer que era ele.
//
// Este modal NÃO força nada: ele COMPLETA o dossiê. A parede da mig 365 fica
// intacta (INV-118) — o que muda é que agora existe um caminho legítimo, com
// autoria registrada (card_event EvidenciaDossieConfirmadaPeloOperador).
//
// O operador ABRE o anexo antes de confirmar (link assinado do storage) —
// confirmar às cegas seria trocar um problema por outro.
// =============================================================================
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { chavesFaltantes, type ChaveEvidencia } from "@/lib/gate-oc33";

interface AnexoInbound {
  id: string;
  message_inbox_id: string | null;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  storage_path: string | null;
}

const ROTULO: Record<ChaveEvidencia, string> = {
  romaneio: "Romaneio de coleta assinado",
  descricao: "Descrição dos itens",
  valor: "Valor dos itens",
};

const AJUDA: Record<ChaveEvidencia, string> = {
  romaneio: "É um DOCUMENTO — só conta com o anexo real que o cliente mandou. Abra e confira antes.",
  descricao: "Cole o trecho do e-mail do cliente que descreve os itens faltantes.",
  valor: "Cole o trecho do e-mail do cliente com o valor dos itens faltantes.",
};

export function ConfirmarEvidenciaDossieModal({
  cardId,
  nf,
  faltando,
  onFechar,
}: {
  cardId: string;
  nf: string | null;
  faltando: string[];
  onFechar: () => void;
}) {
  const qc = useQueryClient();
  const chaves = chavesFaltantes(faltando);
  const [chave, setChave] = useState<ChaveEvidencia>(chaves[0] ?? "romaneio");
  const [anexoSel, setAnexoSel] = useState<string | null>(null);
  const [texto, setTexto] = useState("");

  const { data: anexos = [], isLoading } = useQuery({
    queryKey: ["anexos-inbound-dossie", cardId],
    enabled: !!supabase,
    queryFn: async () => {
      const { data: msgs } = await supabase!
        .from("messages_inbox")
        .select("id")
        .eq("card_id", cardId);
      const ids = (msgs ?? []).map((m: any) => m.id);
      if (!ids.length) return [] as AnexoInbound[];
      const { data } = await supabase!
        .from("email_anexos")
        .select("id, message_inbox_id, filename, mime_type, size_bytes, storage_path")
        .in("message_inbox_id", ids)
        .eq("origem", "inbound");
      return (data ?? []) as AnexoInbound[];
    },
  });

  // Pré-seleciona o único anexo quando só existe um — sem "adivinhar" entre vários.
  useEffect(() => {
    if (chave === "romaneio" && anexos.length === 1 && anexoSel === null) {
      setAnexoSel(anexos[0]!.id);
    }
  }, [chave, anexos, anexoSel]);

  async function abrirAnexo(a: AnexoInbound) {
    if (!a.storage_path) {
      toast.error("Anexo sem arquivo no storage (pode ter sido apagado após o envio).");
      return;
    }
    const { data, error } = await supabase!.storage
      .from("email_anexos")
      .createSignedUrl(a.storage_path, 120);
    if (error || !data?.signedUrl) {
      toast.error("Não consegui abrir o anexo", { description: error?.message });
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  const confirmar = useMutation({
    mutationFn: async () => {
      const anexo = anexos.find((a) => a.id === anexoSel) ?? null;
      const params =
        chave === "romaneio"
          ? {
              p_card_id: cardId,
              p_tipo: chave,
              p_message_inbox_id: anexo?.message_inbox_id ?? null,
              p_filename: anexo?.filename ?? null,
              p_texto: null,
            }
          : {
              p_card_id: cardId,
              p_tipo: chave,
              p_message_inbox_id: null,
              p_filename: null,
              p_texto: texto.trim(),
            };
      const { data, error } = await supabase!.rpc("confirmar_evidencia_dossie" as never, params as never);
      if (error) throw error;
      return data as { dossie_completo?: boolean; faltando?: string[] };
    },
    onSuccess: (r) => {
      if (r?.dossie_completo) {
        toast.success("Dossiê completo — a oc 33 está liberada.");
      } else {
        const restante = (r?.faltando ?? []).join(", ");
        toast.success(`${ROTULO[chave]} confirmado.`, {
          description: restante ? `Ainda falta: ${restante}` : undefined,
        });
      }
      qc.invalidateQueries({ queryKey: ["todos-pendentes", cardId] });
      qc.invalidateQueries({ queryKey: ["card-events", cardId] });
      qc.invalidateQueries({ queryKey: ["cards"] });
      onFechar();
    },
    onError: (err: any) => {
      toast.error("Não consegui confirmar a evidência", {
        description: err?.message ?? "Tente novamente",
      });
    },
  });

  const podeConfirmar =
    chave === "romaneio" ? anexoSel !== null : texto.trim().length >= 3;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-[14px] border border-ink/20 bg-paper shadow-xl">
        <div className="border-b border-ink/10 px-5 py-4">
          <div className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
            completar dossiê — oc 33
          </div>
          <div className="mt-1 text-[15px] font-semibold text-ink">
            NF {nf ?? "?"} — falta: {faltando.join(", ")}
          </div>
          <div className="mt-1 font-display text-[12px] leading-snug text-ink/70">
            A oc 33 abre o processo de indenização. Ela só sai com romaneio, descrição e valor —
            essa regra não muda. Aqui você registra a evidência que o agente não conseguiu
            identificar sozinho, com o seu nome no evento.
          </div>
        </div>

        {chaves.length > 1 && (
          <div className="flex gap-1 border-b border-ink/10 px-5 py-2">
            {chaves.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setChave(c)}
                className={
                  "rounded-[8px] px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider " +
                  (c === chave ? "bg-ink text-paper" : "bg-ink/5 text-ink-soft hover:bg-ink/10")
                }
              >
                {ROTULO[c]}
              </button>
            ))}
          </div>
        )}

        <div className="px-5 py-4">
          <div className="mb-3 font-display text-[12px] leading-snug text-ink/70">{AJUDA[chave]}</div>

          {chave === "romaneio" ? (
            isLoading ? (
              <div className="py-6 text-center font-mono text-[11px] text-ink-soft">carregando anexos...</div>
            ) : anexos.length === 0 ? (
              <div className="rounded-[10px] border border-amber-300 bg-amber-50 px-3 py-3 font-display text-[12px] text-amber-900">
                Este card não tem nenhum anexo recebido do cliente. O romaneio é um documento —
                sem arquivo não há o que confirmar. Peça o romaneio ao cliente antes de lançar a oc 33.
              </div>
            ) : (
              <div className="divide-y divide-ink/10 rounded-[10px] border border-ink/15">
                {anexos.map((a) => (
                  <label
                    key={a.id}
                    className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-ink/[0.02]"
                  >
                    <input
                      type="radio"
                      name="anexo-romaneio"
                      checked={anexoSel === a.id}
                      onChange={() => setAnexoSel(a.id)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] text-ink">{a.filename}</div>
                      <div className="font-mono text-[10px] text-ink-soft">
                        {a.mime_type ?? "?"} · {Math.round((a.size_bytes ?? 0) / 1024)}KB
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        void abrirAnexo(a);
                      }}
                      className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-ink-soft underline-offset-2 hover:text-ink hover:underline"
                    >
                      abrir ↗
                    </button>
                  </label>
                ))}
              </div>
            )
          ) : (
            <textarea
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              rows={5}
              placeholder="Cole aqui o trecho exato do e-mail do cliente."
              className="w-full rounded-[10px] border border-ink/20 bg-surface px-3 py-2 text-[13px] text-ink"
            />
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-ink/10 px-5 py-3">
          <button
            type="button"
            onClick={onFechar}
            className="font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink"
          >
            cancelar
          </button>
          <button
            type="button"
            disabled={!podeConfirmar || confirmar.isPending}
            onClick={() => confirmar.mutate()}
            className="rounded-[8px] bg-[#2B9A40] px-4 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-white hover:bg-[#238636] disabled:opacity-40"
          >
            {confirmar.isPending ? "confirmando..." : "confirmar evidência →"}
          </button>
        </div>
      </div>
    </div>
  );
}
