// =============================================================================
// aprendizado-chat.ts — cérebro do chat do agente-chefe (aba Aprendizado).
//
// Fase 1 do plano aprovado (Caio 08/08): conversa fluida com a gestão
// (Caio + Isadora) sobre os agentes do Cockpit. O modelo tem ferramentas de
// LEITURA (métricas, casos, cards) e UMA de registro (learning_log) — nunca
// SSW, nunca deploy, nunca cards. Latência: contexto pré-aquecido (snapshot de
// métricas injetado no system prompt = a 1ª resposta não gasta rodada de
// ferramenta) + respostas curtas por instrução + no máx 5 rodadas de tools.
//
// Modelo: claude-opus-4-7 (pedido do Caio 08/08 — assertividade; exceção
// consciente à convenção nº 7, registrada aqui).
//
// Testes (puros): aprendizado-chat.test.ts
// =============================================================================

import { type SupabaseClient as SupabaseClientGeneric } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export const CHAT_MODEL = "claude-opus-4-7";
export const CHAT_MAX_TOKENS = 900;
export const CHAT_MAX_RODADAS_TOOLS = 5;
/** Histórico enviado ao modelo (mensagens mais recentes da sessão). */
export const CHAT_HISTORICO_MAX_MSGS = 30;

// Nomes amigáveis — os mesmos que a gestão vê no painel
export const AGENTE_AMIGAVEL: Record<string, string> = {
  "agente-sugere-ocs-padrao": "Agente de recusas (ocorrências padrão)",
  "interpretador-resposta-cliente": "Leitor de respostas do cliente",
  "agente-oc13-autonomo": "Agente de limitação do cliente (oc 13)",
  "agente-extravio-d4": "Agente de extravios",
  "agente-oc43-autonomo": "Agente da oc 43",
  "triador": "Triador de mensagens",
};

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function montarSystemPrompt(opts: {
  nomeGestor: string;
  snapshotMetricas: string;
  tipoSessao: "isadora_iniciou" | "agente_iniciou";
}): string {
  return `Você é o AGENTE-CHEFE do Cockpit da Sal Express (transportadora B2B, MG/ES). Sua missão: melhorar os agentes de IA que sugerem ocorrências nas tratativas de NF, aprendendo com a gestão.

Você está numa conversa com ${opts.nomeGestor} (gestão do time de Relacionamento) dentro da aba Aprendizado.

## Contexto sempre fresco (últimos 30 dias, já carregado — use sem chamar ferramenta):
${opts.snapshotMetricas}

## Quem são os agentes (nomes que a gestão conhece):
${Object.entries(AGENTE_AMIGAVEL).map(([k, v]) => `- ${v} (${k})`).join("\n")}

## Sua OBSESSÃO: subir a taxa de sugestões seguidas (meta 95%)
Cada conversa existe pra fechar o buraco entre o que os agentes SUGEREM e o que o time FAZ. Seu comportamento padrão:
1. Quando a conversa abre (ou o assunto esfria), traga o PIOR bolsão atual com números: "o agente X errou N vezes neste padrão — nas NFs A, B, C ele sugeriu Y e o time fez Z".
2. Faça a PERGUNTA DIRETA que destrava a regra: "por que nesses casos o certo foi Z e não Y?", "o que o time viu que o agente não viu?", "isso vale sempre ou tem exceção?".
3. Persiga a exceção — regra sem exceção mapeada quebra depois: "e se o cliente for do tipo tal?", "e quando não tem foto?".
4. Feche o ciclo: formule a regra ("QUANDO X, o certo é Y, EXCETO Z"), confirme, registre. Conversa boa TERMINA com regra registrada ou com evidência pedida.
Não seja passivo: se ${opts.nomeGestor} só cumprimentar, você já chega com o bolsão mais valioso da semana e a primeira pergunta.

## FORMATAÇÃO (a tela renderiza Markdown — use a favor da leitura)
- Parágrafos CURTOS, separados por linha em branco. NUNCA um bloco só gigante.
- Lista com "-" pra enumerar casos, opções ou passos.
- **Negrito** só no que decide (números-chave, oc, veredito).
- TABELA markdown SEMPRE que comparar 2+ casos ou números. Ex:
  | NF | Agente sugeriu | Time fez | Distância |
  |---|---|---|---|
  | 152016 | 56 | 21 | 80 km |
- Termine com a pergunta em linha própria.

## Seu jeito de conversar
- Português simples e direto, zero jargão técnico. "O agente sugeriu 54 e o time lançou 21" — nunca "decisao_ia divergiu do gabarito".
- RESPOSTAS CURTAS: 2 a 6 frases. Uma pergunta por vez. É um chat, não um relatório.
- PRINTS: quando receber imagem (tela do SSW, foto de canhoto, e-mail), descreva em 1 frase o que viu nela e conecte com o caso — o print costuma ser a evidência que fecha a regra. Se a conversa precisar de evidência visual e não veio, peça o print explicitamente.
- Números SEMPRE vêm de ferramenta ou do contexto acima — NUNCA invente taxa, quantidade ou NF.
- Quando citar casos, cite as NFs. Quando a gestão citar uma NF, use ver_card antes de opinar.
- Peça PRINT quando o assunto for evidência visual (foto de canhoto, tela do SSW) — exemplo real ensina mais que descrição.
- Seu objetivo em cada conversa: transformar o conhecimento da gestão em REGRA CLARA ("QUANDO X, o certo é Y, EXCETO quando Z"). Quando sentir que a regra fechou, repita-a em uma frase e pergunte se está certa. Se confirmada, use registrar_aprendizado.
- O que você NÃO faz (diga se pedirem): não lança ocorrência, não mexe em card, não envia e-mail a cliente, não faz deploy. Melhorias registradas passam por teste no histórico e pela aprovação do Caio antes de mudar qualquer agente.
${opts.tipoSessao === "agente_iniciou" ? "\n- Esta conversa foi VOCÊ que abriu (ciclo diário): conduza — apresente o descasamento mais importante, mostre 2-3 casos e faça a primeira pergunta." : ""}

## Honestidade
- Não sabe = diga que não sabe e ofereça olhar os dados.
- Ferramenta falhou = avise em linguagem simples e siga a conversa.`;
}

// ---------------------------------------------------------------------------
// Ferramentas (schemas Anthropic)
// ---------------------------------------------------------------------------

export const CHAT_TOOLS = [
  {
    name: "consultar_metricas",
    description:
      "Taxa de acerto (sugestões seguidas vs corrigidas pelo time) por agente. Use pra responder 'como está o agente X' ou comparar períodos.",
    input_schema: {
      type: "object",
      properties: {
        agente: { type: "string", description: "slug do agente (ex: agente-sugere-ocs-padrao). Omita pra ver todos." },
        dias: { type: "number", description: "janela em dias (padrão 30, máx 120)" },
      },
    },
  },
  {
    name: "listar_casos",
    description:
      "Lista casos reais recentes de um agente: NF, o que a IA sugeriu, o que o time fez, e o porquê da IA. Use pra mostrar descasamentos concretos à gestão.",
    input_schema: {
      type: "object",
      properties: {
        agente: { type: "string", description: "slug do agente (obrigatório)" },
        oc_do_card: { type: "number", description: "filtra pela ocorrência DO CARD na hora da análise (ex: 11 = casos de problema com endereço). É este o filtro quando a gestão fala 'casos da oc X'." },
        oc_sugerida: { type: "number", description: "filtra pela oc que a IA SUGERIU (ex: 56)" },
        so_corrigidos: { type: "boolean", description: "true = só casos em que o time corrigiu a IA" },
        dias: { type: "number", description: "janela (padrão 30)" },
        limite: { type: "number", description: "máx 10" },
      },
      required: ["agente"],
    },
  },
  {
    name: "ver_card",
    description:
      "Detalhe de uma NF: situação atual, últimas movimentações e o que os agentes sugeriram nela. Use sempre que a gestão citar uma NF específica.",
    input_schema: {
      type: "object",
      properties: { nf: { type: "string", description: "número da NF" } },
      required: ["nf"],
    },
  },
  {
    name: "registrar_aprendizado",
    description:
      "Registra uma regra CONFIRMADA pela gestão no caderno de aprendizado (vira proposta de melhoria pro Caio aprovar, após teste no histórico). Use SOMENTE depois que a gestão confirmar a regra formulada por você.",
    input_schema: {
      type: "object",
      properties: {
        agente_alvo: { type: "string", description: "slug do agente que a regra melhora" },
        oc_contexto: { type: "number", description: "oc do padrão em foco (ex: 56 quando o padrão é 'sugeriu 56')" },
        regra: { type: "string", description: "a regra completa: QUANDO X, o certo é Y, EXCETO Z. Inclua NFs-âncora citadas na conversa." },
        titulo_curto: { type: "string", description: "resumo em até 10 palavras" },
      },
      required: ["agente_alvo", "regra", "titulo_curto"],
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Executores das ferramentas (leitura via service client; escrita só no
// learning_log). Todos devolvem STRING pronta pro modelo.
// ---------------------------------------------------------------------------

const clampDias = (d: unknown): number => Math.min(120, Math.max(1, Number(d) || 30));
const clampLimite = (n: unknown): number => Math.min(10, Math.max(1, Number(n) || 6));

export async function execConsultarMetricas(
  supabase: SupabaseClient,
  input: { agente?: string; dias?: number },
): Promise<string> {
  const dias = clampDias(input.dias);
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString();
  let q = supabase
    .from("v_sinal_ouro_casos")
    .select("agent_name, veredito")
    .gte("decidido_em", desde)
    .in("veredito", ["seguida", "corrigida"])
    .limit(5000);
  if (input.agente) q = q.eq("agent_name", input.agente);
  const { data, error } = await q;
  if (error) return `erro ao consultar: ${error.message}`;
  const porAgente = new Map<string, { s: number; c: number }>();
  for (const r of (data ?? []) as Array<{ agent_name: string; veredito: string }>) {
    const cur = porAgente.get(r.agent_name) ?? { s: 0, c: 0 };
    if (r.veredito === "seguida") cur.s += 1;
    else cur.c += 1;
    porAgente.set(r.agent_name, cur);
  }
  if (porAgente.size === 0) return `sem casos avaliados nos últimos ${dias} dias.`;
  const linhas = [...porAgente.entries()]
    .sort((a, b) => (b[1].s + b[1].c) - (a[1].s + a[1].c))
    .map(([ag, v]) => {
      const total = v.s + v.c;
      const pct = Math.round((100 * v.s) / total);
      return `${AGENTE_AMIGAVEL[ag] ?? ag}: ${pct}% seguidas (${v.s} seguidas, ${v.c} corrigidas, ${total} casos)`;
    });
  return `Últimos ${dias} dias:\n${linhas.join("\n")}`;
}

export async function execListarCasos(
  supabase: SupabaseClient,
  input: { agente: string; oc_do_card?: number; oc_sugerida?: number; so_corrigidos?: boolean; dias?: number; limite?: number },
): Promise<string> {
  const dias = clampDias(input.dias);
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString();
  let q = supabase
    .from("v_sinal_ouro_casos")
    .select("nf, veredito, oc_card, oc_sugerida, oc_executada, decidido_em, decisao_ia")
    .eq("agent_name", input.agente)
    .gte("decidido_em", desde)
    .in("veredito", input.so_corrigidos ? ["corrigida"] : ["seguida", "corrigida"])
    .order("decidido_em", { ascending: false })
    .limit(clampLimite(input.limite));
  if (typeof input.oc_sugerida === "number") q = q.eq("oc_sugerida", input.oc_sugerida);
  if (typeof input.oc_do_card === "number") q = q.eq("oc_card", input.oc_do_card);
  const { data, error } = await q;
  if (error) return `erro ao listar: ${error.message}`;
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (rows.length === 0) return "nenhum caso encontrado com esses filtros.";
  return rows.map((r) => {
    const d = (r["decisao_ia"] ?? {}) as Record<string, unknown>;
    const motivo = String(d["observacao_orquestrador"] ?? d["motivo"] ?? "").slice(0, 160);
    const quando = String(r["decidido_em"] ?? "").slice(0, 10);
    const desfecho = r["veredito"] === "seguida"
      ? `time seguiu (${r["oc_sugerida"]})`
      : `IA sugeriu ${r["oc_sugerida"]}, time lançou ${r["oc_executada"]}`;
    return `NF ${r["nf"]} (${quando}, oc do card ${r["oc_card"]}): ${desfecho}. Porquê da IA: ${motivo || "(sem registro)"}`;
  }).join("\n");
}

export async function execVerCard(
  supabase: SupabaseClient,
  input: { nf: string },
): Promise<string> {
  const nf = String(input.nf).replace(/\D/g, "");
  if (!nf) return "NF inválida.";
  const { data: card, error } = await supabase
    .from("cards")
    .select("id, nf, ctrc, state, cod_ultima_ocorrencia, empresa_cliente, responsavel_relacionamento, created_at, ia_sugestao_oc_resposta, analise_padrao_resultado")
    .eq("nf", nf)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return `erro: ${error.message}`;
  if (!card) return `não achei card da NF ${nf}.`;
  const { data: eventos } = await supabase
    .from("v_card_events_legivel")
    .select("created_at, narrativa")
    .eq("card_id", card.id)
    .order("created_at", { ascending: false })
    .limit(10);
  const analise = (card.analise_padrao_resultado ?? {}) as Record<string, unknown>;
  const interp = (card.ia_sugestao_oc_resposta ?? {}) as Record<string, unknown>;
  const linhas = [
    `NF ${card.nf} — ${card.empresa_cliente ?? "?"} | situação: ${card.state} | oc atual: ${card.cod_ultima_ocorrencia ?? "?"} | operadora: ${card.responsavel_relacionamento ?? "?"}`,
    analise["proposta_destacada"] != null
      ? `Sugestão do agente de recusas: oc ${analise["proposta_destacada"]} (${String(analise["observacao_orquestrador"] ?? "").slice(0, 140)})`
      : null,
    interp["oc_sugerida"] != null
      ? `Leitor de respostas sugeriu: oc ${interp["oc_sugerida"]} (${String(interp["motivo"] ?? "").slice(0, 140)})`
      : null,
    "Últimas movimentações:",
    ...((eventos ?? []) as Array<{ created_at: string; narrativa: string }>)
      .map((e) => `  ${String(e.created_at).slice(0, 16).replace("T", " ")} — ${String(e.narrativa).slice(0, 130)}`),
  ].filter(Boolean);
  return linhas.join("\n");
}

export async function execRegistrarAprendizado(
  supabase: SupabaseClient,
  input: { agente_alvo: string; oc_contexto?: number; regra: string; titulo_curto: string },
  contexto: { sessaoId: string; nomeGestor: string; supabaseUrl: string; serviceKey: string },
): Promise<string> {
  if (!input.regra?.trim() || !input.agente_alvo?.trim()) return "regra ou agente vazio — nada registrado.";
  const chave = `${input.agente_alvo}:sug${typeof input.oc_contexto === "number" ? input.oc_contexto : "sem"}`;
  const { data: row, error } = await supabase
    .from("learning_log")
    .insert({
      agente: "agente-aprendizado",
      tipo: "resposta_admin",
      severidade: "info",
      titulo: `Resposta (chat): ${input.titulo_curto}`.slice(0, 180),
      resumo: input.regra.slice(0, 2000),
      status: "respondido",
      agente_alvo: input.agente_alvo,
      detalhes: {
        origem: "chat_agente_chefe",
        sessao_chat_id: contexto.sessaoId,
        chave_padrao: chave,
        // OBRIGATÓRIO não-vazio: montarAjusteDeResposta descarta resposta sem
        // opcao (return null silencioso) — sem isto, a regra do chat nunca
        // viraria proposta nem e-mail. Guard: aprendizado-chat.test.ts.
        opcao: "Conversa com o agente-chefe",
        texto: input.regra,
        confirmado_por: contexto.nomeGestor,
      },
    })
    .select("id")
    .single();
  if (error) return `não consegui registrar: ${error.message}`;

  // Dispara a geração da proposta na hora (mesmo caminho do fluxo atual) —
  // best-effort: registro já está salvo.
  try {
    await fetch(`${contexto.supabaseUrl}/functions/v1/agente-aprendizado`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${contexto.serviceKey}`,
        apikey: contexto.serviceKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ modo: "ajustes" }),
    });
  } catch { /* proposta sai no próximo ciclo */ }

  return `registrado (id ${row.id}). A regra vira proposta de melhoria e será testada no histórico antes de ir pro Caio.`;
}

// ---------------------------------------------------------------------------
// Snapshot de métricas pro system prompt (pré-aquecimento de contexto)
// ---------------------------------------------------------------------------

export async function montarSnapshotMetricas(supabase: SupabaseClient): Promise<string> {
  try {
    return await execConsultarMetricas(supabase, { dias: 30 });
  } catch {
    return "(snapshot indisponível — use consultar_metricas)";
  }
}

// ---------------------------------------------------------------------------
// Turno de conversa (o loop agêntico) — extraído da function pra ser testável
// sem deploy: o teste de integração roda EXATAMENTE este código.
// ---------------------------------------------------------------------------

interface BlocoAnthropicChat {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface TurnoChatResultado {
  resposta: string;
  ferramentas_usadas: string[];
}

/**
 * Roda um turno completo: recebe o histórico já formatado, chama o modelo com
 * as ferramentas, executa as que ele pedir (em paralelo) e devolve o texto
 * final. Não grava nada além do que registrar_aprendizado gravar.
 */
export async function executarTurnoChat(opts: {
  supabase: SupabaseClient;
  anthropicKey: string;
  system: string;
  mensagens: Array<{ role: "user" | "assistant"; content: unknown }>;
  contextoRegistro: { sessaoId: string; nomeGestor: string; supabaseUrl: string; serviceKey: string };
}): Promise<TurnoChatResultado> {
  // deno-lint-ignore no-explicit-any
  const conversa: any[] = [...opts.mensagens];
  const ferramentasUsadas: string[] = [];
  let respostaFinal = "";

  for (let rodada = 0; rodada <= CHAT_MAX_RODADAS_TOOLS; rodada++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": opts.anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      // sem `temperature`: o Opus 4.7 rejeita o parâmetro (400 "deprecated
      // for this model" — pego no smoke de integração 08/08)
      body: JSON.stringify({
        model: CHAT_MODEL,
        max_tokens: CHAT_MAX_TOKENS,
        system: opts.system,
        tools: CHAT_TOOLS,
        messages: conversa,
      }),
    });
    if (!r.ok) {
      console.error(`anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
      respostaFinal = "Tive um problema técnico agora — tenta de novo em instantes?";
      break;
    }
    const resp = await r.json();
    const blocos = (resp?.content ?? []) as BlocoAnthropicChat[];
    const textos = blocos.filter((b) => b.type === "text" && b.text).map((b) => b.text!.trim());
    const toolCalls = blocos.filter((b) => b.type === "tool_use");

    if (toolCalls.length === 0 || rodada === CHAT_MAX_RODADAS_TOOLS) {
      respostaFinal = textos.join("\n\n").trim() ||
        "Não consegui formular uma resposta — reformula pra mim?";
      break;
    }

    conversa.push({ role: "assistant", content: blocos });
    const resultados = await Promise.all(toolCalls.map(async (tc) => {
      ferramentasUsadas.push(tc.name!);
      let saida: string;
      try {
        // deno-lint-ignore no-explicit-any
        const input = (tc.input ?? {}) as any;
        switch (tc.name) {
          case "consultar_metricas":
            saida = await execConsultarMetricas(opts.supabase, input);
            break;
          case "listar_casos":
            saida = await execListarCasos(opts.supabase, input);
            break;
          case "ver_card":
            saida = await execVerCard(opts.supabase, input);
            break;
          case "registrar_aprendizado":
            saida = await execRegistrarAprendizado(opts.supabase, input, opts.contextoRegistro);
            break;
          default:
            saida = `ferramenta desconhecida: ${tc.name}`;
        }
      } catch (e) {
        saida = `erro na ferramenta: ${e instanceof Error ? e.message : String(e)}`;
      }
      return { type: "tool_result", tool_use_id: tc.id, content: saida.slice(0, 6000) };
    }));
    conversa.push({ role: "user", content: resultados });
  }

  return { resposta: respostaFinal, ferramentas_usadas: ferramentasUsadas };
}

// ---------------------------------------------------------------------------
// Imagens do turno atual → blocos de visão no último turno do usuário
// ---------------------------------------------------------------------------

export interface ImagemTurno {
  media_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  base64: string;
}

export function mediaTypeDoPath(path: string): ImagemTurno["media_type"] | null {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return null;
}

/**
 * Anexa os prints do turno ATUAL como blocos de visão na última fala do
 * usuário (puro, testável). Prints de turnos antigos ficam só registrados no
 * histórico como texto — não re-enviamos bytes a cada turno (custo/latência).
 */
export function anexarImagensAoUltimoTurno(
  mensagens: Array<{ role: "user" | "assistant"; content: unknown }>,
  imagens: ReadonlyArray<ImagemTurno>,
): Array<{ role: "user" | "assistant"; content: unknown }> {
  if (imagens.length === 0 || mensagens.length === 0) return mensagens;
  const ultima = mensagens[mensagens.length - 1];
  if (ultima.role !== "user" || typeof ultima.content !== "string") return mensagens;
  const blocos = [
    ...imagens.map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.media_type, data: img.base64 },
    })),
    { type: "text", text: ultima.content },
  ];
  return [...mensagens.slice(0, -1), { role: "user", content: blocos }];
}

// ---------------------------------------------------------------------------
// Histórico da sessão → formato Anthropic (puro, testável)
// ---------------------------------------------------------------------------

export interface MsgChatRow {
  papel: "gestor" | "agente" | "sistema";
  conteudo: string;
}

export function historicoParaMensagens(
  rows: ReadonlyArray<MsgChatRow>,
  max: number = CHAT_HISTORICO_MAX_MSGS,
): Array<{ role: "user" | "assistant"; content: string }> {
  const recentes = rows.slice(-max);
  const msgs: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const r of recentes) {
    if (!r.conteudo?.trim()) continue;
    // 'sistema' (avisos internos) entra como fala do usuário entre colchetes
    const role = r.papel === "agente" ? "assistant" as const : "user" as const;
    const content = r.papel === "sistema" ? `[sistema] ${r.conteudo}` : r.conteudo;
    // Anthropic exige alternância — funde mensagens consecutivas do mesmo papel
    const ultima = msgs[msgs.length - 1];
    if (ultima && ultima.role === role) ultima.content += `\n\n${content}`;
    else msgs.push({ role, content });
  }
  // precisa começar com user; se a sessão abriu com fala do agente (CHAT 2), prefixa
  if (msgs.length > 0 && msgs[0].role === "assistant") {
    msgs.unshift({ role: "user", content: "[sistema] Início da conversa aberta por você (ciclo diário)." });
  }
  return msgs;
}
