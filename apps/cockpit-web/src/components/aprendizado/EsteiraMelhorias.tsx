// =============================================================================
// Módulo 3 do Aprendizado — a ESTEIRA: o que está pendente do Caio, o que ele
// já aprovou, e o que está em produção rodando (com antes×depois quando a
// mig 344 estiver aplicada). Plano máquina-de-visão, 21/08.
// Fonte: learning_log (ajustes) + v_melhorias_impacto (números pós-merge).
// =============================================================================
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { agenteAmigavel } from "@/lib/agentesCatalogo";

interface AjusteRow {
  id: string;
  titulo: string | null;
  agente_alvo: string | null;
  status: string;
  created_at: string;
  detalhes: { pr_url?: string; mergeado_em?: string } | null;
}

interface ImpactoRow {
  melhoria_id: string;
  pct_pre: number | null;
  pct_pos: number | null;
  pares_pos: number;
}

const COLUNAS = [
  { id: "pendente", titulo: "Aguardando o Caio", cor: "var(--warning)", fundo: "var(--warning-soft)" },
  { id: "aprovado", titulo: "Aprovado — indo pra produção", cor: "var(--c-ink-soft)", fundo: "var(--bg-subtle)" },
  { id: "producao", titulo: "Em produção", cor: "var(--positive)", fundo: "var(--positive-soft)" },
] as const;

export function EsteiraMelhorias() {
  const ajustes = useQuery({
    queryKey: ["aprendizado", "esteira-ajustes"],
    queryFn: async (): Promise<AjusteRow[]> => {
      const { data, error } = await supabase
        .from("learning_log")
        .select("id, titulo, agente_alvo, status, created_at, detalhes")
        .in("tipo", ["ajuste_sugerido", "ajuste_aprovado", "ajuste_aplicado"])
        .order("created_at", { ascending: false })
        .limit(60);
      if (error) throw error;
      return (data ?? []) as AjusteRow[];
    },
    staleTime: 60_000,
    retry: false,
  });

  const impacto = useQuery({
    queryKey: ["aprendizado", "esteira-impacto"],
    queryFn: async (): Promise<ImpactoRow[]> => {
      const { data } = await supabase
        .from("v_melhorias_impacto")
        .select("melhoria_id, pct_pre, pct_pos, pares_pos")
        .limit(200);
      return (data ?? []) as ImpactoRow[];
    },
    staleTime: 60_000,
    retry: false,
  });

  const porColuna = (col: (typeof COLUNAS)[number]["id"]): AjusteRow[] => {
    const rows = ajustes.data ?? [];
    if (col === "pendente") return rows.filter((r) => r.status === "aberto");
    if (col === "aprovado")
      return rows.filter((r) => r.status === "aprovado" && !r.detalhes?.mergeado_em);
    return rows.filter((r) => r.status === "aplicado" || r.detalhes?.mergeado_em);
  };

  const impactoDe = (id: string): ImpactoRow | undefined =>
    (impacto.data ?? []).find((i) => i.melhoria_id === id);

  if (ajustes.isError) {
    return <p className="py-4 text-center text-[13px] text-ink-mute">Esteira indisponível no momento.</p>;
  }

  return (
    <div className="grid gap-3 md:grid-cols-3">
      {COLUNAS.map((col) => {
        const rows = porColuna(col.id);
        return (
          <div key={col.id} className="rounded-xl border border-border bg-bg-elevated p-3">
            <div
              className="mb-2 inline-flex rounded-full px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.1em]"
              style={{ color: col.cor, background: col.fundo }}
            >
              {col.titulo} · {rows.length}
            </div>
            <div className="space-y-2">
              {rows.slice(0, 8).map((r) => {
                const imp = col.id === "producao" ? impactoDe(r.id) : undefined;
                return (
                  <div key={r.id} className="rounded-lg border border-border px-3 py-2.5">
                    <p className="text-[12.5px] font-medium leading-snug text-ink">
                      {(r.titulo ?? "Melhoria").slice(0, 90)}
                    </p>
                    <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                      {agenteAmigavel(r.agente_alvo ?? "")} · {new Date(r.created_at).toLocaleDateString("pt-BR")}
                    </p>
                    {imp && (imp.pct_pre != null || imp.pct_pos != null) && (
                      <p className="mt-1 font-mono text-[12px] font-semibold tabular-nums">
                        <span className="text-ink-mute">{imp.pct_pre ?? "—"}%</span>
                        <span className="mx-1 text-ink-mute">→</span>
                        <span className="text-positive">{imp.pct_pos ?? "—"}%</span>
                        <span className="ml-1 font-normal text-ink-mute">({imp.pares_pos} casos depois)</span>
                      </p>
                    )}
                    {r.detalhes?.pr_url && (
                      <a
                        href={r.detalhes.pr_url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-block font-mono text-[11px] text-sal underline-offset-2 hover:underline"
                      >
                        ver PR →
                      </a>
                    )}
                  </div>
                );
              })}
              {rows.length === 0 && (
                <p className="px-1 py-3 text-center text-[12px] text-ink-mute">nada aqui</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
