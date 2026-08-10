import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { supabase } from "@/lib/supabase";
import { remetenteCruDoAgentState } from "@/lib/contatos";
import { useTemplatesEmail } from "@/hooks/useTemplatesEmail";
import type { CardRow, TodoRow } from "@/lib/types";
import { AnexosUploader, type AnexoUploaded } from "./AnexosUploader";

/* ============================================================================
 * Composer INLINE de oc=54+email, usado dentro do card "RECOMENDADO PELO
 * AGENTE IA" (BannerSugestaoIA → BannerOcsPadrao quando proposta_destacada=54).
 *
 * Self-contained: localiza seu próprio todo (oc=54 pendente), carrega preview
 * via RPC `preview_email_todo`, lista contatos e templates, e dispara
 * `aprovar_e_executar` direto — sem precisar abrir o painel direito.
 * ========================================================================== */

export function BannerInline54Composer({
  card,
  codigoOc = 54,
  templateSugeridoIA,
  onApproved,
}: {
  card: CardRow;
  /** 54 (tratativa) ou 59 (indenização) — separação 54/59. */
  codigoOc?: 54 | 59;
  templateSugeridoIA: string | null;
  onApproved?: () => void;
}) {
  const qc = useQueryClient();

  // Procura o todo pendente oc=54
  const { data: todo, isLoading: loadingTodo } = useQuery({
    queryKey: ["inline54-todo", card.id, codigoOc],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("todos")
        .select("*")
        .eq("card_id", card.id)
        .eq("status", "pendente")
        .order("created_at", { ascending: false });
      if (error) throw error;
      const list = (data ?? []) as TodoRow[];
      return (
        list.find((t) => {
          const pl = (t.proposta_payload ?? {}) as any;
          return Number(pl?.args?.codigo_ssw) === codigoOc;
        }) ?? null
      );
    },
  });

  if (loadingTodo) {
    return (
      <div className="mt-4 flex items-center gap-2 border-t border-ink/10 pt-3 font-mono text-[11px] text-ink-soft">
        <Loader2 className="h-3 w-3 animate-spin" /> carregando composer…
      </div>
    );
  }

  if (!todo) {
    return (
      <div className="mt-4 border-t border-ink/10 pt-3 font-mono text-[11px] text-ink-soft">
        Proposta oc={codigoOc} não está mais pendente.
      </div>
    );
  }

  return (
    <ComposerInner
      card={card}
      todo={todo}
      codigoOc={codigoOc}
      templateSugeridoIA={templateSugeridoIA}
      onApproved={() => {
        qc.invalidateQueries({ queryKey: ["todos-pendentes", card.id] });
        qc.invalidateQueries({ queryKey: ["card", card.id] });
        qc.invalidateQueries({ queryKey: ["card-events", card.id] });
        qc.invalidateQueries({ queryKey: ["inline54-todo", card.id] });
        qc.invalidateQueries({ queryKey: ["cards"] });
        onApproved?.();
      }}
    />
  );
}

function ComposerInner({
  card,
  todo,
  codigoOc,
  templateSugeridoIA,
  onApproved,
}: {
  card: CardRow;
  todo: TodoRow;
  codigoOc: 54 | 59;
  templateSugeridoIA: string | null;
  onApproved: () => void;
}) {
  const cardId = card.id;
  const todoId = todo.id;

  const [skipEmail, setSkipEmail] = useState(false);
  // Aval "enviar mesmo sem evidência" (ocs 10/11/35) — espelho do
  // EditarEmailModal. Sem isto o executor bloqueia com "Evidencia ausente" e o
  // operador fica sem saída (NF 51712 ISABELY, 22/07 — bug RECORRENTE, já
  // sumiu na era Lovable).
  const [skipEvidencia, setSkipEvidencia] = useState(false);
  const [destinatarios, setDestinatarios] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [templateOriginalId, setTemplateOriginalId] = useState<string | null>(null);
  const [assunto, setAssunto] = useState("");
  const [corpo, setCorpo] = useState("");
  const [anexos, setAnexos] = useState<AnexoUploaded[]>([]);
  const [uploadingAnexo, setUploadingAnexo] = useState(false);
  const [aprovando, setAprovando] = useState(false);
  const [naoSeguirThread, setNaoSeguirThread] = useState(false);

  const editouRef = useRef({ assunto: "", corpo: "" });

  const { data: templatesAtivos = [] } = useTemplatesEmail();

  const cnpjPagador =
    (card.agent_state as Record<string, unknown> | null)?.cnpj_pagador as
      | string
      | undefined;
  const cnpjLimpo = cnpjPagador?.replace(/\D/g, "") ?? null;
  const remetenteCru = remetenteCruDoAgentState(card.agent_state);

  const { data: contatos, isLoading: loadingContatos } = useQuery({
    queryKey: ["inline54-contatos", cnpjLimpo, remetenteCru],
    enabled: !!cnpjLimpo && !!supabase,
    queryFn: async () => {
      if (!cnpjLimpo) return [];
      const { data, error } = await supabase!
        .from("contatos_cliente")
        .select("identificador, nome_pessoa, cargo, ordem, cnpj_remetente")
        .eq("documento_cliente", cnpjLimpo)
        .eq("tipo", "email")
        .eq("ativo", true)
        .or(remetenteCru ? `cnpj_remetente.is.null,cnpj_remetente.eq.${remetenteCru}` : "cnpj_remetente.is.null")
        .order("cnpj_remetente", { ascending: false, nullsFirst: false })
        .order("ordem", { nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as {
        identificador: string;
        nome_pessoa: string | null;
        cargo: string | null;
        ordem: number | null;
        cnpj_remetente: string | null;
      }[];
    },
  });

  const [preview, setPreview] = useState<{
    template_atual: {
      id: string;
      nome: string;
      descricao: string;
      assunto_renderizado: string;
      corpo_renderizado: string;
    };
    templates_disponiveis: Array<{ id: string; nome: string; descricao: string }>;
    email_destino: string | null;
    /** RPC preview_email_todo retorna a oc do card — decide o aval de evidência. */
    cod_ultima_ocorrencia_card?: number | null;
  } | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  async function carregarPreview(overrideId?: string) {
    if (!supabase) return null;
    setLoadingPreview(true);
    const { data, error } = await supabase.rpc("preview_email_todo", {
      p_todo_id: todoId,
      p_template_id_override: overrideId ?? null,
    });
    setLoadingPreview(false);
    if (error) {
      toast.error("Erro carregando template", { description: error.message });
      return null;
    }
    return data as any;
  }

  // Carga inicial
  useEffect(() => {
    if (preview || skipEmail) return;
    (async () => {
      const data = await carregarPreview(templateSugeridoIA ?? undefined);
      if (!data) return;
      setPreview(data);
      setTemplateId(data.template_atual.id);
      setTemplateOriginalId(data.template_atual.id);
      setAssunto(data.template_atual.assunto_renderizado);
      setCorpo(data.template_atual.corpo_renderizado);
      if (data.email_destino) setDestinatarios([data.email_destino]);
      editouRef.current = {
        assunto: data.template_atual.assunto_renderizado,
        corpo: data.template_atual.corpo_renderizado,
      };
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleTrocarTemplate(novoId: string) {
    if (!preview || novoId === templateId) return;
    const editou =
      assunto !== editouRef.current.assunto || corpo !== editouRef.current.corpo;
    if (editou) {
      const ok = window.confirm(
        "Trocar de template descarta as edições atuais. Continuar?",
      );
      if (!ok) return;
    }
    const data = await carregarPreview(novoId);
    if (!data) return;
    setPreview(data);
    setTemplateId(novoId);
    setAssunto(data.template_atual.assunto_renderizado);
    setCorpo(data.template_atual.corpo_renderizado);
    editouRef.current = {
      assunto: data.template_atual.assunto_renderizado,
      corpo: data.template_atual.corpo_renderizado,
    };
  }

  function toggleDestinatario(email: string) {
    setDestinatarios((cur) =>
      cur.includes(email) ? cur.filter((e) => e !== email) : [...cur, email],
    );
  }

  async function handleAprovar() {
    if (!supabase) return;
    const extras: Record<string, unknown> = {};
    if (skipEmail) {
      extras.skip_email = true;
      extras.enviar_email = false;
    } else {
      if (!corpo.trim()) return toast.error("Texto do email obrigatório");
      if (!assunto.trim()) return toast.error("Assunto obrigatório");
      if (destinatarios.length === 0)
        return toast.error("Selecione ao menos um destinatário");
      extras.enviar_email = true;
      extras.skip_email = false;
      extras.texto_email_customizado = corpo.trim();
      extras.assunto_override = assunto.trim();
      extras.email_destinatarios = destinatarios;
      if (templateId && templateId !== templateOriginalId) {
        extras.template_id_override = templateId;
      }
      if (naoSeguirThread) {
        extras.nao_seguir_thread = true;
      }
    }

    // Aval de evidência (espelho do EditarEmailModal, linhas ~224-233):
    // ocs 10/11/35 têm validação FORÇADA no executor — só o aval explícito
    // do operador libera o envio sem foto no SSW.
    const ocCard = preview?.cod_ultima_ocorrencia_card ?? null;
    const ocForcada = ocCard !== null && [10, 11, 35].includes(Number(ocCard));
    if (ocForcada && skipEvidencia) {
      extras.skip_evidencia = true;
    }

    if (anexos.length > 0) extras.anexos_ids = anexos.map((a) => a.anexo_id);

    setAprovando(true);
    toast.info(
      skipEmail
        ? `Lançando oc=${codigoOc}…`
        : `Lançando oc=${codigoOc} + enviando email…`,
    );
    const { error } = await supabase.rpc("aprovar_e_executar", {
      p_todo_id: todoId,
      p_extras: extras,
    } as any);
    setAprovando(false);
    if (error) {
      toast.error("Erro ao aprovar", { description: error.message });
      return;
    }
    toast.success(
      skipEmail
        ? `✓ oc=${codigoOc} lançada no SSW`
        : `✓ Email enviado pro cliente + oc=${codigoOc} lançada no SSW`,
    );
    onApproved();
  }

  // Opções: TODOS templates ativos + sugerido com ⭐ no topo
  const templateOpcoes =
    templatesAtivos.length > 0
      ? templatesAtivos
      : preview?.templates_disponiveis ?? [];
  const sugeridoSet = new Set(templateSugeridoIA ? [templateSugeridoIA] : []);
  const templateOpcoesOrdenadas = [
    ...templateOpcoes.filter((t) => sugeridoSet.has(t.id)),
    ...templateOpcoes.filter((t) => !sugeridoSet.has(t.id)),
  ];

  return (
    <div className="mt-4 space-y-3 border-t border-ink/15 pt-3">
      <div className="font-mono text-[10px] font-bold uppercase tracking-widest text-ink-soft">
        ─── email ───────────────────────────
      </div>

      {/* Skip checkbox */}
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={skipEmail}
          onChange={(e) => setSkipEmail(e.target.checked)}
          className="h-3.5 w-3.5 accent-sal"
        />
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink">
          marcar como já enviado manualmente (pula envio, só lança oc no SSW)
        </span>
      </label>

      {!skipEmail && (
        <>
          {/* Destinatários */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                destinatários <span className="text-red-600">*</span>
              </span>
              <span className="font-mono text-[9px] text-ink/40">
                (1º = TO, demais = CC)
              </span>
            </div>
            {loadingContatos ? (
              <div className="font-mono text-[10px] text-ink/50">
                carregando contatos…
              </div>
            ) : !cnpjLimpo ? (
              <div className="border border-amber-300 bg-amber-50 px-2 py-1.5 font-mono text-[10px] text-amber-900">
                Sem CNPJ pagador no card — não dá pra carregar contatos.
              </div>
            ) : (contatos ?? []).length === 0 ? (
              <div className="border border-amber-300 bg-amber-50 px-2 py-1.5 font-mono text-[10px] text-amber-900">
                Nenhum email cadastrado em contatos_cliente (CNPJ {cnpjLimpo}).
              </div>
            ) : (
              <div className="max-h-40 space-y-1 overflow-y-auto border border-ink/15 bg-paper-deep/30 p-1.5">
                {(contatos ?? []).map((c) => {
                  const checked = destinatarios.includes(c.identificador);
                  return (
                    <label
                      key={c.identificador}
                      className="flex cursor-pointer items-start gap-2 px-1 py-0.5 hover:bg-ink/[0.04]"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleDestinatario(c.identificador)}
                        className="mt-0.5 h-3.5 w-3.5 accent-sal"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-[11px] text-ink">
                          {c.identificador}
                        </div>
                        {(c.nome_pessoa || c.cargo || c.cnpj_remetente) && (
                          <div className="truncate font-mono text-[9px] text-ink/50">
                            {[c.cnpj_remetente ? "📌 contato deste remetente" : null, c.nome_pessoa, c.cargo].filter(Boolean).join(" • ")}
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* Template */}
          <div>
            <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
              template <span className="text-red-600">*</span>
            </label>
            {loadingPreview && !preview ? (
              <div className="font-mono text-[10px] text-ink/50">
                carregando templates…
              </div>
            ) : (
              <select
                value={templateId ?? ""}
                onChange={(e) => handleTrocarTemplate(e.target.value)}
                disabled={loadingPreview || templateOpcoesOrdenadas.length <= 1}
                className="w-full border border-ink/30 bg-paper px-2 py-1.5 text-[12px] text-ink outline-none focus:border-ink disabled:opacity-60"
              >
                {templateOpcoesOrdenadas.map((t) => (
                  <option key={t.id} value={t.id} title={t.descricao ?? ""}>
                    {sugeridoSet.has(t.id) ? "⭐ " : ""}
                    {t.nome}{" "}
                    {sugeridoSet.has(t.id) ? "(sugerido pela IA)" : ""}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Assunto */}
          <div>
            <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
              assunto <span className="text-red-600">*</span>
            </label>
            <input
              type="text"
              value={assunto}
              onChange={(e) => setAssunto(e.target.value)}
              className="w-full border border-ink/30 bg-paper px-2 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-ink"
            />
          </div>

          {/* Nova thread (não seguir histórico) */}
          <label className="flex cursor-pointer items-start gap-2 border border-ink/15 bg-paper-deep/30 px-2 py-1.5">
            <input
              type="checkbox"
              checked={naoSeguirThread}
              onChange={(e) => setNaoSeguirThread(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-sal"
            />
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[11px] text-ink">
                Enviar como novo e-mail (não seguir o histórico anterior da tratativa)
              </div>
              <div className="font-mono text-[9px] leading-snug text-ink/50">
                Por padrão, este e-mail continua a conversa anterior com o cliente sobre esta NF.
                Marque aqui só se for um assunto novo que deve começar um e-mail separado.
              </div>
            </div>
          </label>

          {/* Skip evidência — só ocs 10/11/35 (validação forçada no executor).
              Espelho do EditarEmailModal — mesmo texto, mesma semântica. */}
          {preview?.cod_ultima_ocorrencia_card != null &&
            [10, 11, 35].includes(Number(preview.cod_ultima_ocorrencia_card)) && (
              <label className="flex cursor-pointer items-start gap-2 border-2 border-amber-400 bg-amber-50 px-2 py-1.5">
                <input
                  type="checkbox"
                  checked={skipEvidencia}
                  onChange={(e) => setSkipEvidencia(e.target.checked)}
                  disabled={aprovando}
                  className="mt-0.5 h-3.5 w-3.5 accent-amber-600"
                />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[11px] font-bold uppercase tracking-wider text-amber-900">
                    Não validar evidência
                  </div>
                  <div className="font-mono text-[10px] leading-snug text-amber-900/80">
                    Envia o e-mail e lança a oc mesmo sem foto correlacionada
                    no SSW (você se responsabiliza por anexar manualmente).
                    Fica registrado em auditoria.
                  </div>
                </div>
              </label>
            )}

          {/* Corpo */}
          <div>
            <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
              texto do email <span className="text-red-600">*</span>
              <span className="ml-1 normal-case text-ink/40">
                (use {"{link_evidencia}"} pra link automático)
              </span>
            </label>
            <textarea
              value={corpo}
              onChange={(e) => setCorpo(e.target.value)}
              rows={12}
              maxLength={4000}
              className="w-full resize-y border border-ink/30 bg-paper px-2 py-1.5 font-mono text-[11px] leading-relaxed text-ink outline-none focus:border-ink"
            />
            <div className="mt-0.5 flex justify-between font-mono text-[9px] text-ink/40">
              <span>obrigatório</span>
              <span>{corpo.length}/4000</span>
            </div>
          </div>

          {/* Anexos */}
          <div>
            <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
              anexos (opcional)
            </label>
            <AnexosUploader
              cardId={cardId}
              todoId={todoId}
              anexos={anexos}
              onChange={setAnexos}
              uploading={uploadingAnexo}
              setUploading={setUploadingAnexo}
              compact
            />
          </div>
        </>
      )}

      <div className="flex items-center gap-3 border-t border-ink/10 pt-3">
        <button
          type="button"
          onClick={handleAprovar}
          disabled={aprovando || uploadingAnexo}
          className="inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 font-body text-[13px] font-medium text-paper transition-colors hover:bg-ink-soft disabled:opacity-50"
        >
          {aprovando && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {aprovando
            ? skipEmail
              ? "Lançando oc…"
              : "Enviando email + lançando oc…"
            : skipEmail
              ? `✓ Aprovar oc=${codigoOc} (sem email)`
              : `✓ Aprovar oc=${codigoOc} + Email`}
        </button>
      </div>
    </div>
  );
}
