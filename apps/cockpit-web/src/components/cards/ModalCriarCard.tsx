import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Search, X, AlertCircle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/lib/supabase";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ClienteOpt {
  cnpj_cpf: string;
  nome: string;
  segmento_nome: string | null;
}

interface OpcaoCtrc {
  ctrc: string;
  tipo: string;
  rotulo: string;
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function ModalCriarCard({ open, onOpenChange }: Props) {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [nf, setNf] = useState("");
  const [termo, setTermo] = useState("");
  const [cliente, setCliente] = useState<ClienteOpt | null>(null);
  const [mostraLista, setMostraLista] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [opcoesCtrc, setOpcoesCtrc] = useState<OpcaoCtrc[] | null>(null);
  const [ctrcEscolhido, setCtrcEscolhido] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [cardExistenteId, setCardExistenteId] = useState<string | null>(null);

  const termoDeb = useDebounced(termo, 250);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset ao abrir/fechar
  useEffect(() => {
    if (!open) {
      setNf("");
      setTermo("");
      setCliente(null);
      setMostraLista(false);
      setSubmitting(false);
      setOpcoesCtrc(null);
      setCtrcEscolhido(null);
      setErro(null);
      setAviso(null);
      setCardExistenteId(null);
    }
  }, [open]);

  const { data: clientes = [], isFetching: buscandoClientes } = useQuery({
    queryKey: ["criar-card-clientes", termoDeb],
    enabled: open && termoDeb.trim().length >= 2 && !cliente,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("clientes")
        .select("cnpj_cpf, nome, segmento_nome")
        .eq("ativo", true)
        .ilike("nome", `%${termoDeb.trim()}%`)
        .order("nome")
        .limit(20);
      if (error) throw error;
      return (data ?? []) as ClienteOpt[];
    },
    staleTime: 30_000,
  });

  const podeCriar = useMemo(() => {
    return Boolean(nf.trim() && cliente && !submitting);
  }, [nf, cliente, submitting]);

  async function chamar(ctrc?: string) {
    if (!cliente) return;
    setSubmitting(true);
    setErro(null);
    setAviso(null);
    setCardExistenteId(null);

    try {
      const { data, error } = await supabase.functions.invoke("criar-card-manual", {
        body: {
          nf: nf.trim(),
          cnpj_pagador: cliente.cnpj_cpf,
          pagador_nome: cliente.nome,
          ...(ctrc ? { ctrc_escolhido: ctrc } : {}),
        },
      });

      if (error) {
        setErro(error.message || "Falha ao chamar o servidor.");
        return;
      }

      const resultado = data?.resultado as string | undefined;

      switch (resultado) {
        case "created": {
          toast.success("Card criado.");
          qc.invalidateQueries({ queryKey: ["inbox"] });
          qc.invalidateQueries({ queryKey: ["cards"] });
          onOpenChange(false);
          if (data?.card_id) navigate(`/cards/${data.card_id}`);
          break;
        }
        case "card_ja_existe": {
          setAviso("Já existe um card ativo para esta NF.");
          if (data?.card_id) setCardExistenteId(data.card_id);
          break;
        }
        case "ultima_oc_nao_relacionamento": {
          setErro(
            data?.mensagem ||
              "NÃO FOI POSSÍVEL CRIAR POIS A ÚLTIMA OCORRÊNCIA NÃO É RELACIONAMENTO",
          );
          break;
        }
        case "escolher_ctrc": {
          setOpcoesCtrc((data?.opcoes ?? []) as OpcaoCtrc[]);
          setCtrcEscolhido(null);
          break;
        }
        case "sem_ctrc_ativo": {
          setErro(data?.mensagem || "Nenhum CTRC ativo desta NF.");
          break;
        }
        case "erro":
        default: {
          setErro(data?.mensagem || "Não foi possível criar o card.");
          break;
        }
      }
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro inesperado.");
    } finally {
      setSubmitting(false);
    }
  }

  const showListaClientes =
    !cliente && mostraLista && termoDeb.trim().length >= 2;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none border-2 border-ink bg-paper sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono text-[13px] uppercase tracking-widest">
            Criar card manual
          </DialogTitle>
          <DialogDescription className="font-mono text-[11px] text-ink-soft">
            Use só para NF que ainda não entrou pelo Bastão. Consulta SSW ao vivo.
          </DialogDescription>
        </DialogHeader>

        {!opcoesCtrc ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                NF
              </Label>
              <Input
                value={nf}
                onChange={(e) => setNf(e.target.value.replace(/\D/g, ""))}
                placeholder="ex.: 684385"
                inputMode="numeric"
                className="h-9 rounded-none border-2 border-ink bg-paper font-mono text-[12px] focus-visible:ring-0 focus-visible:border-sal"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                Pagador (sua carteira)
              </Label>
              {cliente ? (
                <div className="flex items-center justify-between gap-2 border-2 border-ink bg-canvas px-2 py-1.5">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[12px] text-ink">
                      {cliente.nome}
                    </div>
                    <div className="truncate font-mono text-[10px] text-ink-soft">
                      {cliente.cnpj_cpf}
                      {cliente.segmento_nome ? ` · ${cliente.segmento_nome}` : ""}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setCliente(null);
                      setTermo("");
                    }}
                    className="text-ink-soft hover:text-sal"
                    aria-label="Limpar pagador"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-soft" />
                  <Input
                    value={termo}
                    onChange={(e) => {
                      setTermo(e.target.value);
                      setMostraLista(true);
                    }}
                    onFocus={() => setMostraLista(true)}
                    onBlur={() => {
                      blurTimer.current = setTimeout(
                        () => setMostraLista(false),
                        150,
                      );
                    }}
                    placeholder="Digite o nome do cliente…"
                    className="h-9 rounded-none border-2 border-ink bg-paper pl-7 font-mono text-[12px] focus-visible:ring-0 focus-visible:border-sal"
                  />
                  {showListaClientes && (
                    <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-auto border-2 border-ink bg-paper shadow-lg">
                      {buscandoClientes ? (
                        <div className="flex items-center gap-2 px-2 py-2 font-mono text-[11px] text-ink-soft">
                          <Loader2 className="h-3 w-3 animate-spin" /> buscando…
                        </div>
                      ) : clientes.length === 0 ? (
                        <div className="px-2 py-2 font-mono text-[11px] text-ink-soft">
                          Nenhum cliente encontrado na sua carteira.
                        </div>
                      ) : (
                        clientes.map((c) => (
                          <button
                            key={c.cnpj_cpf}
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              if (blurTimer.current) clearTimeout(blurTimer.current);
                              setCliente(c);
                              setTermo(c.nome);
                              setMostraLista(false);
                            }}
                            className="block w-full border-b border-rule px-2 py-1.5 text-left last:border-b-0 hover:bg-canvas"
                          >
                            <div className="truncate font-mono text-[12px] text-ink">
                              {c.nome}
                            </div>
                            <div className="truncate font-mono text-[10px] text-ink-soft">
                              {c.cnpj_cpf}
                              {c.segmento_nome ? ` · ${c.segmento_nome}` : ""}
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="font-mono text-[11px] uppercase tracking-widest text-ink-soft">
              Esta NF tem mais de um CTRC ativo. Escolha qual:
            </div>
            <div className="space-y-2">
              {opcoesCtrc.map((opt) => (
                <button
                  key={opt.ctrc}
                  type="button"
                  onClick={() => setCtrcEscolhido(opt.ctrc)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 border-2 px-3 py-2 text-left transition-colors",
                    ctrcEscolhido === opt.ctrc
                      ? "border-sal bg-sal/10"
                      : "border-ink bg-paper hover:bg-canvas",
                  )}
                >
                  <div>
                    <div className="font-mono text-[12px] text-ink">{opt.ctrc}</div>
                    <div className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                      {opt.rotulo}
                    </div>
                  </div>
                  {ctrcEscolhido === opt.ctrc && (
                    <CheckCircle2 className="h-4 w-4 text-sal" />
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {(erro || aviso) && (
          <div
            className={cn(
              "flex items-start gap-2 border-2 px-2 py-1.5 font-mono text-[11px]",
              erro
                ? "border-red-500 bg-red-50 text-red-700"
                : "border-amber-500 bg-amber-50 text-amber-800",
            )}
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="space-y-1">
              <div>{erro || aviso}</div>
              {cardExistenteId && (
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-sal"
                  onClick={() => {
                    onOpenChange(false);
                    navigate(`/cards/${cardExistenteId}`);
                  }}
                >
                  Abrir card existente →
                </button>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="rounded-none border-2 border-ink bg-paper font-mono text-[11px] uppercase tracking-widest"
            disabled={submitting}
          >
            Cancelar
          </Button>
          {!opcoesCtrc ? (
            <Button
              type="button"
              onClick={() => chamar()}
              disabled={!podeCriar}
              className="rounded-none border-2 border-ink bg-ink font-mono text-[11px] uppercase tracking-widest text-paper hover:bg-sal hover:text-paper"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" /> Criando…
                </>
              ) : (
                "Criar card"
              )}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => ctrcEscolhido && chamar(ctrcEscolhido)}
              disabled={!ctrcEscolhido || submitting}
              className="rounded-none border-2 border-ink bg-ink font-mono text-[11px] uppercase tracking-widest text-paper hover:bg-sal hover:text-paper"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" /> Criando…
                </>
              ) : (
                "Confirmar CTRC"
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
