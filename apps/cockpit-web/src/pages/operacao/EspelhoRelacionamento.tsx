// =============================================================================
// Espelho do Relacionamento (ADR 0041 D12, mig 438) — /operacao/espelho.
// Decisão do dono: por enquanto nada vai ao Relacionamento real; o que a Operação
// encaminha cai aqui. Gestor e supervisão leem e dizem "teria aceitado / teria
// recusado (porquê)": é o gabarito para as regras aprendidas e os evals.
// Só gestor e supervisor_op (o servidor também barra: sem_acesso_ao_espelho).
// =============================================================================
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { ArrowLeft, Bot, Check, Lightbulb, Loader2, ShieldAlert, X } from "lucide-react";
import { toast } from "sonner";

import { EstadoOperacao } from "@/components/operacao/EstadoOperacao";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useOpApi, useOpSessao } from "@/contexts/OperacaoContext";
import { ehFalhaOp } from "@/lib/operacao/api";
import { mensagemErroOp } from "@/lib/operacao/erros";
import { fonteDaSugestao, frase, nivelCerteza, ROTULO_CERTEZA } from "@/lib/operacao/sugestao";
import type { OpEspelhoItem, OpFalha } from "@/lib/operacao/tipos";
import { cn } from "@/lib/utils";

type FiltroStatus = "todos" | "recebido_no_espelho" | "avaliado";
type FiltroAvaliacao = "todas" | "aceitaria" | "recusaria" | "sem_avaliacao";

const quando = (iso: string | null) => (iso ? format(new Date(iso), "dd/MM HH:mm") : "—");

/** Pura: contadores do espelho. % sobre as avaliadas (null sem avaliação). */
export function contadoresEspelho(itens: readonly OpEspelhoItem[]) {
  const avaliadas = itens.filter((i) => i.status === "avaliado" && i.teria_aceitado != null);
  const aceitaria = avaliadas.filter((i) => i.teria_aceitado).length;
  return {
    encaminhadas: itens.length,
    avaliadas: avaliadas.length,
    pctAceitaria: avaliadas.length ? Math.round((aceitaria / avaliadas.length) * 100) : null,
  };
}

/** Pura: filtro de avaliação (o de status vai ao servidor). */
export function filtrarAvaliacao(itens: readonly OpEspelhoItem[], f: FiltroAvaliacao): OpEspelhoItem[] {
  if (f === "todas") return [...itens];
  if (f === "aceitaria") return itens.filter((i) => i.teria_aceitado === true);
  if (f === "recusaria") return itens.filter((i) => i.teria_aceitado === false);
  return itens.filter((i) => i.teria_aceitado == null);
}

/** "automático · agente · certeza alta", "manual (Marina) · regra da Sal · certeza média". Sem porcentagem. */
export function rotuloOrigem(i: OpEspelhoItem): string {
  const partes: string[] = [i.origem === "auto" ? "automático" : `manual (${i.solicitado_por_nome})`];
  const s = i.sugestao ? { ...i.sugestao, confianca: i.sugestao.confianca ?? i.confianca } : i.confianca != null ? { codigo: null, acao: "encaminhar_relacionamento" as const, fonte: "regra_aprendida" as const, confianca: i.confianca } : null;
  if (s) {
    if (i.sugestao) partes.push(fonteDaSugestao(i.sugestao) === "agente_ia" ? "agente" : "regra da Sal");
    const nivel = nivelCerteza(s);
    if (nivel) partes.push(ROTULO_CERTEZA[nivel]);
  }
  return partes.join(" · ");
}

function CartaoEspelho({ item, onAvaliado }: { item: OpEspelhoItem; onAvaliado: () => void }) {
  const api = useOpApi();
  const [recusando, setRecusando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const agente = item.sugestao ? fonteDaSugestao(item.sugestao) === "agente_ia" : false;

  async function avaliar(aceitaria: boolean) {
    if (!api) return;
    if (!aceitaria && motivo.trim().length < 5) {
      setErro(mensagemErroOp({ erro: "motivo_obrigatorio" }));
      return;
    }
    setErro(null);
    setEnviando(true);
    try {
      const r = await api.espelhoAvaliar(item.id, aceitaria, aceitaria ? "" : motivo.trim());
      if (ehFalhaOp(r)) {
        setErro(mensagemErroOp(r));
        return;
      }
      toast.success(aceitaria ? "Marcado: o Relacionamento teria aceitado." : "Marcado: o Relacionamento teria recusado.");
      setRecusando(false);
      setMotivo("");
      onAvaliado();
    } finally {
      setEnviando(false);
    }
  }

  return (
    <li className="rounded-[14px] border border-rule bg-surface p-4" data-testid={`espelho-${item.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-ink-2">
            NF {item.nf ?? "—"} <span className="font-normal text-ink-soft-2">· CTRC {item.ctrc}</span>
          </div>
          <div className="mt-0.5 text-[12.5px] text-ink-soft-2">
            {item.descricao_oc ? frase(item.descricao_oc) : `Ocorrência ${item.oc_base ?? "—"}`}
            <span className="ml-2 text-[11.5px] font-medium text-ink-mute">base {item.unidade ?? "sem filial"}</span>
          </div>
        </div>
        {item.status === "avaliado" && item.teria_aceitado != null ? (
          <span
            className="rounded-full px-2.5 py-1 text-[11px] font-semibold"
            style={
              item.teria_aceitado
                ? { background: "var(--positive-soft)", color: "var(--positive)" }
                : { background: "var(--signal-soft)", color: "var(--signal-strong)" }
            }
          >
            {item.teria_aceitado ? "Teria aceitado" : "Teria recusado"}
          </span>
        ) : (
          <span className="rounded-full bg-surface-alt px-2.5 py-1 text-[11px] font-semibold text-ink-soft-2">Sem avaliação</span>
        )}
      </div>

      <dl className="mt-3 grid gap-2 text-[12.5px]">
        <div>
          <dt className="text-[11.5px] text-ink-mute">Texto da 49 (não foi ao SSW)</dt>
          <dd className="mt-0.5 whitespace-pre-wrap text-ink-2">{item.texto_49}</dd>
        </div>
        {item.motivo && (
          <div>
            <dt className="text-[11.5px] text-ink-mute">Motivo</dt>
            <dd className="mt-0.5 text-ink-2">{item.motivo}</dd>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-soft-2">
          <span className="inline-flex items-center gap-1">
            {agente ? <Bot className="h-3 w-3" aria-hidden /> : <Lightbulb className="h-3 w-3" aria-hidden />}
            {rotuloOrigem(item)}
          </span>
          <span>recebido {quando(item.recebido_em)}</span>
          {item.avaliado_por_nome && (
            <span>
              avaliado por {item.avaliado_por_nome} · {quando(item.avaliado_em)}
            </span>
          )}
        </div>
        {item.avaliacao_motivo && (
          <div className="text-[12px] text-ink-soft-2">
            Por quê: <span className="text-ink-2">{item.avaliacao_motivo}</span>
          </div>
        )}
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={enviando} onClick={() => avaliar(true)}>
          {enviando ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
          Teria aceitado
        </Button>
        <Button size="sm" variant="outline" disabled={enviando} onClick={() => setRecusando((v) => !v)}>
          <X className="mr-1.5 h-3.5 w-3.5" />
          Teria recusado
        </Button>
      </div>
      {recusando && (
        <div className="mt-2 space-y-2">
          <label htmlFor={`motivo-${item.id}`} className="block text-[12px] font-semibold text-ink-2">
            Por que o Relacionamento teria recusado? (mín. 5 caracteres)
          </label>
          <Textarea
            id={`motivo-${item.id}`}
            rows={2}
            value={motivo}
            onChange={(e) => {
              setMotivo(e.target.value);
              setErro(null);
            }}
            className="text-[13px]"
          />
          <Button size="sm" disabled={enviando} onClick={() => avaliar(false)} className="bg-sal text-white hover:bg-sal/90">
            Confirmar recusa
          </Button>
        </div>
      )}
      {erro && (
        <p role="alert" className="mt-2 text-[12px]" style={{ color: "var(--signal-strong)" }}>
          {erro}
        </p>
      )}
    </li>
  );
}

export default function EspelhoRelacionamento() {
  const api = useOpApi();
  const qc = useQueryClient();
  const { sessao, carregada } = useOpSessao();
  const podeVer = !!sessao?.eh_gestor || sessao?.membro?.papel_op === "supervisor_op";
  const [status, setStatus] = useState<FiltroStatus>("todos");
  const [avaliacao, setAvaliacao] = useState<FiltroAvaliacao>("todas");

  const { data, isLoading } = useQuery({
    queryKey: ["op", "espelho", status],
    enabled: !!api && carregada && podeVer,
    queryFn: () => api!.espelhoListar(status === "todos" ? null : status),
  });
  // Contadores sobre TUDO (não sobre o filtro de status).
  const { data: todos } = useQuery({
    queryKey: ["op", "espelho", "todos"],
    enabled: !!api && carregada && podeVer,
    queryFn: () => api!.espelhoListar(null),
  });

  const itens = data && !ehFalhaOp(data) ? data.itens : [];
  const visiveis = useMemo(() => filtrarAvaliacao(itens, avaliacao), [itens, avaliacao]);
  const cont = contadoresEspelho(todos && !ehFalhaOp(todos) ? todos.itens : []);
  const modo = data && !ehFalhaOp(data) ? data.modo : null;
  const atualizar = () => qc.invalidateQueries({ queryKey: ["op", "espelho"] });

  if (!api || !carregada) {
    return (
      <EstadoOperacao tipo="carregando" titulo="Abrindo o espelho do Relacionamento…" />
    );
  }
  if (!podeVer) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
        <ShieldAlert className="h-8 w-8 text-ink-mute" aria-hidden />
        <h1 className="mt-4 text-[20px] font-semibold text-ink-2">Espelho do Relacionamento</h1>
        <p className="mt-2 text-[13.5px] text-ink-soft-2">{mensagemErroOp({ erro: "sem_acesso_ao_espelho" })}</p>
        <Link to="/operacao" className="mt-4 text-[13px] font-semibold underline">
          Voltar para a fila
        </Link>
      </div>
    );
  }

  const SELECT = "h-9 rounded-[10px] border border-rule bg-surface px-2.5 text-[13px] text-ink-2";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="grid gap-5 border-b border-rule px-5 pb-4 pt-5 md:px-7 lg:grid-cols-[1fr,minmax(360px,440px)]">
        <div className="min-w-0">
          <Link
            to="/operacao"
            className="inline-flex items-center gap-1 text-[12.5px] font-medium text-ink-mute hover:text-ink-2"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Voltar ao trabalho da Operação
          </Link>
          <h1 className="mt-1 text-[22px] font-semibold leading-tight text-ink-2 md:text-[24px]" style={{ letterSpacing: "-0.01em" }}>
            Espelho do Relacionamento
          </h1>
          <p className="mt-1 max-w-[640px] text-[13.5px] text-ink-soft-2">
            O que a Operação encaminhou ao Relacionamento fica aqui, e nada chega ao Cockpit real. Diga se o
            Relacionamento teria aceitado: é assim que as sugestões aprendem.
          </p>
          {modo && (
            <p className="mt-2 text-[12px] font-semibold" style={{ color: modo === "espelho" ? "var(--encaminhar)" : "var(--signal-strong)" }}>
              {modo === "espelho"
                ? "Modo atual: ESPELHO. Nada vai ao Relacionamento real."
                : "Modo atual: REAL. Encaminhamentos novos viram card no Relacionamento."}
            </p>
          )}
        </div>
        <dl className="grid min-w-0 grid-cols-3 self-end overflow-hidden rounded-[14px] border border-rule">
          {[
            ["Encaminhadas", String(cont.encaminhadas)],
            ["Avaliadas", String(cont.avaliadas)],
            ["Teria aceitado", cont.pctAceitaria == null ? "—" : `${cont.pctAceitaria}%`],
          ].map(([rotulo, valor], i) => (
            <div key={rotulo} className={cn("px-4 py-3", i > 0 && "border-l border-rule")}>
              <dt className="text-[12px] text-ink-mute">{rotulo}</dt>
              <dd className="tabular mt-0.5 text-[22px] font-semibold leading-none text-ink-2">{valor}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-rule px-5 py-3 md:px-7">
        <select aria-label="Filtrar por status" value={status} onChange={(e) => setStatus(e.target.value as FiltroStatus)} className={SELECT}>
          <option value="todos">Qualquer situação</option>
          <option value="recebido_no_espelho">Recebido no espelho</option>
          <option value="avaliado">Avaliado</option>
        </select>
        <select
          aria-label="Filtrar por avaliação"
          value={avaliacao}
          onChange={(e) => setAvaliacao(e.target.value as FiltroAvaliacao)}
          className={SELECT}
        >
          <option value="todas">Qualquer avaliação</option>
          <option value="aceitaria">Teria aceitado</option>
          <option value="recusaria">Teria recusado</option>
          <option value="sem_avaliacao">Sem avaliação</option>
        </select>
        <span className="tabular text-[12.5px] text-ink-mute" data-testid="contagem-espelho">
          {visiveis.length} de {itens.length}
        </span>
      </div>

      <div className="px-5 py-4 md:px-7">
        {isLoading ? (
          <EstadoOperacao tipo="carregando" titulo="Lendo o espelho…" compacto />
        ) : data && ehFalhaOp(data) ? (
          <p role="alert" className="text-[13px]" style={{ color: "var(--signal-strong)" }}>
            {mensagemErroOp(data as OpFalha)}
          </p>
        ) : visiveis.length === 0 ? (
          <EstadoOperacao tipo="vazio" compacto titulo="Nada no espelho com esses filtros" texto="O que a Operação encaminhar ao Relacionamento aparece aqui para você avaliar." />
        ) : (
          <ul className={cn("grid gap-3 xl:grid-cols-2")}>
            {visiveis.map((i) => (
              <CartaoEspelho key={i.id} item={i} onAvaliado={atualizar} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
