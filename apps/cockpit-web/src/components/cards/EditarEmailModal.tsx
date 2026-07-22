import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/lib/supabase";
import { useTemplatesEmail } from "@/hooks/useTemplatesEmail";
import { AnexosUploader, type AnexoUploaded } from "./AnexosUploader";

export interface PreviewEmailRpcResponse {
  todo_id: string;
  card_id: string;
  nf: string | null;
  codigo_ssw_proposta: number;
  cod_ultima_ocorrencia_card: number | null;
  email_destino: string | null;
  template_atual: {
    id: string;
    nome: string;
    descricao: string;
    assunto_renderizado: string;
    corpo_renderizado: string;
    usa_link_evidencia: boolean;
  };
  templates_disponiveis: Array<{
    id: string;
    nome: string;
    descricao: string;
  }>;
}

export function EditarEmailModal({
  todoId,
  onClose,
  onConfirm,
  submitting,
  iaCorpoSugerido,
  templateSugeridoIA,
  origemExtravio = false,
  permitirAprovarSemPreview = false,
}: {
  todoId: string;
  onClose: () => void;
  onConfirm: (extras: Record<string, unknown>) => void;
  submitting: boolean;
  iaCorpoSugerido?: string | null;
  templateSugeridoIA?: string | null;
  origemExtravio?: boolean;
  /**
   * Fluxos tolerantes a falha de e-mail (romaneio-interno: "se email falhar,
   * registra aviso mas lança oc=33 mesmo assim") podem aprovar mesmo com o
   * preview quebrado (ex.: template do cliente removido) — extras vazios =
   * renderização/envio ficam por conta do executor. Sem isso o modal vira
   * hard-gate num fluxo que o backend desenhou pra nunca travar.
   */
  permitirAprovarSemPreview?: boolean;
}) {
  const { data: templatesAtivos = [] } = useTemplatesEmail();

  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewEmailRpcResponse | null>(null);

  const [templateId, setTemplateId] = useState<string>("");
  const [templateOriginalId, setTemplateOriginalId] = useState<string>("");
  const [assunto, setAssunto] = useState("");
  const [corpo, setCorpo] = useState("");
  const [destinatarios, setDestinatarios] = useState<string[]>([]);
  const [destinatarioManual, setDestinatarioManual] = useState<string>("");
  const [trocandoTemplate, setTrocandoTemplate] = useState(false);
  const [validarEvidencia, setValidarEvidencia] = useState(false);
  const [skipEvidencia, setSkipEvidencia] = useState(false);
  const [anexos, setAnexos] = useState<AnexoUploaded[]>([]);
  const [uploadingAnexo, setUploadingAnexo] = useState(false);
  const [naoSeguirThread, setNaoSeguirThread] = useState(false);


  // controle de "usuário editou" — pra alertar antes de descartar
  const editouRef = useRef(false);
  const baseAssuntoRef = useRef("");
  const baseCorpoRef = useRef("");

  const iaCorpoAplicadoRef = useRef(false);

  function aplicarPreview(p: PreviewEmailRpcResponse, manterDestinatarios = false) {
    setPreview(p);
    setTemplateId(p.template_atual.id);
    setAssunto(p.template_atual.assunto_renderizado);
    // Se IA sugeriu corpo do email, usa ele na primeira carga (precedência sobre template raw)
    const corpoInicial =
      iaCorpoSugerido && !iaCorpoAplicadoRef.current
        ? iaCorpoSugerido
        : p.template_atual.corpo_renderizado;
    setCorpo(corpoInicial);
    if (iaCorpoSugerido && !iaCorpoAplicadoRef.current) {
      iaCorpoAplicadoRef.current = true;
    }
    if (!manterDestinatarios) {
      setDestinatarios(p.email_destino ? [p.email_destino] : []);
    }
    baseAssuntoRef.current = p.template_atual.assunto_renderizado;
    baseCorpoRef.current = corpoInicial;
    editouRef.current = false;
  }


  async function carregarPreview(overrideId?: string, manterDestinatarios = false) {
    if (!supabase) return;
    setLoading(true);
    setErrored(null);
    const { data, error } = await supabase.rpc("preview_email_todo", {
      p_todo_id: todoId,
      p_template_id_override: overrideId ?? null,
    });
    setLoading(false);
    if (error) {
      setErrored(error.message);
      return;
    }
    const p = data as PreviewEmailRpcResponse;
    aplicarPreview(p, manterDestinatarios);
    if (!manterDestinatarios) setTemplateOriginalId(p.template_atual.id);
  }

  useEffect(() => {
    // se IA sugeriu template, já carrega com ele aplicado
    carregarPreview(templateSugeridoIA ?? undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todoId]);

  // carrega CNPJ do card pra buscar contatos
  const { data: cardCtx } = useQuery({
    queryKey: ["editar-email-card-ctx", preview?.card_id],
    enabled: !!preview?.card_id && !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("cards")
        .select("agent_state")
        .eq("id", preview!.card_id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const cnpjLimpo = useMemo(() => {
    const cnpj = (cardCtx?.agent_state as Record<string, unknown> | null)
      ?.cnpj_pagador as string | undefined;
    return cnpj?.replace(/\D/g, "") ?? null;
  }, [cardCtx]);

  const { data: contatos, isLoading: loadingContatos } = useQuery({
    queryKey: ["editar-email-contatos", cnpjLimpo],
    enabled: !!cnpjLimpo && !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("contatos_cliente")
        .select("identificador, nome_pessoa, cargo, ordem")
        .eq("documento_cliente", cnpjLimpo!)
        .eq("tipo", "email")
        .eq("ativo", true)
        .order("ordem", { nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as {
        identificador: string;
        nome_pessoa: string | null;
        cargo: string | null;
        ordem: number | null;
      }[];
    },
  });

  function marcarEditadoSeNecessario(novoAssunto: string, novoCorpo: string) {
    if (
      novoAssunto !== baseAssuntoRef.current ||
      novoCorpo !== baseCorpoRef.current
    ) {
      editouRef.current = true;
    }
  }

  async function handleTrocarTemplate(novoId: string) {
    if (!preview) return;
    if (novoId === templateId) return;
    if (editouRef.current) {
      const ok = window.confirm(
        "Trocar de template descarta as edições atuais. Continuar?",
      );
      if (!ok) return;
    }
    setTrocandoTemplate(true);
    await carregarPreview(novoId, true);
    setTrocandoTemplate(false);
  }

  function toggleDestinatario(email: string) {
    setDestinatarios((atual) =>
      atual.includes(email) ? atual.filter((e) => e !== email) : [...atual, email],
    );
  }

  function adicionarManual() {
    const email = destinatarioManual.trim();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast.error("Email inválido");
      return;
    }
    if (!destinatarios.includes(email)) {
      setDestinatarios((d) => [...d, email]);
    }
    setDestinatarioManual("");
  }

  function handleConfirmar() {
    if (!preview) return;
    if (destinatarios.length === 0) {
      toast.error("Selecione ao menos um destinatário.");
      return;
    }
    if (!assunto.trim()) {
      toast.error("Assunto vazio.");
      return;
    }
    if (!corpo.trim()) {
      toast.error("Corpo vazio.");
      return;
    }
    const extras: Record<string, unknown> = {
      assunto_override: assunto,
      texto_email_customizado: corpo,
      email_destinatarios: destinatarios,
    };
    const ocCard = preview.cod_ultima_ocorrencia_card;
    const ocForcada = ocCard !== null && [10, 11, 35].includes(ocCard);
    if (origemExtravio) {
      extras.validar_evidencia = false;
    } else if (!ocForcada) {
      extras.validar_evidencia = validarEvidencia;
    }
    if (ocForcada && skipEvidencia) {
      extras.skip_evidencia = true;
    }
    if (templateId !== templateOriginalId) {
      extras.template_id_override = templateId;
    }
    if (anexos.length > 0) {
      extras.anexos_ids = anexos.map((a) => a.anexo_id);
    }
    if (naoSeguirThread) {
      extras.nao_seguir_thread = true;
    }
    onConfirm(extras);

  }

  const podeConfirmar =
    !!preview &&
    !submitting &&
    !loading &&
    !trocandoTemplate &&
    !uploadingAnexo &&
    destinatarios.length > 0 &&
    !!assunto.trim() &&
    !!corpo.trim();

  const contatosLista = contatos ?? [];
  const destinatariosExtras = destinatarios.filter(
    (e) => !contatosLista.some((c) => c.identificador === e),
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto border border-ink/20 bg-paper p-5">
        <div className="mb-3 font-mono text-[11px] uppercase tracking-wider text-ink-soft">
          ✉️ Aprovar e enviar email
          {preview?.nf && (
            <span className="ml-2 text-ink">— NF {preview.nf}</span>
          )}
        </div>

        {loading && (
          <div className="py-8 text-center font-mono text-[11px] text-ink-soft">
            carregando preview…
          </div>
        )}

        {errored && (
          <div className="border border-red-300 bg-red-50 p-3 text-[12px] text-red-900">
            Erro ao carregar preview: {errored}
            <div className="mt-2 flex justify-end gap-2">
              <button
                onClick={onClose}
                className="border border-ink/30 bg-paper px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink"
              >
                Fechar
              </button>
              <button
                onClick={() => carregarPreview()}
                className="bg-sal px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-paper"
              >
                Tentar de novo
              </button>
              {permitirAprovarSemPreview && (
                <button
                  onClick={() => onConfirm({})}
                  disabled={submitting}
                  className="bg-amber-600 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-paper disabled:opacity-50"
                  title="Aprova sem editar: o executor renderiza/envia o e-mail pelo fluxo automático (tolerante a falha) e lança a oc mesmo se o e-mail falhar"
                >
                  {submitting ? "aprovando..." : "aprovar sem editar →"}
                </button>
              )}
            </div>
          </div>
        )}

        {preview && !errored && (
          <div className="space-y-3">
            {/* Destinatários */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                  Destinatários <span className="text-red-600">*</span>
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
                  Sem CNPJ pagador no card — informe o e-mail do destinatário abaixo.
                </div>
              ) : contatosLista.length === 0 ? (
                <div className="border-2 border-amber-400 bg-amber-50 px-2 py-1.5 font-mono text-[10px] font-bold text-amber-900">
                  ⚠ Cliente sem e-mail cadastrado — informe o destinatário abaixo.
                  <div className="mt-0.5 font-normal normal-case tracking-normal text-amber-800/80">
                    O e-mail informado será auto-cadastrado pra esse cliente nos próximos cards.
                  </div>
                </div>
              ) : (
                <div className="max-h-40 space-y-1 overflow-y-auto border border-ink/15 bg-paper-deep/30 p-1.5">
                  {contatosLista.map((c) => {
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
                          {(c.nome_pessoa || c.cargo) && (
                            <div className="truncate font-mono text-[9px] text-ink/50">
                              {[c.nome_pessoa, c.cargo].filter(Boolean).join(" • ")}
                            </div>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}

              {destinatariosExtras.length > 0 && (
                <div className="mt-1 space-y-1 border border-ink/15 bg-paper-deep/30 p-1.5">
                  {destinatariosExtras.map((email) => (
                    <label
                      key={email}
                      className="flex cursor-pointer items-center gap-2 px-1 py-0.5 hover:bg-ink/[0.04]"
                    >
                      <input
                        type="checkbox"
                        checked
                        onChange={() => toggleDestinatario(email)}
                        className="h-3.5 w-3.5 accent-sal"
                      />
                      <span className="truncate font-mono text-[11px] text-ink">
                        {email} <span className="text-ink/40">(manual)</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <div className="mt-1 flex gap-1">
                <input
                  type="email"
                  value={destinatarioManual}
                  onChange={(e) => setDestinatarioManual(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      adicionarManual();
                    }
                  }}
                  placeholder={
                    destinatarios.length === 0 && contatosLista.length === 0
                      ? "informe o e-mail do destinatário…"
                      : "adicionar email manual…"
                  }
                  className={
                    "flex-1 border bg-paper px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-ink " +
                    (destinatarios.length === 0
                      ? "border-red-400 ring-1 ring-red-200"
                      : "border-ink/30")
                  }
                />
                <button
                  type="button"
                  onClick={adicionarManual}
                  className="border border-ink/30 bg-paper px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink"
                >
                  +
                </button>
              </div>
              <div className="mt-0.5 font-mono text-[9px] text-ink/50">
                {destinatarios.length === 0 ? (
                  <span className="font-bold text-red-600">
                    obrigatório — informe ao menos 1 e-mail
                  </span>
                ) : (
                  <>{destinatarios.length} selecionado(s)</>
                )}
              </div>
            </div>

            {/* Template — universal: TODOS os templates ativos em QUALQUER oc */}
            {(() => {
              const opcoes =
                templatesAtivos.length > 0
                  ? templatesAtivos
                  : preview.templates_disponiveis;
              const sugeridoSet = new Set(
                templateSugeridoIA ? [templateSugeridoIA] : [],
              );
              const opcoesOrdenadas = [
                ...opcoes.filter((t) => sugeridoSet.has(t.id)),
                ...opcoes.filter((t) => !sugeridoSet.has(t.id)),
              ];
              const t = opcoesOrdenadas.find((x) => x.id === templateId);
              return (
                <div>
                  <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                    Template <span className="text-red-600">*</span>
                  </label>
                  <select
                    value={templateId}
                    onChange={(e) => handleTrocarTemplate(e.target.value)}
                    disabled={
                      trocandoTemplate || submitting || opcoesOrdenadas.length <= 1
                    }
                    className="w-full border border-ink/30 bg-paper px-2 py-1.5 text-[12px] text-ink outline-none focus:border-ink disabled:opacity-60"
                  >
                    {opcoesOrdenadas.map((t) => (
                      <option key={t.id} value={t.id} title={t.descricao ?? ""}>
                        {sugeridoSet.has(t.id) ? "⭐ " : ""}
                        {t.nome}
                        {sugeridoSet.has(t.id) ? " (sugerido pela IA)" : ""}
                      </option>
                    ))}
                  </select>
                  {t?.descricao ? (
                    <div className="mt-1 font-mono text-[10px] text-ink/50">
                      {t.descricao}
                    </div>
                  ) : null}
                </div>
              );
            })()}

            {/* Validar evidência (oc != 10/11/35) — escondido pra extravios */}
            {!origemExtravio &&
              preview.cod_ultima_ocorrencia_card !== null &&
              ![10, 11, 35].includes(preview.cod_ultima_ocorrencia_card) && (
                <label className="flex cursor-pointer items-start gap-2 border border-ink/15 bg-paper-deep/30 px-2 py-1.5">
                  <input
                    type="checkbox"
                    checked={validarEvidencia}
                    onChange={(e) => setValidarEvidencia(e.target.checked)}
                    disabled={submitting}
                    className="mt-0.5 h-3.5 w-3.5 accent-sal"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[11px] text-ink">
                      Validar evidência antes de enviar
                    </div>
                    <div className="font-mono text-[9px] leading-snug text-ink/50">
                      Aplica regra de bloqueio se SSW não tiver foto anexada
                      na oc do card. Ative só se o motivo exige foto (ex:
                      contestação de recusa).
                    </div>
                  </div>
                </label>
              )}

            {/* Skip evidência — só para ocs 10/11/35 onde a validação é forçada */}
            {!origemExtravio &&
              preview.cod_ultima_ocorrencia_card !== null &&
              [10, 11, 35].includes(preview.cod_ultima_ocorrencia_card) && (
                <label className="flex cursor-pointer items-start gap-2 border-2 border-amber-400 bg-amber-50 px-2 py-1.5">
                  <input
                    type="checkbox"
                    checked={skipEvidencia}
                    onChange={(e) => setSkipEvidencia(e.target.checked)}
                    disabled={submitting}
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



            {/* Assunto */}
            <div>
              <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                Assunto <span className="text-red-600">*</span>
              </label>
              <input
                type="text"
                value={assunto}
                onChange={(e) => {
                  setAssunto(e.target.value);
                  marcarEditadoSeNecessario(e.target.value, corpo);
                }}
                disabled={submitting}
                className="w-full border border-ink/30 bg-paper px-2 py-1.5 text-[12px] text-ink outline-none focus:border-ink"
              />
            </div>

            {/* Nova thread (não seguir histórico) */}
            <label className="flex cursor-pointer items-start gap-2 border border-ink/15 bg-paper-deep/30 px-2 py-1.5">
              <input
                type="checkbox"
                checked={naoSeguirThread}
                onChange={(e) => setNaoSeguirThread(e.target.checked)}
                disabled={submitting}
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



            {/* Corpo */}
            <div>
              <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                Texto do email <span className="text-red-600">*</span>
                <span className="ml-1 normal-case text-ink/40">
                  (use {"{link_evidencia}"} pra inserir link automático)
                </span>
              </label>
              <textarea
                value={corpo}
                onChange={(e) => {
                  setCorpo(e.target.value);
                  marcarEditadoSeNecessario(assunto, e.target.value);
                }}
                rows={14}
                disabled={submitting}
                className="w-full resize-y border border-ink/30 bg-paper px-2 py-2 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-ink"
              />
            </div>

            {preview.template_atual.usa_link_evidencia && (
              <div className="border-l-2 border-yellow-400 bg-yellow-50 px-3 py-2 text-[11px] text-yellow-900">
                🔗 O placeholder <code>{"{link_evidencia}"}</code> será
                substituído por um link único no momento do envio. Mantenha-o
                no texto se quiser que o cliente veja a evidência.
              </div>
            )}

            {!origemExtravio && (
              <div className="border-l-2 border-ink/30 bg-ink/[0.02] px-2 py-1.5 font-mono text-[10px] leading-snug text-ink/60">
                <strong className="text-ink/80">Como funciona:</strong> ao
                confirmar, lança a oc no SSW e dispara o email pelo seu Gmail
                (mesma thread). O placeholder <code>{"{link_evidencia}"}</code>{" "}
                vira link automático — não precisa colar nada manual.
              </div>
            )}

            <AnexosUploader
              cardId={preview.card_id}
              todoId={preview.todo_id}
              anexos={anexos}
              onChange={setAnexos}
              uploading={uploadingAnexo}
              setUploading={setUploadingAnexo}
              disabled={submitting}
            />

            <div className="flex justify-end gap-2 border-t border-ink/10 pt-3">
              <button
                onClick={onClose}
                disabled={submitting}
                className="border border-ink/30 bg-paper px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink transition-colors hover:border-ink disabled:opacity-40"
              >
                Cancelar
              </button>
              <button
                onClick={handleConfirmar}
                disabled={!podeConfirmar}
                className="bg-sal px-4 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-paper transition-colors hover:bg-ink disabled:opacity-40"
              >
                {submitting ? "..." : "Confirmar →"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
