import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ChevronRight,
  ChevronDown,
  Plus,
  Pencil,
  Trash2,
  Check,
  X,
  Search,
  Mail,
  MessageCircle,
  Globe,
  Loader2,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

type Cliente = {
  cnpj_cpf: string;
  nome: string;
  segmento_codigo: string | null;
  segmento_nome: string | null;
  ativo: boolean;
};

type Contato = {
  id: number;
  tipo: "email" | "whatsapp" | "dominio";
  identificador: string;
  documento_cliente: string;
  nome_pessoa: string | null;
  ativo: boolean;
  operador_responsavel_id: string | null;
};

function formatDoc(doc: string): string {
  const d = (doc || "").replace(/\D/g, "");
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  if (d.length === 11) {
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  }
  return doc;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ClientesTab() {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [showInativos, setShowInativos] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data: operadorId } = useQuery({
    queryKey: ["cadastros", "operador-self-id", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("operadores")
        .select("id")
        .eq("user_id", user!.id)
        .single();
      if (error) throw error;
      return data.id as string;
    },
  });

  const { data: clientes, isLoading } = useQuery({
    queryKey: ["cadastros", "clientes-v2"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("clientes")
        .select("cnpj_cpf, nome, segmento_codigo, segmento_nome, ativo")
        .order("nome");
      if (error) throw error;
      return (data ?? []) as Cliente[];
    },
  });

  // Bug (Larissa 2026-08-18): antes buscava `.in("documento_cliente", docs)` com
  // TODOS os 838 CNPJs → query-string ~12KB → gateway devolvia 414/cortava → os
  // contatos vinham vazios pra TODOS os clientes ("Nenhum contato" mesmo tendo).
  // Agora busca os contatos que o operador enxerga de uma vez — a RLS de
  // contatos_cliente já scopeia por operador_responsavel_id (gestor vê tudo), sem
  // o `.in` gigante. `limit` alto pra não bater no cap default de 1000 (há ~1621
  // no total; a RLS reduz pro operador). Mapeados por documento_cliente e casados
  // com cnpj_cpf (mesmo formato de dígitos) no `contatosPorDoc`.
  const { data: contatos } = useQuery({
    queryKey: ["cadastros", "contatos-v2"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contatos_cliente")
        .select("id, tipo, identificador, documento_cliente, nome_pessoa, ativo, operador_responsavel_id")
        .limit(10000);
      if (error) throw error;
      return (data ?? []) as Contato[];
    },
  });

  const contatosPorDoc = useMemo(() => {
    const map = new Map<string, Contato[]>();
    (contatos ?? []).forEach((c) => {
      const arr = map.get(c.documento_cliente) ?? [];
      arr.push(c);
      map.set(c.documento_cliente, arr);
    });
    return map;
  }, [contatos]);

  const visiveis = useMemo(() => {
    let list = clientes ?? [];
    if (!showInativos) list = list.filter((c) => c.ativo);
    if (search.trim()) {
      const q = search.toLowerCase();
      const qd = q.replace(/\D/g, "");
      list = list.filter(
        (c) =>
          c.nome.toLowerCase().includes(q) ||
          (qd && c.cnpj_cpf.includes(qd)) ||
          (c.segmento_nome ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [clientes, search, showInativos]);

  function toggle(doc: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(doc)) next.delete(doc);
      else next.add(doc);
      return next;
    });
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-soft" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome, documento ou segmento…"
            className="w-80 border-2 border-ink bg-paper py-1.5 pl-7 pr-2 font-mono text-[11px] uppercase tracking-wider placeholder:normal-case placeholder:tracking-normal placeholder:text-ink-soft"
          />
        </div>
        <label className="inline-flex items-center gap-1.5 border-2 border-ink bg-paper px-2 py-1 font-mono text-[11px] uppercase tracking-wider">
          <input
            type="checkbox"
            checked={showInativos}
            onChange={(e) => setShowInativos(e.target.checked)}
          />
          Mostrar inativos
        </label>
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
          {visiveis.length} cliente{visiveis.length === 1 ? "" : "s"}
        </span>
      </div>

      {isLoading ? (
        <div className="font-display italic text-ink-soft">Carregando…</div>
      ) : visiveis.length === 0 ? (
        <div className="border-2 border-dashed border-ink/30 bg-paper px-6 py-10 text-center">
          <div className="font-display text-[14px] italic text-ink-soft">
            {search
              ? "Nenhum cliente encontrado."
              : "Sua carteira de clientes está vazia."}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {visiveis.map((c) => {
            const isOpen = expanded.has(c.cnpj_cpf);
            const cts = contatosPorDoc.get(c.cnpj_cpf) ?? [];
            const ativos = cts.filter((x) => x.ativo);
            return (
              <div key={c.cnpj_cpf} className="border-2 border-ink bg-paper">
                <button
                  onClick={() => toggle(c.cnpj_cpf)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-paper-deep/30"
                >
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-ink-soft" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-ink-soft" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-display text-[14px] font-semibold text-ink truncate">
                        {c.nome}
                      </span>
                      <span
                        className={cn(
                          "inline-flex shrink-0 items-center border-2 border-ink px-1.5 py-0 font-mono text-[9px] font-bold uppercase tracking-widest",
                          c.ativo
                            ? "bg-emerald-500 text-paper"
                            : "bg-paper-deep text-ink-soft",
                        )}
                      >
                        {c.ativo ? "Ativo" : "Inativo"}
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[10px] text-ink-soft">
                      <span>{formatDoc(c.cnpj_cpf)}</span>
                      {c.segmento_nome && (
                        <>
                          <span>·</span>
                          <span className="uppercase tracking-wider">
                            {c.segmento_nome}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <span className="shrink-0 border border-ink/30 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                    {ativos.length} contato{ativos.length === 1 ? "" : "s"}
                  </span>
                </button>

                {isOpen && (
                  <ContatosBloco
                    documento={c.cnpj_cpf}
                    contatos={cts}
                    operadorId={operadorId ?? null}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------ Contatos bloco aninhado ------------ */

function ContatosBloco({
  documento,
  contatos,
  operadorId,
}: {
  documento: string;
  contatos: Contato[];
  operadorId: string | null;
}) {
  const { operador: operadorContatos } = useAuth();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  function refetch() {
    qc.invalidateQueries({ queryKey: ["cadastros", "contatos-v2"] });
    qc.invalidateQueries({ queryKey: ["cadastros", "contatos-flat"] });
  }

  return (
    <div className="border-t-2 border-ink/20 bg-paper-deep/20 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
          Contatos
        </h4>
        {!adding && operadorContatos?.pode_executar !== false && (
          <button
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 border-2 border-ink bg-paper px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink hover:bg-ink hover:text-paper"
          >
            <Plus className="h-3 w-3" /> Adicionar contato
          </button>
        )}
      </div>

      {adding && operadorId && (
        <ContatoEditor
          documento={documento}
          operadorId={operadorId}
          onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            refetch();
          }}
        />
      )}

      {contatos.length === 0 && !adding && (
        <div className="border-2 border-dashed border-ink/30 bg-paper px-4 py-6 text-center font-display text-[12px] italic text-ink-soft">
          Nenhum contato cadastrado.
        </div>
      )}

      <div className="mt-2 space-y-1">
        {contatos.map((c) =>
          editingId === c.id ? (
            <ContatoEditor
              key={c.id}
              documento={documento}
              operadorId={operadorId ?? ""}
              contato={c}
              onCancel={() => setEditingId(null)}
              onSaved={() => {
                setEditingId(null);
                refetch();
              }}
            />
          ) : (
            <LinhaContato
              key={c.id}
              contato={c}
              onEdit={() => setEditingId(c.id)}
              onDeleted={refetch}
            />
          ),
        )}
      </div>
    </div>
  );
}

function tipoIcon(t: Contato["tipo"]) {
  if (t === "email") return <Mail className="h-3.5 w-3.5" />;
  if (t === "whatsapp") return <MessageCircle className="h-3.5 w-3.5" />;
  return <Globe className="h-3.5 w-3.5" />;
}

function LinhaContato({
  contato,
  onEdit,
  onDeleted,
}: {
  contato: Contato;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);

  async function remover() {
    if (!confirm(`Remover contato ${contato.identificador}?`)) return;
    setDeleting(true);
    const { error } = await supabase
      .from("contatos_cliente")
      .delete()
      .eq("id", contato.id);
    setDeleting(false);
    if (error) {
      toast.error(`Não foi possível remover: ${error.message}`);
      return;
    }
    toast.success("Contato removido.");
    onDeleted();
  }

  return (
    <div
      className={cn(
        "flex items-center gap-2 border-2 border-ink/20 bg-paper px-2 py-1.5",
        !contato.ativo && "opacity-50",
      )}
    >
      <span className="text-ink-soft">{tipoIcon(contato.tipo)}</span>
      <span className="shrink-0 border border-ink/30 px-1.5 font-mono text-[9px] uppercase tracking-widest text-ink-soft">
        {contato.tipo}
      </span>
      <span className="font-mono text-[11px] text-ink truncate flex-1">
        {contato.identificador}
      </span>
      {contato.nome_pessoa && (
        <span className="font-display text-[12px] italic text-ink-soft truncate max-w-[200px]">
          {contato.nome_pessoa}
        </span>
      )}
      {!contato.ativo && (
        <span className="shrink-0 border border-ink/30 px-1.5 font-mono text-[9px] uppercase tracking-widest text-ink-soft">
          Inativo
        </span>
      )}
      <div className="ml-auto flex shrink-0 gap-1">
        <button
          onClick={onEdit}
          className="inline-flex items-center gap-1 border border-ink/30 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink hover:border-ink"
        >
          <Pencil className="h-3 w-3" />
        </button>
        <button
          onClick={remover}
          disabled={deleting}
          className="inline-flex items-center gap-1 border border-ink/30 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-sal hover:border-sal disabled:opacity-40"
        >
          {deleting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="h-3 w-3" />
          )}
        </button>
      </div>
    </div>
  );
}

function ContatoEditor({
  documento,
  operadorId,
  contato,
  onCancel,
  onSaved,
}: {
  documento: string;
  operadorId: string;
  contato?: Contato;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const editing = !!contato;
  const [tipo, setTipo] = useState<Contato["tipo"]>(contato?.tipo ?? "email");
  const [identificador, setIdentificador] = useState(contato?.identificador ?? "");
  const [nomePessoa, setNomePessoa] = useState(contato?.nome_pessoa ?? "");
  const [ativo, setAtivo] = useState(contato?.ativo ?? true);
  const [saving, setSaving] = useState(false);

  async function salvar() {
    const val = identificador.trim();
    if (!val) {
      toast.error("Identificador obrigatório.");
      return;
    }
    if (tipo === "email" && !EMAIL_RE.test(val)) {
      toast.error("Email inválido.");
      return;
    }
    setSaving(true);
    if (editing) {
      const { error } = await supabase
        .from("contatos_cliente")
        .update({
          tipo,
          identificador: val,
          nome_pessoa: nomePessoa.trim() || null,
          ativo,
        })
        .eq("id", contato!.id);
      setSaving(false);
      if (error) {
        toast.error(`Não foi possível salvar: ${error.message}`);
        return;
      }
      toast.success("Contato atualizado.");
    } else {
      const { error } = await supabase.from("contatos_cliente").insert({
        tipo,
        identificador: val,
        nome_pessoa: nomePessoa.trim() || null,
        documento_cliente: documento,
        operador_responsavel_id: operadorId,
        ativo: true,
      });
      setSaving(false);
      if (error) {
        toast.error(`Não foi possível adicionar: ${error.message}`);
        return;
      }
      toast.success("Contato adicionado.");
    }
    onSaved();
  }

  return (
    <div className="grid grid-cols-12 gap-2 border-2 border-sal bg-paper p-2">
      <select
        value={tipo}
        onChange={(e) => setTipo(e.target.value as Contato["tipo"])}
        className="col-span-2 border-2 border-ink/40 bg-paper px-1.5 py-1 font-mono text-[11px]"
      >
        <option value="email">Email</option>
        <option value="whatsapp">WhatsApp</option>
        <option value="dominio">Domínio</option>
      </select>
      <input
        value={identificador}
        onChange={(e) => setIdentificador(e.target.value)}
        placeholder={
          tipo === "email"
            ? "email@cliente.com"
            : tipo === "whatsapp"
              ? "31999998888"
              : "cliente.com.br"
        }
        autoFocus
        className="col-span-5 border-2 border-ink/40 bg-paper px-1.5 py-1 font-mono text-[11px]"
      />
      <input
        value={nomePessoa}
        onChange={(e) => setNomePessoa(e.target.value)}
        placeholder="Nome da pessoa (opcional)"
        maxLength={50}
        className="col-span-3 border-2 border-ink/40 bg-paper px-1.5 py-1 font-mono text-[11px]"
      />
      <div className="col-span-2 flex items-center justify-end gap-1">
        {editing && (
          <label className="mr-1 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-ink-soft">
            <input
              type="checkbox"
              checked={ativo}
              onChange={(e) => setAtivo(e.target.checked)}
            />
            Ativo
          </label>
        )}
        <button
          onClick={salvar}
          disabled={saving}
          className="inline-flex items-center gap-1 border-2 border-ink bg-ink px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-paper hover:bg-paper hover:text-ink disabled:opacity-40"
        >
          {saving ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Check className="h-3 w-3" />
          )}
        </button>
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1 border-2 border-ink bg-paper px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink hover:bg-paper-deep"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
