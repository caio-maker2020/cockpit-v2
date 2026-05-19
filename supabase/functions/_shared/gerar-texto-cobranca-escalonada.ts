// Caio 2026-05-19 (PRIORIDADES AI):
// Helper Sonnet 4.6 — gera texto de cobrança escalonada parametrizado por
// (papel × oc_origem 13/21 × histórico_cobranças_anteriores × canal).
//
// Reusado pelos endpoints sugerir-cobranca-ai (preview no modal) e
// disparar-cobranca-escalonada (quando operador envia sem editar).

import {
  createAnthropicClient,
  readAnthropicEnvFromProcess,
} from "./anthropic-client.ts";

const MODEL = "claude-sonnet-4-6";

export type Papel = "gerente_base" | "coordenador_entrega" | "gerente_relacionamento";
export type Canal = "email" | "whatsapp";

export interface GerarTextoArgs {
  papel: Papel;
  canal: Canal;
  oc_origem: 13 | 21;
  nf: string;
  ctrc: string | null;
  base: string | null;
  empresa_cliente: string | null;
  dias_uteis_parados: number;
  contato_destinatario_nome: string | null;
  contato_destinatario_cargo_humanizado: string;
  operador_nome: string;
  // Histórico das cobranças anteriores (texto + papel + canal + data) — pra
  // tom escalado
  cobrancas_anteriores: Array<{
    papel: Papel;
    canal: Canal;
    disparado_em: string; // ISO
    contato_nome: string | null;
  }>;
}

export interface GerarTextoResult {
  assunto: string;
  texto: string;
  rationale: string;
  modelo: string;
  tokens_input?: number;
  tokens_output?: number;
}

const SYSTEM_PROMPT_BASE = `Você gera mensagens de cobrança operacional pra base/gerência da Sal Express (transportadora B2B). Contexto: NF do cliente está parada há X dias sem movimentação no SSW (oc=21 reentrega solicitada ou oc=13 mudança de endereço pelo destinatário). Operador precisa cobrar quem destrava na base/gerência.

REGRAS:
- Português PT-BR direto, sem floreios corporativos
- NUNCA invente dados — só use o que está no contexto
- Curto: WhatsApp 600-900 chars; Email 1500-2500 chars
- Mencione NF, CTRC quando houver, dias parados, base
- Tom escalado quando há cobranças anteriores no mesmo card
- Assinatura do operador no email; WhatsApp dispensa
- Devolva EXCLUSIVAMENTE JSON: { "assunto", "texto", "rationale" }
  (assunto pode ser null/vazio em canal=whatsapp)

TOM POR PAPEL:
- gerente_base: cobrança direta, foco em retorno operacional ("preciso saber se vai sair pra entrega hoje OU motivo do bloqueio")
- coordenador_entrega: tom escalado — menciona que gerente foi cobrado mas sem retorno, pede intervenção da coordenação
- gerente_relacionamento: alerta executivo — risco de impacto comercial com cliente; pede intervenção imediata`;

function humanizarPapel(papel: Papel): string {
  switch (papel) {
    case "gerente_base": return "Gerente da Base";
    case "coordenador_entrega": return "Coordenador de Entrega";
    case "gerente_relacionamento": return "Gerente de Relacionamento";
  }
}

function descricaoOcOrigem(oc: 13 | 21): string {
  if (oc === 21) return "oc=21 (reentrega solicitada pelo cliente — aguardando saída pra entrega/oc=14)";
  return "oc=13 (cliente mudou endereço ou solicitou alteração — base parou movimentação)";
}

export async function gerarTextoCobrancaEscalonada(
  env: Record<string, string | undefined>,
  args: GerarTextoArgs,
): Promise<GerarTextoResult> {
  const anthropic = createAnthropicClient({ env: readAnthropicEnvFromProcess(env) });

  const contextoOc = descricaoOcOrigem(args.oc_origem);
  const histLinhas = args.cobrancas_anteriores.length === 0
    ? "(nenhuma cobrança anterior — esta é a 1ª)"
    : args.cobrancas_anteriores
        .map((c) => `- ${c.disparado_em}: ${humanizarPapel(c.papel)} via ${c.canal}${c.contato_nome ? ` (${c.contato_nome})` : ""}`)
        .join("\n");

  const userPrompt = [
    `Operador: ${args.operador_nome}`,
    `Canal alvo: ${args.canal.toUpperCase()}`,
    `Papel a cobrar agora: ${humanizarPapel(args.papel)}${args.contato_destinatario_nome ? ` — ${args.contato_destinatario_nome}` : ""}`,
    "",
    `NF: ${args.nf}`,
    `CTRC: ${args.ctrc ?? "?"}`,
    `Base: ${args.base ?? "?"}`,
    `Cliente: ${args.empresa_cliente ?? "?"}`,
    `Dias úteis parados: ${args.dias_uteis_parados.toFixed(1)}`,
    `Contexto da oc atual: ${contextoOc}`,
    "",
    "Cobranças anteriores nesse card:",
    histLinhas,
    "",
    `Gere o texto de cobrança pra ${humanizarPapel(args.papel)} via ${args.canal}.`,
  ].join("\n");

  const out = await anthropic.completeJson<{ assunto?: string; texto: string; rationale?: string }>({
    model: MODEL,
    system: SYSTEM_PROMPT_BASE,
    messages: [{ role: "user", content: userPrompt }],
    maxTokens: 1200,
    temperature: 0.4,
  });

  return {
    assunto: (out.assunto ?? "").slice(0, 200),
    texto: (out.texto ?? "").trim(),
    rationale: (out.rationale ?? "").slice(0, 500),
    modelo: MODEL,
  };
}
