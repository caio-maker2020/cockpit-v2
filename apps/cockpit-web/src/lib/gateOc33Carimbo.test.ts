// INV-152 (Karol 2026-09-11, NF 436268) — a tela não oferece oc 33 que a parede
// de `aprovar_e_executar` vai recusar, e o `disabled` sai do CARIMBO (o que a
// parede lê), nunca do espelho do dossiê.
// Rodar: npx vitest run src/lib/gateOc33Carimbo.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lerGateOc33Carimbo, textoGateOc33Carimbo } from "./gateOc33Carimbo";

describe("lerGateOc33Carimbo — caso-âncora de produção", () => {
  it("NF 436268 / KAROLINE: carimbo bloqueia por 'descrição dos itens'", () => {
    // Cópia literal do todo 5d3432d0 (tool lancar_oc33_solo_portal), lido no
    // banco em 11/09 — é o card do print da Karol.
    const g = lerGateOc33Carimbo({
      tool: "lancar_oc33_solo_portal",
      meta: {
        gate_oc33: {
          faltando: ["descrição dos itens"],
          natureza: "completude",
          bloqueada: true,
        },
      },
    });
    expect(g?.bloqueada).toBe(true);
    expect(g?.faltando).toEqual(["descrição dos itens"]);
    expect(g?.natureza).toBe("completude");
    expect(textoGateOc33Carimbo(g)).toBe("falta descrição dos itens");
  });
});

describe("lerGateOc33Carimbo — o que NUNCA pode acontecer", () => {
  it("SEM carimbo devolve null — a parede deixa passar, a tela não pode apagar", () => {
    // 26 todos pendentes medidos em 11/09 estão exatamente assim: dossiê
    // incompleto, nenhum carimbo. `aprovar_e_executar` aceita esses. Tratar
    // null como bloqueio apagaria botão que funciona.
    expect(lerGateOc33Carimbo({ tool: "lancar_oc33_solo_portal", meta: {} })).toBeNull();
    expect(lerGateOc33Carimbo({ tool: "lancar_oc33_solo_portal" })).toBeNull();
    expect(lerGateOc33Carimbo(null)).toBeNull();
    expect(lerGateOc33Carimbo(undefined)).toBeNull();
  });

  it("carimbo=false não bloqueia (3 todos medidos em 11/09)", () => {
    const g = lerGateOc33Carimbo({ meta: { gate_oc33: { bloqueada: false, faltando: [] } } });
    expect(g?.bloqueada).toBe(false);
    expect(textoGateOc33Carimbo(g)).toBe("");
  });

  it("'true' como STRING não bloqueia — a parede compara o booleano", () => {
    // A parede faz `->>'bloqueada' = 'true'` sobre JSON: só o booleano true
    // vira o texto 'true'. Aceitar truthy aqui apagaria botão que o banco deixa
    // passar — a tela inventando política que o backend não tem.
    const g = lerGateOc33Carimbo({ meta: { gate_oc33: { bloqueada: "true" } } });
    expect(g?.bloqueada).toBe(false);
  });

  it("bloqueado sem lista de faltas ainda dá um motivo legível", () => {
    // Botão apagado e mudo é pior que o bug original: a operadora perde até o
    // erro que tinha pra ler.
    const g = lerGateOc33Carimbo({ meta: { gate_oc33: { bloqueada: true } } });
    expect(textoGateOc33Carimbo(g)).toBe("dossiê incompleto");
  });

  it("ignora lixo dentro de faltando sem quebrar", () => {
    const g = lerGateOc33Carimbo({
      meta: { gate_oc33: { bloqueada: true, faltando: ["valor dos itens", "", null, 7] } },
    });
    expect(g?.faltando).toEqual(["valor dos itens"]);
  });
});

describe("INV-152: fiação em ProposedActions.tsx", () => {
  const src = readFileSync(
    resolve(__dirname, "../components/cards/ProposedActions.tsx"),
    "utf-8",
  );

  it("o disabled vem do CARIMBO, não do espelho do dossiê", () => {
    expect(src).toContain("lerGateOc33Carimbo(pl)");
    expect(src).toContain("const bloqueadoPeloBanco = gate33Carimbo?.bloqueada === true;");
    // Teste de FONTE: se alguém trocar a origem pro espelho, cai aqui.
    // O espelho lê o dossiê VIVO; a parede lê o carimbo. Divergiam em 29 todos.
    expect(src).not.toContain("bloqueadoPeloBanco = faltaDossie33");
    expect(src).not.toContain("const bloqueadoPeloBanco = faltaDossie33?.bloqueada");
  });

  it("todos os botões de lançar da lista carregam o bloqueio", () => {
    const comBloqueio = src.match(/disabled=\{aprovacaoEmVoo[^}]*bloqueadoPeloBanco\}/g) ?? [];
    expect(comBloqueio.length).toBe(8);
    // Nenhum botão da lista pode ficar sem — inclusive o "confirmar lançamento"
    // do painel expandido, que era o único com outra combinação de disabled.
    expect(src).toContain("disabled={aprovacaoEmVoo || uploadingAnexo || bloqueadoPeloBanco}");
  });

  it("todo ramo de render mostra o motivo (6 ramos, incl. a ★ Recomendada)", () => {
    // O ramo destacado era o ÚNICO sem o aviso: apagar o botão lá sem este
    // banner deixaria a ação cinza e muda.
    const usos = src.match(/\{AvisoDossie33Banner\}/g) ?? [];
    expect(usos.length).toBe(6);
  });

  it("o 44+59 não é apagado pela regra da 33", () => {
    // Paridade com faltaDossie33: combo 44+59 não é oc 33 e não tem dossiê a cobrar.
    expect(src).toContain("ehQualquerOc33 && !isCombo4459 ? lerGateOc33Carimbo(pl) : null");
  });

  it("o modal de oc 33 só fecha quando a aprovação PASSA", () => {
    // Fechar no clique fazia a operadora perder a seleção de anexos a cada
    // recusa — e deixar página convertida órfã no bucket.
    for (const setter of [
      "setComboModalTodo",
      "setOc33SoloModalTodo",
      "setEmailOc33ModalTodo",
    ]) {
      expect(src).toContain(`{ onSuccess: () => ${setter}(null) }`);
    }
    expect(src).toContain("approve.mutate({ todo, extras }, { onSuccess: () => opts?.onSuccess?.() })");
  });
});
