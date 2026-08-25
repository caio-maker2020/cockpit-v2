// =============================================================================
// acaoAutonomaVeto — lógica PURA do trilho autônomo no front (Etapa E, 25/08).
//
// O front NUNCA decide a janela: lê o espelho cards.acao_autonoma (mantido
// pelo trigger da mig 353) e exibe. Aqui vivem: predicados das 2 abas,
// countdown, explicações didáticas (nível "15 anos"), validação local do
// formulário (o servidor revalida — RPC cancelar_acao_autonoma) e o
// hashDaProposta ESPELHO do _shared (paridade travada por teste com vetor
// fixo — hash divergente = edição devolvida pro humano no vencimento).
// =============================================================================

export interface AcaoAutonomaEspelho {
  agendamento_id: number;
  acao_key: string | null;
  executar_em: string | null;
  status: string | null;
  hash_proposta: string | null;
  processed_at: string | null;
  cancelado_motivo: string | null;
}

/** Aba 1 — AÇÃO AUTÔNOMA: janela aberta (contagem correndo ou executando). */
export function emJanelaDeVeto(e: AcaoAutonomaEspelho | null | undefined): boolean {
  return e?.status === "pendente" || e?.status === "executando";
}

/** Aba 2 — EXECUTADA: processado há menos de 1h (segunda conferência). */
export function executadaRecente(
  e: AcaoAutonomaEspelho | null | undefined,
  agoraMs: number,
): boolean {
  if (e?.status !== "processado" || !e.processed_at) return false;
  return agoraMs - new Date(e.processed_at).getTime() < 60 * 60 * 1000;
}

/** Countdown legível. O alvo é ABSOLUTO (calculado em minutos úteis no
 *  backend) — aqui só se formata a distância; nunca se recalcula a janela. */
export function rotuloCountdown(executarEm: string | null, agoraMs: number): string {
  if (!executarEm) return "—";
  const alvo = new Date(executarEm).getTime();
  const diffMin = Math.round((alvo - agoraMs) / 60000);
  if (diffMin <= 0) return "executando…";
  if (diffMin < 60) return `${diffMin} min`;
  const d = new Date(executarEm);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const hoje = new Date(agoraMs);
  const mesmoDia = d.getFullYear() === hoje.getFullYear() &&
    d.getMonth() === hoje.getMonth() && d.getDate() === hoje.getDate();
  const dia = mesmoDia
    ? ""
    : `${["dom", "seg", "ter", "qua", "qui", "sex", "sáb"][d.getDay()]} `;
  return `vence ${dia}${hh}:${mm}`;
}

/** Urgência pro visual (DS 4.0): <=15min = crítica, <=30 = alta, senão normal. */
export function urgenciaCountdown(
  executarEm: string | null,
  agoraMs: number,
): "critica" | "alta" | "normal" {
  if (!executarEm) return "normal";
  const diffMin = (new Date(executarEm).getTime() - agoraMs) / 60000;
  if (diffMin <= 15) return "critica";
  if (diffMin <= 30) return "alta";
  return "normal";
}

/** Explicação didática por ação — nível "pessoa de 15 anos que não entende de
 *  transporte" (plano 25/08). Textos passam pela validação do Caio antes de
 *  cada degrau da escada. */
const EXPLICACOES: Record<string, string> = {
  "lancar_ocorrencia:21":
    "O cliente autorizou tentar entregar de novo. Se você não fizer nada, o robô registra a liberação da nova entrega no sistema.",
  "lancar_ocorrencia:55":
    "O cliente deixou seguir a entrega com o que temos agora. Se você não fizer nada, o robô registra essa autorização no sistema.",
  "lancar_ocorrencia:54":
    "Ainda estamos esperando uma resposta do cliente. Se você não fizer nada, o robô registra no sistema que seguimos aguardando.",
  "lancar_ocorrencia:59":
    "Ainda estamos esperando os documentos da indenização. Se você não fizer nada, o robô registra que seguimos aguardando.",
  "lancar_oc_e_enviar_email:54":
    "O robô vai avisar o cliente por e-mail (o texto está logo abaixo) e registrar no sistema que aguardamos a resposta dele.",
  "lancar_oc_e_enviar_email:59":
    "O robô vai pedir por e-mail os documentos da indenização (o texto está logo abaixo) e registrar que aguardamos o retorno.",
  "ignorar_e_aguardar:54":
    "O cliente respondeu, mas sem a informação que falta. Se você não fizer nada, o robô mantém o card aguardando o retorno de verdade.",
  "ignorar_e_aguardar:59":
    "O cliente respondeu, mas sem os documentos que faltam. Se você não fizer nada, o robô mantém o card aguardando.",
};

export function explicacaoDidatica(acaoKey: string | null): string {
  if (!acaoKey) return "O robô vai executar a ação sugerida se ninguém cancelar até o fim da contagem.";
  return (
    EXPLICACOES[acaoKey] ??
    "O robô vai executar a ação sugerida (detalhes abaixo) se ninguém cancelar até o fim da contagem."
  );
}

// ── Formulário de cancelamento (validação local; o servidor revalida) ────────
export const OPCOES_ONDE_OLHOU = [
  { id: "historico_ssw", label: "Histórico do SSW" },
  { id: "email_cliente", label: "E-mail do cliente" },
  { id: "foto_evidencia", label: "Foto / evidência" },
  { id: "conhecimento_cliente", label: "Conhecimento do cliente" },
  { id: "telefone_fora_cockpit", label: "Telefone/WhatsApp fora do Cockpit" },
  { id: "outro", label: "Outro" },
] as const;

export interface RespostasCancelamento {
  o_que_leu_errado: string;
  onde_olhou: string[];
  info_existe_no_cockpit: "sim_interpretou_errado" | "nao_so_fora" | "";
  onde_fora?: string;
  excecao_cliente: boolean | null;
  excecao_qual?: string;
  extras?: Record<string, string>;
}

export function validarFormularioCancelamento(r: RespostasCancelamento): string | null {
  if (r.o_que_leu_errado.trim().length < 5) {
    return "Explique o que o agente leu errado (mínimo 5 caracteres).";
  }
  if (r.onde_olhou.length === 0) return "Marque onde você olhou pra saber.";
  if (r.info_existe_no_cockpit === "") {
    return "Responda se a informação que faltou existe dentro do Cockpit.";
  }
  if (r.info_existe_no_cockpit === "nao_so_fora" && !(r.onde_fora ?? "").trim()) {
    return "Diga onde (fora do Cockpit) a informação estava.";
  }
  if (r.excecao_cliente == null) return "Responda se é uma exceção deste cliente.";
  if (r.excecao_cliente === true && (r.excecao_qual ?? "").trim().length < 3) {
    return "Descreva qual é a exceção deste cliente.";
  }
  return null;
}

// ── hashDaProposta — ESPELHO EXATO de _shared/acao-autonoma-veto.ts ─────────
// (edge não importa do front e vice-versa; paridade travada por vetor fixo em
// ambos os testes. Divergir aqui = edição devolvida pro humano — fail-safe.)
function jsonCanonico(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jsonCanonico).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const chaves = Object.keys(obj).sort();
  return `{${chaves.map((k) => `${JSON.stringify(k)}:${jsonCanonico(obj[k])}`).join(",")}}`;
}

export function hashDaProposta(propostaPayload: unknown): string {
  const s = jsonCanonico(propostaPayload ?? null);
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}
