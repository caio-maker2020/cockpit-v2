// =============================================================================
// Pdi1a1 — ritual de 1:1: Caio grava no iPhone, sobe o áudio aqui; a edge
// pdi-processar-1a1 transcreve (OpenAI, ADR 0029) e resume (Sonnet); os
// compromissos viram cards no kanban automaticamente. Resumo é visível pra
// Isadora (decisão Caio 16/09); a nota privada do Caio vive em tabela com RLS
// só dele — pra Isadora ela não existe.
// =============================================================================
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { Chip } from "@/components/cockpit/Chip";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ehCaioPdi, type Pdi1a1Row } from "@/lib/pdi";

const STATUS_1A1: Record<string, { rotulo: string; tone: "neutral" | "warning" | "positive" | "crit" }> = {
  aguardando_audio: { rotulo: "Aguardando áudio", tone: "neutral" },
  processando: { rotulo: "Transcrevendo e resumindo…", tone: "warning" },
  resumido: { rotulo: "Resumida ✓", tone: "positive" },
  erro: { rotulo: "Erro no processamento", tone: "crit" },
};

export default function Pdi1a1() {
  const { user } = useAuth();
  const caio = ehCaioPdi(user?.email);
  const qc = useQueryClient();
  const [subindo, setSubindo] = useState<string | null>(null);

  const { data: sessoes = [] } = useQuery({
    queryKey: ["pdi-1a1"],
    enabled: !!supabase,
    refetchInterval: (q) =>
      (q.state.data as Pdi1a1Row[] | undefined)?.some((s) => s.status === "processando") ? 5000 : false,
    queryFn: async () => {
      const { data, error } = await supabase!.from("pdi_1a1").select("*")
        .order("data", { ascending: false }).order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Pdi1a1Row[];
    },
  });
  const { data: notas = {} } = useQuery({
    queryKey: ["pdi-1a1-notas"],
    enabled: !!supabase && caio,
    queryFn: async () => {
      const { data, error } = await supabase!.from("pdi_1a1_notas_caio").select("sessao_id, nota");
      if (error) throw error;
      return Object.fromEntries(((data ?? []) as Array<{ sessao_id: string; nota: string }>)
        .map((n) => [n.sessao_id, n.nota]));
    },
  });

  const recarregar = () => {
    void qc.invalidateQueries({ queryKey: ["pdi-1a1"] });
    void qc.invalidateQueries({ queryKey: ["pdi-todos"] });
  };

  const novaSessao = async () => {
    const { error } = await supabase!.from("pdi_1a1").insert({});
    if (error) { toast.error(error.message); return; }
    recarregar();
  };

  const subirAudio = async (sessao: Pdi1a1Row, file: File) => {
    if (file.size > 25 * 1024 * 1024) {
      toast.error("Arquivo acima de 25MB — grave em qualidade comprimida ou divida a gravação.");
      return;
    }
    setSubindo(sessao.id);
    try {
      const ext = (file.name.split(".").pop() || "m4a").toLowerCase();
      const path = `${sessao.id}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase!.storage.from("pdi_1a1")
        .upload(path, file, { contentType: file.type || "audio/m4a", upsert: false });
      if (upErr) throw upErr;
      const { error: rowErr } = await supabase!.from("pdi_1a1")
        .update({ audio_path: path, status: "processando", erro: null }).eq("id", sessao.id);
      if (rowErr) throw rowErr;
      recarregar();
      const { error: fnErr } = await supabase!.functions.invoke("pdi-processar-1a1", {
        body: { sessao_id: sessao.id },
      });
      if (fnErr) throw fnErr;
      toast.success("Áudio processado — resumo pronto.");
    } catch (e) {
      toast.error(`Falhou: ${e instanceof Error ? e.message : String(e)} (o áudio não se perde — use Reprocessar)`);
    } finally {
      setSubindo(null);
      recarregar();
    }
  };

  const reprocessar = async (sessao: Pdi1a1Row) => {
    setSubindo(sessao.id);
    const { error } = await supabase!.functions.invoke("pdi-processar-1a1", {
      body: { sessao_id: sessao.id },
    });
    setSubindo(null);
    if (error) { toast.error(`Reprocesso falhou: ${error.message}`); }
    else toast.success("Reprocessado.");
    recarregar();
  };

  const salvarNota = async (sessaoId: string, nota: string) => {
    const { error } = await supabase!.from("pdi_1a1_notas_caio")
      .upsert({ sessao_id: sessaoId, nota, updated_at: new Date().toISOString() });
    if (error) { toast.error(error.message); return; }
    toast.success("Nota privada salva.");
    void qc.invalidateQueries({ queryKey: ["pdi-1a1-notas"] });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[12.5px] text-ink-mute">
          Grave a reunião no celular; suba o arquivo aqui. A IA transcreve, resume e joga os
          compromissos no kanban da Isadora.
        </p>
        {caio && <Button size="sm" onClick={novaSessao}>+ Nova sessão 1:1</Button>}
      </div>

      {sessoes.length === 0 && (
        <div className="rounded-lg border border-rule bg-paper p-6 text-center text-[13.5px] text-ink-mute">
          Nenhum 1:1 registrado ainda.
        </div>
      )}

      {sessoes.map((s) => {
        const st = STATUS_1A1[s.status] ?? STATUS_1A1.aguardando_audio;
        const r = s.resumo ?? {};
        return (
          <section key={s.id} className="rounded-lg border border-rule bg-paper p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[15px] font-semibold text-ink-2">
                1:1 de {s.data.slice(8, 10)}/{s.data.slice(5, 7)}/{s.data.slice(0, 4)}
              </span>
              <Chip tone={st.tone}>{st.rotulo}</Chip>
            </div>

            {s.status === "erro" && s.erro && (
              <p className="mt-2 rounded bg-signal-soft px-3 py-2 text-[13px] text-signal-strong">{s.erro}</p>
            )}

            {caio && (s.status === "aguardando_audio" || s.status === "erro") && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <label className="cursor-pointer rounded-md border border-rule px-3 py-1.5 text-[13px] font-medium text-ink-2 hover:border-ink/40">
                  {subindo === s.id ? "Enviando…" : s.audio_path ? "Trocar áudio" : "Anexar áudio da reunião"}
                  <input type="file" accept="audio/*,.m4a,.mp3,.wav,.aac" className="hidden"
                    disabled={subindo === s.id}
                    onChange={(ev) => {
                      const f = ev.target.files?.[0];
                      if (f) void subirAudio(s, f);
                      ev.target.value = "";
                    }} />
                </label>
                {s.audio_path && (
                  <Button size="sm" variant="outline" disabled={subindo === s.id}
                    onClick={() => void reprocessar(s)}>
                    Reprocessar
                  </Button>
                )}
              </div>
            )}

            {s.status === "resumido" && (
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                <BlocoResumo titulo="Pauta tratada" itens={r.pauta ?? []} />
                <BlocoResumo titulo="Feedbacks" itens={r.feedbacks ?? []} />
                <div>
                  <h4 className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-mute">
                    Compromissos (viram cards no kanban)
                  </h4>
                  <ul className="mt-1 space-y-1">
                    {(r.compromissos ?? []).map((c, i) => (
                      <li key={i} className="text-[13.5px] text-ink-2">
                        • {c.titulo}
                        <span className="ml-1 font-mono text-[11px] text-ink-mute">
                          [{c.responsavel ?? "isadora"}{c.prazo ? ` · até ${c.prazo}` : ""}]
                        </span>
                      </li>
                    ))}
                    {(r.compromissos ?? []).length === 0 && <li className="text-[13px] text-ink-mute">nenhum</li>}
                  </ul>
                </div>
                <BlocoResumo titulo="Sinais de evolução / atenção" itens={r.sinais ?? []} />
                {s.transcricao && (
                  <details className="md:col-span-2">
                    <summary className="cursor-pointer font-mono text-[11px] uppercase text-ink-mute">
                      transcrição completa
                    </summary>
                    <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded bg-surface p-3 text-[12.5px] text-ink-mute">
                      {s.transcricao}
                    </p>
                  </details>
                )}
              </div>
            )}

            {caio && (
              <div className="mt-4 border-t border-rule pt-3">
                <h4 className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-signal">
                  Nota privada (só você vê)
                </h4>
                <NotaPrivada valorInicial={(notas as Record<string, string>)[s.id] ?? ""}
                  onSalvar={(v) => void salvarNota(s.id, v)} />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function BlocoResumo({ titulo, itens }: { titulo: string; itens: string[] }) {
  return (
    <div>
      <h4 className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-mute">{titulo}</h4>
      <ul className="mt-1 space-y-1">
        {itens.map((x, i) => <li key={i} className="text-[13.5px] text-ink-2">• {x}</li>)}
        {itens.length === 0 && <li className="text-[13px] text-ink-mute">—</li>}
      </ul>
    </div>
  );
}

function NotaPrivada({ valorInicial, onSalvar }: { valorInicial: string; onSalvar: (v: string) => void }) {
  const [v, setV] = useState(valorInicial);
  return (
    <div className="mt-1 space-y-2">
      <Textarea rows={2} value={v} placeholder="Percepções que ficam só com você…"
        onChange={(e) => setV(e.target.value)} />
      <Button size="sm" variant="outline" onClick={() => onSalvar(v)}>Salvar nota</Button>
    </div>
  );
}
