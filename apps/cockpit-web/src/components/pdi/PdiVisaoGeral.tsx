// =============================================================================
// PdiVisaoGeral — as 3 frentes (gating do Caio) + detalhe da frente aberta:
// treinamentos, frameworks (documento vivo) e entregas com aceite.
// Regra: entregue ≠ validado — o aceite é do Caio, via RPC (servidor decide).
// Visual: idioma do Cockpit (ticket-card, pílula de header, botões sal).
// =============================================================================
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { Chip } from "@/components/cockpit/Chip";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { BotaoLinha, BotaoSal, Callout, Cartao, ChipCodigo, Rotulo } from "./pdi-ui";
import { ehCaioPdi, type PdiEntregaRow, type PdiFrenteRow } from "@/lib/pdi";

interface TreinamentoRow {
  id: string; frente_id: number; titulo: string; resumo: string | null; realizado_em: string | null;
}
interface FrameworkRow {
  id: string; frente_id: number; titulo: string; conteudo: string; versao: number;
}

const STATUS_ENTREGA: Record<string, { rotulo: string; tone: "neutral" | "warning" | "positive" | "crit" }> = {
  a_fazer: { rotulo: "A fazer", tone: "neutral" },
  fazendo: { rotulo: "Em andamento", tone: "warning" },
  entregue: { rotulo: "Aguarda aceite", tone: "warning" },
  validada: { rotulo: "Validada ✓", tone: "positive" },
  devolvida: { rotulo: "Devolvida", tone: "crit" },
};

export default function PdiVisaoGeral({ onIrParaDemanda }: { onIrParaDemanda: () => void }) {
  const { user } = useAuth();
  const caio = ehCaioPdi(user?.email);
  const qc = useQueryClient();
  const [frenteAberta, setFrenteAberta] = useState<number>(1);
  const [confirmaLiberar, setConfirmaLiberar] = useState<number | null>(null);

  const { data: frentes = [] } = useQuery({
    queryKey: ["pdi-frentes"],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!.from("pdi_frentes").select("*").order("id");
      if (error) throw error;
      return (data ?? []) as PdiFrenteRow[];
    },
  });
  const { data: entregas = [] } = useQuery({
    queryKey: ["pdi-entregas"],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!.from("pdi_entregas").select("*").order("prazo");
      if (error) throw error;
      return (data ?? []) as PdiEntregaRow[];
    },
  });
  const { data: treinamentos = [] } = useQuery({
    queryKey: ["pdi-treinamentos"],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!.from("pdi_treinamentos").select("*")
        .order("realizado_em", { ascending: false });
      if (error) throw error;
      return (data ?? []) as TreinamentoRow[];
    },
  });
  const { data: frameworks = [] } = useQuery({
    queryKey: ["pdi-frameworks"],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!.from("pdi_frameworks").select("*").order("created_at");
      if (error) throw error;
      return (data ?? []) as FrameworkRow[];
    },
  });

  const invalidar = () => {
    void qc.invalidateQueries({ queryKey: ["pdi-frentes"] });
    void qc.invalidateQueries({ queryKey: ["pdi-entregas"] });
    void qc.invalidateQueries({ queryKey: ["pdi-treinamentos"] });
    void qc.invalidateQueries({ queryKey: ["pdi-frameworks"] });
  };

  const liberar = useMutation({
    mutationFn: async (frenteId: number) => {
      const { error } = await supabase!.rpc("pdi_liberar_frente", { p_frente_id: frenteId });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Frente liberada pra Isadora."); setConfirmaLiberar(null); invalidar(); },
    onError: (e: Error) => toast.error(`Não liberou: ${e.message}`),
  });

  const frente = frentes.find((f) => f.id === frenteAberta);
  const frenteLiberada = frente?.liberada ?? false;

  return (
    <div className="mx-auto max-w-[1060px] space-y-5">
      {/* cards das 3 frentes — idioma ticket-card com espinha */}
      <div className="grid gap-3 md:grid-cols-3">
        {frentes.map((f) => {
          const ents = entregas.filter((e) => e.frente_id === f.id);
          const validadas = ents.filter((e) => e.status === "validada").length;
          const ativa = frenteAberta === f.id;
          return (
            <div
              key={f.id}
              role="button"
              tabIndex={0}
              onClick={() => setFrenteAberta(f.id)}
              onKeyDown={(ev) => { if (ev.key === "Enter") setFrenteAberta(f.id); }}
              className={`ticket-card cursor-pointer border-l-2 p-4 ${
                f.liberada ? "border-l-sal" : "border-l-transparent opacity-75"
              } ${ativa ? "ring-2 ring-ink/70" : ""}`}
            >
              <div className="flex items-center justify-between gap-2">
                <Rotulo>Frente {f.id}</Rotulo>
                <Chip tone={f.liberada ? "positive" : "neutral"}>
                  {f.liberada ? "Liberada" : "🔒 Bloqueada"}
                </Chip>
              </div>
              <div className="mt-1 text-[16px] font-semibold leading-snug text-ink-2">{f.nome}</div>
              <p className="mt-1 text-[12.5px] leading-snug text-ink-mute">{f.descricao}</p>
              {f.liberada && ents.length > 0 && (
                <div className="mt-2"><ChipCodigo>validadas {validadas}/{ents.length}</ChipCodigo></div>
              )}
              {caio && !f.liberada && (
                <div className="mt-3" onClick={(ev) => ev.stopPropagation()}>
                  {confirmaLiberar === f.id ? (
                    <BotaoSal disabled={liberar.isPending} onClick={() => liberar.mutate(f.id)}>
                      Confirmar liberação
                    </BotaoSal>
                  ) : (
                    <BotaoLinha onClick={() => setConfirmaLiberar(f.id)}>Liberar frente</BotaoLinha>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* detalhe da frente selecionada */}
      {frente && !frenteLiberada && (
        <Cartao className="text-center">
          <p className="text-[13.5px] text-ink-mute">
            🔒 Esta frente ainda não foi liberada pelo Caio. O conteúdo aparece aqui quando o
            treinamento dela começar.
          </p>
        </Cartao>
      )}
      {frente && frenteLiberada && (
        <div className="grid gap-5 lg:grid-cols-2">
          <SecaoTreinamentos frenteId={frente.id} treinamentos={treinamentos.filter((t) => t.frente_id === frente.id)} caio={caio} aoMudar={invalidar} />
          <SecaoFrameworks frameworks={frameworks.filter((fw) => fw.frente_id === frente.id)} caio={caio} frenteId={frente.id} aoMudar={invalidar} />
          <div className="lg:col-span-2">
            <SecaoEntregas entregas={entregas.filter((e) => e.frente_id === frente.id)} caio={caio} frenteId={frente.id} aoMudar={invalidar} onIrParaDemanda={onIrParaDemanda} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── treinamentos ──────────────────────────────────────────────────────────────
function SecaoTreinamentos({ frenteId, treinamentos, caio, aoMudar }: {
  frenteId: number; treinamentos: TreinamentoRow[]; caio: boolean; aoMudar: () => void;
}) {
  const [novo, setNovo] = useState(false);
  const [titulo, setTitulo] = useState("");
  const [resumo, setResumo] = useState("");
  const salvar = async () => {
    if (!titulo.trim()) return;
    const { error } = await supabase!.from("pdi_treinamentos")
      .insert({ frente_id: frenteId, titulo, resumo, realizado_em: new Date().toISOString().slice(0, 10) });
    if (error) { toast.error(error.message); return; }
    setNovo(false); setTitulo(""); setResumo(""); aoMudar();
  };
  return (
    <Cartao>
      <div className="flex items-center justify-between">
        <Rotulo>Treinamentos</Rotulo>
        {caio && <BotaoLinha onClick={() => setNovo((v) => !v)}>+ registrar</BotaoLinha>}
      </div>
      {novo && (
        <div className="mt-2 space-y-2 rounded-[10px] border border-rule p-3">
          <Input placeholder="Título do treinamento" value={titulo} onChange={(e) => setTitulo(e.target.value)} />
          <Textarea placeholder="Resumo do que foi treinado" value={resumo} onChange={(e) => setResumo(e.target.value)} />
          <BotaoSal onClick={salvar}>Salvar</BotaoSal>
        </div>
      )}
      <ul className="mt-2.5 space-y-2">
        {treinamentos.length === 0 && <li className="text-[13px] text-ink-mute">Nenhum treinamento registrado ainda.</li>}
        {treinamentos.map((t) => (
          <li key={t.id} className="rounded-[10px] border border-rule p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[14px] font-semibold text-ink-2">{t.titulo}</span>
              {t.realizado_em && <ChipCodigo>{t.realizado_em.slice(8, 10)}/{t.realizado_em.slice(5, 7)}</ChipCodigo>}
            </div>
            {t.resumo && <p className="mt-1 whitespace-pre-wrap text-[13px] text-ink-mute">{t.resumo}</p>}
          </li>
        ))}
      </ul>
    </Cartao>
  );
}

// ── frameworks (documento vivo, versionado) ───────────────────────────────────
function SecaoFrameworks({ frameworks, caio, frenteId, aoMudar }: {
  frameworks: FrameworkRow[]; caio: boolean; frenteId: number; aoMudar: () => void;
}) {
  const [editando, setEditando] = useState<string | null>(null);
  const [texto, setTexto] = useState("");
  const [novoTitulo, setNovoTitulo] = useState("");

  const salvarEdicao = async (fw: FrameworkRow) => {
    const { error } = await supabase!.from("pdi_frameworks")
      .update({ conteudo: texto, versao: fw.versao + 1, updated_at: new Date().toISOString() })
      .eq("id", fw.id);
    if (error) { toast.error(error.message); return; }
    toast.success(`"${fw.titulo}" salvo (v${fw.versao + 1}).`);
    setEditando(null); aoMudar();
  };
  const criar = async () => {
    if (!novoTitulo.trim()) return;
    const { error } = await supabase!.from("pdi_frameworks")
      .insert({ frente_id: frenteId, titulo: novoTitulo, conteudo: "" });
    if (error) { toast.error(error.message); return; }
    setNovoTitulo(""); aoMudar();
  };

  return (
    <Cartao>
      <Rotulo>Frameworks — documentos vivos</Rotulo>
      <ul className="mt-2.5 space-y-2">
        {frameworks.map((fw) => (
          <li key={fw.id} className="rounded-[10px] border border-rule p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[14px] font-semibold text-ink-2">{fw.titulo}</span>
              <div className="flex items-center gap-2">
                <ChipCodigo>v{fw.versao}</ChipCodigo>
                <BotaoLinha
                  onClick={() => { setEditando(editando === fw.id ? null : fw.id); setTexto(fw.conteudo); }}>
                  {editando === fw.id ? "fechar" : "editar"}
                </BotaoLinha>
              </div>
            </div>
            {editando === fw.id ? (
              <div className="mt-2 space-y-2">
                <Textarea rows={8} value={texto} onChange={(e) => setTexto(e.target.value)} />
                <BotaoSal onClick={() => void salvarEdicao(fw)}>Salvar nova versão</BotaoSal>
              </div>
            ) : (
              <pre className="mt-2 whitespace-pre-wrap font-sans text-[13px] text-ink-mute">{fw.conteudo || "—"}</pre>
            )}
          </li>
        ))}
      </ul>
      {caio && (
        <div className="mt-3 flex items-center gap-2">
          <Input placeholder="Novo framework (título)" value={novoTitulo} onChange={(e) => setNovoTitulo(e.target.value)} />
          <BotaoLinha className="shrink-0" onClick={criar}>Criar</BotaoLinha>
        </div>
      )}
    </Cartao>
  );
}

// ── entregas (com definição de pronto + aceite do Caio) ───────────────────────
function SecaoEntregas({ entregas, caio, frenteId, aoMudar, onIrParaDemanda }: {
  entregas: PdiEntregaRow[]; caio: boolean; frenteId: number; aoMudar: () => void;
  onIrParaDemanda: () => void;
}) {
  const [novo, setNovo] = useState(false);
  const [nTitulo, setNTitulo] = useState("");
  const [nDod, setNDod] = useState("");
  const [nPrazo, setNPrazo] = useState("");
  const [conteudoDraft, setConteudoDraft] = useState<Record<string, string>>({});
  const [devolutiva, setDevolutiva] = useState<Record<string, string>>({});

  const atualizar = async (id: string, patch: Record<string, unknown>, msg?: string) => {
    const { error } = await supabase!.from("pdi_entregas").update(patch).eq("id", id);
    if (error) { toast.error(error.message); return; }
    if (msg) toast.success(msg);
    aoMudar();
  };
  const validar = async (id: string, aceita: boolean) => {
    const { error } = await supabase!.rpc("pdi_validar_entrega", {
      p_id: id, p_aceita: aceita, p_devolutiva: devolutiva[id] ?? null,
    });
    if (error) { toast.error(error.message); return; }
    toast.success(aceita ? "Entrega validada." : "Entrega devolvida com devolutiva.");
    aoMudar();
  };
  const criar = async () => {
    if (!nTitulo.trim() || !nDod.trim()) { toast.error("Título e definição de pronto são obrigatórios."); return; }
    const { error } = await supabase!.from("pdi_entregas").insert({
      frente_id: frenteId, titulo: nTitulo, definicao_de_pronto: nDod, prazo: nPrazo || null,
    });
    if (error) { toast.error(error.message); return; }
    setNovo(false); setNTitulo(""); setNDod(""); setNPrazo(""); aoMudar();
  };

  const hoje = new Date().toISOString().slice(0, 10);
  const atrasada = (e: PdiEntregaRow) => e.prazo != null && e.status !== "validada" && e.prazo < hoje;

  return (
    <Cartao>
      <div className="flex items-center justify-between">
        <Rotulo>Entregas — entregue ≠ validado</Rotulo>
        {caio && <BotaoLinha onClick={() => setNovo((v) => !v)}>+ nova entrega</BotaoLinha>}
      </div>
      {novo && (
        <div className="mt-2 space-y-2 rounded-[10px] border border-rule p-3">
          <Input placeholder="Título da entrega" value={nTitulo} onChange={(e) => setNTitulo(e.target.value)} />
          <Textarea placeholder="Definição de pronto (critério objetivo de 'entregue')" value={nDod} onChange={(e) => setNDod(e.target.value)} />
          <Input type="date" className="max-w-[180px]" value={nPrazo} onChange={(e) => setNPrazo(e.target.value)} />
          <BotaoSal onClick={criar}>Criar entrega</BotaoSal>
        </div>
      )}
      <ul className="mt-3 space-y-3">
        {entregas.length === 0 && <li className="text-[13px] text-ink-mute">Sem entregas nesta frente ainda.</li>}
        {entregas.map((e) => {
          const st = STATUS_ENTREGA[e.status] ?? STATUS_ENTREGA.a_fazer;
          const podeEditarConteudo = ["a_fazer", "fazendo", "devolvida"].includes(e.status);
          // Entrega estruturada: o registro acontece no formulário do Mapa de
          // Demanda (campos travados), NUNCA em texto livre (Caio 16/09). O
          // texto aqui é só a leitura final da definição de pronto.
          const ehMapaDemanda = e.titulo.startsWith("Mapa de Demanda");
          return (
            <li key={e.id} className={`ticket-card border-l-2 p-4 ${e.status === "devolvida" || atrasada(e) ? "border-l-sal" : "border-l-transparent"}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[15px] font-semibold text-ink-2">{e.titulo}</span>
                <div className="flex items-center gap-2">
                  {e.prazo && (
                    <ChipCodigo>
                      <span className={atrasada(e) ? "text-signal" : undefined}>
                        prazo {e.prazo.slice(8, 10)}/{e.prazo.slice(5, 7)}{atrasada(e) ? " · ATRASADA" : ""}
                      </span>
                    </ChipCodigo>
                  )}
                  <Chip tone={st.tone}>{st.rotulo}</Chip>
                </div>
              </div>
              <p className="mt-1 text-[12.5px] leading-snug text-ink-mute">
                <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.1em]">Pronto quando: </span>
                {e.definicao_de_pronto}
              </p>
              {e.status === "devolvida" && e.devolutiva && (
                <div className="mt-2">
                  <Callout titulo="Devolvida pelo Caio">{e.devolutiva}</Callout>
                </div>
              )}
              {ehMapaDemanda && (
                <div className="mt-2">
                  <Callout titulo="O registro é no formulário estruturado">
                    <div className="mt-1">
                      <BotaoSal onClick={onIrParaDemanda}>Abrir o Mapa de Demanda</BotaoSal>
                    </div>
                  </Callout>
                </div>
              )}
              <div className="mt-2">
                <Textarea
                  rows={3}
                  placeholder={ehMapaDemanda
                    ? "Leitura final (5 linhas): qual classe de causa domina e o que você propõe atacar primeiro"
                    : "A entrega em si — escreva/cole aqui (este é o lugar oficial)"}
                  disabled={!podeEditarConteudo}
                  value={conteudoDraft[e.id] ?? e.conteudo}
                  onChange={(ev) => setConteudoDraft((d) => ({ ...d, [e.id]: ev.target.value }))}
                />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {podeEditarConteudo && (
                  <>
                    <BotaoLinha
                      onClick={() => void atualizar(e.id, { conteudo: conteudoDraft[e.id] ?? e.conteudo, status: e.status === "a_fazer" ? "fazendo" : e.status }, "Rascunho salvo.")}>
                      Salvar rascunho
                    </BotaoLinha>
                    <BotaoSal
                      onClick={() => {
                        const c = (conteudoDraft[e.id] ?? e.conteudo).trim();
                        if (c.length < 10) { toast.error("Escreva a entrega antes de entregar."); return; }
                        void atualizar(e.id, { conteudo: c, status: "entregue", entregue_em: new Date().toISOString() }, "Entregue — aguardando aceite do Caio.");
                      }}>
                      Entregar pro Caio
                    </BotaoSal>
                  </>
                )}
                {caio && e.status === "entregue" && (
                  <>
                    <BotaoSal onClick={() => void validar(e.id, true)}>Validar ✓</BotaoSal>
                    <Input className="max-w-xs" placeholder="devolutiva (se for devolver)"
                      value={devolutiva[e.id] ?? ""}
                      onChange={(ev) => setDevolutiva((d) => ({ ...d, [e.id]: ev.target.value }))} />
                    <BotaoLinha onClick={() => void validar(e.id, false)}>Devolver</BotaoLinha>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Cartao>
  );
}
