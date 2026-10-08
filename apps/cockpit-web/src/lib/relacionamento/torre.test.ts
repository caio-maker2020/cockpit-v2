import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KANBAN_COLUMNS } from "@/lib/types";
import { cardsDemoRel } from "./demo/dadosDemoRel";
import {
  ETAPAS_REL,
  agruparInbox,
  avisoPorCard,
  avisosRel,
  colunasNaOrdem,
  contagemPorEtapa,
  nivelDaConfianca,
  ordemDosCards,
  registroRel,
  resumirRel,
} from "./torre";

describe("etapas do Relacionamento", () => {
  it("toda coluna do kanban está em exatamente uma etapa", () => {
    for (const c of KANBAN_COLUMNS) expect(ETAPAS_REL.filter((e) => e.colunas.includes(c.id))).toHaveLength(1);
  });
  it("o trilho autônomo só entra na ordem para quem está no piloto", () => {
    expect(colunasNaOrdem(true)).toContain("veto_janela");
    expect(colunasNaOrdem(false)).not.toContain("veto_janela");
    expect(colunasNaOrdem(false)[0]).toBe("validacao");
  });
});

describe("agruparInbox (mesma regra do Inbox)", () => {
  const cards = cardsDemoRel();
  const g = agruparInbox(cards, null);
  it("cada card cai em uma coluna; nada some", () => {
    let total = 0;
    g.forEach((v) => (total += v.length));
    expect(total).toBe(cards.length);
  });
  it("possível resposta em outra thread vai para Cliente respondeu", () => {
    const alvo = cards.find((c) => c.state === "AGUARDANDO_CLIENTE")!;
    const g2 = agruparInbox(cards, new Set([alvo.id]));
    expect(g2.get("cliente_respondeu")!.some((c) => c.id === alvo.id && c.possivel_resposta_outra_thread)).toBe(true);
  });
  it("veto_janela: quem vence primeiro no topo; validação: o mais velho primeiro", () => {
    const v = g.get("veto_janela")!.map((c) => Date.parse(c.acao_autonoma!.executar_em!));
    expect([...v].sort((a, b) => a - b)).toEqual(v);
    const d = g.get("validacao")!.map((c) => c.bastao_data_ultima_ocorrencia ?? "9999");
    expect([...d].sort()).toEqual(d);
  });
  it("contagem por etapa e ordem de navegação seguem o fluxo", () => {
    const k = contagemPorEtapa(g);
    expect(k.voce).toBe((g.get("validacao")?.length ?? 0) + (g.get("cliente_respondeu")?.length ?? 0));
    const ordem = ordemDosCards(g, colunasNaOrdem(true));
    expect(ordem[0]).toBe(g.get("validacao")![0]!.id);
    expect(ordem).toHaveLength(cards.length);
  });
});

describe("torre: certeza, conselheiro, registro", () => {
  it("certeza em palavras, sem porcentagem", () => {
    expect(nivelDaConfianca(0.92)).toBe("alta");
    expect(nivelDaConfianca(0.7)).toBe("media");
    expect(nivelDaConfianca(0.4)).toBe("baixa");
    expect(nivelDaConfianca(88)).toBe("alta");
    expect(nivelDaConfianca(null)).toBeNull();
  });
  it("o conselheiro soma os sinais e marca o card", () => {
    const cards = cardsDemoRel();
    const avisos = avisosRel(cards, () => false);
    expect(avisos[0]!.id).toBe("falhou");
    expect(avisoPorCard(avisos).size).toBeGreaterThan(0);
    const r = resumirRel(agruparInbox(cards, null));
    expect(r.total).toBe(cards.length);
    expect(r.especialistas.length).toBeGreaterThan(0);
    expect(registroRel(cards).length).toBeGreaterThan(0);
  });
});

describe("demonstração do Relacionamento fica fora da produção", () => {
  const SRC = join(__dirname, "..", "..");
  it("só o modo demo-rel liga a demo, e o App importa a página por import dinâmico", () => {
    expect(readFileSync(join(SRC, "lib/relacionamento/demo/modoDemoRel.ts"), "utf8")).toMatch(
      /export const RELACIONAMENTO_DEMO: boolean = import\.meta\.env\.MODE === "demo-rel";/,
    );
    const app = readFileSync(join(SRC, "App.tsx"), "utf8");
    expect(app).toMatch(/RELACIONAMENTO_DEMO \? lazy\(\(\) => import\("\.\/pages\/relacionamento\/DemoRelacionamento"\)\) : null/);
    expect(app).not.toMatch(/^import .*DemoRelacionamento/m);
  });
});
