# Lovable — Configurações: cadastro de contatos de escalonamento

**Data:** 2026-05-29
**Backend:** zero mudança. Tabela `contatos_escalonamento` já existe (mig 123 + mig 181) com RLS `gestor` pra modificar.

## Contexto

Hoje os contatos de cobrança escalonada (gerente_base, coordenador_entrega, gerente_relacionamento, **time_ressarcimento**) são cadastrados via SQL direto. Caio agora precisa cadastrar e editar pela interface — principalmente o cargo novo **time_ressarcimento** que o agente IA de oc=49 Caso 1c precisa pra disparar WhatsApp.

**Esta tela só precisa existir pra usuário com `papel='gestor'`.** Operadores comuns não veem.

## Esquema da tabela

```ts
interface ContatoEscalonamento {
  id: string;            // uuid
  cargo: 'gerente_base' | 'coordenador_entrega' | 'gerente_relacionamento' | 'time_ressarcimento';
  nome: string;          // ex: "João Silva"
  telefone: string | null;  // formato Evolution: 5535999990000 (cód país + DDD + número, sem espaços/sinais)
  email: string | null;
  base: string | null;   // código SSW da base (NULL = global, vale pra todas)
  ativo: boolean;
  observacao: string | null;
  created_at: string;
  updated_at: string;
}
```

## Onde criar a tela

Em **Configurações** (rota existente). Nova sub-aba: **"Contatos de escalonamento"** — listada apenas se `currentOperator.papel === 'gestor'`.

```
Configurações
├─ Geral
├─ Templates de email
├─ Contatos de escalonamento  ← NOVO (só gestor vê)
└─ Outras
```

## Layout da página

```
┌─ Contatos de escalonamento ────────────────────────────────────┐
│                                                                  │
│ Filtros: [Cargo: Todos ▾]  [Base: Todos ▾]  [☑ Só ativos]      │
│                                                  [+ Novo contato]│
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐ │
│ │ Nome           │ Cargo            │ Telefone       │ Base │ │
│ ├────────────────────────────────────────────────────────────┤ │
│ │ João Silva     │ Time Ressarcim.  │ 5535999990000  │ —    │ │
│ │ Maria Lopes    │ Gerente Base     │ 5531988887777  │ POE  │ │
│ │ ...                                                          │ │
│ └────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

Cada linha tem ícones de ação à direita: ✏️ Editar / 🗑️ Remover.

## Componente: lista + filtros

```tsx
function ContatosEscalonamentoPage() {
  const { operator } = useCurrentOperator();
  if (operator?.papel !== 'gestor') {
    return <p className="text-ink-mute">Sem permissão. Apenas gestores podem editar contatos de escalonamento.</p>;
  }

  const [filtroCargo, setFiltroCargo] = useState<string>("todos");
  const [filtroBase, setFiltroBase] = useState<string>("todas");
  const [soAtivos, setSoAtivos] = useState(true);

  const { data: contatos, isLoading } = useQuery({
    queryKey: ['contatos_escalonamento', filtroCargo, filtroBase, soAtivos],
    queryFn: async () => {
      let q = supabase
        .from("contatos_escalonamento")
        .select("*")
        .order("cargo")
        .order("nome");
      if (filtroCargo !== "todos") q = q.eq("cargo", filtroCargo);
      if (filtroBase !== "todas") q = q.eq("base", filtroBase);
      if (soAtivos) q = q.eq("ativo", true);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });

  const [modalAberto, setModalAberto] = useState<ContatoEscalonamento | "novo" | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h1 className="font-display text-h4">Contatos de escalonamento</h1>
        <button
          onClick={() => setModalAberto("novo")}
          className="bg-ink text-bg px-4 py-2 rounded font-mono text-caption hover:bg-signal"
        >
          + Novo contato
        </button>
      </div>

      <div className="flex gap-3 items-center text-caption font-mono">
        <span className="text-ink-mute">Cargo:</span>
        <select
          value={filtroCargo}
          onChange={(e) => setFiltroCargo(e.target.value)}
          className="border border-ink-mute/30 rounded px-2 py-1"
        >
          <option value="todos">Todos</option>
          <option value="gerente_base">Gerente de base</option>
          <option value="coordenador_entrega">Coordenador de entrega</option>
          <option value="gerente_relacionamento">Gerente de relacionamento</option>
          <option value="time_ressarcimento">Time Ressarcimento</option>
        </select>
        <label className="flex items-center gap-1 ml-3">
          <input type="checkbox" checked={soAtivos} onChange={(e) => setSoAtivos(e.target.checked)} />
          Só ativos
        </label>
      </div>

      {isLoading ? (
        <p className="text-ink-mute italic">Carregando...</p>
      ) : contatos?.length === 0 ? (
        <p className="text-ink-mute italic">Nenhum contato cadastrado com esses filtros.</p>
      ) : (
        <table className="w-full text-caption">
          <thead>
            <tr className="border-b border-ink-mute/20 text-ink-mute font-mono uppercase tracking-wide">
              <th className="text-left py-2">Nome</th>
              <th className="text-left">Cargo</th>
              <th className="text-left">Telefone</th>
              <th className="text-left">Email</th>
              <th className="text-left">Base</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {contatos.map((c) => (
              <tr key={c.id} className={cn("border-b border-ink-mute/10", !c.ativo && "opacity-50")}>
                <td className="py-2 font-medium">{c.nome}</td>
                <td>{labelCargo(c.cargo)}</td>
                <td className="font-mono">{c.telefone ?? "—"}</td>
                <td className="font-mono">{c.email ?? "—"}</td>
                <td>{c.base ?? <span className="text-ink-mute">global</span>}</td>
                <td className="text-right">
                  <button onClick={() => setModalAberto(c)} title="Editar" className="px-2 hover:text-signal">✏️</button>
                  <button onClick={() => removerContato(c.id)} title="Remover" className="px-2 hover:text-rose-700">🗑️</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {modalAberto && (
        <ModalContato
          contato={modalAberto === "novo" ? null : modalAberto}
          onClose={() => setModalAberto(null)}
        />
      )}
    </div>
  );
}

function labelCargo(c: string): string {
  return {
    gerente_base: "Gerente de base",
    coordenador_entrega: "Coordenador de entrega",
    gerente_relacionamento: "Gerente de relacionamento",
    time_ressarcimento: "Time Ressarcimento",
  }[c] ?? c;
}
```

## Componente: modal de cadastro/edição

```tsx
function ModalContato({ contato, onClose }: { contato: ContatoEscalonamento | null; onClose: () => void }) {
  const isEdit = contato !== null;
  const [form, setForm] = useState({
    cargo: contato?.cargo ?? "time_ressarcimento",
    nome: contato?.nome ?? "",
    telefone: contato?.telefone ?? "",
    email: contato?.email ?? "",
    base: contato?.base ?? "",
    ativo: contato?.ativo ?? true,
    observacao: contato?.observacao ?? "",
  });
  const [salvando, setSalvando] = useState(false);

  async function salvar() {
    // Validação telefone (Evolution exige cód país + DDD + número, só dígitos)
    const telLimpo = form.telefone.replace(/\D/g, "");
    if (form.telefone && !/^\d{12,13}$/.test(telLimpo)) {
      toast.error("Telefone inválido. Use formato: 5535999990000 (cód país + DDD + número, só dígitos)");
      return;
    }

    setSalvando(true);
    const payload = {
      cargo: form.cargo,
      nome: form.nome.trim(),
      telefone: telLimpo || null,
      email: form.email.trim() || null,
      base: form.base.trim() || null,
      ativo: form.ativo,
      observacao: form.observacao.trim() || null,
    };
    const { error } = isEdit
      ? await supabase.from("contatos_escalonamento").update(payload).eq("id", contato!.id)
      : await supabase.from("contatos_escalonamento").insert(payload);
    setSalvando(false);
    if (error) {
      toast.error(`Não consegui salvar: ${error.message}`);
      return;
    }
    toast.success(isEdit ? "Contato atualizado" : "Contato cadastrado");
    queryClient.invalidateQueries({ queryKey: ['contatos_escalonamento'] });
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-bg rounded-lg max-w-lg w-full p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-display text-h6">{isEdit ? "Editar contato" : "Novo contato"}</h3>

        <div>
          <label className="text-caption font-mono text-ink-mute">Cargo *</label>
          <select
            value={form.cargo}
            onChange={(e) => setForm({ ...form, cargo: e.target.value })}
            className="w-full border border-ink-mute/30 rounded px-2 py-1 mt-1"
          >
            <option value="time_ressarcimento">Time Ressarcimento</option>
            <option value="gerente_base">Gerente de base</option>
            <option value="coordenador_entrega">Coordenador de entrega</option>
            <option value="gerente_relacionamento">Gerente de relacionamento</option>
          </select>
        </div>

        <div>
          <label className="text-caption font-mono text-ink-mute">Nome *</label>
          <input
            type="text"
            value={form.nome}
            onChange={(e) => setForm({ ...form, nome: e.target.value })}
            placeholder="Ex: João Silva"
            className="w-full border border-ink-mute/30 rounded px-2 py-1 mt-1"
          />
        </div>

        <div>
          <label className="text-caption font-mono text-ink-mute">Telefone WhatsApp</label>
          <input
            type="text"
            value={form.telefone}
            onChange={(e) => setForm({ ...form, telefone: e.target.value })}
            placeholder="5535999990000 (cód país + DDD + número)"
            className="w-full border border-ink-mute/30 rounded px-2 py-1 mt-1 font-mono"
          />
          <p className="text-caption text-ink-mute mt-1">
            Só dígitos. Ex: 55 (Brasil) + 35 (DDD) + 999990000 = 5535999990000
          </p>
        </div>

        <div>
          <label className="text-caption font-mono text-ink-mute">Email (opcional)</label>
          <input
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="w-full border border-ink-mute/30 rounded px-2 py-1 mt-1"
          />
        </div>

        <div>
          <label className="text-caption font-mono text-ink-mute">Base SSW (opcional)</label>
          <input
            type="text"
            value={form.base}
            onChange={(e) => setForm({ ...form, base: e.target.value })}
            placeholder="Ex: POE, POA. Deixe vazio = vale pra todas as bases"
            className="w-full border border-ink-mute/30 rounded px-2 py-1 mt-1 font-mono"
          />
        </div>

        <div>
          <label className="text-caption font-mono text-ink-mute">Observação (opcional)</label>
          <textarea
            value={form.observacao}
            onChange={(e) => setForm({ ...form, observacao: e.target.value })}
            rows={2}
            className="w-full border border-ink-mute/30 rounded px-2 py-1 mt-1"
          />
        </div>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.ativo}
            onChange={(e) => setForm({ ...form, ativo: e.target.checked })}
          />
          <span className="text-caption">Ativo</span>
        </label>

        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-3 py-1 text-caption text-ink-mute hover:text-ink">
            Cancelar
          </button>
          <button
            onClick={salvar}
            disabled={salvando || !form.nome.trim()}
            className="bg-ink text-bg px-4 py-1 rounded font-mono text-caption hover:bg-signal disabled:opacity-50"
          >
            {salvando ? "Salvando..." : "Salvar"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

## Função `removerContato`

```ts
async function removerContato(id: string) {
  if (!confirm("Remover esse contato? Não dá pra desfazer.")) return;
  const { error } = await supabase.from("contatos_escalonamento").delete().eq("id", id);
  if (error) {
    toast.error(`Não consegui remover: ${error.message}`);
    return;
  }
  toast.success("Contato removido");
  queryClient.invalidateQueries({ queryKey: ['contatos_escalonamento'] });
}
```

## Validação

1. Login como **gestor** → menu Configurações mostra "Contatos de escalonamento".
2. Login como **operador comum** (papel != gestor) → aba não aparece. Se acessar URL direto, vê mensagem "Sem permissão".
3. Clica "+ Novo contato" → modal abre com Cargo default = "Time Ressarcimento".
4. Preenche nome "João Silva" + telefone "5535999990000" → salva. Aparece na lista.
5. Edita telefone → confere que aceita só dígitos. Validação mostra erro se formato inválido.
6. Cadastra 1 contato com cargo="time_ressarcimento" e ativo=true → no card oc=49 Caso 1c (extravio sem qtd) o botão "📱 COBRAR RESSARCIMENTO" agora funciona end-to-end.
7. Desativa o contato → próximo card oc=49 Caso 1c volta a mostrar "cadastre o contato".
8. Remove o contato → idem.

## Por que esse cadastro importa

O **botão "📱 COBRAR RESSARCIMENTO"** do banner agente oc=49 (caso `extravio_sem_qtd`) chama a edge `cobrar-ressarcimento-wpp` que faz `SELECT * FROM contatos_escalonamento WHERE cargo='time_ressarcimento' AND ativo=true`. Sem nenhum contato cadastrado, a edge retorna erro `"Nenhum contato cadastrado em contatos_escalonamento com cargo=time_ressarcimento"` e o operador vê toast pedindo cadastro.

A mesma tabela serve pros 3 cargos existentes (gerente_base / coordenador_entrega / gerente_relacionamento) das cobranças escalonadas — então esta tela substitui edição via SQL pra TODOS os cargos. Reuso total.

Cola no Lovable.
