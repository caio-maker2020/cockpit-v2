// =============================================================================
// MelhoriasOrganizadas — a área "o que já foi feito" da aba Aprendizado,
// reorganizada (Caio 08/08: "separação por melhoria, dados logo abaixo
// confirmando melhorou/piorou, abas separadas").
//
// Uma ABA por melhoria. Dentro de cada aba:
//   1. A regra ensinada (resposta da gestão que originou)
//   2. A linha do tempo (respondida → proposta → decisão)
//   3. O IMPACTO VIVO: % de sugestões seguidas ANTES vs DEPOIS da resposta,
//      calculado na hora direto dos casos reais (não depende de snapshot)
//   4. Reabrir quando rejeitada (INV-051 — preservado da trilha antiga)
// =============================================================================
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { TrendingDown, TrendingUp } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { podeReabrir, rotuloRevisao } from "@/lib/melhorias";

const AMIGAVEL: Record<string, string> = {
  "agente-sugere-ocs-padrao": "Agente de recusas",
  "interpretador-resposta-cliente": "Leitor de respostas",
  "agente-oc13-autonomo": "Limitação (oc 13)",
};

const STATUS_META: Record<string, { rotulo: string; classe: string }> = {
  aberto: { rotulo: "aguardando aprovação", classe: "bg-warning-soft text-warning" },
  aprovado: { rotulo: "aprovada — aguarda aplicação", classe: "bg-ai-soft text-ai" },
  aplicado: { rotulo: "aplicada no agente", classe: "bg-positive-soft text-positive" },
  rejeitado: { rotulo: "rejeitada", classe: "bg-negative-soft text-negative" },
  observacao: { rotulo: "em observação", classe: "bg-bg-subtle text-ink-mute" },
  revertido: { rotulo: "revertida", classe: "bg-negative-soft text-negative" },
};

interface MelhoriaOrganizada {
  id: string;
  titulo: string;
  resumo: string | null;
  status: string;
  created_at: string;
  revisado_em: string | null;
  revisor_nome: string | null;
  revisado_por: string | null;
  agente_alvo: string | null;
  chave_padrao: string | null;
  regra_texto: string | null;
  resposta_em: string | null;
  impacto_texto: string | null;
}

function useMelhoriasOrganizadas() {
  return useQuery({
    queryKey: ["aprendizado", "melhorias-organizadas"],
    queryFn: async (): Promise<MelhoriaOrganizada[]> => {
      const { data: ajustes, error } = await supabase
        .from("learning_log")
        .select("id,titulo,resumo,status,created_at,revisado_em,revisado_por,agente_alvo,parent_id,detalhes")
        .eq("agente", "agente-aprendizado")
        .eq("tipo", "ajuste_sugerido")
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      const rows = (ajustes ?? []) as Array<Record<string, unknown>>;
      const parentIds = rows.map((r) => r["parent_id"]).filter(Boolean) as string[];
      const revisorIds = rows.map((r) => r["revisado_por"]).filter(Boolean) as string[];

      const [respostasRes, revisoresRes, impactosRes] = await Promise.all([
        parentIds.length
          ? supabase.from("learning_log").select("id,resumo,created_at,detalhes").in("id", parentIds)
          : Promise.resolve({ data: [] }),
        revisorIds.length
          ? supabase.from("operadores").select("id,nome").in("id", revisorIds)
          : Promise.resolve({ data: [] }),
        parentIds.length
          ? supabase
            .from("learning_log")
            .select("parent_id,resumo,created_at")
            .eq("tipo", "impacto_medido")
            .in("parent_id", parentIds)
            .order("created_at", { ascending: false })
          : Promise.resolve({ data: [] }),
      ]);
      const respostas = new Map(
        ((respostasRes.data ?? []) as Array<Record<string, unknown>>).map((r) => [r["id"], r]),
      );
      const revisores = new Map(
        ((revisoresRes.data ?? []) as Array<{ id: string; nome: string }>).map((r) => [r.id, r.nome]),
      );
      const impactos = new Map<string, string>();
      for (const i of (impactosRes.data ?? []) as Array<Record<string, unknown>>) {
        const pid = i["parent_id"] as string;
        if (!impactos.has(pid)) impactos.set(pid, i["resumo"] as string);
      }

      return rows.map((r) => {
        const det = (r["detalhes"] ?? {}) as Record<string, unknown>;
        const resposta = respostas.get(r["parent_id"] as string) as Record<string, unknown> | undefined;
        return {
          id: r["id"] as string,
          titulo: r["titulo"] as string,
          resumo: (r["resumo"] as string) ?? null,
          status: r["status"] as string,
          created_at: r["created_at"] as string,
          revisado_em: (r["revisado_em"] as string) ?? null,
          revisado_por: (r["revisado_por"] as string) ?? null,
          revisor_nome: revisores.get(r["revisado_por"] as string) ?? null,
          agente_alvo: (r["agente_alvo"] as string) ?? null,
          chave_padrao: (det["chave_padrao"] as string) ?? null,
          regra_texto: ((resposta?.["detalhes"] as Record<string, unknown>)?.["texto"] as string) ??
            (resposta?.["resumo"] as string) ?? null,
          resposta_em: (resposta?.["created_at"] as string) ?? null,
          impacto_texto: impactos.get(r["parent_id"] as string) ?? null,
        };
      });
    },
  });
}

/** % seguidas ANTES (14d pré-resposta) vs DEPOIS (pós-resposta) — ao vivo. */
function ImpactoVivo({ chave, respostaEm }: { chave: string | null; respostaEm: string | null }) {
  const q = useQuery({
    queryKey: ["aprendizado", "impacto-vivo", chave, respostaEm],
    enabled: !!chave && !!respostaEm,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const m = /^(.+):sug(\d+|sem)$/.exec(chave!);
      if (!m) return null;
      const agente = m[1];
      const ocSug = m[2] === "sem" ? null : Number(m[2]);
      const marco = new Date(respostaEm!);
      const antesIni = new Date(marco.getTime() - 14 * 86_400_000).toISOString();

      const contar = async (deQuando: string, ateQuando: string | null, veredito?: string) => {
        let query = supabase
          .from("v_sinal_ouro_casos")
          .select("nf", { count: "exact", head: true })
          .eq("agent_name", agente)
          .in("veredito", veredito ? [veredito] : ["seguida", "corrigida"])
          .gte("decidido_em", deQuando);
        if (ateQuando) query = query.lt("decidido_em", ateQuando);
        if (ocSug !== null) query = query.eq("oc_sugerida", ocSug);
        const { count } = await query;
        return count ?? 0;
      };
      const marcoIso = marco.toISOString();
      const [antesTotal, antesSeguidas, depoisTotal, depoisSeguidas] = await Promise.all([
        contar(antesIni, marcoIso),
        contar(antesIni, marcoIso, "seguida"),
        contar(marcoIso, null),
        contar(marcoIso, null, "seguida"),
      ]);
      return { antesTotal, antesSeguidas, depoisTotal, depoisSeguidas };
    },
  });

  if (!chave || !respostaEm) return null;
  if (!q.data) return <p className="text-[12px] text-ink-mute">calculando impacto…</p>;

  const { antesTotal, antesSeguidas, depoisTotal, depoisSeguidas } = q.data;
  const pctAntes = antesTotal > 0 ? Math.round((100 * antesSeguidas) / antesTotal) : null;
  const pctDepois = depoisTotal > 0 ? Math.round((100 * depoisSeguidas) / depoisTotal) : null;
  const suficiente = depoisTotal >= 8 && pctAntes !== null && pctDepois !== null;
  const delta = suficiente ? pctDepois! - pctAntes! : 0;

  return (
    <div className="rounded-lg border border-border bg-bg p-3">
      <p className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-mute">
        Impacto medido nos casos reais deste padrão
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <p className="text-[11px] text-ink-mute">antes da resposta (14d)</p>
          <p className="font-mono text-[18px] font-semibold tabular-nums text-ink-soft">
            {pctAntes !== null ? `${pctAntes}%` : "—"}
            <span className="ml-1 text-[11px] font-normal text-ink-mute">({antesTotal} casos)</span>
          </p>
        </div>
        <span className="text-ink-mute">→</span>
        <div>
          <p className="text-[11px] text-ink-mute">depois da resposta</p>
          <p className="font-mono text-[18px] font-semibold tabular-nums text-ink">
            {pctDepois !== null ? `${pctDepois}%` : "—"}
            <span className="ml-1 text-[11px] font-normal text-ink-mute">({depoisTotal} casos)</span>
          </p>
        </div>
        {suficiente ? (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-[11px] font-bold ${
              delta > 0
                ? "bg-positive-soft text-positive"
                : delta < 0
                ? "bg-negative-soft text-negative"
                : "bg-bg-subtle text-ink-mute"
            }`}
          >
            {delta > 0 ? <TrendingUp className="h-3 w-3" /> : delta < 0 ? <TrendingDown className="h-3 w-3" /> : null}
            {delta > 0 ? `MELHOROU +${delta} pts` : delta < 0 ? `PIOROU ${delta} pts` : "ESTÁVEL"}
          </span>
        ) : (
          <span className="rounded-full bg-bg-subtle px-2.5 py-1 font-mono text-[11px] text-ink-mute">
            aguardando dados (mín. 8 casos depois)
          </span>
        )}
      </div>
    </div>
  );
}

export function MelhoriasOrganizadas() {
  const melhorias = useMelhoriasOrganizadas();
  const qc = useQueryClient();
  const [aba, setAba] = useState<string | null>(null);

  const reabrir = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("reabrir_learning_log", {
        p_id: id,
        p_motivo: "Reaberto no painel Aprendizado",
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Reaberta — voltou pra fila de aprovação.");
      qc.invalidateQueries({ queryKey: ["aprendizado"] });
    },
    onError: (e: Error) => toast.error(`Não consegui reabrir: ${e.message}`),
  });

  const lista = melhorias.data ?? [];
  const abaAtiva = useMemo(
    () => (aba && lista.some((x) => x.id === aba) ? aba : lista[0]?.id ?? ""),
    [aba, lista],
  );
  if (lista.length === 0) return null;

  return (
    <section aria-label="Melhorias organizadas" className="mt-8">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-[15px] font-semibold text-ink">📚 Melhorias — uma aba por regra ensinada</h2>
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-ink-mute">
          {lista.length} registrada{lista.length > 1 ? "s" : ""}
        </span>
      </div>

      <Tabs value={abaAtiva} onValueChange={setAba}>
        <TabsList className="h-auto w-full flex-wrap justify-start gap-1 bg-bg-subtle p-1">
          {lista.map((m) => (
            <TabsTrigger
              key={m.id}
              value={m.id}
              className="max-w-[220px] truncate text-[12px] data-[state=active]:bg-bg-elevated"
            >
              {m.status === "aplicado" ? "✅ " : m.status === "rejeitado" ? "✖ " : m.status === "aprovado" ? "🕐 " : ""}
              {AMIGAVEL[m.agente_alvo ?? ""] ?? m.agente_alvo ?? "?"}
              {m.chave_padrao ? ` · ${m.chave_padrao.split(":sug")[1] === "sem" ? "geral" : "oc " + m.chave_padrao.split(":sug")[1]}` : ""}
            </TabsTrigger>
          ))}
        </TabsList>

        {lista.map((m) => {
          const st = STATUS_META[m.status] ?? { rotulo: m.status, classe: "bg-bg-subtle text-ink-mute" };
          return (
            <TabsContent key={m.id} value={m.id} className="mt-3">
              <div className="space-y-3 rounded-xl border border-border bg-bg-elevated p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="max-w-[60ch] text-[14px] font-semibold leading-snug text-ink">
                    {m.titulo.replace(/^Melhorar o |^Alinhar o /, "")}
                  </p>
                  <span className={`rounded-full px-2.5 py-1 font-mono text-[10.5px] font-semibold uppercase ${st.classe}`}>
                    {st.rotulo}
                  </span>
                </div>

                {m.regra_texto && (
                  <div>
                    <p className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-mute">
                      A regra ensinada pela gestão
                    </p>
                    <p className="max-w-[70ch] whitespace-pre-line rounded-lg bg-bg-subtle/60 p-3 text-[13px] leading-relaxed text-ink-soft">
                      {m.regra_texto.length > 600 ? m.regra_texto.slice(0, 600) + "…" : m.regra_texto}
                    </p>
                  </div>
                )}

                <p className="font-mono text-[11px] text-ink-mute">
                  {m.resposta_em ? `respondida ${format(new Date(m.resposta_em), "dd/MM", { locale: ptBR })} · ` : ""}
                  proposta {format(new Date(m.created_at), "dd/MM", { locale: ptBR })}
                  {m.revisado_em
                    ? ` · ${rotuloRevisao(m.status, m.revisor_nome, false)} ${format(new Date(m.revisado_em), "dd/MM HH:mm", { locale: ptBR })}`
                    : ""}
                </p>

                <ImpactoVivo chave={m.chave_padrao} respostaEm={m.resposta_em} />

                {m.impacto_texto && (
                  <p className="text-[12px] text-ink-soft">
                    <span className="font-mono text-[10px] uppercase text-ink-mute">medição do agente-chefe: </span>
                    {m.impacto_texto}
                  </p>
                )}

                {podeReabrir(m.status) && (
                  <Button size="sm" variant="outline" onClick={() => reabrir.mutate(m.id)} disabled={reabrir.isPending}>
                    Reabrir esta melhoria
                  </Button>
                )}
              </div>
            </TabsContent>
          );
        })}
      </Tabs>
    </section>
  );
}
