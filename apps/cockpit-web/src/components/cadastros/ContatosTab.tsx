import { useMemo, useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Search, Check, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

type ContatoRow = {
  id: number;
  documento_cliente: string;
  tipo: "email" | "whatsapp" | "dominio";
  identificador: string;
  nome_pessoa: string | null;
  ativo: boolean;
  cliente_nome?: string | null;
};

const GENERIC_PREFIXES = [
  "comercial",
  "contato",
  "sac",
  "atendimento",
  "financeiro",
  "compras",
  "vendas",
  "rh",
  "no-reply",
  "noreply",
];

function emailParenteceGenerico(email: string): boolean {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  return GENERIC_PREFIXES.some((p) => local === p || local.startsWith(p + "."));
}

export function ContatosTab() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");

  const { data: contatos, isLoading } = useQuery({
    queryKey: ["cadastros", "contatos-flat"],
    queryFn: async () => {
      const [{ data: cts, error: e1 }, { data: clis, error: e2 }] = await Promise.all([
        supabase
          .from("contatos_cliente")
          .select("id, documento_cliente, tipo, identificador, nome_pessoa, ativo")
          .eq("ativo", true)
          .eq("tipo", "email")
          .order("identificador"),
        supabase
          .from("tracking_credentials")
          .select("documento, nome_amigavel"),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;
      const nomeByDoc = new Map<string, string>();
      (clis ?? []).forEach((c: { documento: string; nome_amigavel: string }) =>
        nomeByDoc.set(c.documento, c.nome_amigavel),
      );
      return (cts ?? []).map((c: ContatoRow) => ({
        ...c,
        cliente_nome: nomeByDoc.get(c.documento_cliente) ?? null,
      })) as ContatoRow[];
    },
  });

  const filtrados = useMemo(() => {
    const list = contatos ?? [];
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter(
      (c) =>
        c.identificador.toLowerCase().includes(q) ||
        (c.cliente_nome ?? "").toLowerCase().includes(q) ||
        (c.nome_pessoa ?? "").toLowerCase().includes(q),
    );
  }, [contatos, search]);

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-soft" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar email, cliente ou nome…"
            className="w-80 border-2 border-ink bg-paper py-1.5 pl-7 pr-2 font-mono text-[11px] uppercase tracking-wider placeholder:normal-case placeholder:tracking-normal placeholder:text-ink-soft"
          />
        </div>
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
          {filtrados.length} contato{filtrados.length === 1 ? "" : "s"}
        </span>
      </div>

      {isLoading ? (
        <div className="font-display italic text-ink-soft">Carregando…</div>
      ) : (
        <div className="border-2 border-ink bg-paper">
          <table className="w-full">
            <thead className="border-b-2 border-ink bg-paper-deep/40">
              <tr className="text-left">
                <th className="px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                  Email
                </th>
                <th className="px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                  Cliente
                </th>
                <th className="px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                  Nome da pessoa
                </th>
              </tr>
            </thead>
            <tbody>
              {filtrados.map((c) => (
                <LinhaContato
                  key={c.id}
                  contato={c}
                  onSaved={() =>
                    qc.invalidateQueries({ queryKey: ["cadastros", "contatos-flat"] })
                  }
                />
              ))}
              {filtrados.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-8 text-center font-display italic text-ink-soft">
                    Nenhum contato encontrado.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LinhaContato({
  contato,
  onSaved,
}: {
  contato: ContatoRow;
  onSaved: () => void;
}) {
  const [valor, setValor] = useState(contato.nome_pessoa ?? "");
  const [saving, setSaving] = useState(false);
  const dirty = (contato.nome_pessoa ?? "") !== valor.trim();
  const generico = emailParenteceGenerico(contato.identificador);

  useEffect(() => {
    setValor(contato.nome_pessoa ?? "");
  }, [contato.nome_pessoa]);

  async function salvar() {
    if (!dirty || saving) return;
    setSaving(true);
    const novo = valor.trim();
    if (novo.length > 50) {
      toast.error("Nome muito longo (máx 50).");
      setSaving(false);
      return;
    }
    const { error } = await supabase
      .from("contatos_cliente")
      .update({ nome_pessoa: novo || null })
      .eq("id", contato.id);
    setSaving(false);
    if (error) {
      toast.error(`Não consegui salvar: ${error.message}`);
      return;
    }
    toast.success("Nome atualizado");
    onSaved();
  }

  return (
    <tr className="border-t border-ink/10 hover:bg-paper-deep/20">
      <td className="px-3 py-2 font-mono text-[11px] text-ink">
        {contato.identificador}
        {generico && (
          <span
            title="Email genérico — recomendado deixar nome em branco para usar fallback empresa"
            className="ml-2 inline-flex border border-warn px-1 py-0.5 font-mono text-[9px] uppercase tracking-widest text-warn"
          >
            genérico
          </span>
        )}
      </td>
      <td className="px-3 py-2 font-mono text-[11px] text-ink-soft">
        {contato.cliente_nome ?? "—"}
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <input
            value={valor}
            maxLength={50}
            placeholder={generico ? "(deixe em branco — email genérico)" : "Ex: Allyson"}
            onChange={(e) => setValor(e.target.value)}
            onBlur={salvar}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setValor(contato.nome_pessoa ?? "");
            }}
            className={cn(
              "w-56 border-2 bg-paper px-2 py-1 font-mono text-[11px]",
              dirty ? "border-sal" : "border-ink/30",
            )}
          />
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-soft" />
          ) : dirty ? (
            <button
              onClick={salvar}
              className="inline-flex items-center gap-1 border border-ink/40 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink hover:border-ink"
            >
              <Check className="h-3 w-3" /> Salvar
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
