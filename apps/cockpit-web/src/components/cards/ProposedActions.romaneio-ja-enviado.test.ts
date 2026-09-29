// =============================================================================
// Guard da FIAÇÃO e das PREMISSAS da 33 relançada com romaneio já enviado
// (Carlos 29/09, NF 435297 — INV-162).
//
// A regra pura (romaneio-modal-oc33.ts) só é segura por causa de duas coisas
// que teste de função pura não enxerga:
//   1. o modal da 33+44 passa `modal: "combo"` — se passar "solo", a tela
//      libera e o combo lança a 33 SEM romaneio (processarComboPortal33_44 não
//      busca o arquivo; é o erro da NF 158084);
//   2. o executor da 33 sozinha busca o romaneio de novo e REVERTE se não achar.
//      Se esse elo sumir do backend, a tela libera e a 33 sai sem romaneio.
// Mesma técnica de ProposedActions.segregacao.test.ts: lê o fonte.
// =============================================================================
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EVENTO_REBUSCA_FALHOU, MIMES_IMAGEM_SSW } from "@/lib/romaneio-modal-oc33";

function semComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

// vitest roda com cwd=apps/cockpit-web
const front = semComentarios(readFileSync(resolve(process.cwd(), "src/components/cards/ProposedActions.tsx"), "utf8"));
const executor = semComentarios(readFileSync(resolve(process.cwd(), "../../supabase/functions/executor/index.ts"), "utf8"));
const dossie = semComentarios(
  readFileSync(resolve(process.cwd(), "../../supabase/functions/_shared/extravio-parcial-dossie.ts"), "utf8"),
);

function trecho(fonte: string, inicio: string, fim: string): string {
  const i = fonte.indexOf(inicio);
  const j = fonte.indexOf(fim, i + inicio.length);
  expect(i, `início "${inicio}" não achado`).toBeGreaterThan(-1);
  expect(j, `fim "${fim}" não achado`).toBeGreaterThan(i);
  return fonte.slice(i, j);
}

const modalCombo = trecho(front, "function ModalCombo3344(", "function ModalOc33Solo(");
const modalSolo = trecho(front, "function ModalOc33Solo(", "function ModalEmailEOc33(");

describe("fiação nos modais da oc 33", () => {
  it("33+44 declara modal combo — nunca solo", () => {
    expect(modalCombo).toContain('modal: "combo"');
    expect(modalCombo).not.toContain('modal: "solo"');
  });

  it("33 sozinha declara modal solo e lê o histórico de falhas da busca", () => {
    expect(modalSolo).toContain('modal: "solo"');
    expect(modalSolo).toContain("EVENTO_REBUSCA_FALHOU");
    expect(modalSolo).toContain("falhasDeRebusca,");
    // reabrir logo depois de uma falha tem de ver a falha (cache do app é 30s)
    expect(modalSolo).toMatch(/rebusca-romaneio-falhou[\s\S]{0,200}staleTime: 0/);
  });

  it("os dois modais decidem o clique pela regra nova, com a lista carregada", () => {
    for (const m of [modalCombo, modalSolo]) {
      expect(m).toContain("decidirConfirmacaoRomaneio(situacaoRomaneio, finalNomes)");
      expect(m).toContain("carregado: anexosCarregados");
      expect(m).toContain("isSuccess: anexosCarregados");
      // erro da consulta não pode virar "lista vazia" (liberaria a busca à toa)
      expect(m).toContain("if (errAnexos) throw errAnexos;");
      expect(m).toContain("if (errMsgs) throw errMsgs;");
      // a lista continua só com anexo vivo (auditoria 25/07)
      expect(m).toContain('.is("deletado_em", null)');
    }
  });

  it("o guard antigo (exige pelo nome o que a lista esconde) não volta", () => {
    expect(front).not.toContain("romaneioExigidoDoCard(card)");
  });
});

describe("premissas do backend em que a tela se apoia", () => {
  const solo = trecho(executor, "async function processarOc33SoloPortal(", "\nasync function ");
  const combo = trecho(executor, "async function processarComboPortal33_44(", "\nasync function ");
  const materializar = trecho(executor, "async function materializarOc33Completude(", "\nasync function ");

  it("a 33 sozinha materializa o dossiê e REVERTE se faltar evidência", () => {
    expect(solo).toContain("materializarOc33Completude(");
    expect(solo).toMatch(/materializado\.faltando\.length > 0\)[\s\S]{0,200}reverter_acao_falhou/);
    expect(solo).toContain(`event_type: "${EVENTO_REBUSCA_FALHOU}"`);
  });

  it("a materialização busca o romaneio de novo e o dá como faltando se não achar", () => {
    expect(materializar).toContain("reanexarEvidenciaDoDossie(supabase, env, dossie.romaneio)");
    expect(materializar).toContain('faltando.push("romaneio")');
    expect(materializar).toContain("romaneioCobertoPeloOperador");
  });

  it("o combo 33+44 NÃO busca o romaneio — por isso o modal dele continua barrando", () => {
    // Se um dia o combo passar a materializar, esta premissa muda: revisar
    // romaneio-modal-oc33.ts antes de relaxar o modal do combo.
    expect(combo).not.toContain("materializarOc33Completude(");
  });

  it("os tipos de imagem do modal são os mesmos do executor (ehImagemMimeSsw)", () => {
    const fn = trecho(dossie, "export function ehImagemMimeSsw(", "\n}");
    const doExecutor = [...fn.matchAll(/mime === "([^"]+)"/g)].map((m) => m[1]).sort();
    expect(doExecutor.length).toBeGreaterThan(0);
    expect([...MIMES_IMAGEM_SSW].sort()).toEqual(doExecutor);
  });
});
