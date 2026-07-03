import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/lib/supabase";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";

interface OcOption {
  codigo_ssw: number;
  descricao: string;
}

interface Props {
  cardId: string;
  nf: string | null;
  isOpen: boolean;
  onClose: () => void;
}

export function ModalLancarEmergencial({ cardId, nf, isOpen, onClose }: Props) {
  const qc = useQueryClient();
  const [ocs, setOcs] = useState<OcOption[]>([]);
  const [codigoSelecionado, setCodigoSelecionado] = useState<number | null>(null);
  const [textoDescricao, setTextoDescricao] = useState("");
  const [anexoId, setAnexoId] = useState<string | null>(null);
  const [anexoFilename, setAnexoFilename] = useState<string | null>(null);
  const [anexoSize, setAnexoSize] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !supabase) return;
    setCodigoSelecionado(null);
    setTextoDescricao("");
    setAnexoId(null);
    setAnexoFilename(null);
    setAnexoSize(null);
    setErro(null);
    supabase
      .from("ocorrencias_dicionario")
      .select("codigo_ssw:codigo, descricao")
      .order("codigo")
      .then(({ data }) => setOcs((data ?? []) as OcOption[]));
  }, [isOpen]);

  const ocExigeTexto = codigoSelecionado === 41;

  async function selecionarArquivo(file: File) {
    setErro(null);
    const mimesAceitos = ["image/jpeg", "image/jpg", "image/pjpeg", "application/pdf"];
    if (!mimesAceitos.includes(file.type)) {
      setErro("Apenas JPEG ou PDF são aceitos pelo SSW.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setErro("Arquivo maior que 10MB.");
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("card_id", cardId);
      const { data, error } = await supabase.functions.invoke("upload-anexo-email", {
        body: form,
      });
      if (error) throw new Error(error.message);
      if (!data?.ok) throw new Error(data?.error || "Falha no upload");
      setAnexoId(data.anexo_id);
      setAnexoFilename(data.filename ?? file.name);
      setAnexoSize(data.size_bytes ?? file.size);
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  function removerAnexo() {
    setAnexoId(null);
    setAnexoFilename(null);
    setAnexoSize(null);
  }

  async function lancar() {
    if (!supabase || !codigoSelecionado) return;
    if (ocExigeTexto && !textoDescricao.trim()) {
      setErro("Texto adicional é obrigatório para oc=41 (informação complementar).");
      return;
    }
    setLoading(true);
    setErro(null);
    const { error } = await supabase.rpc("lancar_oc_emergencial_acao_executada", {
      p_card_id: cardId,
      p_codigo_ssw: codigoSelecionado,
      p_texto_descricao: textoDescricao.trim() || null,
      p_anexo_id: anexoId,
    });
    setLoading(false);
    if (error) {
      setErro(error.message);
      return;
    }
    toast.success(`oc ${codigoSelecionado} lançada`);
    qc.invalidateQueries({ queryKey: ["card", cardId] });
    qc.invalidateQueries({ queryKey: ["cards"] });
    onClose();
  }

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-[18px]">
            Lançar oc emergencial — NF {nf ?? "—"}
          </DialogTitle>
          <DialogDescription className="border-l-2 border-yellow-500 bg-yellow-50 px-2 py-1.5 text-[12px] text-yellow-900">
            ⚠ Use com atenção — lançamento direto no SSW.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="font-mono text-[11px] uppercase tracking-widest">Ocorrência</Label>
            <Select
              value={codigoSelecionado?.toString() ?? ""}
              onValueChange={(v) => setCodigoSelecionado(Number(v) || null)}
            >
              <SelectTrigger>
                <SelectValue placeholder="— escolher —" />
              </SelectTrigger>
              <SelectContent>
                {ocs.map((o) => (
                  <SelectItem key={o.codigo_ssw} value={o.codigo_ssw.toString()}>
                    {o.codigo_ssw} — {o.descricao}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="font-mono text-[11px] uppercase tracking-widest">
              Texto adicional {ocExigeTexto ? "(obrigatório)" : "(opcional)"}
            </Label>
            <Textarea
              value={textoDescricao}
              onChange={(e) => setTextoDescricao(e.target.value)}
              rows={3}
              placeholder={
                ocExigeTexto
                  ? "Descreva a informação complementar..."
                  : "Texto adicional pro lançamento (opcional)"
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label className="font-mono text-[11px] uppercase tracking-widest">
              Imagem/PDF para o SSW (opcional, JPEG ou PDF, máx 10MB)
            </Label>
            <div className="border border-rule bg-paper-deep p-2.5 text-[12px]">
              {!anexoId ? (
                <label className="inline-flex cursor-pointer items-center gap-2 text-blue-700 hover:underline">
                  <span>📎 {uploading ? "Enviando..." : "Anexar arquivo"}</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/jpg,application/pdf"
                    className="hidden"
                    disabled={uploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) selecionarArquivo(f);
                      e.target.value = "";
                    }}
                  />
                </label>
              ) : (
                <div className="flex items-center gap-2">
                  <span>📎 {anexoFilename}</span>
                  {anexoSize != null && (
                    <span className="text-ink-soft">({Math.round(anexoSize / 1024)} KB)</span>
                  )}
                  <button
                    type="button"
                    onClick={removerAnexo}
                    className="ml-2 text-red-600 hover:text-red-800"
                  >
                    ✕ remover
                  </button>
                </div>
              )}
              <p className="mt-1 text-[10px] text-ink-soft">
                Enviado direto ao SSW como evidência. Removido do Cockpit após sucesso.
              </p>
            </div>
          </div>

          {erro && (
            <div className="border border-red-300 bg-red-50 p-2 text-[12px] text-red-900">
              {erro}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading || uploading}>
            Cancelar
          </Button>
          <Button onClick={lancar} disabled={!codigoSelecionado || loading || uploading}>
            {loading ? "Lançando..." : "Lançar oc →"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
