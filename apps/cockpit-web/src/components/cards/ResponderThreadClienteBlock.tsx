import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

const TEMPLATE_ID_BY_OC: Record<number, string> = {
  21: "RESPOSTA_AUTORIZA_REENTREGA",
  44: "RESPOSTA_AUTORIZA_DEVOLUCAO",
  55: "RESPOSTA_AUTORIZA_ENTREGA_PARCIAL",
};

function useTemplateRespostaThread(codigo: number) {
  const templateId = TEMPLATE_ID_BY_OC[codigo];
  return useQuery({
    queryKey: ["template-resposta-thread", templateId],
    enabled: !!templateId,
    staleTime: 30 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("templates_email")
        .select("corpo_template")
        .eq("id", templateId)
        .maybeSingle();
      if (error) throw error;
      const corpo = (data?.corpo_template as string | undefined) ?? "";
      return corpo.replace(/\{saudacao\}/g, "pessoal");
    },
  });
}

export function ResponderThreadClienteBlock({
  codigo,
  nf,
  enviar,
  corpo,
  prefillAplicado,
  onChange,
  disabled,
}: {
  codigo: number;
  nf: string | null;
  enviar: boolean;
  corpo: string;
  prefillAplicado: boolean;
  onChange: (patch: {
    responder_thread_enviar?: boolean;
    responder_thread_corpo?: string;
    _resp_thread_prefill_aplicado?: boolean;
  }) => void;
  disabled?: boolean;
}) {
  const { data: corpoTemplate, isLoading } = useTemplateRespostaThread(codigo);

  // Pre-fill 1x quando template chega
  useEffect(() => {
    if (prefillAplicado) return;
    if (corpoTemplate == null) return;
    onChange({
      responder_thread_corpo: corpo && corpo.trim() ? corpo : corpoTemplate,
      responder_thread_enviar: enviar,
      _resp_thread_prefill_aplicado: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corpoTemplate, prefillAplicado]);

  return (
    <div className="border border-ink/20 bg-paper p-3">
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={enviar}
          onChange={(e) => onChange({ responder_thread_enviar: e.target.checked })}
          disabled={disabled}
          className="h-3.5 w-3.5 accent-sal"
        />
        <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-ink">
          📧 Responder cliente por email
        </span>
      </label>

      {enviar && (
        <div className="mt-2.5 space-y-2">
          <div className="font-mono text-[10px] text-ink/60">
            <span className="uppercase tracking-wider">Assunto:</span>{" "}
            <span className="text-ink">Re: NF {nf ?? "—"}</span>
            <span className="ml-1 text-ink/40">(não editável)</span>
          </div>
          <textarea
            value={corpo}
            onChange={(e) => onChange({ responder_thread_corpo: e.target.value })}
            rows={4}
            disabled={disabled}
            placeholder={isLoading ? "carregando texto do template…" : ""}
            className="w-full resize-y border border-ink/30 bg-paper px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-ink disabled:opacity-50"
          />
          <div className="font-mono text-[9px] leading-snug text-ink/50">
            Enviado em resposta à última mensagem do cliente — mantém a mesma conversa Gmail.
          </div>
        </div>
      )}
    </div>
  );
}

export function ocAceitaRespostaThread(codigo: number): boolean {
  return codigo === 21 || codigo === 44 || codigo === 55;
}
