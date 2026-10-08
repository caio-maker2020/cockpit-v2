// Carga sintética realista da fila da Operação (incidente WORKER_RESOURCE_LIMIT, 08/10).
// Só para testes/bench: gera N pendências com ocs, unidades e instruções tiradas das
// regras aprendidas reais (fixtures/regras-aprendidas-2026-10.json, CNPJs trocados).
import type { PendenciaOperacao } from "./operacao-materializar.ts";
import type { RegraAprendidaOperacao } from "./operacao-sugestao.ts";

export const AGORA_CARGA = Date.parse("2026-10-08T12:00:00Z");

export function regrasDaFixture(): RegraAprendidaOperacao[] {
  const url = new URL("./fixtures/regras-aprendidas-2026-10.json", import.meta.url);
  return JSON.parse(Deno.readTextFileSync(url)) as RegraAprendidaOperacao[];
}

/** PRNG determinístico (mulberry32): mesma carga em toda rodada. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Desfaz o modelo da instrução: "#" vira número/data, varia caixa e acento. */
function instanciar(modelo: string, r: () => number): string {
  let s = modelo.replace(/#/g, () => String(Math.floor(r() * 9000) + 10));
  if (r() < 0.3) s = s.toLowerCase();
  if (r() < 0.2) s = s.replace(/CAO/g, "ÇÃO").replace(/cao/g, "ção");
  if (r() < 0.2) s = `  ${s.replace(/ /g, "  ")} `;
  return s;
}

export function pendenciasSinteticas(n: number, regras: readonly RegraAprendidaOperacao[], seed = 42): PendenciaOperacao[] {
  const r = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const unidades = ["VGA", "MTZ", "AMP", "BHZ", "CTG", "CVL", "VGE", "BHE", "FRU", "PAS", "JME", "URA", "JAU", "PNO", "SJR"];
  const ocsLivres = [2, 13, 14, 15, 21, 32, 34, 36, 37, 41, 56, 99];
  const cnpjs = [...new Set(regras.map((x) => x.estado.pagador_cnpj).filter(Boolean) as string[]), "12345678000199", "98765432000110"];
  const out: PendenciaOperacao[] = [];
  for (let i = 0; i < n; i++) {
    const base = r() < 0.8 ? pick(regras) : null; // 80% num estado que alguma regra conhece
    const oc = base ? base.estado.oc : pick(ocsLivres);
    const unidade = base?.estado.unidade && r() < 0.7 ? base.estado.unidade : pick(unidades);
    const modelo = base?.estado.instrucao_modelo ?? base?.estado.instrucao_padrao;
    const instr = modelo && r() < 0.75 ? instanciar(modelo, r) : (r() < 0.5 ? null : `texto livre ${Math.floor(r() * 1e6)} em ${i}/10`);
    const horas = Math.floor(r() * 24 * 20);
    out.push({
      id: `b-${i}`, ctrc: `VGA${String(100000 + i)}${i % 10}`, nf: String(1000 + i), filial: unidade,
      cod_ultima_ocorrencia: r() < 0.01 ? null : oc, instrucao_ultima_ocorrencia: instr,
      data_ultima_ocorrencia: r() < 0.03 ? null : new Date(AGORA_CARGA - horas * 3_600_000).toISOString(),
      responsavel_atual: "operacao", pagador: "P", cnpj_pagador: r() < 0.1 ? pick(cnpjs) : null,
      destinatario: "D", cidade_destino: "Varginha", uf_destino: "MG", base_destino: unidade, unidade_origem: "BHZ",
      unidade_destino: unidade, unidade_atual: r() < 0.5 ? unidade.toLowerCase() + " " : unidade,
      previsao_entrega: r() < 0.2 ? null : new Date(AGORA_CARGA + (r() - 0.5) * 10 * 86_400_000).toISOString(),
      atraso_original: 1, qtd_volumes: 2, tipo_documento: "NORMAL",
    });
  }
  return out;
}
