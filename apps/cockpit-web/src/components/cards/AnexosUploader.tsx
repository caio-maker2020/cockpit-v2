import { useRef, type ChangeEvent } from "react";
import { toast } from "sonner";

import { supabase } from "@/lib/supabase";

export interface AnexoUploaded {
  anexo_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
}

const ACCEPT =
  ".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt";
const ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/plain",
]);
const ALLOWED_EXTS = new Set([
  "pdf", "jpg", "jpeg", "png", "gif", "webp",
  "doc", "docx", "xls", "xlsx", "csv", "txt",
]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 5;

function isMimeAllowed(file: File): boolean {
  if (file.type && ALLOWED_MIMES.has(file.type.toLowerCase())) return true;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ALLOWED_EXTS.has(ext);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AnexosUploader({
  cardId,
  todoId,
  anexos,
  onChange,
  uploading,
  setUploading,
  disabled,
  compact,
}: {
  cardId: string;
  todoId?: string;
  anexos: AnexoUploaded[];
  onChange: (next: AnexoUploaded[]) => void;
  uploading: boolean;
  setUploading: (v: boolean) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const totalBytes = anexos.reduce((s, a) => s + a.size_bytes, 0);

  async function handleFileSelect(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) return;

    if (file.size > MAX_FILE_BYTES) {
      toast.error("Arquivo muito grande. Limite de 10MB por anexo.");
      return;
    }
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "heic" || ext === "heif") {
      toast.error(
        "Fotos de iPhone (.heic) não são aceitas. Converta para JPG ou PNG antes de anexar.",
      );
      return;
    }
    if (!isMimeAllowed(file)) {
      toast.error(
        `Tipo de arquivo não suportado${ext ? ` (.${ext})` : ""}. Aceitos: PDF, JPG, PNG, GIF, WEBP, Word (.doc/.docx), Excel (.xls/.xlsx), CSV e TXT.`,
      );
      return;
    }
    if (totalBytes + file.size > MAX_TOTAL_BYTES) {
      toast.error("Total de anexos excederia 25MB.");
      return;
    }
    if (anexos.length >= MAX_FILES) {
      toast.error("Limite de 5 anexos atingido.");
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("card_id", cardId);
      if (todoId) formData.append("todo_id", todoId);

      const { data, error } = await supabase.functions.invoke(
        "upload-anexo-email",
        { body: formData },
      );
      if (error) {
        let msg = "Falha no upload do anexo.";
        try {
          const corpo = await (error as any).context?.json?.();
          if (corpo?.error) msg = corpo.error;
          else if (corpo?.message) msg = corpo.message;
        } catch {
          /* mantém msg padrão */
        }
        toast.error(msg);
        return;
      }
      if (!data?.ok) {
        toast.error(data?.error || "Falha no upload");
        return;
      }
      onChange([
        ...anexos,
        {
          anexo_id: data.anexo_id,
          filename: data.filename,
          mime_type: data.mime_type,
          size_bytes: data.size_bytes,
        },
      ]);
    } catch (err) {
      toast.error("Erro ao subir arquivo", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUploading(false);
    }
  }

  function removeAnexo(id: string) {
    onChange(anexos.filter((a) => a.anexo_id !== id));
  }

  const atLimit = anexos.length >= MAX_FILES;

  return (
    <div className={compact ? "" : "border border-ink/15 bg-paper-deep/30 p-2"}>
      <div className="mb-1 flex items-center justify-between">
        <label className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">
          📎 Anexos ({anexos.length}/{MAX_FILES})
          {totalBytes > 0 && (
            <span className="ml-2 normal-case text-ink/40">
              {formatSize(totalBytes)} / 25 MB
            </span>
          )}
        </label>
      </div>

      <input
        type="file"
        ref={fileInputRef}
        style={{ display: "none" }}
        accept={ACCEPT}
        onChange={handleFileSelect}
      />

      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled || uploading || atLimit}
        className="border border-ink/30 bg-paper px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink disabled:opacity-40"
      >
        {uploading ? "Subindo…" : "+ Adicionar arquivo"}
      </button>
      <p className="mt-1 font-mono text-[9px] text-ink/50">
        PDF, imagens, Word, Excel, CSV ou texto. Até 10MB.
      </p>

      {anexos.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {anexos.map((a) => (
            <li
              key={a.anexo_id}
              className="flex items-center justify-between gap-2 border border-ink/15 bg-paper px-2 py-1"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">
                {a.filename}{" "}
                <span className="text-ink/40">({formatSize(a.size_bytes)})</span>
              </span>
              <button
                type="button"
                onClick={() => removeAnexo(a.anexo_id)}
                disabled={disabled}
                className="font-mono text-[12px] leading-none text-ink/50 hover:text-sal disabled:opacity-40"
                title="Remover"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {atLimit && (
        <p className="mt-1 font-mono text-[9px] text-ink/50">
          Limite de {MAX_FILES} anexos atingido.
        </p>
      )}
    </div>
  );
}
