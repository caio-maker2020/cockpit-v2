import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Pencil, Trash2, Plus, Search } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";

type Cargo =
  | "gerente_base"
  | "coordenador_entrega"
  | "gerente_relacionamento"
  | "time_ressarcimento";

type ContatoEscalonamento = {
  id: string;
  base: string | null;
  cargo: Cargo;
  nome: string;
  telefone: string | null;
  email: string | null;
  ativo: boolean;
  observacao: string | null;
  created_at: string;
  updated_at: string;
};

const CARGO_UI: Record<Cargo, { label: string; icon: string }> = {
  gerente_base: { label: "Gerente da Base", icon: "📤" },
  coordenador_entrega: { label: "Coordenador de Entrega", icon: "📞" },
  gerente_relacionamento: { label: "Gerente de Relacionamento", icon: "🚨" },
  time_ressarcimento: { label: "Time Ressarcimento", icon: "💰" },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;



export function EscalonamentoTab() {
  const { operador } = useAuth();
  const qc = useQueryClient();
  // Modo visualização (mig 324): vê a lista, não edita.
  const isGestor = !!operador && operador.pode_executar !== false;

  const [search, setSearch] = useState("");
  const [filtroCargo, setFiltroCargo] = useState<"all" | Cargo>("all");
  const [filtroBase, setFiltroBase] = useState<string>("all");
  const [showInativos, setShowInativos] = useState(false);
  const [editando, setEditando] = useState<ContatoEscalonamento | null | "new">(null);
  const [confirmarDeletar, setConfirmarDeletar] = useState<ContatoEscalonamento | null>(null);

  const { data: contatos, isLoading } = useQuery({
    queryKey: ["escalonamento", "contatos"],
    enabled: !!operador,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contatos_escalonamento")
        .select("*")
        .order("base", { ascending: true, nullsFirst: false })
        .order("cargo");
      if (error) throw error;
      return (data ?? []) as ContatoEscalonamento[];
    },
  });

  const { data: basesSsw } = useQuery({
    queryKey: ["escalonamento", "bases-ssw"],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cards")
        .select("base_destino")
        .not("base_destino", "is", null)
        .limit(5000);
      if (error) throw error;
      const set = new Set<string>();
      (data ?? []).forEach((r: { base_destino: string | null }) => {
        if (r.base_destino) set.add(r.base_destino);
      });
      return [...set].sort();
    },
  });

  const basesNosContatos = useMemo(() => {
    const set = new Set<string>();
    (contatos ?? []).forEach((c) => c.base && set.add(c.base));
    return [...set].sort();
  }, [contatos]);

  const basesParaFiltro = useMemo(() => {
    const set = new Set<string>(basesNosContatos);
    (basesSsw ?? []).forEach((b) => set.add(b));
    return [...set].sort();
  }, [basesNosContatos, basesSsw]);

  const visiveis = useMemo(() => {
    let list = contatos ?? [];
    if (!showInativos) list = list.filter((c) => c.ativo);
    if (filtroCargo !== "all") list = list.filter((c) => c.cargo === filtroCargo);
    if (filtroBase !== "all") {
      if (filtroBase === "__global__") list = list.filter((c) => !c.base);
      else list = list.filter((c) => c.base === filtroBase);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (c) =>
          c.nome.toLowerCase().includes(q) ||
          (c.email ?? "").toLowerCase().includes(q) ||
          (c.telefone ?? "").includes(q.replace(/\D+/g, "")),
      );
    }
    return list;
  }, [contatos, search, filtroCargo, filtroBase, showInativos]);

  async function deletar(c: ContatoEscalonamento) {
    const { error } = await supabase.from("contatos_escalonamento").delete().eq("id", c.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Contato removido.");
    qc.invalidateQueries({ queryKey: ["escalonamento"] });
    setConfirmarDeletar(null);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink/10 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-soft" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar nome, email, telefone…"
              className="w-72 border-2 border-ink bg-paper py-1.5 pl-7 pr-2 font-mono text-[11px] uppercase tracking-wider placeholder:normal-case placeholder:tracking-normal placeholder:text-ink-soft"
            />
          </div>
          <select
            value={filtroBase}
            onChange={(e) => setFiltroBase(e.target.value)}
            className="border-2 border-ink bg-paper px-2 py-1 font-mono text-[11px] uppercase tracking-wider"
          >
            <option value="all">Todas bases</option>
            <option value="__global__">— Global (sem base)</option>
            {basesParaFiltro.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          <select
            value={filtroCargo}
            onChange={(e) => setFiltroCargo(e.target.value as "all" | Cargo)}
            className="border-2 border-ink bg-paper px-2 py-1 font-mono text-[11px] uppercase tracking-wider"
          >
            <option value="all">Todos cargos</option>
            {(Object.keys(CARGO_UI) as Cargo[]).map((k) => (
              <option key={k} value={k}>
                {CARGO_UI[k].icon} {CARGO_UI[k].label}
              </option>
            ))}
          </select>
          <label className="inline-flex items-center gap-1.5 border-2 border-ink bg-paper px-2 py-1 font-mono text-[11px] uppercase tracking-wider">
            <input
              type="checkbox"
              checked={showInativos}
              onChange={(e) => setShowInativos(e.target.checked)}
            />
            Inativos
          </label>
        </div>
        {isGestor && (
          <button
            onClick={() => setEditando("new")}
            className="inline-flex items-center gap-2 border-2 border-ink bg-ink px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-paper hover:bg-paper hover:text-ink"
          >
            <Plus className="h-3.5 w-3.5" /> Novo contato
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto pt-4">
        {isLoading ? (
          <div className="font-display italic text-ink-soft">Carregando…</div>
        ) : visiveis.length === 0 ? (
          <div className="border-2 border-dashed border-ink/30 bg-paper px-6 py-10 text-center">
            <div className="font-display text-[14px] italic text-ink-soft">
              Nenhum contato de escalonamento cadastrado.
            </div>
            {isGestor && (
              <button
                onClick={() => setEditando("new")}
                className="mt-3 inline-flex items-center gap-2 border-2 border-ink bg-paper px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-ink hover:bg-ink hover:text-paper"
              >
                <Plus className="h-3.5 w-3.5" /> Cadastrar primeiro contato
              </button>
            )}
          </div>
        ) : (
          <div className="border-2 border-ink bg-paper">
            <table className="w-full">
              <thead className="border-b-2 border-ink bg-paper-deep/40">
                <tr className="text-left">
                  <th className="px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-soft">Base</th>
                  <th className="px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-soft">Cargo</th>
                  <th className="px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-soft">Nome</th>
                  <th className="px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-soft">Telefone</th>
                  <th className="px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-soft">Email</th>
                  <th className="px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-soft">Ativo</th>
                  {isGestor && (
                    <th className="px-3 py-2 text-right font-mono text-[10px] uppercase tracking-widest text-ink-soft">Ações</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {visiveis.map((c) => {
                  const cargoUi = CARGO_UI[c.cargo];
                  return (
                    <tr key={c.id} className="border-t border-ink/10 hover:bg-paper-deep/20">
                      <td className="px-3 py-2 font-mono text-[11px]">
                        {c.base ? (
                          <span className="font-bold text-ink">{c.base}</span>
                        ) : (
                          <span className="text-ink-soft" title="Contato global (todas bases)">
                            — <span className="text-[10px] uppercase">global</span>
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-ink-soft">
                        <span className="mr-1">{cargoUi.icon}</span>
                        {cargoUi.label}
                      </td>
                      <td className="px-3 py-2 font-display text-[13px] font-semibold text-ink">{c.nome}</td>
                      <td className="px-3 py-2 font-mono text-[11px] text-ink-soft">{c.telefone ?? "—"}</td>
                      <td className="px-3 py-2 font-mono text-[11px] text-ink-soft">{c.email ?? "—"}</td>
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            "inline-flex items-center border-2 border-ink px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest",
                            c.ativo ? "bg-emerald-500 text-paper" : "bg-paper-deep text-ink-soft",
                          )}
                        >
                          {c.ativo ? "Ativo" : "Inativo"}
                        </span>
                      </td>
                      {isGestor && (
                        <td className="px-3 py-2">
                          <div className="flex justify-end gap-1">
                            <button
                              onClick={() => setEditando(c)}
                              className="inline-flex items-center gap-1 border border-ink/30 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink hover:border-ink"
                            >
                              <Pencil className="h-3 w-3" /> Editar
                            </button>
                            <button
                              onClick={async () => {
                                const { error } = await supabase
                                  .from("contatos_escalonamento")
                                  .update({ ativo: !c.ativo })
                                  .eq("id", c.id);
                                if (error) return toast.error(error.message);
                                toast.success(c.ativo ? "Contato desativado." : "Contato ativado.");
                                qc.invalidateQueries({ queryKey: ["escalonamento"] });
                              }}
                              className="inline-flex items-center gap-1 border border-ink/30 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink hover:border-ink"
                            >
                              {c.ativo ? "Desativar" : "Ativar"}
                            </button>
                            <button
                              onClick={() => setConfirmarDeletar(c)}
                              className="inline-flex items-center gap-1 border border-ink/30 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-sal hover:border-sal"
                            >
                              <Trash2 className="h-3 w-3" /> Excluir
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editando && (
        <FormEscalonamento
          contato={editando === "new" ? null : editando}
          basesSsw={basesSsw ?? []}
          onClose={() => setEditando(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["escalonamento"] });
            setEditando(null);
          }}
        />
      )}

      <Dialog open={!!confirmarDeletar} onOpenChange={(o) => !o && setConfirmarDeletar(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Excluir contato {confirmarDeletar?.nome}?</DialogTitle>
            <DialogDescription>
              Esta ação remove permanentemente o contato. Considere apenas desativar.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setConfirmarDeletar(null)}
              className="border-2 border-ink bg-paper px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-ink hover:bg-paper-deep"
            >
              Cancelar
            </button>
            <button
              onClick={() => confirmarDeletar && deletar(confirmarDeletar)}
              className="border-2 border-ink bg-sal px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-paper hover:opacity-90"
            >
              Excluir
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ---------------- FORM ---------------- */

function FormEscalonamento({
  contato,
  basesSsw,
  onClose,
  onSaved,
}: {
  contato: ContatoEscalonamento | null;
  basesSsw: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!contato;
  const [base, setBase] = useState(contato?.base ?? "");
  const [cargo, setCargo] = useState<Cargo | "">(contato?.cargo ?? "");
  const [nome, setNome] = useState(contato?.nome ?? "");
  const [telefone, setTelefone] = useState(contato?.telefone ?? "");
  const [email, setEmail] = useState(contato?.email ?? "");
  const [observacao, setObservacao] = useState(contato?.observacao ?? "");
  const [ativo, setAtivo] = useState(contato?.ativo ?? true);
  const [loading, setLoading] = useState(false);


  async function salvar() {
    if (!cargo) {
      toast.error("Selecione o cargo.");
      return;
    }
    if (!nome.trim()) {
      toast.error("Nome é obrigatório.");
      return;
    }
    const telTrim = telefone.trim();
    const emailTrim = email.trim();
    if (!telTrim && !emailTrim) {
      toast.error("Informe pelo menos um telefone ou email.");
      return;
    }
    if (emailTrim && !EMAIL_RE.test(emailTrim)) {
      toast.error("Email inválido.");
      return;
    }

    setLoading(true);
    const payload = {
      base: base.trim() ? base.trim().toUpperCase() : null,
      cargo,
      nome: nome.trim(),
      telefone: telTrim || null,
      email: emailTrim || null,
      observacao: observacao.trim() || null,
      ativo,
    };

    const { error } = editing
      ? await supabase.from("contatos_escalonamento").update(payload).eq("id", contato!.id)
      : await supabase.from("contatos_escalonamento").insert(payload);

    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(editing ? "Contato atualizado." : "Contato criado.");
    onSaved();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Editar contato" : "Cadastrar contato de escalonamento"}</DialogTitle>
          <DialogDescription>
            Contato de escalonamento usado para acionar a base quando o operador cobra um card.
          </DialogDescription>

        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label className="block font-mono text-[10px] uppercase tracking-widest text-ink-soft">
              Base SSW
            </label>
            <input
              list="bases-ssw-list"
              value={base}
              onChange={(e) => setBase(e.target.value.toUpperCase())}
              placeholder="— Global (todas bases)"
              className="mt-1 w-full border-2 border-ink bg-paper px-2 py-1.5 font-mono text-[12px] uppercase"
              style={{ textTransform: "uppercase" }}
            />
            <datalist id="bases-ssw-list">
              {basesSsw.map((b) => (
                <option key={b} value={b} />
              ))}
            </datalist>
            <p className="mt-1 font-mono text-[10px] text-ink-soft">
              Deixe vazio se for contato global (ex: Gerente de Relacionamento).
            </p>
          </div>

          <div>
            <label className="block font-mono text-[10px] uppercase tracking-widest text-ink-soft">
              Cargo *
            </label>
            <select
              value={cargo}
              onChange={(e) => setCargo(e.target.value as Cargo)}
              className="mt-1 w-full border-2 border-ink bg-paper px-2 py-1.5 font-mono text-[12px]"
            >
              <option value="">Selecione…</option>
              {(Object.keys(CARGO_UI) as Cargo[]).map((k) => (
                <option key={k} value={k}>
                  {CARGO_UI[k].icon} {CARGO_UI[k].label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block font-mono text-[10px] uppercase tracking-widest text-ink-soft">
              Nome *
            </label>
            <input
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              className="mt-1 w-full border-2 border-ink bg-paper px-2 py-1.5 font-display text-[13px]"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                Telefone (WhatsApp)
              </label>
              <input
                value={telefone}
                onChange={(e) => setTelefone(e.target.value)}
                placeholder="(35) 99999-0000"
                className="mt-1 w-full border-2 border-ink bg-paper px-2 py-1.5 font-mono text-[12px]"
              />
            </div>
            <div>
              <label className="block font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="nome@empresa.com"
                className="mt-1 w-full border-2 border-ink bg-paper px-2 py-1.5 font-mono text-[12px]"
              />
            </div>
          </div>

          <div>
            <label className="block font-mono text-[10px] uppercase tracking-widest text-ink-soft">
              Observação
            </label>
            <textarea
              value={observacao}
              onChange={(e) => setObservacao(e.target.value)}
              rows={2}
              className="mt-1 w-full border-2 border-ink bg-paper px-2 py-1.5 font-mono text-[12px]"
            />
          </div>

          <label className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider">
            <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} />
            Ativo
          </label>
        </div>

        <DialogFooter>
          <button
            onClick={onClose}
            disabled={loading}
            className="border-2 border-ink bg-paper px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-ink hover:bg-paper-deep disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={salvar}
            disabled={loading}
            className="border-2 border-ink bg-ink px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-paper hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "Salvando…" : "Salvar"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
