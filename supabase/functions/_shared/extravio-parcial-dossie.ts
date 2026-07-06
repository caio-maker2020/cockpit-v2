// =============================================================================
// extravio-parcial-dossie — dossiê de completude + gate da oc 33 no fluxo de
// EXTRAVIO PARCIAL (perdeu ALGUNS volumes da NF, não todos).
//
// Caio 2026-07-01 (NF 66193 INOVAMED / Larissa). Contexto:
//   - Extravio TOTAL: a oc 33 (handoff pro Ressarcimento) exige SÓ o romaneio de
//     coleta assinado. (já funciona — este módulo NÃO mexe nesse caminho.)
//   - Extravio PARCIAL: a oc 33 de COMPLETUDE exige 3 informações que chegam
//     FATIADAS, em e-mails diferentes: romaneio + descrição dos itens + valor dos
//     itens. Até as 3 estarem completas, a oc 33 de completude fica bloqueada e o
//     operador é avisado do que falta.
//
// Duas naturezas da oc 33 (ver plano / ADR 0011):
//   1. OPERACIONAL (combo com oc 44) — Caso 2 (devolução/recusa total): sai SÓ
//      com romaneio, destrava a devolução física. NÃO marca indenização completa.
//   2. COMPLETUDE de indenização — exige romaneio + descrição + valor. É a única
//      oc 33 do Caso 1 (pós-oc 19) e a 2ª oc 33 do Caso 2 (pós-devolução).
//
// Funções PURAS, testadas em extravio-parcial-dossie.test.ts (convenção nº 8).
// A DETECÇÃO de "é extravio parcial" e o preenchimento do dossiê são
// responsabilidade dos callers (interpretador-resposta-cliente etc.); aqui só
// avaliamos/gateamos a partir do estado já gravado em agent_state.
// =============================================================================

/** Rótulos humanos das 3 evidências — usados no banner "faltam: ...". */
export const ROTULO_EVIDENCIA = {
  romaneio: "romaneio de coleta assinado",
  descricao: "descrição dos itens",
  valor: "valor dos itens",
} as const;

// "corpo"/"anexo" = evidência do cliente (fonte original). "ssw" = evidência
// PROCESSUAL derivada do histórico SSW (Nível 2 do seed histórico do romaneio:
// oc 33 já lançada + oc 49 do Ressarcimento pedindo só descrição/valor). O LLM
// NUNCA cria "ssw" — só os helpers determinísticos (Codex 2026-07-02).
export type FonteEvidencia = "corpo" | "anexo" | "ssw";

/** Referência p/ RE-BUSCAR o anexo do e-mail (o binário NÃO é guardado aqui). */
export interface RefEvidenciaAnexo {
  gmail_message_id?: string | null;
  gmail_thread_id?: string | null;
  message_inbox_id?: string | null;
  /** operador que RECEBEU o inbound (raw_payload.operador_id) — caixa Gmail da re-busca. */
  operador_id?: string | null;
  operador_email?: string | null;
  filename?: string | null;
  size_bytes?: number | null;
  mime_type?: string | null;
  /** Só p/ evidência fonte="ssw" (processual): datas da oc 33/oc 49 que a sustentam.
   * NÃO tem anexo/binário — o materializador da 2ª oc 33 NÃO deve tentar reanexar. */
  ref_processual?: { oc33?: string | null; oc49?: string | null };
}

export interface EvidenciaRomaneio extends RefEvidenciaAnexo {
  presente: boolean;
  /** Romaneio é sempre um documento anexado; fonte fica "anexo" (ou inline). */
  fonte?: FonteEvidencia | null;
  visto_em?: string | null;
}

export interface EvidenciaTexto extends RefEvidenciaAnexo {
  presente: boolean;
  fonte?: FonteEvidencia | null;
  /** Trecho BRUTO do que o cliente enviado (Ajuste 5: LLM rotula, evidência é a
   * fonte original — nunca paráfrase). Preenchido quando fonte='corpo'. */
  texto_bruto?: string | null;
  visto_em?: string | null;
}

export interface DossieExtravioParcial {
  romaneio: EvidenciaRomaneio;
  descricao: EvidenciaTexto;
  valor: EvidenciaTexto;
  /** romaneio && descricao && valor presentes. */
  completo: boolean;
  /** Caso 2: 1ª oc 33 operacional (com 44) já foi lançada — NÃO é completude. */
  oc33_operacional_lancada: boolean;
  /** oc 33 de completude (as 3 infos) já foi lançada — handoff concluído. */
  indenizacao_completa: boolean;
}

export interface ExtravioParcialState {
  caso: "1" | "2";
  fase?: string | null;
  dossie: DossieExtravioParcial;
}

/** Card mínimo que o gate/detecção lê (agent_state). */
export interface CardComAgentState {
  agent_state?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Construção / leitura
// ---------------------------------------------------------------------------

export function dossieVazio(): DossieExtravioParcial {
  return {
    romaneio: { presente: false },
    descricao: { presente: false },
    valor: { presente: false },
    completo: false,
    oc33_operacional_lancada: false,
    indenizacao_completa: false,
  };
}

/** Lê o estado extravio_parcial do card (null se não for card parcial). */
export function lerExtravioParcial(
  card: CardComAgentState | null | undefined,
): ExtravioParcialState | null {
  const raw = card?.agent_state?.["extravio_parcial"];
  if (!raw || typeof raw !== "object") return null;
  const st = raw as Partial<ExtravioParcialState>;
  if (st.caso !== "1" && st.caso !== "2") return null;
  return {
    caso: st.caso,
    fase: st.fase ?? null,
    dossie: { ...dossieVazio(), ...(st.dossie ?? {}) },
  };
}

/**
 * É extravio parcial em coleta? true SÓ quando o card já tem
 * agent_state.extravio_parcial.caso setado. Card de extravio total / card comum
 * NUNCA tem essa chave → false → gate passa tudo intacto (zero regressão).
 */
export function ehExtravioParcial(
  card: CardComAgentState | null | undefined,
): boolean {
  return lerExtravioParcial(card) !== null;
}

// ---------------------------------------------------------------------------
// Avaliação de completude
// ---------------------------------------------------------------------------

export interface AvaliacaoDossie {
  completo: boolean;
  /** Rótulos humanos das evidências AINDA faltantes (ordem romaneio→desc→valor). */
  faltando: string[];
}

export function avaliarDossie(dossie: DossieExtravioParcial): AvaliacaoDossie {
  const faltando: string[] = [];
  if (!dossie.romaneio?.presente) faltando.push(ROTULO_EVIDENCIA.romaneio);
  if (!dossie.descricao?.presente) faltando.push(ROTULO_EVIDENCIA.descricao);
  if (!dossie.valor?.presente) faltando.push(ROTULO_EVIDENCIA.valor);
  return { completo: faltando.length === 0, faltando };
}

// ---------------------------------------------------------------------------
// Merge idempotente de evidências (acumula ao longo das respostas fatiadas)
// ---------------------------------------------------------------------------

type EntradaEvidencia = RefEvidenciaAnexo & {
  fonte?: FonteEvidencia;
  texto_bruto?: string | null;
  visto_em?: string | null;
};

export interface EvidenciasRecebidas {
  romaneio?: EntradaEvidencia | null;
  descricao?: EntradaEvidencia | null;
  valor?: EntradaEvidencia | null;
}

/**
 * Aplica evidências recém-chegadas ao dossiê. IDEMPOTENTE e MONOTÔNICO:
 * `presente` nunca volta pra false (uma evidência já recebida não "desaparece"
 * se um e-mail posterior não a repetir). Referências/texto novos SOBRESCREVEM
 * (última fonte vence — ex.: cliente reenvia romaneio corrigido). Recalcula
 * `completo`. Não muta a entrada.
 */
export function mergeEvidencia(
  dossie: DossieExtravioParcial,
  recebidas: EvidenciasRecebidas | null | undefined,
): DossieExtravioParcial {
  const next: DossieExtravioParcial = {
    ...dossie,
    romaneio: { ...dossie.romaneio },
    descricao: { ...dossie.descricao },
    valor: { ...dossie.valor },
  };
  if (recebidas?.romaneio) {
    next.romaneio = { ...next.romaneio, ...recebidas.romaneio, presente: true };
  }
  if (recebidas?.descricao) {
    next.descricao = { ...next.descricao, ...recebidas.descricao, presente: true };
  }
  if (recebidas?.valor) {
    next.valor = { ...next.valor, ...recebidas.valor, presente: true };
  }
  next.completo = avaliarDossie(next).completo;
  return next;
}

// ---------------------------------------------------------------------------
// Validação determinística de evidência (Ajuste 2 / auditoria Codex)
//
// O LLM CLASSIFICA (qual evidência chegou, de onde); mas a evidência só CONTA se
// provada contra a fonte real — nunca marca dossiê completo com dado inventado:
//   - fonte="anexo": o filename precisa existir na lista de anexos inbound;
//   - fonte="corpo": o trecho_verbatim precisa EXISTIR no corpo do e-mail (com
//     normalização leve de whitespace/caixa);
//   - romaneio: é um DOCUMENTO — só conta com um anexo real (nunca por filename
//     inventado pelo LLM).
// ---------------------------------------------------------------------------

export interface EvidenciaLlmRaw {
  fonte?: "corpo" | "anexo";
  anexo_filename?: string;
  trecho_verbatim?: string;
}

export interface AnexoInbound {
  filename: string;
  mime_type: string;
  size_bytes: number;
}

export interface RefMensagem {
  message_inbox_id: string;
  gmail_message_id: string | null;
  gmail_thread_id?: string | null;
  operador_id?: string | null;
  visto_em: string;
}

/** Normalização leve pra comparar texto do LLM com o corpo: caixa + whitespace. */
export function normalizarTexto(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** true se `trecho` (não trivial) existe no `conteudo`, com normalização leve. */
export function corpoContemTrecho(
  trecho: string | null | undefined,
  conteudo: string | null | undefined,
): boolean {
  if (!trecho || !conteudo) return false;
  const t = normalizarTexto(trecho);
  if (t.length < 3) return false; // evita match trivial ("r$", "1", etc.)
  return normalizarTexto(conteudo).includes(t);
}

/** Acha o anexo inbound correspondente ao filename (exato → case-insensitive → substring); null se não existir. */
export function acharAnexoInbound(
  nome: string | null | undefined,
  anexos: readonly AnexoInbound[],
): AnexoInbound | null {
  if (!nome) return null;
  const alvo = nome.trim().toLowerCase();
  if (!alvo) return null;
  return (
    anexos.find((a) => a.filename.toLowerCase() === alvo) ??
    anexos.find((a) => {
      const f = a.filename.toLowerCase();
      return f.includes(alvo) || alvo.includes(f);
    }) ??
    null
  );
}

/**
 * Converte a classificação do LLM em `EvidenciasRecebidas` VALIDADAS. Só inclui
 * as evidências que passam na prova determinística (acima). Função pura.
 */
export function montarEvidenciasRecebidas(
  llm: { romaneio?: EvidenciaLlmRaw; descricao?: EvidenciaLlmRaw; valor?: EvidenciaLlmRaw } | null | undefined,
  anexos: readonly AnexoInbound[],
  conteudo: string,
  ref: RefMensagem,
): EvidenciasRecebidas {
  const out: EvidenciasRecebidas = {};
  if (!llm) return out;

  const refAnexo = (a: AnexoInbound) => ({
    fonte: "anexo" as const,
    message_inbox_id: ref.message_inbox_id,
    gmail_message_id: ref.gmail_message_id,
    gmail_thread_id: ref.gmail_thread_id ?? null,
    operador_id: ref.operador_id ?? null,
    filename: a.filename,
    size_bytes: a.size_bytes,
    mime_type: a.mime_type,
    visto_em: ref.visto_em,
  });
  const refCorpo = (trecho: string) => ({
    fonte: "corpo" as const,
    texto_bruto: trecho.slice(0, 4000),
    message_inbox_id: ref.message_inbox_id,
    gmail_message_id: ref.gmail_message_id,
    gmail_thread_id: ref.gmail_thread_id ?? null,
    operador_id: ref.operador_id ?? null,
    visto_em: ref.visto_em,
  });

  // romaneio: SÓ conta com anexo real (documento). Filename inventado → ignora.
  if (llm.romaneio) {
    const a = acharAnexoInbound(llm.romaneio.anexo_filename, anexos);
    if (a) out.romaneio = refAnexo(a);
  }

  // descrição/valor: anexo real OU trecho verbatim presente no corpo.
  for (const chave of ["descricao", "valor"] as const) {
    const ev = llm[chave];
    if (!ev) continue;
    if (ev.fonte === "anexo") {
      const a = acharAnexoInbound(ev.anexo_filename, anexos);
      if (a) out[chave] = refAnexo(a);
    } else {
      // fonte "corpo" (ou ausente): exige o trecho verbatim no corpo.
      if (corpoContemTrecho(ev.trecho_verbatim, conteudo)) {
        out[chave] = refCorpo(ev.trecho_verbatim as string);
      } else {
        // fallback: se o LLM não deu fonte mas há anexo que casa, aceita o anexo.
        const a = acharAnexoInbound(ev.anexo_filename, anexos);
        if (a) out[chave] = refAnexo(a);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fase 2 — preservação, marcação e materialização da 2ª oc 33
// ---------------------------------------------------------------------------

/**
 * Copia `extravio_parcial` do agent_state EXISTENTE do card pro snapshot novo do
 * Bastão (sync-bastao passa snapshot fresco a proporAutoAcaoSeAplicavel — sem o
 * dossiê, o gate ficaria cego). No-op quando o card não tem dossiê. Puro.
 */
export function mesclarExtravioParcial(
  snapshot: Record<string, unknown>,
  existingAgentState: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const ep = existingAgentState?.["extravio_parcial"];
  if (!ep || typeof ep !== "object") return snapshot;
  return { ...snapshot, extravio_parcial: ep };
}

/**
 * O interpretador deve PROCESSAR/atualizar o dossiê? true quando o LLM marcou
 * contexto de extravio parcial OU o card JÁ tem dossiê (reabertura Caso 2 — o LLM
 * pode esquecer a flag numa resposta curta de descrição/valor). Puro.
 */
export function deveProcessarDossie(
  contextoExtravioParcial: boolean | undefined,
  jaEhParcial: boolean,
): boolean {
  return contextoExtravioParcial === true || jaEhParcial === true;
}

/**
 * Patch IMUTÁVEL das flags de progresso do dossiê (oc33_operacional_lancada /
 * indenizacao_completa) no agent_state. No-op quando o card não é parcial.
 * NÃO recalcula `completo` (as flags de lançamento não mexem nas evidências).
 */
export function marcarDossie(
  agentState: Record<string, unknown> | null | undefined,
  patch: Partial<Pick<DossieExtravioParcial, "oc33_operacional_lancada" | "indenizacao_completa">>,
): Record<string, unknown> {
  const base = (agentState ?? {}) as Record<string, unknown>;
  const ep = base["extravio_parcial"];
  if (!ep || typeof ep !== "object") return base;
  const epObj = ep as ExtravioParcialState;
  const dossie = { ...dossieVazio(), ...(epObj.dossie ?? {}) };
  return { ...base, extravio_parcial: { ...epObj, dossie: { ...dossie, ...patch } } };
}

/**
 * Junta descrição + valor ORIGINAIS do dossiê num texto pra Instrução da oc 33.
 * Só usa `texto_bruto` (evidência de FONTE ORIGINAL); evidência que veio em anexo
 * (texto_bruto null) fica de fora do texto — vai como anexo na 2ª oc 33.
 */
export function montarTextoDescricaoValor(dossie: DossieExtravioParcial): string {
  const partes: string[] = [];
  const d = dossie.descricao?.texto_bruto;
  const v = dossie.valor?.texto_bruto;
  if (typeof d === "string" && d.trim()) partes.push(`Descrição dos itens: ${d.trim()}`);
  if (typeof v === "string" && v.trim()) partes.push(`Valor dos itens: ${v.trim()}`);
  return partes.join(" | ");
}

/** Limite seguro do campo Instrução do SSW (f6 70 + observ 500 no portal). */
export const LIMITE_TEXTO_SSW = 500;

export interface TextoOc33Preparado {
  instrucao: string;
  precisaImagem: boolean;
  textoParaImagem: string | null;
}

/**
 * Decide o que vai na Instrução da oc 33: se o texto completo cabe em
 * LIMITE_TEXTO_SSW, vai inteiro; senão, gera EVIDÊNCIA em imagem com o texto
 * completo (fonte original) e deixa um resumo curto na instrução. Puro.
 */
export function prepararTextoOc33(
  textoCompleto: string,
  nf: string,
  limite: number = LIMITE_TEXTO_SSW,
): TextoOc33Preparado {
  const t = (textoCompleto ?? "").trim();
  if (t.length <= limite) {
    return { instrucao: t, precisaImagem: false, textoParaImagem: null };
  }
  return {
    instrucao: `Descrição e valor dos itens da NF ${nf} em imagem anexa (texto excedeu o limite do SSW). Ressarcimento: ver anexo.`.slice(0, limite),
    precisaImagem: true,
    textoParaImagem: t,
  };
}

// ---------------------------------------------------------------------------
// Gate da oc 33
// ---------------------------------------------------------------------------

const TOOLS_OC33 = new Set<string>([
  "lancar_combo_33_44",
  "lancar_oc33_solo_portal",
  "enviar_email_livre_e_lancar_oc33_portal",
  "enviar_email_e_lancar_33_romaneio_interno",
]);

const TIPOS_OC33 = new Set<string>(["combo_33_44", "oc33_solo"]);

/**
 * Proposta genérica — cobre os shapes dos DOIS geradores:
 *   - propostas-pos-resposta-cliente: { codigo_ssw, tipo_acao?, tool? }
 *   - regras-auto-acao: { codigo_ssw_proposto, tool_override?, ... }
 *   - proposta_payload persistido: { tool, args:{codigo_ssw}, meta:{tipo_acao} }
 * Lê qualquer um sem exigir normalização no caller.
 */
export type PropostaGenerica = Record<string, unknown>;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

/**
 * Classifica uma proposta de oc 33 como operacional | completude; null se não é
 * oc 33. A natureza depende do CASO do card:
 *   - OPERACIONAL (combo 33+44, romaneio-only) SÓ no Caso 2 (devolução/recusa).
 *   - Caso 1 (parcial entregue, pós-oc 19): TODA oc 33 é COMPLETUDE (exige as 3),
 *     mesmo um combo — nesse contexto o combo nem deveria existir.
 *   - Fallback CONSERVADOR: sem `caso === "2"` comprovado, trata como completude
 *     (nunca libera oc 33 só com romaneio por engano).
 */
export function classificarOc33(
  p: PropostaGenerica,
  caso?: "1" | "2" | null,
): "operacional" | "completude" | null {
  const payload = obj(p["proposta_payload"]);
  const args = obj(p["args"]) ?? obj(payload?.["args"]);
  const meta = obj(p["meta"]) ?? obj(payload?.["meta"]);

  const codigo = num(p["codigo_ssw"]) ?? num(p["codigo_ssw_proposto"]) ?? num(args?.["codigo_ssw"]);
  const tool = str(p["tool"]) ?? str(p["tool_override"]) ?? str(payload?.["tool"]);
  const tipo = str(p["tipo_acao"]) ?? str(meta?.["tipo_acao"]);

  const ehOc33 = codigo === 33 ||
    (tool != null && TOOLS_OC33.has(tool)) ||
    (tipo != null && TIPOS_OC33.has(tipo));
  if (!ehOc33) return null;

  const ehCombo = tool === "lancar_combo_33_44" || tipo === "combo_33_44";
  return ehCombo && caso === "2" ? "operacional" : "completude";
}

export interface DecisaoGateOc33 {
  bloqueada: boolean;
  faltando: string[];
  natureza: "operacional" | "completude";
}

/**
 * Decide se uma proposta de oc 33 deve ser bloqueada, dado o dossiê.
 *   - completude → bloqueia até o dossiê estar completo (3 evidências).
 *   - operacional (Caso 2) → exige SÓ romaneio; sem romaneio, bloqueia.
 */
export function decidirGateOc33(
  natureza: "operacional" | "completude",
  dossie: DossieExtravioParcial,
): DecisaoGateOc33 {
  if (natureza === "operacional") {
    const temRomaneio = dossie.romaneio?.presente === true;
    return {
      natureza,
      bloqueada: !temRomaneio,
      faltando: temRomaneio ? [] : [ROTULO_EVIDENCIA.romaneio],
    };
  }
  const av = avaliarDossie(dossie);
  return { natureza, bloqueada: !av.completo, faltando: av.faltando };
}

export interface GateOc33Result<T> {
  proposta: T;
  natureza: "operacional" | "completude" | null;
  bloqueada: boolean;
  faltando: string[];
}

/**
 * Choke-point ÚNICO do gate. Percorre a lista de propostas e, para card de
 * extravio parcial, decide bloqueio de cada oc 33. NÃO remove propostas (modo
 * AVISADO — front mostra desabilitada com "faltam: X"); apenas anota
 * bloqueada/faltando. Propostas não-oc33 e cards não-parciais passam intactos
 * (bloqueada=false) — zero regressão no extravio total.
 *
 * Retorna decisões; o caller aplica ao SEU shape (marca o payload / persiste).
 * `ehParcial` deve vir de ehExtravioParcial(card).
 */
export function aplicarGateOc33Parcial<T extends PropostaGenerica>(
  propostas: readonly T[],
  ehParcial: boolean,
  dossie: DossieExtravioParcial,
  caso?: "1" | "2" | null,
): GateOc33Result<T>[] {
  return propostas.map((proposta) => {
    const natureza = classificarOc33(proposta, caso);
    if (!ehParcial || natureza === null) {
      return { proposta, natureza, bloqueada: false, faltando: [] };
    }
    const d = decidirGateOc33(natureza, dossie);
    return { proposta, natureza, bloqueada: d.bloqueada, faltando: d.faltando };
  });
}

// ---------------------------------------------------------------------------
// Seed HISTÓRICO do romaneio (Codex 2026-07-02, âncora NF 575330)
//
// Causa raiz: o dossiê valida SÓ a resposta corrente; romaneio recebido/aceito
// ANTES do dossiê nascer virava falso "faltando romaneio". Estes helpers puros
// semeiam SÓ o romaneio a partir do histórico do card, deterministicamente
// (nunca via LLM). Descrição/valor NÃO são semeados (risco de ruído — fora
// desta rodada). deletado_em NÃO entra aqui (registro deletado ainda é evidência
// histórica reprocessável via message_inbox_id — decisão de reupload é downstream).
// ---------------------------------------------------------------------------

/** Anexo salvo (email_anexos). */
export interface AnexoHistorico {
  message_inbox_id: string | null;
  filename: string;
  mime_type: string;
  size_bytes: number;
  origem?: string | null; // 'inbound' | 'outbound'
  /** IGNORADO de propósito (emenda 2 Codex): registro deletado ainda é evidência
   * histórica reprocessável via message_inbox_id. deletado_em só decide reupload,
   * NÃO decide "isso existiu". Presente aqui só como documentação. */
  deletado_em?: string | null;
}

/** Metadados da messages_inbox (corpo + refs p/ re-busca) por message_inbox_id. */
export interface MensagemHistorico {
  message_inbox_id: string;
  conteudo?: string | null;
  remetente?: string | null;
  gmail_message_id?: string | null;
  gmail_thread_id?: string | null;
  operador_id?: string | null;
  recebido_em?: string | null;
}

/** Ocorrência SSW mínima (mais-recente-primeiro no array). */
export interface OcHistSsw {
  codigo: number | null;
  instrucao?: string | null;
  usuario?: string | null;
  data?: string | null;
}

const RE_MIME_ROMANEIO = /^(application\/pdf|image\/)/i;
/** Sinal POSITIVO de ENVIO do romaneio (cliente mandou). Codex 2026-07-02:
 * NÃO aceitar "romaneio de coleta" isolado — exige "romaneio assinado" OU um
 * verbo/contexto de envio PERTO de "romaneio". */
const RE_ROMANEIO_ENVIO =
  /romaneio\s+assinado|(segue|seguem|anexo|anexei|anexado|anexamos|encaminho|encaminhamos|encaminhando|encaminhei|enviando|envio|enviei|enviamos)[^.\n]{0,40}romaneio|romaneio[^.\n]{0,25}(em|no)\s+anexo/i;
/** Linguagem de PEDIDO do romaneio (o Sal pedindo) — exclui (emenda 2 + Codex
 * 2026-07-02 ampliou: precisamos/necessitamos/solicitamos/aguardamos/favor
 * encaminhar/poderiam enviar). "solicitamos"/"solicito" ≠ "solicitado" (passivo,
 * não é pedido nosso) — preserva a fixture 575330. */
const RE_ROMANEIO_PEDIDO =
  /(aguardo|aguardamos|favor\s+enviar|favor\s+encaminhar|poderia\s+enviar|poderiam\s+enviar|pode(?:ria)?\s+nos\s+enviar|solicitamos|solicito|precisamos|necessitamos|precis[ao]\s+d[oe]\s+romaneio|encaminhar\s+o\s+romaneio|enviar(?:em)?\s+o\s+romaneio|nos\s+envie|gentileza\s+enviar)/i;

function ehRemetenteCliente(remetente: string | null | undefined): boolean {
  const r = (remetente ?? "").toLowerCase();
  return r.length > 0 && !r.includes("@salexpress");
}

/**
 * NÍVEL 1 — acha o romaneio nos anexos inbound do card (não só na resposta
 * corrente). Determinístico: anexo PDF/imagem cujo e-mail-mãe (remetente do
 * cliente) tem sinal de ENVIO do romaneio e NÃO é linguagem de pedido. Retorna
 * a referência COMPLETA (metadados p/ re-busca) — fonte "anexo". null se nada.
 */
export function detectarRomaneioNoHistorico(
  anexos: readonly AnexoHistorico[],
  mensagens: readonly MensagemHistorico[],
): (RefEvidenciaAnexo & { fonte: "anexo"; visto_em: string | null }) | null {
  const mapMsg = new Map<string, MensagemHistorico>();
  for (const m of mensagens) if (m.message_inbox_id) mapMsg.set(m.message_inbox_id, m);
  for (const a of anexos) {
    if ((a.origem ?? "inbound") !== "inbound") continue;
    if (!a.message_inbox_id) continue;
    if (!RE_MIME_ROMANEIO.test(a.mime_type ?? "")) continue;
    const m = mapMsg.get(a.message_inbox_id);
    if (!m) continue;
    if (!ehRemetenteCliente(m.remetente)) continue;
    const corpo = m.conteudo ?? "";
    if (!RE_ROMANEIO_ENVIO.test(corpo)) continue;
    if (RE_ROMANEIO_PEDIDO.test(corpo)) continue;
    return {
      fonte: "anexo",
      message_inbox_id: a.message_inbox_id,
      gmail_message_id: m.gmail_message_id ?? null,
      gmail_thread_id: m.gmail_thread_id ?? null,
      operador_id: m.operador_id ?? null,
      filename: a.filename,
      size_bytes: a.size_bytes,
      mime_type: a.mime_type,
      visto_em: m.recebido_em ?? null,
    };
  }
  return null;
}

/** Pede EXPLICITAMENTE descrição/valor/itens (sem incluir romaneio/acareação). */
const RE_PEDE_DESC_VALOR_ITENS = /\b(DESCRI[CÇ][AÃ]O|VALOR|ITENS)\b/i;
const RE_MENCIONA_ROMANEIO = /\bROMANEIO\b/i;

export interface RomaneioSswResult {
  aceito: boolean;
  oc33?: OcHistSsw | null;
  oc49?: OcHistSsw | null;
}

/**
 * NÍVEL 2 — o Ressarcimento já ACEITOU o romaneio (evidência PROCESSUAL, não
 * anexo). Conservador (Codex 2026-07-02): true SÓ quando existe oc 49 que
 *   (a) pede explicitamente descrição/valor/itens,
 *   (b) NÃO menciona romaneio,
 *   (c) tem contexto Ressarcimento confiável (oc 46 do MESMO usuário da 49), e
 *   (d) há uma oc 33 ANTERIOR a essa 49.
 * Provado pelas fixtures: 575330 (oc49 "DESCRICAO E VALOR" → aceito) e 66193
 * (oc49 "DESCRICAO, VALOR E ROMANEIO" → NÃO aceito). Histórico mais-recente-1º.
 */
export function romaneioAceitoPorRessarcimento(
  historico: readonly OcHistSsw[],
): RomaneioSswResult {
  if (!Array.isArray(historico) || historico.length === 0) return { aceito: false };
  const uNorm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
  for (let i = 0; i < historico.length; i++) {
    const oc = historico[i];
    if (oc?.codigo !== 49) continue;
    const instr = oc.instrucao ?? "";
    if (!RE_PEDE_DESC_VALOR_ITENS.test(instr)) continue;
    if (RE_MENCIONA_ROMANEIO.test(instr)) continue;
    const u49 = uNorm(oc.usuario);
    if (u49 === "") continue;
    // SEQUÊNCIA do MESMO CICLO (mais-recente-primeiro, índice crescente = mais
    // antigo): oc49 → oc46 (mesmo usuário, DEPOIS da 49) → oc33 (DEPOIS da 46).
    // Codex 2026-07-02: `.some()` (oc46 em qualquer lugar) aceitava oc46 de ciclo
    // antigo. A ordem oc49→oc46→oc33 garante que a 46 e a 33 são deste round-trip.
    let j46 = -1;
    for (let j = i + 1; j < historico.length; j++) {
      if (historico[j]?.codigo === 46 && uNorm(historico[j]?.usuario) === u49) { j46 = j; break; }
    }
    if (j46 === -1) continue;
    let oc33: OcHistSsw | null = null;
    for (let k = j46 + 1; k < historico.length; k++) {
      if (historico[k]?.codigo === 33) { oc33 = historico[k] as OcHistSsw; break; }
    }
    if (!oc33) continue;
    return { aceito: true, oc33, oc49: oc };
  }
  return { aceito: false };
}

/**
 * Monta o seed do romaneio p/ merge (Nível 1 anexo TEM PRECEDÊNCIA sobre Nível 2
 * processual). {} quando nenhum sinal → merge no-op (monotônico). Só romaneio.
 */
export function montarSeedRomaneio(
  anexos: readonly AnexoHistorico[],
  mensagens: readonly MensagemHistorico[],
  historico: readonly OcHistSsw[],
): EvidenciasRecebidas {
  const anexo = detectarRomaneioNoHistorico(anexos, mensagens);
  if (anexo) return { romaneio: anexo };
  const ssw = romaneioAceitoPorRessarcimento(historico);
  if (ssw.aceito) {
    return {
      romaneio: {
        fonte: "ssw",
        visto_em: ssw.oc49?.data ?? null,
        ref_processual: { oc33: ssw.oc33?.data ?? null, oc49: ssw.oc49?.data ?? null },
      },
    };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Materialização da 2ª oc 33: ação do romaneio DEPENDE DA FONTE (emenda 1 Codex)
//   - "anexo"  → reanexa; se a re-busca falhar, BLOQUEIA (faltando).
//   - "ssw"    → NÃO reanexa, NÃO bloqueia; acrescenta nota processual.
//   - ausente / desconhecida → conservador: não reanexa, não inventa, não bloqueia.
// ---------------------------------------------------------------------------

export const NOTA_ROMANEIO_PROCESSUAL =
  "Romaneio já aceito em oc 33 anterior; oc 49 do Ressarcimento pediu apenas descrição/valor.";

export type AcaoRomaneioCompletude =
  | { tipo: "reanexar" }
  | { tipo: "processual"; nota: string }
  | { tipo: "nenhuma" };

export function decidirAcaoRomaneioCompletude(
  dossie: DossieExtravioParcial,
): AcaoRomaneioCompletude {
  if (!dossie.romaneio?.presente) return { tipo: "nenhuma" };
  const fonte = dossie.romaneio.fonte ?? null;
  if (fonte === "anexo") return { tipo: "reanexar" };
  if (fonte === "ssw") return { tipo: "processual", nota: NOTA_ROMANEIO_PROCESSUAL };
  return { tipo: "nenhuma" };
}
