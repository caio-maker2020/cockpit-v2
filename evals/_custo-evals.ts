// =============================================================================
// evals/_custo-evals.ts — chave PRÓPRIA e custo VISÍVEL pra todo script local
// que chama a Anthropic (INV-166, Caio 02/10/2026).
//
// Origem: em 02/10 um ensaio A/B local (replay de prompt, 1.083 chamadas Sonnet
// 4.6 em 37 min) rodou com a chave de PRODUÇÃO do `.env.local`. Custou ~US$ 35,
// disparou 5 recargas de US$ 10 no mesmo dia e NÃO apareceu em lugar nenhum: o
// script não grava consumo e a chave é a mesma das edges, então no console da
// Anthropic o gasto se misturou ao do backend. Três furos, três regras:
//
//   1. Script local NUNCA usa `ANTHROPIC_API_KEY` (produção). Usa
//      `ANTHROPIC_API_KEY_EVALS` — chave separada no console, com teto próprio.
//      Assim o gasto de eval aparece SEPARADO e nunca drena o crédito da produção.
//   2. Todo eval conta tokens e imprime o custo no fim (o cliente da API não
//      grava nada sozinho).
//   3. Lote caro (>LIMITE_CHAMADAS_SEM_CONFIRMAR chamadas) só roda com
//      `--confirmar-custo <USD>` — a estimativa aparece antes, não depois.
// =============================================================================

export const VAR_CHAVE_EVALS = "ANTHROPIC_API_KEY_EVALS";
export const VAR_CHAVE_PRODUCAO = "ANTHROPIC_API_KEY";
export const LIMITE_CHAMADAS_SEM_CONFIRMAR = 50;

/** US$ por 1M tokens (entrada, saída). Fonte: tabela pública da Anthropic. */
export const PRECO_USD_POR_M: Record<string, { entrada: number; saida: number }> = {
  "claude-sonnet-4-6": { entrada: 3, saida: 15 },
  "claude-haiku-4-5": { entrada: 0.8, saida: 4 },
  "claude-haiku-4-5-20251001": { entrada: 0.8, saida: 4 },
  "claude-opus-4-7": { entrada: 15, saida: 75 },
};
const PRECO_DESCONHECIDO = { entrada: 3, saida: 15 }; // assume Sonnet: erra pra cima, nunca pra baixo

/** Média medida em produção (anthropic_usage_log, 7 dias, interpretador): ~9.9k in / ~300 out. */
export const ESTIMATIVA_TOKENS_POR_CHAMADA = { entrada: 10_000, saida: 300 };

export interface UsageAnthropic {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Lê a chave de EVAL. Recusa — com explicação — quando só a de produção está
 * no ambiente: é exatamente o cenário do incidente.
 */
export function lerChaveEvals(env: { get(k: string): string | undefined }): string {
  const evals = env.get(VAR_CHAVE_EVALS)?.trim();
  if (evals) return evals;
  const producao = env.get(VAR_CHAVE_PRODUCAO)?.trim();
  if (producao) {
    throw new Error(
      `${VAR_CHAVE_PRODUCAO} está no ambiente mas ${VAR_CHAVE_EVALS} não. ` +
        `Eval/script local NÃO roda com a chave de produção (INV-166: incidente de 02/10, ~US$35 invisíveis). ` +
        `Crie uma chave própria no console da Anthropic (com teto de gasto) e exporte ${VAR_CHAVE_EVALS}.`,
    );
  }
  throw new Error(
    `falta ${VAR_CHAVE_EVALS} no ambiente (chave separada pra evals; a de produção não serve — INV-166).`,
  );
}

export function custoUsd(modelo: string, entrada: number, saida: number): number {
  const p = PRECO_USD_POR_M[modelo] ?? PRECO_DESCONHECIDO;
  return (entrada / 1e6) * p.entrada + (saida / 1e6) * p.saida;
}

export function estimarUsd(modelo: string, chamadas: number): number {
  return custoUsd(
    modelo,
    chamadas * ESTIMATIVA_TOKENS_POR_CHAMADA.entrada,
    chamadas * ESTIMATIVA_TOKENS_POR_CHAMADA.saida,
  );
}

/**
 * Portão de custo. Retorna `null` quando pode rodar; senão a mensagem que o
 * chamador deve imprimir antes de sair (exit 2). `confirmado` = valor passado em
 * `--confirmar-custo`: tem de ser um número ≥ estimativa (pra ninguém confirmar
 * "sim" sem olhar o número).
 */
export function portaoDeCusto(
  modelo: string,
  chamadasPrevistas: number,
  confirmado: string | undefined,
): string | null {
  if (chamadasPrevistas <= LIMITE_CHAMADAS_SEM_CONFIRMAR) return null;
  const est = estimarUsd(modelo, chamadasPrevistas);
  const ok = Number(confirmado);
  if (Number.isFinite(ok) && ok >= est) return null;
  return (
    `CUSTO: este eval vai fazer ~${chamadasPrevistas} chamadas a ${modelo} ` +
    `(~${(chamadasPrevistas * ESTIMATIVA_TOKENS_POR_CHAMADA.entrada / 1e6).toFixed(1)}M tokens de entrada) ` +
    `≈ US$ ${est.toFixed(2)}. Acima de ${LIMITE_CHAMADAS_SEM_CONFIRMAR} chamadas exige confirmação explícita: ` +
    `repita o comando com --confirmar-custo ${Math.ceil(est)} ` +
    (confirmado !== undefined ? `(recebido: "${confirmado}", abaixo da estimativa). ` : "") +
    `Ou reduza --limit/--controle/--rodadas.`
  );
}

/** Acumula o `usage` de cada resposta e imprime o total no fim. */
export class ContadorCusto {
  chamadas = 0;
  entrada = 0;
  saida = 0;
  cacheCriado = 0;
  cacheLido = 0;
  constructor(readonly modelo: string) {}

  registrar(usage: UsageAnthropic | undefined): void {
    this.chamadas += 1;
    if (!usage) return;
    this.entrada += usage.input_tokens ?? 0;
    this.saida += usage.output_tokens ?? 0;
    this.cacheCriado += usage.cache_creation_input_tokens ?? 0;
    this.cacheLido += usage.cache_read_input_tokens ?? 0;
  }

  get usd(): number {
    // cache: criação custa 1,25× entrada; leitura 0,1× — aproximado pela entrada cheia
    // (erra pra cima). Evals não usam cache hoje.
    return custoUsd(this.modelo, this.entrada + this.cacheCriado + this.cacheLido, this.saida);
  }

  relatorio(): string {
    return (
      `CUSTO DESTE EVAL: ${this.chamadas} chamadas a ${this.modelo} · ` +
      `entrada ${this.entrada.toLocaleString("pt-BR")} · saída ${this.saida.toLocaleString("pt-BR")} tokens` +
      (this.cacheCriado + this.cacheLido > 0 ? ` · cache ${this.cacheCriado}/${this.cacheLido}` : "") +
      ` ≈ US$ ${this.usd.toFixed(2)} (chave ${VAR_CHAVE_EVALS}; não aparece em anthropic_usage_log — é dev, não produção).`
    );
  }
}
