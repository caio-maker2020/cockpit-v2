import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";

type GmailCreds = {
  email?: string;
  conectado_em?: string;
} | null;

function ConectarGmailCard() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [conectando, setConectando] = useState(false);

  const { data: operador } = useQuery({
    queryKey: ["operador-gmail", user?.id],
    enabled: !!user?.id && !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("operadores")
        .select("id, nome, email, gmail_oauth_credentials")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data as {
        id: string;
        nome: string | null;
        email: string | null;
        gmail_oauth_credentials: GmailCreds;
      } | null;
    },
  });

  const creds = operador?.gmail_oauth_credentials ?? null;
  const conectado = !!creds?.email;
  const emailConectado = creds?.email;
  const conectadoEm = creds?.conectado_em;

  async function handleConectar() {
    if (!supabase) return;
    setConectando(true);
    const { data, error } = await supabase.functions.invoke("oauth-gmail-start");
    setConectando(false);
    if (error || !data?.ok) {
      toast.error(error?.message ?? data?.error ?? "Erro ao iniciar OAuth");
      return;
    }
    window.location.href = data.auth_url;
  }

  async function handleDesconectar() {
    if (!operador?.id || !supabase) return;
    if (
      !confirm(
        "Desconectar o Gmail? Os próximos emails voltam pra Postmark (podem cair em spam).",
      )
    )
      return;
    const { error } = await supabase
      .from("operadores")
      .update({ gmail_oauth_credentials: null })
      .eq("id", operador.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Gmail desconectado.");
    queryClient.invalidateQueries({ queryKey: ["operador-gmail"] });
  }

  return (
    <section className="border-2 border-ink bg-paper p-5">
      <header className="flex items-center justify-between gap-3 border-b border-rule pb-3">
        <h2 className="font-display text-[15px] font-semibold text-ink">
          📧 Email do Cockpit
        </h2>
        {conectado ? (
          <span className="inline-flex items-center border border-ok bg-ok/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-ink">
            ✓ Conectado
          </span>
        ) : (
          <span className="inline-flex items-center border border-warn bg-warn/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-ink">
            ⚠ Não conectado
          </span>
        )}
      </header>

      {conectado ? (
        <div className="space-y-3 pt-3">
          <p className="text-[12px] text-ink-soft">
            Os emails automáticos do Cockpit estão saindo de{" "}
            <span className="font-mono text-ink">{emailConectado}</span>.
            {conectadoEm && (
              <span className="ml-1 block text-[11px] text-ink-soft">
                Conectado em {new Date(conectadoEm).toLocaleString("pt-BR")}
              </span>
            )}
          </p>
          <button
            onClick={handleDesconectar}
            className="border border-rule-strong bg-paper px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-ink-soft hover:bg-paper-deep"
          >
            Desconectar
          </button>
        </div>
      ) : (
        <div className="space-y-3 pt-3">
          <p className="text-[12px] text-ink-soft">
            Conecte sua conta Gmail do Workspace pra que os emails automáticos
            do Cockpit saiam direto da sua caixa. Sem isso, os emails podem
            cair em spam dos clientes.
          </p>
          <button
            onClick={handleConectar}
            disabled={conectando}
            className="border-2 border-ink bg-ink px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-widest text-paper hover:bg-ink-soft disabled:opacity-50"
          >
            {conectando ? "Abrindo Google..." : "🔐 Conectar Gmail"}
          </button>
          <p className="text-[11px] italic text-ink-soft">
            Você vai ser redirecionado pra accounts.google.com pra autorizar.
            Permissão pedida: enviar emails em nome da sua conta. Pode revogar
            a qualquer momento.
          </p>
        </div>
      )}
    </section>
  );
}

export default function Configuracoes() {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-rule px-5 py-3">
        <h1 className="font-display text-[15px] font-semibold text-ink">
          Configurações
        </h1>
        <p className="text-[12px] text-ink-soft">
          Preferências da operação e do operador.
        </p>
      </header>
      <div className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-2xl">
          <ConectarGmailCard />
        </div>
      </div>
    </div>
  );
}
