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
    // INV-155 (Carlos 2026-09-16): o `disabled` passou a sair de `travaBotao33`.
    // A INTENÇÃO deste guard não mudou — todo botão de lançar da lista carrega a
    // trava — e o teste seguinte prova que `travaBotao33` NASCE de
    // `bloqueadoPeloBanco`, então a parede continua sendo a fonte.
    const comBloqueio = src.match(/disabled=\{aprovacaoEmVoo[^}]*travaBotao33\}/g) ?? [];
    expect(comBloqueio.length).toBe(8);
    // Nenhum botão da lista pode ficar sem — inclusive o "confirmar lançamento"
    // do painel expandido, que era o único com outra combinação de disabled.
    expect(src).toContain("disabled={aprovacaoEmVoo || uploadingAnexo || travaBotao33}");
    // Migração pela metade é o pior dos mundos: botão que ficou no nome antigo
    // deixaria de respeitar o pop-up (ou o contrário) sem ninguém ver.
    expect(src).not.toMatch(/disabled=\{aprovacaoEmVoo[^}]*bloqueadoPeloBanco\}/);
  });

  it("INV-155: a trava do botão NASCE da parede — o pop-up só abre exceção", () => {
    // Se alguém definir `travaBotao33` de outra fonte (ou fixar em false), os 8
    // botões acima continuam "carregando a trava" e a parede some em silêncio.
    expect(src).toContain(
      "const travaBotao33 = bloqueadoPeloBanco && !podeConfirmar33;",
    );
    // E a exceção só existe com a chave ligada, fora do combo 33+44.
    expect(src).toContain("flagConfirma33 === true && !isCombo");
    // O pop-up NUNCA substitui a parede do banco: quem lança segue sendo
    // aprovar_e_executar, chamada pelo clique original que ficou em espera.
    expect(src).toContain("aoConfirmar: abrir");
  });

  it("todo ramo de render mostra o motivo (6 ramos, incl. a ★ Recomendada)", () => {
    // O ramo destacado era o ÚNICO sem o aviso: apagar o botão lá sem este
    // banner deixaria a ação cinza e muda.
    // (09/10: contado DENTRO da lista — o cartão simples tem o seu, testado abaixo.)
    const usos = corpoDaFuncao(src, "ValidacaoHumanaList").match(/\{AvisoDossie33Banner\}/g) ?? [];
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

/** Corpo de uma função de topo do arquivo: do `function Nome(` até a próxima. */
function corpoDaFuncao(src: string, nome: string): string {
  const ini = src.search(new RegExp(`^(?:export )?function ${nome}\\(`, "m"));
  if (ini < 0) return "";
  const resto = src.slice(ini + 1);
  const prox = resto.search(/^(?:export )?function \w+\(/m);
  return prox < 0 ? src.slice(ini) : src.slice(ini, ini + 1 + prox);
}

/** Todas as funções de topo do arquivo, com nome e corpo. */
function funcoesDeTopo(src: string): { nome: string; corpo: string }[] {
  const nomes = [...src.matchAll(/^(?:export )?function (\w+)\(/gm)].map((m) => m[1] as string);
  return nomes.map((nome) => ({ nome, corpo: corpoDaFuncao(src, nome) }));
}

// Carlos 2026-10-09 (NF 387252, CH-20261007-B8VZ): fora de
// AGUARDANDO_VALIDACAO_HUMANA a tela usa o ProposalCard, que nascia SEM a trava
// do carimbo e SEM o pop-up — botão da 33 aceso, 7 anexos marcados e a parede
// recusando (OC33_DOSSIE_INCOMPLETO) duas vezes em 08/10. Em 09/10, 139 cards
// em AGUARDANDO_CLIENTE assim. Os testes acima só olhavam a LISTA.
describe("INV-152/INV-155 no cartão simples (fora da validação humana)", () => {
  const src = readFileSync(
    resolve(__dirname, "../components/cards/ProposedActions.tsx"),
    "utf-8",
  );
  const cartao = corpoDaFuncao(src, "ProposalCard");

  it("o cartão simples existe e é achado pelo teste", () => {
    expect(cartao.length).toBeGreaterThan(0);
    expect(cartao).toContain("decidirCliqueAprovacao(");
  });

  it("a trava sai do CARIMBO e o pop-up é só a exceção — iguais à lista", () => {
    expect(cartao).toContain("ehQualquerOc33 && !isCombo4459 ? lerGateOc33Carimbo(pl) : null");
    expect(cartao).toContain("const bloqueadoPeloBanco = gate33Carimbo?.bloqueada === true;");
    expect(cartao).not.toContain("bloqueadoPeloBanco = faltaDossie33");
    expect(cartao).toContain("const travaBotao33 = bloqueadoPeloBanco && !podeConfirmar33;");
    expect(cartao).toContain("flagConfirma33 === true && !isCombo");
  });

  it("o botão de aprovar carrega a trava, abre o pop-up e diz o motivo", () => {
    expect(cartao).toContain("disabled={busy || travaBotao33}");
    expect(cartao).toContain("onClick={comConfirmacao33(");
    // O clique original fica em espera até o SIM; quem lança segue sendo a RPC.
    expect(cartao).toContain("aoConfirmar: abrir");
    expect(cartao).toContain("<ModalConfirmarDossie33");
    expect(cartao.match(/\{AvisoDossie33Banner\}/g)?.length ?? 0).toBe(1);
  });

  it("as janelas da 33 do cartão só fecham quando a aprovação PASSA", () => {
    for (const setter of ["setShowModalOc33Solo", "setShowModalCombo3344", "setShowModalEmailOc33"]) {
      expect(cartao).toContain(`{ onSuccess: () => ${setter}(false) }`);
    }
    expect(src).toContain(
      "approve.mutate({ todo: t, extras }, { onSuccess: () => opts?.onSuccess?.() })",
    );
    expect(src).toContain("onApprove={(extras, opts) => onApprove(t, extras, opts)}");
  });

  it("lista e cartão leem a chave e o 'card tem anexo' da MESMA fonte", () => {
    expect(corpoDaFuncao(src, "ValidacaoHumanaList")).toContain("usePopupConfirmaOc33(card.id)");
    expect(cartao).toContain("usePopupConfirmaOc33(card.id)");
    // Nenhuma cópia solta da consulta da chave dentro do componente.
    expect(src).not.toContain('"popup_confirma_dossie_oc33_enabled"');
  });

  it("TODA função que abre janela de lançamento da 33 carrega a trava", () => {
    // Pega o próximo componente que nascer sem trava — foi exatamente assim que
    // o ProposalCard ficou de fora em 11/09 e 16/09.
    const abridores = [
      "setOc33SoloModalTodo(todo)",
      "setComboModalTodo(todo)",
      "setEmailOc33ModalTodo(todo)",
      "setEmailExtravioModalTodo(todo)",
      "setShowModalOc33Solo(true)",
      "setShowModalCombo3344(true)",
      "setShowModalEmailOc33(true)",
    ];
    const queAbrem = funcoesDeTopo(src).filter((f) =>
      abridores.some((a) => f.corpo.includes(a)),
    );
    expect(queAbrem.map((f) => f.nome).sort()).toEqual(["ProposalCard", "ValidacaoHumanaList"]);
    for (const f of queAbrem) {
      expect(f.corpo, f.nome).toContain("travaBotao33");
      expect(f.corpo, f.nome).toContain("comConfirmacao33(");
    }
  });
});

// Carlos 2026-10-09, opção "b": na NF 387252 a descrição veio no CORPO do e-mail
// e a pergunta "em anexo?" não tinha resposta honesta (NÃO = segue travado).
describe("pergunta do pop-up: 'no e-mail ou em anexo?'", () => {
  const modal = readFileSync(
    resolve(__dirname, "../components/cards/ModalConfirmarDossie33.tsx"),
    "utf-8",
  );
  const lista = readFileSync(
    resolve(__dirname, "../components/cards/ProposedActions.tsx"),
    "utf-8",
  );
  const servidor = readFileSync(
    resolve(__dirname, "../../../../supabase/functions/confirmar-dossie-oc33/index.ts"),
    "utf-8",
  );

  it("o pop-up pergunta pelos dois caminhos", () => {
    expect(modal).toContain("<b>no e-mail ou em anexo</b>?");
    expect(modal).not.toContain("<b>em anexo</b>?");
  });

  it("o aviso da lista e do cartão convida pelos dois caminhos", () => {
    expect(lista).toContain("<b>no e-mail ou em anexo</b>");
    expect(lista).not.toContain("<b>em anexo</b>");
  });

  it("o registro do NÃO descreve a pergunta que foi feita", () => {
    expect(servidor).toContain("cliente nao informou no e-mail nem em anexo");
    expect(servidor).not.toContain("cliente nao informou por anexo");
  });
});
