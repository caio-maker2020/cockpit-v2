import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import type { CardRow, CardWithRelations, OperadorRow } from "@/lib/types";
import {
  canalIcon,
  copyToClipboard,
  initials,
  relativeShort,
  responsabilidadeChipClasses,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { WurthRodadaChip } from "@/components/cards/WurthRodadaChip";
import { WurthRetornoCicloAnteriorAviso } from "@/components/cards/WurthRetornoCicloAnteriorAviso";

// Traduz o erro cru do robô num aviso legível pra operadora (Resultado 3).
function msgErroIntranet(e?: { login?: string; passo?: string; erro?: string }): string {
  const raw = e?.erro ?? "";
  const ondeLogin = e?.login ? ` (login ${e.login.toUpperCase()})` : "";
  const ondePasso = e?.passo ? `, etapa ${e.passo}` : "";
  if (/refused|2002|HY000|timeout|indispon|ETIMEDOUT|ECONNREFUSED/i.test(raw)) {
    return `Intranet da Würth indisponível agora${ondeLogin} — o servidor deles pode estar fora. Tente de novo em alguns minutos.`;
  }
  return `Não consegui consultar a intranet${ondeLogin}${ondePasso}: ${raw || "erro desconhecido"}`;
}

function InstrucaoSSW({ card }: { card: { agent_state: Record<string, unknown> | null } }) {
  const raw = (card.agent_state as { instrucao_ultima_ocorrencia?: string | null } | null)
    ?.instrucao_ultima_ocorrencia;
  const instrucao = raw?.trim();
  if (!instrucao) return null;
  const RUIDO = [
    "aguardando retorno do cliente pagador",
    "recebimento encerrado",
    "(sswmobile)",
    "(ssw webapi parceiro)",
  ];
  const baixo = instrucao.toLowerCase();
  if (RUIDO.some((r) => baixo === r || baixo === r + "." || baixo === `aguardando retorno do cliente pagador  (ssw webapi parceiro)`)) {
    return null;
  }
  return (
    <div className="mt-1.5 flex items-start gap-1 border-t border-current/20 pt-1.5 text-[11px] opacity-90">
      <span className="opacity-60">◇</span>
      <div>
        <span className="font-mono text-[9px] uppercase tracking-widest opacity-60">Instrução SSW:</span>{" "}
        <span className="font-medium">{instrucao}</span>
      </div>
    </div>
  );
}

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function MetadataItem({
  label,
  value,
  mono = true,
  onCopy,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  onCopy?: () => void;
}) {
  return (
    <div className="border-b border-rule pb-1.5">
      <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-soft">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 break-words text-[12px] text-ink",
          mono && "font-mono",
          onCopy && "cursor-pointer hover:text-sal",
        )}
        onClick={onCopy}
      >
        {value}
      </div>
    </div>
  );
}

export function CardIdentification({ card }: { card: CardWithRelations }) {
  const { operador } = useAuth();
  const qc = useQueryClient();
  // Modo visualização (mig 324): gestor travado não reatribui nem edita.
  const isGestor = operador?.papel === "gestor" && operador?.pode_executar !== false;

  const [reassignOpen, setReassignOpen] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  // BUSCAR INTRANET (Würth/Ingrid, Caio 2026-08-11): visível só pra cliente
  // com retorno via intranet Würth (cliente_config — nunca hardcode de CNPJ).
  const cnpjPagadorCard = String(
    (card.agent_state as Record<string, unknown> | null)?.["cnpj_pagador"] ?? "",
  ).replace(/\D/g, "");
  // Visibilidade via RPC (mig 335): cliente_config é service-only e o front
  // (authenticated) NÃO consegue lê-la — ler direto dava permission denied e o
  // botão nunca aparecia. A RPC expõe só o boolean.
  const { data: ehIntranetWurth = false } = useQuery({
    queryKey: ["cliente-intranet-wurth", cnpjPagadorCard],
    enabled: !!supabase && cnpjPagadorCard.length === 14,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await supabase!.rpc("card_eh_intranet_wurth", { p_cnpj: cnpjPagadorCard });
      return !!data;
    },
  });
  const buscarIntranet = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase!.functions.invoke("robo-intranet-wurth", {
        body: { card_id: card.id },
      });
      if (error) throw error;
      const r = data as {
        ok?: boolean; skipped?: string; error?: string;
        retornos_aplicados?: Array<{ efeito?: string }>;
        erros?: Array<{ login?: string; passo?: string; erro?: string }>;
        resumo?: {
          encontrou?: boolean;
          aplicados?: number;
          ja_processado?: boolean;
          descartados_ciclo_anterior?: number;
          descarte_motivo?: string | null;
        };
      } | null;
      if (!r?.ok) throw new Error(r?.error ?? "falha na busca");
      return r;
    },
    // 4 desfechos (Caio 2026-08-13). Ordem importa: erro vence "sem retorno"
    // (consulta que falhou não é o mesmo que NF sem retorno).
    onSuccess: (r) => {
      if (r.skipped) {
        toast.info("Busca na intranet está desligada (flag).");
        return;
      }
      const aplicados = r.resumo?.aplicados ?? r.retornos_aplicados?.length ?? 0;
      if (aplicados > 0) {
        // Resultado 1: achou retorno novo → robô já criou/enxertou a sugestão.
        toast.success(`Würth retornou: ${aplicados} sugestão(ões) criada(s) — veja o card.`);
        qc.invalidateQueries();
        return;
      }
      if ((r.resumo?.descartados_ciclo_anterior ?? 0) > 0) {
        // Resultado 1c (Caio 2026-08-14, NF 677750): existe linha na intranet,
        // mas a Würth respondeu ANTES da ocorrência que gerou esta tratativa —
        // é retorno de outro ciclo. Dizer "sem retorno" aqui seria mentira.
        toast.warning(
          "Retorno da Würth é de um ciclo anterior — desconsiderado. " +
            (r.resumo?.descarte_motivo ?? "Respondeu antes da ocorrência desta tratativa."),
        );
        return;
      }
      if (r.resumo?.encontrou && r.resumo?.ja_processado) {
        // Resultado 1b: existe retorno, mas já estava registrado (dedupe).
        toast.info("Já havia retorno registrado para esta NF — veja as sugestões do card.");
        qc.invalidateQueries();
        return;
      }
      if ((r.erros?.length ?? 0) > 0) {
        // Resultado 3: não conseguiu consultar (detalha o bug).
        toast.error(msgErroIntranet(r.erros![0]));
        return;
      }
      // Resultado 2: consulta OK, sem retorno pra esta NF.
      toast.info("Sem retorno na intranet da Würth para esta NF.");
    },
    onError: (e: Error) => toast.error(`Buscar intranet falhou: ${e.message}`),
  });

  const diasAtraso =
    (card.agent_state as Record<string, unknown> | null)?.["dias_atraso"];

  const handleCopy = async (val: string | null, label: string) => {
    if (!val) return;
    if (await copyToClipboard(val)) toast.success(`${label} copiado`);
  };

  const assignToMe = useMutation({
    mutationFn: async () => {
      if (!supabase || !operador) throw new Error("Sem operador");
      const { error } = await supabase
        .from("cards")
        .update({ assigned_operator_id: operador.id })
        .eq("id", card.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Card atribuído a você");
      qc.invalidateQueries({ queryKey: ["card", card.id] });
      qc.invalidateQueries({ queryKey: ["inbox", "cards"] });
    },
    onError: (e: Error) => toast.error("Falha ao atribuir", { description: e.message }),
  });

  return (
    <div className="flex flex-col gap-5 p-5">
      {/* Manifesto — NF herói */}
      <section>
        <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute">
          Nota fiscal
        </div>
        <button
          type="button"
          onClick={() => handleCopy(card.nf, "NF")}
          title="Copiar NF"
          className="mt-1 block tabular font-mono text-[26px] font-semibold leading-none text-ink hover:text-sal"
        >
          {card.nf || "—"}
        </button>
        <button
          type="button"
          onClick={() => handleCopy(card.ctrc, "CTRC")}
          title="Copiar CTRC"
          className="mt-1.5 block tabular font-mono text-[11px] text-ink-mute hover:text-sal"
        >
          CTRC {card.ctrc || "—"}
        </button>
        <div className="mt-2 text-[13.5px] font-semibold leading-snug text-ink">
          {card.pagador || card.empresa_cliente || "—"}
        </div>
      </section>

      {/* Dados */}
      <section className="space-y-2">
        <MetadataItem label="Base destino" value={card.base_destino || "—"} />
        {typeof diasAtraso !== "undefined" && diasAtraso !== null && (
          <MetadataItem label="Dias de atraso" value={String(diasAtraso)} />
        )}
        <MetadataItem
          label="Responsável"
          value={card.responsavel_relacionamento || "—"}
          mono={false}
        />
        <MetadataItem
          label="Canal de origem"
          value={
            <span className="inline-flex items-center gap-1.5">
              <span>{canalIcon(card.canal_origem)}</span>
              <span className="capitalize">{card.canal_origem || "—"}</span>
            </span>
          }
          mono={false}
        />
        <MetadataItem label="Criado" value={relativeShort(card.created_at)} mono={false} />
      </section>

      {/* Aprovação */}
      <AprovacaoBadge card={card} />

      {/* Setor */}
      <SetorTag card={card} />

      {/* Última ocorrência */}
      {(card.ocorrencia || card.cod_ultima_ocorrencia != null) && (() => {
        const ocoClasses = responsabilidadeChipClasses(card.ocorrencia?.responsabilidade);
        return (
          <section className="space-y-2">
            <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-ink-soft">
              Última ocorrência
            </h3>
            <div
              className={cn(
                "border-l-[3px] py-2 pl-2.5 pr-2 text-[12px]",
                ocoClasses.chip,
                ocoClasses.border,
              )}
            >
              <div className="flex items-baseline gap-1.5">
                <span className="font-mono text-[11px] font-semibold tabular">
                  {card.cod_ultima_ocorrencia ?? "?"}
                </span>
                <span className="text-rule-strong">·</span>
                <span className="font-display italic">
                  {card.ocorrencia?.descricao ?? "—"}
                </span>
              </div>
              {card.ocorrencia?.responsabilidade && (
                <div className="mt-0.5 font-mono text-[9px] uppercase tracking-widest opacity-70">
                  {card.ocorrencia.responsabilidade}
                </div>
              )}
              <InstrucaoSSW card={card} />
            </div>
          </section>
        );
      })()}

      {/* Operador */}
      <section className="space-y-2">
        <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-ink-soft">
          Operador
        </h3>
        {card.operador ? (
          <div className="flex items-center gap-2.5 rounded-md border border-rule bg-surface p-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-ink font-mono text-[11px] font-bold text-paper">
              {initials(card.operador.nome)}
            </div>
            <div className="min-w-0">
              <div className="truncate text-[12.5px] font-semibold text-ink">
                {card.operador.nome}
              </div>
              <div className="font-mono text-[9px] uppercase tracking-widest text-ink-mute">
                {card.operador.papel}
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-rule-strong p-2.5 text-[12px] italic text-ink-mute">
            Sem dono
          </div>
        )}
      </section>

      {/* Ações */}
      <section className="space-y-1.5 border-t border-rule pt-4">
        {operador && card.assigned_operator_id !== operador.id && (
          <button
            onClick={() => assignToMe.mutate()}
            disabled={assignToMe.isPending}
            className="btn-flat w-full bg-sal text-paper"
          >
            Atribuir a mim
          </button>
        )}
        {ehIntranetWurth && operador?.pode_executar !== false && (
          <button
            onClick={() => buscarIntranet.mutate()}
            disabled={buscarIntranet.isPending}
            className="btn-flat w-full bg-paper text-ink disabled:opacity-50"
            title="Consulta agora a intranet da Würth por retornos desta NF (fora dos horários agendados de 08h/16h)"
          >
            {buscarIntranet.isPending ? "Buscando na intranet…" : "🔎 Buscar intranet Würth"}
          </button>
        )}
        {ehIntranetWurth && <WurthRetornoCicloAnteriorAviso cardId={card.id} />}
        {ehIntranetWurth && <WurthRodadaChip />}
        {isGestor && (
          <>
            <button onClick={() => setReassignOpen(true)} className="btn-flat w-full bg-paper text-ink">
              Reatribuir…
            </button>
            <button onClick={() => setResolveOpen(true)} className="btn-flat w-full bg-paper text-ink">
              Marcar resolvido
            </button>
            <button
              onClick={() => setCancelOpen(true)}
              className="btn-flat w-full bg-paper text-sal"
            >
              Cancelar card
            </button>
          </>
        )}
      </section>

      <ReassignDialog open={reassignOpen} onOpenChange={setReassignOpen} card={card} />
      <ResolveCancelDialog
        open={resolveOpen}
        onOpenChange={setResolveOpen}
        card={card}
        kind="resolve"
      />
      <ResolveCancelDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        card={card}
        kind="cancel"
      />
    </div>
  );
}

/* ---------------- Aprovação badge ---------------- */

function AprovacaoBadge({ card }: { card: CardWithRelations }) {
  const modo = card.aprovacao_modo;

  const { data: approver } = useQuery({
    queryKey: ["aprovador", card.id],
    enabled: !!supabase && modo === "humana",
    queryFn: async () => {
      const { data } = await supabase!
        .from("todos")
        .select("approved_by,approved_at,operadores:operadores!todos_approved_by_fkey(nome)")
        .eq("card_id", card.id)
        .not("approved_by", "is", null)
        .order("approved_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const nome = (data as any)?.operadores?.nome ?? null;
      return { nome, at: (data as any)?.approved_at ?? null };
    },
  });

  if (!modo) return null;

  if (modo === "autonoma") {
    return (
      <section className="border-2 border-ink bg-ink p-3 text-paper">
        <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-paper/60">
          Aprovação
        </div>
        <div className="mt-1 font-display text-[14px] font-semibold">Autônoma</div>
        <div className="mt-1 font-display text-[11px] italic text-paper/75">
          Agente decidiu sozinho — sem clique humano.
        </div>
      </section>
    );
  }

  return (
    <section className="border-2 border-ink bg-paper p-3">
      <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-soft">
        Aprovação
      </div>
      <div className="mt-1 font-display text-[14px] font-semibold">
        Humana
      </div>
      <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-ink-soft">
        {approver?.nome ?? "operador"} {approver?.at && `· ${relativeShort(approver.at)}`}
      </div>
    </section>
  );
}

/* ---------------- Setor responsável ---------------- */

const SETOR_ICONS: Record<string, string> = {
  "Operação": "▣",
  "Devolução": "↩",
  "Ressarcimento": "◈",
  "Perdas": "▽",
  "Agendamento": "▤",
  "Cliente": "○",
  "Relacionamento": "◇",
};

function SetorTag({ card }: { card: CardWithRelations }) {
  const { data } = useQuery({
    queryKey: ["setor-destino", card.id],
    enabled:
      !!supabase &&
      (card.state === "TRANSFERIDO" || card.state === "TRATATIVA_PENDENTE"),
    queryFn: async () => {
      const { data } = await supabase!
        .from("card_events")
        .select("payload,created_at")
        .eq("card_id", card.id)
        .eq("event_type", "DevolvidoParaSetor")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const setor = (data as any)?.payload?.setor_destino as string | undefined;
      return setor ?? null;
    },
  });

  if (card.state !== "TRANSFERIDO" && card.state !== "TRATATIVA_PENDENTE") return null;
  if (!data) return null;
  const icon = SETOR_ICONS[data] ?? "▣";

  return (
    <section className="border-2 border-warn bg-warn/20 p-3">
      <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-soft">
        Transferido
      </div>
      <div className="mt-1 font-display text-[14px] font-semibold text-ink">
        {icon} {data}
      </div>
      {card.state === "TRATATIVA_PENDENTE" && (
        <div className="mt-1 font-display text-[11px] italic text-ink-soft">
          Cliente cobrou novamente — voltou pra tratativa.
        </div>
      )}
    </section>
  );
}

/* ---------------- Dialogs ---------------- */

function ReassignDialog({
  open,
  onOpenChange,
  card,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  card: CardRow;
}) {
  const qc = useQueryClient();
  const [target, setTarget] = useState<string | null>(null);

  const { data: operadores } = useQuery({
    queryKey: ["operadores", "ativos"],
    enabled: open && !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("operadores")
        .select("id,nome,papel")
        .eq("ativo", true)
        .order("nome");
      if (error) throw error;
      return (data ?? []) as Pick<OperadorRow, "id" | "nome" | "papel">[];
    },
  });

  const reassign = useMutation({
    mutationFn: async () => {
      if (!supabase || !target) throw new Error("Selecione um operador");
      const { error } = await supabase
        .from("cards")
        .update({ assigned_operator_id: target })
        .eq("id", card.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Card reatribuído");
      qc.invalidateQueries({ queryKey: ["card", card.id] });
      qc.invalidateQueries({ queryKey: ["inbox", "cards"] });
      onOpenChange(false);
      setTarget(null);
    },
    onError: (e: Error) => toast.error("Falha ao reatribuir", { description: e.message }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reatribuir card</DialogTitle>
          <DialogDescription>Selecione o operador que vai assumir este card.</DialogDescription>
        </DialogHeader>
        <Select value={target ?? undefined} onValueChange={setTarget}>
          <SelectTrigger>
            <SelectValue placeholder="Escolher operador…" />
          </SelectTrigger>
          <SelectContent>
            {(operadores ?? []).map((op) => (
              <SelectItem key={op.id} value={op.id}>
                {op.nome} <span className="text-muted-foreground">· {op.papel}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => reassign.mutate()} disabled={!target || reassign.isPending}>
            Reatribuir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResolveCancelDialog({
  open,
  onOpenChange,
  card,
  kind,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  card: CardRow;
  kind: "resolve" | "cancel";
}) {
  const { operador } = useAuth();
  const qc = useQueryClient();
  const [motivo, setMotivo] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      if (!supabase || !operador) throw new Error("Sem operador");
      if (motivo.trim().length < 3) throw new Error("Informe um motivo.");

      const eventType = kind === "resolve" ? "CardEncerradoManualmente" : "CardCancelado";
      const newState = kind === "resolve" ? "RESOLVIDO" : "CANCELADO";

      const { error: e1 } = await supabase.from("card_events").insert({
        card_id: card.id,
        event_type: eventType,
        event_version: 1,
        actor_type: "operator",
        actor_id: operador.id,
        payload: { motivo },
      });
      if (e1) throw e1;

      const { error: e2 } = await supabase
        .from("cards")
        .update({ state: newState })
        .eq("id", card.id);
      if (e2) throw e2;
    },
    onSuccess: () => {
      toast.success(kind === "resolve" ? "Card resolvido" : "Card cancelado");
      qc.invalidateQueries({ queryKey: ["card", card.id] });
      qc.invalidateQueries({ queryKey: ["inbox", "cards"] });
      qc.invalidateQueries({ queryKey: ["card-events", card.id] });
      onOpenChange(false);
      setMotivo("");
    },
    onError: (e: Error) => toast.error("Falha", { description: e.message }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {kind === "resolve" ? "Marcar como resolvido" : "Cancelar card"}
          </DialogTitle>
          <DialogDescription>
            {kind === "resolve"
              ? "Esse card sairá da inbox ativa. Informe o motivo do encerramento."
              : "Ação destrutiva — informe o motivo do cancelamento."}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="Motivo (mínimo 3 caracteres)…"
          rows={4}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Voltar
          </Button>
          <Button
            variant={kind === "cancel" ? "destructive" : "default"}
            onClick={() => submit.mutate()}
            disabled={motivo.trim().length < 3 || submit.isPending}
          >
            {kind === "resolve" ? "Marcar resolvido" : "Cancelar card"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
