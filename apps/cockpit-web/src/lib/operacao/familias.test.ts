import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FAMILIAS_PROBLEMA, agruparPorFamilia, familiaDaOc } from "./familias";
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

  it("semântica conferida nas descrições do dicionário", () => {
    expect(familiaDaOc(13)).toBe("entrega_impossivel"); // limitação cliente
    expect(familiaDaOc(39)).toBe("entrega_impossivel"); // problemas com janela
    expect(familiaDaOc(36)).toBe("pronta_entrega"); // chegada na base para entrega
    expect(familiaDaOc(55)).toBe("pronta_entrega"); // autorizado para seguir pra entrega
    expect(familiaDaOc(29)).toBe("reentrega_agendamento"); // agendamento de entrega
    expect(familiaDaOc(21)).toBe("reentrega_agendamento"); // reentrega solicitada
    expect(familiaDaOc(40)).toBe("transferencia"); // redespacho final
    expect(familiaDaOc(38)).toBe("transferencia"); // problemas na transferência
    expect(familiaDaOc(12)).toBe("comprovante"); // comprovante retido
    expect(familiaDaOc(56)).toBe("informacao"); // falta de informação operacional
    expect(familiaDaOc(45)).toBe("informacao"); // carga cubada
  });

  it("código desconhecido ou nulo cai em Outros", () => {
    expect(familiaDaOc(999)).toBe("outros");
    expect(familiaDaOc(null)).toBe("outros");
  });

  it("todo código da Operação no dicionário oficial que pode estar na fila tem família ou é decisão explícita", () => {
    const semFamilia = ocsDaOperacaoNoDicionario().filter((oc) => !FORA_DA_FILA.has(oc) && familiaDaOc(oc) === "outros");
    // Ficam em Outros de propósito (caso a caso): 27 custo extra, 51 início de destroca.
    expect(semFamilia).toEqual([27, 51]);
  });

  it("com a fila real (fixture local, quando existe), só cai em Outros o que é de propósito (27, 51)", () => {
    const f = resolve(__dirname, "../../../demo/fila-real.json");
    if (!existsSync(f)) return;
    const linhas = JSON.parse(readFileSync(f, "utf8")) as OpFilaLinha[];
    const g = agruparPorFamilia(linhas);
    expect(g.outros.filter((l) => ![27, 51].includes(l.cod_ultima_ocorrencia as number))).toEqual([]);
  });

  it("agrupar preserva a ordem de entrada (tempo parado)", () => {
    const l = (id: string, oc: number) => ({ op_item_id: id, cod_ultima_ocorrencia: oc }) as OpFilaLinha;
    const g = agruparPorFamilia([l("a", 13), l("b", 36), l("c", 15), l("d", 13)]);
    expect(g.entrega_impossivel.map((x) => x.op_item_id)).toEqual(["a", "c", "d"]);
    expect(g.pronta_entrega.map((x) => x.op_item_id)).toEqual(["b"]);
  });
});
