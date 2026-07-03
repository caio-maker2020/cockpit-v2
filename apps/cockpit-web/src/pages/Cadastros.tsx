import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Pencil, Ban, Plus, Search } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { EscalonamentoTab } from "@/components/cadastros/EscalonamentoTab";
import { ContatosTab } from "@/components/cadastros/ContatosTab";
import { ClientesTab } from "@/components/cadastros/ClientesTab";
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

type Cliente = {
  documento: string;
  nome_amigavel: string;
  ativo: boolean;
  operador_responsavel_id: string | null;
  notes: string | null;
  updated_at: string | null;
};

type Contato = {
  documento_cliente: string;
  tipo: "email" | "whatsapp" | "dominio";
  identificador: string;
  ordem: number;
  tipo_uso: string;
  nome_pessoa: string | null;
  ativo: boolean;
};

type Operador = {
  id: string;
  nome: string;
  email: string;
  papel: "operador" | "gestor";
};

type ContatoForm = {
  canal: "email" | "whatsapp";
  valor: string;
  ordem: number;
  uso: "geral" | "cobranca" | "logistico" | "financeiro" | "comercial";
  pessoa: string;
  observacao: string;
  id?: number;
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

function maskDocInput(value: string): string {
  const d = value.replace(/\D/g, "").slice(0, 14);
  if (d.length <= 11) {
    // CPF mask progressive
    return d
      .replace(/^(\d{3})(\d)/, "$1.$2")
      .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
      .replace(/\.(\d{3})(\d)/, ".$1-$2");
  }
  // CNPJ mask
  return d
    .replace(/^(\d{2})(\d)/, "$1.$2")
    .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1/$2")
    .replace(/(\d{4})(\d)/, "$1-$2");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Cadastros() {
  const { operador } = useAuth();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [showInativos, setShowInativos] = useState(false);
  const [filtroOperador, setFiltroOperador] = useState<string>("all");
  const [editando, setEditando] = useState<{ documento?: string } | null>(null);
  const [confirmarDesativar, setConfirmarDesativar] = useState<Cliente | null>(null);
  const [subtab, setSubtab] = useState<"clientes" | "contatos" | "escalonamento">("clientes");

  const isGestor = operador?.papel === "gestor";

  const { data: clientes, isLoading } = useQuery({
    queryKey: ["cadastros", "clientes"],
    enabled: !!operador,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tracking_credentials")
        .select("documento, nome_amigavel, ativo, operador_responsavel_id, notes, updated_at")
        .order("nome_amigavel", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Cliente[];
    },
  });

  const docs = useMemo(() => (clientes ?? []).map((c) => c.documento), [clientes]);

  const { data: contatos } = useQuery({
    queryKey: ["cadastros", "contatos", docs.join(",")],
    enabled: docs.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contatos_cliente")
        .select("documento_cliente, tipo, identificador, ordem, tipo_uso, nome_pessoa, ativo")
        .in("documento_cliente", docs);
      if (error) throw error;
      return (data ?? []) as Contato[];
    },
  });

  const { data: operadores } = useQuery({
    queryKey: ["cadastros", "operadores"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("operadores")
        .select("id, nome, email, papel")
        .eq("ativo", true)
        .order("nome");
      if (error) throw error;
      return (data ?? []) as Operador[];
    },
  });

  const contatosPorDoc = useMemo(() => {
    const map = new Map<string, { emails: number; whatsapps: number }>();
    (contatos ?? []).forEach((c) => {
      if (!c.ativo) return;
      const cur = map.get(c.documento_cliente) ?? { emails: 0, whatsapps: 0 };
      if (c.tipo === "email") cur.emails++;
      else if (c.tipo === "whatsapp") cur.whatsapps++;
      map.set(c.documento_cliente, cur);
    });
    return map;
  }, [contatos]);

  const operadorById = useMemo(() => {
    const m = new Map<string, Operador>();
    (operadores ?? []).forEach((o) => m.set(o.id, o));
    return m;
  }, [operadores]);

  const visiveis = useMemo(() => {
    let list = clientes ?? [];
    if (!showInativos) list = list.filter((c) => c.ativo);
    if (search.trim()) {
      const q = search.toLowerCase();
      const qd = q.replace(/\D/g, "");
      list = list.filter(
        (c) =>
          c.nome_amigavel.toLowerCase().includes(q) ||
          (qd && c.documento.includes(qd)),
      );
    }
    if (isGestor && filtroOperador !== "all") {
      list = list.filter((c) => c.operador_responsavel_id === filtroOperador);
    }
    return list;
  }, [clientes, search, showInativos, filtroOperador, isGestor]);

  async function desativar(c: Cliente) {
    const { error } = await supabase.rpc("desativar_cliente", { p_documento: c.documento });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Cliente desativado.");
    qc.invalidateQueries({ queryKey: ["cadastros"] });
    setConfirmarDesativar(null);
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b-2 border-ink bg-paper px-6 py-3">
        <div>
          <h1 className="font-display text-[20px] font-semibold">Cadastros</h1>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
            {subtab === "clientes"
              ? "Clientes rastreados pelo Cockpit"
              : subtab === "contatos"
                ? "Nome da pessoa por email (usado no {primeiro_nome})"
                : "Contatos para escalonamento de cobrança"}
          </p>
        </div>
        {subtab === "clientes" && (
          <button
            onClick={() => setEditando({})}
            className="inline-flex items-center gap-2 border-2 border-ink bg-ink px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-paper hover:bg-paper hover:text-ink"
          >
            <Plus className="h-3.5 w-3.5" /> Novo Cliente
          </button>
        )}
      </header>

      <nav className="flex items-center gap-1 border-b-2 border-ink bg-paper px-6">
        {([
          { id: "clientes", label: "Clientes" },
          { id: "contatos", label: "Contatos" },
          { id: "escalonamento", label: "Escalonamento" },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setSubtab(t.id)}
            className={cn(
              "border-x-2 border-t-2 px-4 py-2 font-mono text-[11px] uppercase tracking-widest -mb-[2px]",
              subtab === t.id
                ? "border-ink bg-paper text-ink border-b-paper"
                : "border-transparent text-ink-soft hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>


      <div className="flex-1 overflow-y-auto bg-paper-deep/30 p-6">
        {subtab === "escalonamento" ? (
          <EscalonamentoTab />
        ) : subtab === "contatos" ? (
          <ContatosTab />
        ) : (
          <ClientesTab />
        )}
      </div>



      {editando && (
        <FormCliente
          documento={editando.documento}
          isGestor={isGestor}
          operadorSelf={operador!}
          operadores={operadores ?? []}
          onClose={() => setEditando(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["cadastros"] });
            setEditando(null);
          }}
        />
      )}

      <Dialog
        open={!!confirmarDesativar}
        onOpenChange={(o) => !o && setConfirmarDesativar(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Desativar cliente {confirmarDesativar?.nome_amigavel}?</DialogTitle>
            <DialogDescription>
              Os contatos param de ser usados pelo Cockpit imediatamente. Você pode reativar
              editando depois.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setConfirmarDesativar(null)}
              className="border-2 border-ink bg-paper px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-ink hover:bg-paper-deep"
            >
              Cancelar
            </button>
            <button
              onClick={() => confirmarDesativar && desativar(confirmarDesativar)}
              className="border-2 border-ink bg-sal px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-paper hover:opacity-90"
            >
              Desativar
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ---------------- FORM ---------------- */

function FormCliente({
  documento,
  isGestor,
  operadorSelf,
  operadores,
  onClose,
  onSaved,
}: {
  documento?: string;
  isGestor: boolean;
  operadorSelf: { id: string; nome: string };
  operadores: Operador[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!documento;

  const [doc, setDoc] = useState(documento ? formatDoc(documento) : "");
  const [nome, setNome] = useState("");
  const [senha, setSenha] = useState("");
  const [notes, setNotes] = useState("");
  const [opResp, setOpResp] = useState<string>(isGestor ? "" : operadorSelf.id);
  const [contatos, setContatos] = useState<ContatoForm[]>([
    { canal: "email", valor: "", ordem: 1, uso: "geral", pessoa: "", observacao: "" },
  ]);
  const [loading, setLoading] = useState(false);
  const [loadingExisting, setLoadingExisting] = useState(editing);
  
  const { session } = useAuth();

  // Carrega dados se for edição
  useEffect(() => {
    if (!editing) return;
    (async () => {
      const [cli, ct] = await Promise.all([
        supabase
          .from("tracking_credentials")
          .select("documento, nome_amigavel, senha, notes, operador_responsavel_id")
          .eq("documento", documento)
          .maybeSingle(),
        supabase
          .from("contatos_cliente")
          .select("id, tipo, identificador, ordem, tipo_uso, nome_pessoa, observacao, ativo")
          .eq("documento_cliente", documento)
          .eq("ativo", true)
          .order("ordem"),
      ]);
      if (cli.data) {
        setNome(cli.data.nome_amigavel ?? "");
        setSenha(cli.data.senha ?? "");
        setNotes(cli.data.notes ?? "");
        setOpResp(cli.data.operador_responsavel_id ?? operadorSelf.id);
      }
      if (ct.data) {
        const filtered = ct.data
          .filter((c: { tipo: string }) => c.tipo === "email" || c.tipo === "whatsapp")
          .map((c: {
            tipo: string; identificador: string; ordem: number; tipo_uso: string;
            nome_pessoa: string | null; observacao: string | null;
          }) => ({
            canal: c.tipo as "email" | "whatsapp",
            valor: c.identificador,
            ordem: c.ordem ?? 1,
            uso: (c.tipo_uso ?? "geral") as ContatoForm["uso"],
            pessoa: c.nome_pessoa ?? "",
            observacao: c.observacao ?? "",
          }));
        if (filtered.length > 0) setContatos(filtered);
      }
      setLoadingExisting(false);
    })();
  }, [editing, documento, operadorSelf.id]);

  const docDigits = doc.replace(/\D/g, "");
  const docValido = docDigits.length === 11 || docDigits.length === 14;

  const temEmailValido = contatos.some(
    (c) => c.canal === "email" && EMAIL_RE.test(c.valor.trim()),
  );
  const todosContatosValidos = contatos.every((c) => c.valor.trim().length > 0);
  const opRespOk = isGestor ? !!opResp : true;
  const podeSalvar =
    docValido &&
    nome.trim().length > 0 &&
    
    opRespOk &&
    temEmailValido &&
    todosContatosValidos &&
    !loading;

  function updateContato(i: number, patch: Partial<ContatoForm>) {
    setContatos((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }
  function addContato() {
    setContatos((prev) => [
      ...prev,
      {
        canal: "email",
        valor: "",
        ordem: prev.length + 1,
        uso: "geral",
        pessoa: "",
        observacao: "",
      },
    ]);
  }
  function removeContato(i: number) {
    setContatos((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function salvar() {
    setLoading(true);
    try {
      // Validação extra: emails
      for (const c of contatos) {
        if (c.canal === "email" && !EMAIL_RE.test(c.valor.trim())) {
          toast.error(`Email inválido: ${c.valor}`);
          setLoading(false);
          return;
        }
      }
      const payload = {
        p_documento: docDigits,
        p_nome: nome.trim(),
        p_senha_tracking: senha.trim(),
        p_contatos: contatos.map((c) => ({
          tipo: c.canal,
          identificador: c.valor.trim(),
          ordem: c.ordem,
          tipo_uso: c.uso,
          nome_pessoa: c.pessoa?.trim() || null,
          observacao: c.observacao?.trim() || null,
        })),
        p_operador_responsavel_id: isGestor ? opResp : null,
        p_notes: notes?.trim() || null,
      };
      const { data, error } = await supabase.rpc("cadastrar_cliente_completo", payload);
      if (error) {
        toast.error(error.message);
        setLoading(false);
        return;
      }
      const nomeFinal = (data as { nome?: string })?.nome ?? nome.trim();
      const inseridos = (data as { contatos_inseridos?: number })?.contatos_inseridos ?? contatos.length;
      const dominios = (data as { dominios_inferidos?: string[] })?.dominios_inferidos ?? [];
      toast.success(
        `Cliente ${nomeFinal} cadastrado. ${inseridos} contatos${
          dominios.length ? ` + ${dominios.length} domínio${dominios.length === 1 ? "" : "s"} inferido${dominios.length === 1 ? "" : "s"}` : ""
        }.`,
      );
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto border-2 border-ink bg-paper">
        <DialogHeader>
          <DialogTitle className="font-display text-[18px]">
            {editing ? "Editar cliente" : "Novo cliente"}
          </DialogTitle>
          <DialogDescription className="font-mono text-[10px] uppercase tracking-widest">
            Dados básicos e contatos usados pelo Cockpit
          </DialogDescription>
        </DialogHeader>

        {loadingExisting ? (
          <div className="py-8 text-center font-display italic text-ink-soft">Carregando…</div>
        ) : (
          <>
            {/* Seção 1 — dados básicos */}
            <section className="space-y-3">
              <h3 className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                Dados do cliente
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                    CNPJ / CPF *
                  </label>
                  <input
                    value={doc}
                    onChange={(e) => setDoc(maskDocInput(e.target.value))}
                    readOnly={editing}
                    placeholder="00.000.000/0000-00"
                    className={cn(
                      "mt-1 w-full border-2 border-ink bg-paper px-2 py-1.5 font-mono text-[12px]",
                      editing && "bg-paper-deep/40 text-ink-soft",
                    )}
                  />
                  {!docValido && doc.length > 0 && (
                    <p className="mt-0.5 font-mono text-[10px] text-sal">
                      Documento deve ter 11 (CPF) ou 14 (CNPJ) dígitos.
                    </p>
                  )}
                </div>
                <div>
                  <label className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                    Nome do cliente *
                  </label>
                  <input
                    value={nome}
                    onChange={(e) => setNome(e.target.value)}
                    placeholder="Ex: INOVAMED"
                    className="mt-1 w-full border-2 border-ink bg-paper px-2 py-1.5 font-mono text-[12px]"
                  />
                </div>
                <div className="col-span-2">
                  <label className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                    Operador responsável *
                  </label>
                  {isGestor ? (
                    <select
                      value={opResp}
                      onChange={(e) => setOpResp(e.target.value)}
                      className="mt-1 w-full border-2 border-ink bg-paper px-2 py-1.5 font-mono text-[12px]"
                    >
                      <option value="">Selecione…</option>
                      {operadores
                        .filter((o) => o.papel === "operador")
                        .map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.nome} — {o.email}
                          </option>
                        ))}
                    </select>
                  ) : (
                    <div className="mt-1 border-2 border-ink/30 bg-paper-deep/40 px-2 py-1.5 font-mono text-[12px] text-ink-soft">
                      Você ({operadorSelf.nome})
                    </div>
                  )}
                </div>
                <div className="col-span-2">
                  <label className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                    Observações
                  </label>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={2}
                    className="mt-1 w-full border-2 border-ink bg-paper px-2 py-1.5 font-mono text-[12px]"
                  />
                </div>
              </div>
            </section>

            {/* Seção 2 — contatos */}
            <section className="mt-4 space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                  Contatos *
                </h3>
                <button
                  type="button"
                  onClick={addContato}
                  className="inline-flex items-center gap-1 border border-ink/30 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink hover:border-ink"
                >
                  <Plus className="h-3 w-3" /> Adicionar contato
                </button>
              </div>

              <div className="space-y-2">
                {contatos.map((c, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-12 gap-2 border-2 border-ink/20 bg-paper-deep/20 p-2"
                  >
                    <select
                      value={c.canal}
                      onChange={(e) =>
                        updateContato(i, { canal: e.target.value as ContatoForm["canal"] })
                      }
                      className="col-span-2 border border-ink/40 bg-paper px-1.5 py-1 font-mono text-[11px]"
                    >
                      <option value="email">Email</option>
                      <option value="whatsapp">WhatsApp</option>
                    </select>
                    <input
                      value={c.valor}
                      onChange={(e) => updateContato(i, { valor: e.target.value })}
                      placeholder={c.canal === "email" ? "email@cliente.com" : "31999998888"}
                      className="col-span-4 border border-ink/40 bg-paper px-1.5 py-1 font-mono text-[11px]"
                    />
                    <input
                      type="number"
                      min={1}
                      value={c.ordem}
                      onChange={(e) =>
                        updateContato(i, { ordem: Math.max(1, parseInt(e.target.value) || 1) })
                      }
                      className="col-span-1 border border-ink/40 bg-paper px-1.5 py-1 font-mono text-[11px]"
                      title="Ordem"
                    />
                    <select
                      value={c.uso}
                      onChange={(e) =>
                        updateContato(i, { uso: e.target.value as ContatoForm["uso"] })
                      }
                      className="col-span-2 border border-ink/40 bg-paper px-1.5 py-1 font-mono text-[11px]"
                    >
                      <option value="geral">Geral</option>
                      <option value="cobranca">Cobrança</option>
                      <option value="logistico">Logístico</option>
                      <option value="financeiro">Financeiro</option>
                      <option value="comercial">Comercial</option>
                    </select>
                    <input
                      value={c.pessoa}
                      onChange={(e) => updateContato(i, { pessoa: e.target.value })}
                      placeholder="Pessoa"
                      className="col-span-2 border border-ink/40 bg-paper px-1.5 py-1 font-mono text-[11px]"
                    />
                    <button
                      type="button"
                      disabled={contatos.length <= 1}
                      onClick={() => removeContato(i)}
                      className="col-span-1 border border-ink/30 px-1 font-mono text-[11px] text-sal hover:border-sal disabled:opacity-30 disabled:hover:border-ink/30"
                      title="Remover"
                    >
                      🗑
                    </button>
                    <input
                      value={c.observacao}
                      onChange={(e) => updateContato(i, { observacao: e.target.value })}
                      placeholder="Observação (opcional)"
                      className="col-span-12 border border-ink/40 bg-paper px-1.5 py-1 font-mono text-[11px]"
                    />
                  </div>
                ))}
              </div>

              {!temEmailValido && (
                <p className="font-mono text-[10px] text-sal">
                  Pelo menos 1 contato canal=email com email válido é obrigatório.
                </p>
              )}
            </section>

            <DialogFooter className="mt-4 gap-2">
              <button
                onClick={onClose}
                className="border-2 border-ink bg-paper px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-ink hover:bg-paper-deep"
              >
                Cancelar
              </button>
              <button
                onClick={salvar}
                disabled={!podeSalvar}
                className="border-2 border-ink bg-ink px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-paper hover:bg-paper hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-ink disabled:hover:text-paper"
              >
                {loading ? "Salvando…" : "Salvar"}
              </button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
