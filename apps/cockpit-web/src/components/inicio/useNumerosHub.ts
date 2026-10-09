// =============================================================================
// Números AO VIVO do hub do gestor. Cada número é uma query independente: se um
// falhar, só ele vira "—"; o hub continua de pé.
//
// Relacionamento: três contagens `head` (sem trazer linha nenhuma), com as MESMAS
// regras das colunas do Inbox (KANBAN_COLUMNS em lib/types.ts). Nenhuma query,
// rota ou RLS do Relacionamento é alterada; só se lê.
// Operação: a MESMA query da fila (["op","fila"]) e dos códigos que a tela da
// Operação usa — cache compartilhado, nenhuma chamada nova ao servidor.
// =============================================================================
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useOpApi } from "@/contexts/OperacaoContext";
import { useFiltroOperadorStore } from "@/stores/useFiltroOperadorStore";
import { OCS_AGUARDANDO_CLIENTE } from "@/lib/types";
import { OPERACAO_DEMO } from "@/lib/operacao/modoDemo";
import { resumirTorre, avisosDoConselheiro } from "@/lib/operacao/torre";
import { resumirGestao } from "@/lib/operacao/gestao";
import { agruparInbox, type CardInbox } from "@/lib/relacionamento/torre";

export interface Numero {
  valor: number | null;
  carregando: boolean;
  erro: boolean;
}

const AVH = "AGUARDANDO_VALIDACAO_HUMANA";
const FECHADOS = "(CANCELADO,RESOLVIDO,TRANSFERIDO,EXTRAVIO_MONITORADO)";
const OCS = `(${OCS_AGUARDANDO_CLIENTE.join(",")})`;
const REFRESCO_MS = 30_000;

/** As mesmas contas do Inbox, sobre uma lista de cards (usada na demonstração e em teste). */
export function contarRelacionamento(cards: readonly CardInbox[]) {
  const g = agruparInbox(cards, null);
  return {
    aguardando: g.get("validacao")?.length ?? 0,
    clienteRespondeu: g.get("cliente_respondeu")?.length ?? 0,
    slaRisco: cards.filter((c) => c.risco === "alto" && !["CANCELADO", "RESOLVIDO", "TRANSFERIDO", "EXTRAVIO_MONITORADO"].includes(c.state)).length,
  };
}

// Só na demonstração: o import some do bundle de produção (OPERACAO_DEMO vira literal falso).
const carregarDemoRel = OPERACAO_DEMO
  ? () => import("@/lib/relacionamento/demo/dadosDemoRel").then((m) => contarRelacionamento(m.cardsDemoRel()))
  : null;

function num(q: { data?: number | null; isLoading: boolean; isError: boolean }): Numero {
  return { valor: q.data ?? null, carregando: q.isLoading, erro: q.isError };
}

export function useNumerosRelacionamento(ativo: boolean) {
  const filtro = useFiltroOperadorStore((s) => s.operadorId);
  const base = { enabled: ativo && !!supabase && !carregarDemoRel, staleTime: 20_000, refetchInterval: REFRESCO_MS, refetchOnWindowFocus: true, retry: 1 };
  const contar = async (montar: (q: any) => any): Promise<number> => {
    let q = supabase!.from("cards").select("id", { count: "exact", head: true });
    if (filtro) q = q.eq("assigned_operator_id", filtro);
    const { count, error } = await montar(q);
    if (error) throw error;
    return count ?? 0;
  };

  const aguardando = useQuery({
    ...base,
    queryKey: ["hub", "rel", "aguardando", filtro ?? "equipe"],
    // Coluna "Aguardando você": AVH, exceto resposta do cliente às ocs de aguardar cliente.
    queryFn: () => contar((q) => q.eq("state", AVH).or(`cliente_respondeu_em.is.null,cod_ultima_ocorrencia.is.null,cod_ultima_ocorrencia.not.in.${OCS}`)),
  });
  const clienteRespondeu = useQuery({
    ...base,
    queryKey: ["hub", "rel", "cliente-respondeu", filtro ?? "equipe"],
    queryFn: () => contar((q) => q.eq("state", AVH).not("cliente_respondeu_em", "is", null).in("cod_ultima_ocorrencia", OCS_AGUARDANDO_CLIENTE as number[])),
  });
  const slaRisco = useQuery({
    ...base,
    queryKey: ["hub", "rel", "sla-risco", filtro ?? "equipe"],
    // Mesmo critério do "SLA em risco" do Inbox: card ativo com risco alto.
    queryFn: () => contar((q) => q.not("state", "in", FECHADOS).eq("risco", "alto")),
  });

  const demo = useQuery({
    queryKey: ["hub", "rel", "demo"],
    enabled: ativo && !!carregarDemoRel,
    staleTime: Infinity,
    queryFn: () => carregarDemoRel!(),
  });

  if (carregarDemoRel) {
    const d = (k: "aguardando" | "clienteRespondeu" | "slaRisco"): Numero => ({ valor: demo.data?.[k] ?? null, carregando: demo.isLoading, erro: demo.isError });
    return { aguardando: d("aguardando"), clienteRespondeu: d("clienteRespondeu"), slaRisco: d("slaRisco"), escopo: "demonstração" };
  }
  return {
    aguardando: num(aguardando),
    clienteRespondeu: num(clienteRespondeu),
    slaRisco: num(slaRisco),
    escopo: filtro ? "do operador filtrado" : "da equipe toda",
  };
}

export interface NumerosOperacao {
  precisaVoce: Numero;
  comSugestao: Numero;
  conselheiro: Numero;
  gargalo: { unidade: string; paradas: number; setor: string } | null;
  total: Numero;
  carregando: boolean;
  erro: boolean;
}

export function useNumerosOperacao(ativo: boolean): NumerosOperacao {
  const api = useOpApi();
  // MESMAS chaves da tela da Operação (Operacao.tsx): cache e Realtime compartilhados.
  const fila = useQuery({
    queryKey: ["op", "fila"],
    enabled: ativo && !!api,
    refetchInterval: 60_000,
    queryFn: () => api!.fila(),
  });
  const codigos = useQuery({
    queryKey: ["op", "codigos"],
    enabled: ativo && !!api,
    staleTime: 60_000,
    queryFn: () => api!.codigosDisponiveis(),
  });
  const carregando = !api || fila.isLoading;
  const erro = fila.isError;

  const r = useMemo(() => {
    if (!fila.data) return null;
    const agora = Date.now();
    const liberados = codigos.data ? new Set(codigos.data.map((c) => c.codigo)) : null;
    const torre = resumirTorre(fila.data, agora, liberados);
    const avisos = avisosDoConselheiro(fila.data, agora, 99);
    let gargalo: NumerosOperacao["gargalo"] = null;
    try {
      const g = resumirGestao(fila.data, agora).gargalos[0];
      if (g && g.paradas > 0) gargalo = { unidade: g.unidade, paradas: g.paradas, setor: g.nomeSetor };
    } catch {
      gargalo = null;
    }
    return { precisa: torre.duvidas + torre.semSugestao, sugestao: torre.firmesAcao, conselheiro: avisos.length, total: torre.total, gargalo };
  }, [fila.data, codigos.data]);

  const n = (v: number | undefined): Numero => ({ valor: v ?? null, carregando, erro });
  return {
    precisaVoce: n(r?.precisa),
    comSugestao: n(r?.sugestao),
    conselheiro: n(r?.conselheiro),
    total: n(r?.total),
    gargalo: r?.gargalo ?? null,
    carregando,
    erro,
  };
}
