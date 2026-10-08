// =============================================================================
// Tela da Operação (ADR 0041): a fila dela, o detalhe e o lançamento no SSW
// pelo clique humano sobre a prévia. Rota /operacao e /operacao/:itemId.
//
// Duas abas (pedido do dono, 08/10: "tudo na mesma tela atrapalha a operação"):
//  - Trabalho (principal): faixa compacta da torre + as notas no fluxo da torre + o detalhe.
//  - Torre: o quadro completo (agente principal, regras, especialistas, conselheiro, registro).
// Personas e fluxo de cada uma: docs/OPERACAO-TELA.md.
// =============================================================================
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowDownUp, Columns3, Keyboard, List, Loader2, PowerOff } from "lucide-react";

import { AgentePrincipal, Conselheiro, Especialistas, FaixaFoco, RegistroDoTurno, RegrasDaSal } from "@/components/operacao/TorreOperacao";
import { BarraOperacao } from "@/components/operacao/BarraOperacao";
import { EstadoOperacao } from "@/components/operacao/EstadoOperacao";
import { FILIAL_MINHAS, FILIAL_PADRAO, type EscolhaFilial } from "@/components/operacao/FiliaisOperacao";
import { DetalheItemOperacao } from "@/components/operacao/DetalheItemOperacao";
import { KanbanFluxo } from "@/components/operacao/KanbanFluxo";
import { KanbanOperacao } from "@/components/operacao/KanbanOperacao";
import { ListaFilaOperacao } from "@/components/operacao/ListaFilaOperacao";
import { useAreas, useOpApi, useOpSessao } from "@/contexts/OperacaoContext";
import { useRealtimeTable } from "@/hooks/useRealtimeTable";
import { usePersistentState } from "@/hooks/usePersistentState";
import {
  FILTROS_PADRAO,
  filtrarFila,
  opcoesDaFila,
  ordenarPorTempoParado,
  type FiltrosFila,
} from "@/lib/operacao/fila";
import {
  ETAPAS_FLUXO,
  agruparPorEtapa,
  avisoPorNota,
  avisosDoConselheiro,
  casaFoco,
  contagemPorFilial,
  notasAlertadas,
  ordemDeNavegacao,
  registroDoTurno,
  resumirTorre,
  type EtapaFluxoId,
  type FocoTorre,
} from "@/lib/operacao/torre";
import { cn } from "@/lib/utils";

const CHAVE_FILA = ["op", "fila"] as const;
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
const LIMITE_AVISO = 1000;

function useAgora(intervaloMs = 30_000): number {
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setAgora(Date.now()), intervaloMs);
    return () => clearInterval(t);
  }, [intervaloMs]);
  return agora;
}

export default function Operacao() {
  const { itemId } = useParams<{ itemId?: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const api = useOpApi();
  const { sessao, carregada } = useOpSessao();
  const areas = useAreas();
  const agoraMs = useAgora();
  const membro = sessao?.membro ?? null;

  const [filtros, setFiltros] = usePersistentState<FiltrosFila>("operacao.filtros.v1", FILTROS_PADRAO);
  const [direcao, setDirecao] = usePersistentState<"mais_parado" | "menos_parado">("operacao.ordem.v1", "mais_parado");
  // Kanban é a visão principal (pedido do dono); a lista continua a um clique. Lembrada por navegador.
  // Três visões (pedido do dono, 07/10): por problema (principal), por andamento e lista.
  // 08/10: a visão principal segue o MESMO fluxo da torre (dúvida → firme → segue → conselheiro → enviadas).
  const [visao, setVisao] = usePersistentState<"fluxo" | "problema" | "andamento" | "lista">("operacao.visao.v3", "fluxo");
  const [aba, setAba] = usePersistentState<"trabalho" | "torre">("operacao.aba.v1", "trabalho");
  // Filial (unidade do SSW) lembrada por navegador. "padrão" = as filiais do operador, ou todas.
  const [filialSalva, setFilial] = usePersistentState<EscolhaFilial>("operacao.filial.v1", FILIAL_PADRAO);

  // A tela desligada esconde a fila do membro; o gestor continua vendo para conferir (ADR 0041 D9).
  const podeVerFila = areas.telaLigada || areas.ehGestor;

  const { data: linhas, isLoading, error, isFetching } = useQuery({
    queryKey: CHAVE_FILA,
    enabled: !!api && carregada && podeVerFila,
    // Rede de segurança do Realtime: se o canal cair calado, a fila não congela.
    refetchInterval: 60_000,
    queryFn: () => api!.fila(),
  });

  // Lista de códigos liberados: decide se a sugestão vira botão quando a regra não disse.
  const { data: codigos } = useQuery({
    queryKey: ["op", "codigos"],
    enabled: !!api && carregada && podeVerFila,
    staleTime: 60_000,
    queryFn: () => api!.codigosDisponiveis(),
  });
  const codigosLiberados = useMemo(() => (codigos ? new Set(codigos.map((c) => c.codigo)) : null), [codigos]);

  // Realtime (produção): op_itens e op_lancamentos mudam → refetch da fila e do item aberto.
  const realtimeLigado = !!api && api.modo === "supabase" && podeVerFila;
  useRealtimeTable({ table: "op_itens", queryKeys: [["op"]], enabled: realtimeLigado });
  useRealtimeTable({ table: "op_lancamentos", queryKeys: [["op"]], enabled: realtimeLigado });
  // Demo: o "worker" falso avisa por aqui.
  useEffect(() => {
    if (!api?.assinarMudancas) return;
    return api.assinarMudancas(() => qc.invalidateQueries({ queryKey: ["op"] }));
  }, [api, qc]);

  const todas = useMemo(() => linhas ?? [], [linhas]);
  const ehOperadorDeFilial = !!membro && membro.papel_op !== "supervisor_op" && membro.unidades.length > 0;
  const filial: string | null = filialSalva === FILIAL_PADRAO ? (ehOperadorDeFilial ? FILIAL_MINHAS : null) : filialSalva;
  const daFilial = useMemo(() => {
    if (filial == null) return todas;
    if (filial === FILIAL_MINHAS) return todas.filter((l) => !!l.unidade && !!membro?.unidades.includes(l.unidade));
    return todas.filter((l) => (l.unidade ?? "") === filial);
  }, [todas, filial, membro]);
  const filiais = useMemo(() => contagemPorFilial(todas), [todas]);
  const opcoes = useMemo(() => opcoesDaFila(daFilial), [daFilial]);

  // Foco vindo da torre (especialista, regra, aviso do conselheiro): só recorta a fila, não grava nada.
  const [foco, setFoco] = useState<FocoTorre>(null);
  const [etapaDestaque, setEtapaDestaque] = useState<EtapaFluxoId | null>(null);
  const trabalhoRef = useRef<HTMLDivElement>(null);
  const focar = (f: FocoTorre) => {
    setFoco(f);
    if (f) setAba("trabalho");
  };
  const visiveis = useMemo(
    () => ordenarPorTempoParado(filtrarFila(daFilial, filtros, { membro, agoraMs }).filter((l) => casaFoco(l, foco)), agoraMs, direcao),
    [daFilial, filtros, membro, agoraMs, direcao, foco],
  );
  const resumo = useMemo(() => resumirTorre(daFilial, agoraMs, codigosLiberados), [daFilial, agoraMs, codigosLiberados]);
  const avisos = useMemo(() => avisosDoConselheiro(daFilial, agoraMs), [daFilial, agoraMs]);
  const alertadas = useMemo(() => notasAlertadas(avisos), [avisos]);
  const avisoDaNota = useMemo(() => avisoPorNota(avisos), [avisos]);
  const eventos = useMemo(() => registroDoTurno(daFilial, resumo), [daFilial, resumo]);
  const porEtapa = useMemo(() => agruparPorEtapa(daFilial, alertadas, codigosLiberados), [daFilial, alertadas, codigosLiberados]);
  const contagens = useMemo(
    () => Object.fromEntries(ETAPAS_FLUXO.map((e) => [e.id, porEtapa[e.id].length])) as Record<EtapaFluxoId, number>,
    [porEtapa],
  );
  const ordem = useMemo(
    () => ordemDeNavegacao(visiveis, visao === "fluxo", alertadas, codigosLiberados),
    [visiveis, visao, alertadas, codigosLiberados],
  );

  const abrir = (id: string) => navigate(`/operacao/${id}`);
  const fechar = () => navigate("/operacao");
  const posicao = itemId ? ordem.indexOf(itemId) : -1;
  const vizinho = (passo: 1 | -1): string | null => {
    if (ordem.length === 0) return null;
    if (posicao < 0) return passo === 1 ? ordem[0]! : ordem[ordem.length - 1]!;
    return ordem[posicao + passo] ?? null;
  };
  const irPara = (id: string | null) => {
    if (!id) return;
    abrir(id);
    requestAnimationFrame(() => document.querySelector(`[data-testid="cartao-${id}"], [data-testid="linha-${id}"]`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" }));
  };
  // Depois de confirmar: a próxima nota da mesma ordem, sem voltar à fila. Fim da fila: fecha.
  const proximaDepoisDe = (id: string) => {
    const i = ordem.indexOf(id);
    const prox = ordem.slice(i + 1).find((x) => x !== id) ?? null;
    if (prox) irPara(prox);
    else fechar();
  };

  // Ir direto à coluna de uma etapa (números da faixa da torre).
  const irParaEtapa = (id: EtapaFluxoId) => {
    setAba("trabalho");
    setVisao("fluxo");
    setEtapaDestaque(id);
    requestAnimationFrame(() =>
      document.querySelector(`[data-testid="etapa-${id}"]`)?.scrollIntoView?.({ behavior: "smooth", block: "nearest", inline: "start" }),
    );
  };
  useEffect(() => {
    if (!etapaDestaque) return;
    const t = setTimeout(() => setEtapaDestaque(null), 1600);
    return () => clearTimeout(t);
  }, [etapaDestaque]);

  // Atalhos: j/k próxima/anterior, Enter abre a primeira, Esc fecha. Nunca dentro de campo nem com janela aberta.
  const atalhos = useRef({ vizinho, irPara, fechar, itemId, aba, ordem });
  atalhos.current = { vizinho, irPara, fechar, itemId, aba, ordem };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const alvo = e.target as HTMLElement | null;
      if (alvo?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector("[role='dialog']")) return;
      const a = atalhos.current;
      if (a.aba !== "trabalho") return;
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        a.irPara(a.vizinho(e.key === "j" ? 1 : -1));
      } else if (e.key === "Enter" && !a.itemId && a.ordem.length > 0 && (alvo === document.body || !alvo)) {
        e.preventDefault();
        a.irPara(a.ordem[0]!);
      } else if (e.key === "Escape" && a.itemId) {
        a.fechar();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  if (!api || !carregada) {
    return <EstadoOperacao tipo="carregando" titulo="Carregando a fila da Operação…" />;
  }

  if (!podeVerFila) {
    return (
      <EstadoOperacao
        tipo="vazio"
        icone={<PowerOff className="h-6 w-6" aria-hidden />}
        titulo="A tela da Operação ainda está desligada"
        texto="Seu acesso está cadastrado. A fila aparece aqui assim que a tela for ligada."
      />
    );
  }

  const papel = membro
    ? `${membro.papel_op === "supervisor_op" ? "Supervisão" : "Operador"} · ${
        membro.papel_op === "supervisor_op" ? "todas as filiais" : membro.unidades.join(", ") || "sem filial"
      }`
    : "Gestor · vendo como conferência";
  const demo = api.modo === "demo";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto" data-testid="torre-operacao">
      <BarraOperacao
        aba={aba}
        onAba={setAba}
        contagens={contagens}
        etapaAtiva={etapaDestaque}
        onEtapa={irParaEtapa}
        titulo={
          <h1 className="whitespace-nowrap text-[12.5px] font-normal text-ink-mute" data-testid="contagem-fila">
            <span className="tabular font-semibold text-ink-2">
              {aba === "trabalho" && visiveis.length !== daFilial.length ? `${visiveis.length} de ${daFilial.length}` : daFilial.length}
            </span>{" "}
            {daFilial.length === 1 ? "nota" : "notas"}
            {resumo.lidaEm ? ` · lida às ${hhmm(resumo.lidaEm)}` : ""}
            {isFetching && <Loader2 className="ml-1 inline h-3 w-3 animate-spin" />}
          </h1>
        }
        filiais={filiais}
        totalFiliais={todas.length}
        filial={filial}
        minhas={ehOperadorDeFilial ? membro!.unidades : null}
        onFilial={setFilial}
        filtros={filtros}
        onFiltros={setFiltros}
        ocs={opcoes.ocs}
        cidades={opcoes.cidades}
        tiposCte={opcoes.tiposCte}
        direcao={direcao}
        onDirecao={setDirecao}
        visao={visao}
        onVisao={setVisao}
        podeEspelho={areas.ehGestor || membro?.papel_op === "supervisor_op"}
      />

      {/* Só avisos que mudam o que a pessoa pode fazer. A demonstração já tem o banner do topo. */}
      {((!areas.telaLigada && areas.ehGestor) || (sessao?.flags && !sessao.flags.operacao_lancar_ssw) || (membro && !membro.pode_lancar)) && (
        <p className="border-b border-rule px-4 py-1.5 text-[12px] font-medium md:px-6" style={{ color: "var(--warning)" }}>
          {!areas.telaLigada && areas.ehGestor
            ? "A tela está desligada para os membros. Você vê como gestor."
            : membro && !membro.pode_lancar
              ? "Seu acesso é só de leitura."
              : "O lançamento no SSW está desligado: dá para ver e assumir, mas não lançar."}
        </p>
      )}

      {aba === "torre" ? (
        <div role="tabpanel" aria-label="Torre">
          <AgentePrincipal resumo={resumo} papel={papel} avisos={avisos.length} />
          {daFilial.length > 0 && (
            <div className="grid items-start gap-5 px-5 pb-5 md:px-7 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]">
                <RegrasDaSal resumo={resumo} foco={foco} onFoco={focar} />
                <Especialistas resumo={resumo} foco={foco} onFoco={focar} />
              </div>
              <Conselheiro avisos={avisos} foco={foco} onFoco={focar} demo={demo} />
            </div>
          )}
          <RegistroDoTurno eventos={eventos} />
        </div>
      ) : (
        <div role="tabpanel" aria-label="Trabalho" ref={trabalhoRef} className="flex min-h-[600px] flex-1 flex-col">
          {foco && (
            <div className="px-4 pt-2 md:px-6">
              <FaixaFoco foco={foco} onLimpar={() => setFoco(null)} visiveis={visiveis.length} />
            </div>
          )}

          {todas.length >= LIMITE_AVISO && (
            <div className="flex items-center gap-2 border-b px-7 py-2 text-[12px]" style={{ background: "var(--warning-soft)", color: "var(--c-ink)" }}>
              <AlertCircle className="h-3.5 w-3.5" style={{ color: "var(--warning)" }} />
              A fila passou de {LIMITE_AVISO} itens e a lista mostra só os {LIMITE_AVISO} mais parados. Use os filtros.
            </div>
          )}

          <div className={cn("grid min-h-0 flex-1", itemId && "lg:grid-cols-[minmax(0,1fr),minmax(420px,500px)]")}>
            <div className={cn("min-h-0", visao !== "lista" ? "overflow-hidden" : "overflow-y-auto", itemId && "hidden lg:block")}>
              {isLoading ? (
                <EstadoOperacao tipo="carregando" titulo="Lendo a fila…" compacto />
              ) : error ? (
                <EstadoOperacao tipo="erro" titulo="Não deu para carregar a fila" texto="Ela tenta de novo sozinha a cada minuto." compacto />
              ) : visiveis.length === 0 && visao === "lista" ? (
                <EstadoOperacao
                  tipo="vazio"
                  compacto
                  titulo={todas.length === 0 ? "Nenhuma nota parada com a Operação" : "Nenhuma nota com esses filtros"}
                  texto={todas.length === 0 ? "Quando o Bastão mandar uma nota para a Operação, ela aparece aqui." : "Mude a filial ou limpe os filtros."}
                />
              ) : visao === "fluxo" ? (
                <KanbanFluxo
                  linhas={visiveis}
                  agoraMs={agoraMs}
                  sessao={sessao}
                  codigosLiberados={codigosLiberados}
                  alertadas={alertadas}
                  avisoDaNota={avisoDaNota}
                  etapaDestaque={etapaDestaque}
                  selecionadoId={itemId ?? null}
                  onAbrir={abrir}
                />
              ) : visao !== "lista" ? (
                <KanbanOperacao
                  agrupamento={visao as "problema" | "andamento"}
                  linhas={visiveis}
                  agoraMs={agoraMs}
                  sessao={sessao}
                  codigosLiberados={codigosLiberados}
                  selecionadoId={itemId ?? null}
                  onAbrir={abrir}
                />
              ) : (
                <ListaFilaOperacao
                  linhas={visiveis}
                  agoraMs={agoraMs}
                  selecionadoId={itemId ?? null}
                  meuMembroId={membro?.id ?? null}
                  codigosLiberados={codigosLiberados}
                  avisoDaNota={avisoDaNota}
                  onSelecionar={abrir}
                />
              )}
            </div>
            {itemId && (
              <aside className="min-h-0 overflow-y-auto border-l border-rule bg-surface" aria-label="Detalhe da nota">
                <DetalheItemOperacao
                  key={itemId}
                  itemId={itemId}
                  sessao={sessao}
                  agoraMs={agoraMs}
                  onFechar={fechar}
                  aviso={avisoDaNota.get(itemId) ?? null}
                  posicao={posicao >= 0 ? { atual: posicao + 1, total: ordem.length } : null}
                  onAnterior={vizinho(-1) && posicao > 0 ? () => irPara(vizinho(-1)) : undefined}
                  onProxima={vizinho(1) ? () => irPara(vizinho(1)) : undefined}
                  onConcluido={() => proximaDepoisDe(itemId)}
                />
              </aside>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
