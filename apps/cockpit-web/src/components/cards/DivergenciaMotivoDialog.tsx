import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sparkle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { Divergencia } from "@/lib/divergencia";

// Popup de divergência (F4 do Loop de Aprendizado): o operador aprovou uma
// ação DIFERENTE da destacada pela IA → 1 chip de motivo (obrigatório) +
// texto opcional. O registro é best-effort (falha NUNCA trava a aprovação);
// cancelar aborta a aprovação inteira. Chips vêm do motivo_bank (aprovados).

type Chip = { codigo: string; label: string };

export function DivergenciaMotivoDialog({
  aberta,
  div,
  onConfirmar,
  onCancelar,
}: {
  aberta: boolean;
  div: Divergencia | null;
  onConfirmar: (reasonCode: string, texto: string) => void | Promise<void>;
  onCancelar: () => void;
}) {
  const [chip, setChip] = useState<string | null>(null);
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);

  const { data: chips } = useQuery({
    queryKey: ["motivo-bank", "popup_divergencia"],
    enabled: aberta && !!supabase,
    staleTime: 10 * 60 * 1000,
    queryFn: async (): Promise<Chip[]> => {
      const { data, error } = await supabase!
        .from("motivo_bank")
        .select("codigo,label")
        .eq("contexto", "popup_divergencia")
        .eq("status", "aprovado")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Chip[];
    },
  });

  async function confirmar() {
    if (!chip) return;
    setEnviando(true);
    try {
      await onConfirmar(chip, texto.trim());
    } finally {
      setEnviando(false);
      setChip(null);
      setTexto("");
    }
  }

  return (
    <Dialog open={aberta} onOpenChange={(o) => { if (!o) onCancelar(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <Sparkle className="h-4 w-4 fill-current text-ai" aria-hidden />
            Você escolheu diferente da sugestão da IA
          </DialogTitle>
        </DialogHeader>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {div?.ocSugerida !== null && div?.ocAprovada !== null
            ? `A IA sugeriu a oc ${div?.ocSugerida} e você está aprovando a oc ${div?.ocAprovada}. `
            : ""}
          Conta rapidinho o porquê — é isso que ensina a IA a sugerir melhor.
        </p>
        <div className="flex flex-col gap-1.5">
          {(chips && chips.length > 0
            ? chips
            : // Auditoria 25/07: motivo_bank vazio/erro deixava "Registrar e
              // aprovar" disabled PRA SEMPRE (única saída: cancelar a
              // aprovação). Fallback local garante sempre 1 chip clicável.
              [{ codigo: "outro", label: "Outro motivo (detalhe abaixo)" }]
          ).map((c) => (
            <button
              key={c.codigo}
              type="button"
              onClick={() => setChip((atual) => (atual === c.codigo ? null : c.codigo))}
              className={`rounded-md border px-3 py-2 text-left text-[13px] leading-snug transition-colors ${
                chip === c.codigo
                  ? "border-foreground bg-foreground text-background"
                  : "hover:bg-muted"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <Textarea
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          placeholder="Detalhe opcional (1 frase já ajuda)"
          className="min-h-[56px] text-[13px]"
        />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancelar} disabled={enviando}>
            Cancelar aprovação
          </Button>
          <Button onClick={confirmar} disabled={!chip || enviando}>
            {enviando ? "Registrando…" : "Registrar e aprovar"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
