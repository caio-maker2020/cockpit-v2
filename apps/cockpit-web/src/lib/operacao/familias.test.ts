import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FAMILIAS_PROBLEMA, OCS_EM_OUTROS_DE_PROPOSITO, agruparPorFamilia, familiaDaOc, familiaPorId } from "./familias";
import type { OpFilaLinha } from "./tipos";

const MIG_204 = resolve(__dirname, "../../../../../migration/2026-06-16_204_dicionario_planilha_oficial_verdade_absoluta.sql");

/** Códigos com responsabilidade 'Operação' no dicionário oficial (mig 204). */
function ocsDaOperacaoNoDicionario(): number[] {
  const sql = readFileSync(MIG_204, "utf8");
  return [...sql.matchAll(/\((\d{1,3}),\s*'[^']*',\s*'Operação'/g)].map((m) => Number(m[1]));
}

// Finalizadoras e documentais nunca entram na fila (INV-182); não precisam de família.
const FORA_DA_FILA = new Set([1, 2, 30, 32, 34]);

describe("família do problema (kanban principal)", () => {
  it("nenhum código em duas famílias, e 'Outros' não tem código", () => {
    const vistos = new Map<number, string>();
    for (const f of FAMILIAS_PROBLEMA) {
      for (const oc of f.ocs) {
        expect(vistos.has(oc), `oc ${oc} em ${vistos.get(oc)} e ${f.id}`).toBe(false);
        vistos.set(oc, f.id);
      }
    }
    expect(FAMILIAS_PROBLEMA.find((f) => f.id === "outros")!.ocs).toHaveLength(0);
  });

  it("famílias do Caio (08/10): pronta para entregar = próxima oc 14; 56 → 49 pelo Relacionamento", () => {
    for (const oc of [13, 15, 55, 21, 7, 36, 39]) expect(familiaDaOc(oc), `oc ${oc}`).toBe("pronta_entrega");
    expect(familiaPorId("pronta_entrega").proximaOc).toBe(14);
    expect(familiaDaOc(29)).toBe("agendamento");
    expect(familiaDaOc(56)).toBe("necessita_informacao");
    expect(familiaPorId("necessita_informacao").proximaOc).toBe(49);
    expect(familiaDaOc(12)).toBe("comprovante");
    expect(familiaDaOc(40)).toBe("redespacho");
    expect(familiaDaOc(41)).toBe("informacao");
    // 14 é automática (romaneio): "Em rota", passiva, sem ação até a baixa do motorista
    expect(familiaDaOc(14)).toBe("em_rota");
    expect(familiaPorId("em_rota").passiva).toBe(true);
    // "Entrega impossível" não se aplica mais
    expect(FAMILIAS_PROBLEMA.map((f) => f.id)).not.toContain("entrega_impossivel");
  });

  it("código desconhecido ou nulo cai em Outros", () => {
    expect(familiaDaOc(999)).toBe("outros");
    expect(familiaDaOc(null)).toBe("outros");
  });

  it("todo código da Operação no dicionário oficial que pode estar na fila tem família ou é decisão explícita", () => {
    const semFamilia = ocsDaOperacaoNoDicionario().filter((oc) => !FORA_DA_FILA.has(oc) && familiaDaOc(oc) === "outros");
    // Ficam em Outros por decisão explícita do Caio (08/10): a lista é travada aqui.
    expect(semFamilia.sort((a, b) => a - b)).toEqual([...OCS_EM_OUTROS_DE_PROPOSITO].sort((a, b) => a - b));
  });

  it("com a fila real (fixture local, quando existe), só cai em Outros o que é de propósito", () => {
    const f = resolve(__dirname, "../../../demo/fila-real.json");
    if (!existsSync(f)) return;
    const linhas = JSON.parse(readFileSync(f, "utf8")) as OpFilaLinha[];
    const g = agruparPorFamilia(linhas);
    expect(g.outros.filter((l) => !OCS_EM_OUTROS_DE_PROPOSITO.includes(l.cod_ultima_ocorrencia as number))).toEqual([]);
  });

  it("agrupar preserva a ordem de entrada (tempo parado)", () => {
    const l = (id: string, oc: number) => ({ op_item_id: id, cod_ultima_ocorrencia: oc }) as OpFilaLinha;
    const g = agruparPorFamilia([l("a", 13), l("b", 29), l("c", 15), l("d", 13)]);
    expect(g.pronta_entrega.map((x) => x.op_item_id)).toEqual(["a", "c", "d"]);
    expect(g.agendamento.map((x) => x.op_item_id)).toEqual(["b"]);
  });
});
