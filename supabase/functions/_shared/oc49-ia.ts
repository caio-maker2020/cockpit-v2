// =============================================================================
// oc49-ia — leitura CONTEXTUAL da oc 49 pelo Sonnet (Caio 27/08, NF 25021).
//
// Papel na arquitetura de 3 camadas:
//   1. Regras determinísticas do Caio (oc49-contexto.ts) — sempre ganham;
//   2. ESTA leitura — decide quando as regras não deram match, e na fase
//      SOMBRA roda em paralelo a TODA decisão da 49 pra comparação no monitor
//      (tabela oc49_sombra + página no vercel-monitor-capacidade);
//   3. Cercas de saída — confiança REAL da IA alimenta o piso do autônomo;
//      corpo de e-mail nunca por interpolação de instrução SSW.
//
// Prompt VALIDADO pelo Caio: prompts/agente-oc49-leitura-contextual.md — o
// SYSTEM abaixo é a transcrição literal; mudar lá = mudar aqui + evals.
// =============================================================================

import {
  createAnthropicClient,
  readAnthropicEnvFromProcess,
} from "./anthropic-client.ts";

export interface LeituraIa49 {
  leitura_do_contexto: string;
  origem_da_49: "indenizacao" | "operacao" | "cobranca_de_retorno" | "devolucao" | "outro";
  acao_sugerida_oc: number | null;
  enviar_email_cliente: boolean;
  corpo_email: string | null;
  texto_ssw_sugerido: string;
  alerta_divergencia: string | null;
  confianca: number;
  o_que_falta: string | null;
}

export const MODELO_OC49_IA = "claude-sonnet-4-6";

export const SYSTEM_OC49 = `Você é o agente de tratativas de NF da Sal Express (transportadora B2B). Um card está na ocorrência 49 e as regras determinísticas não deram match. Sua tarefa: ler o CONTEXTO COMPLETO (linha do tempo de ocorrências, ciclos e e-mails) e decidir a próxima ação.

**Vocabulário de ocorrências:** 2=emissão CT-e · 5/36/14=operacionais (viagem/chegada/**saída pra entrega**) · 9=extravio na coleta · 6=extravio na transferência · 10=recusa total · 11=problema de endereço (governa GPS, não foto) · 13=tentativa/local fechado · 19=entrega com falta de volumes · 35=recusa parcial · 21=reentrega autorizada (**encerra o ciclo**) · 55=autorizado seguir entrega (**encerra o ciclo**) · 44=devolução · 46=indenização em análise (**apenas informativa**: o caso entrou no indicador da indenização) · 49=tratativa de relacionamento (**o TEXTO diz o que a área quer**) · 54=aguardando retorno do cliente (pós e-mail) · 56=falta info operacional (**o texto vai pra OPERAÇÃO**) · 59=retorno indenização (pede docs ao cliente) · 41=informação complementar · 33=reversão de perdas (abre a indenização DE FATO, com docs).

**Conceito de CICLO (prioridade máxima):** ocorrência de insucesso/recusa (10/11/13/19/35) ABRE um ciclo de tratativa; 21/55 ENCERRAM o ciclo (insucesso anterior a elas JÁ FOI tratado — não reabra). Cada ocorrência de relacionamento nova recria o card num ciclo novo.

**Regras invioláveis:**
1. 46 seguida de 49 no mesmo dia = a indenização SINALIZANDO pendência de documentos. O texto dessa 49 NUNCA é motivo de recusa, de devolução ou de qualquer evento físico — não misture.
2. Autorização do cliente (explícita ou implícita, ex.: "pode seguir", "é só 1 volume mesmo, cliente ciente") PESA MAIS que perguntas secundárias na mesma mensagem. Cliente repetindo a mesma informação = atrito; priorize DESTRAVAR, não perguntar de novo.
3. Nunca proponha e-mail perguntando o que a thread já respondeu.
4. Se o cliente contesta um fato do sistema (ex.: volumes do CT-e ≠ real), registre em \`alerta_divergencia\` — isso pode invalidar o próprio extravio/indenização.
5. Texto pra SSW: caixa alta, direto, tratado — informação correta pra quem vai ler (operação ou indenização), sem copiar texto cru de outra ocorrência.

**Responda APENAS o JSON:**
{"leitura_do_contexto": "...", "origem_da_49": "indenizacao|operacao|cobranca_de_retorno|devolucao|outro", "acao_sugerida_oc": <número ou null>, "enviar_email_cliente": true/false, "corpo_email": "... ou null", "texto_ssw_sugerido": "...", "alerta_divergencia": "... ou null", "confianca": 0.0-1.0, "o_que_falta": "... ou null"}

Confiança calibrada de verdade: 0.9+ só quando o contexto é inequívoco; abaixo de 0.7 a ação fica para o operador humano.`;

export interface ContextoOc49Input {
  nf: string;
  volumesCte: number | null;
  timeline: Array<{ codigo: number | null; data: string | null; descricao: string | null; instrucao: string | null }>;
  emails: Array<{ direcao: "cliente" | "sal"; em: string | null; trecho: string }>;
  ocAtual: number | null;
}

export function montarUserOc49(c: ContextoOc49Input): string {
  const linha = c.timeline
    .map((o) => `${o.data ?? "?"} · oc ${o.codigo ?? "?"} · ${(o.descricao ?? "").slice(0, 50)} · INSTRUCAO: ${(o.instrucao ?? "").slice(0, 200)}`)
    .join("\n");
  const mails = c.emails.length
    ? c.emails.map((m) => `[${m.direcao === "cliente" ? "CLIENTE" : "SAL"} ${m.em ?? "?"}] ${m.trecho.slice(0, 500)}`).join("\n---\n")
    : "(sem e-mails na thread)";
  return `NF ${c.nf} — CT-e com ${c.volumesCte ?? "?"} volume(s). Oc atual do card: ${c.ocAtual ?? "?"}.

LINHA DO TEMPO SSW:
${linha}

E-MAILS DA THREAD (mais recentes por último):
${mails}

Qual a próxima ação?`;
}

export interface ResultadoIa49 {
  leitura: LeituraIa49 | null;
  erro: string | null;
  custoTokens: { in: number; out: number } | null;
}

export async function lerContexto49ViaIA(
  env: Record<string, string | undefined>,
  input: ContextoOc49Input,
  onUsage?: (u: { inputTokens: number; outputTokens: number }) => void,
): Promise<ResultadoIa49> {
  let tokens: { in: number; out: number } | null = null;
  try {
    const client = createAnthropicClient({
      env: readAnthropicEnvFromProcess(env),
      onUsage: (u: { inputTokens?: number; outputTokens?: number }) => {
        tokens = { in: u.inputTokens ?? 0, out: u.outputTokens ?? 0 };
        try { onUsage?.({ inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0 }); } catch { /* best-effort */ }
      },
    } as Parameters<typeof createAnthropicClient>[0]);
    const leitura = await client.completeJson<LeituraIa49>({
      model: MODELO_OC49_IA,
      system: SYSTEM_OC49,
      messages: [{ role: "user", content: montarUserOc49(input) }],
      maxTokens: 1200,
      temperature: 0,
    });
    if (typeof leitura?.confianca !== "number" || typeof leitura?.texto_ssw_sugerido !== "string") {
      return { leitura: null, erro: "resposta fora do schema", custoTokens: tokens };
    }
    return { leitura, erro: null, custoTokens: tokens };
  } catch (e) {
    return { leitura: null, erro: e instanceof Error ? e.message : String(e), custoTokens: tokens };
  }
}
