// =============================================================================
// acareacao-41 — INV-192 (decisão 2026-10-09, opção "a"; NF 1119123).
//
// A 41 DA ACAREAÇÃO (regra R1 do playbook, ADR 0022) tem duas garantias:
//
//   1. SOBREVIVE à limpeza pós-resposta do cliente. A whitelist de
//      `propostas-pos-resposta-cliente` não conhecia a 41 e a cancelava como
//      "proposta obsoleta após resposta do cliente" — 25 cards entre 01/09 e
//      09/10; em 10 deles a operadora teve de lançar a 41 FORA do Cockpit.
//      Caso-âncora NF 1119123: a 41 nasceu 19:01, a R1 reconheceu a acareação
//      19:04 e um e-mail interno lido como resposta apagou a 41 às 19:17.
//
//   2. Leva o texto pronto "Realizar acareação" mesmo quando o menu nasceu
//      ANTES da decisão do agente. `proporAutoAcaoSeAplicavel` deduplica por
//      código: com uma 41 já ativa, o override de texto nunca era aplicado
//      (só 12 de 54 cards tiveram o texto).
//
// OPÇÃO "a": o texto pronto só entra quando a 49 é PEDIDO. A R1 casa qualquer
// "ACAREA" e também pega 49 que informam o RESULTADO ("ACAREACAO REALIZADA",
// "ACAREACAO NAO ASSINADA", "INSERINDO ACAREACAO", "RESSALVA REFERENTE A
// ACAREACAO") — 14 de 54 cards. Nesses a 41 continua protegida (garantia 1),
// mas SEM texto pronto: a operadora escreve. Lista de BLOQUEIO, de propósito:
// errar aqui só tira a sugestão de texto, nunca inventa uma.
//
// Nada aqui lança nada: a 41 está fora da escada autônoma e a tela sempre abre
// a caixa de texto da 41 antes de aprovar (OCS_COM_INPUT_OBRIGATORIO).
// Puro e sem efeito — quem grava é o chamador.
// =============================================================================
import { TEXTO_OC41_ACAREACAO } from "./oc49-casos-time.ts";

/** Mesma origem que `regras-auto-acao` grava no todo da 41 criado pela R1. */
export const ORIGEM_TEXTO_41_ACAREACAO = "agente-ocs-padrao-acareacao";

/** Marca no `meta` do todo: esta 41 é a da acareação pedida pela 49. */
export const MARCA_41_ACAREACAO = "acareacao_oc49";

/** Palavras de RESULTADO da acareação (texto já sem acento, maiúsculo). */
const RE_RESULTADO_ACAREACAO = /(REALIZAD|ASSIN|INSERIND|RESSALVA|ENTREGUE|RECEB)/;

function semAcentoMaiusculo(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
}

/** A 49 parece informar o RESULTADO da acareação (e não pedir)? */
export function pareceResultadoAcareacao(texto49: string | null | undefined): boolean {
  if (typeof texto49 !== "string" || texto49.trim() === "") return false;
  return RE_RESULTADO_ACAREACAO.test(semAcentoMaiusculo(texto49));
}

type Payload = Record<string, unknown> | null | undefined;

function objeto(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function codigoDoTodo(payload: Payload): number | null {
  const cod = objeto(objeto(payload)["args"])["codigo_ssw"];
  return typeof cod === "number" ? cod : null;
}

/**
 * Este todo é a 41 da acareação? Marca nova (`meta.acareacao_oc49`) OU a origem
 * que a R1 já gravava nos extras (todos criados antes desta mudança).
 */
export function ehTodo41Acareacao(payload: Payload): boolean {
  if (codigoDoTodo(payload) !== 41) return false;
  const p = objeto(payload);
  if (objeto(p["meta"])[MARCA_41_ACAREACAO] === true) return true;
  return objeto(objeto(p["args"])["extras"])["origem"] === ORIGEM_TEXTO_41_ACAREACAO;
}

/**
 * Texto que o agente semeia na 41 ao CRIAR o menu (`textoSsw41Override`).
 * Igual ao de antes, exceto: 49 de acareação com cara de resultado → sem texto.
 */
export function textoOverride41Acareacao(decisao: {
  proposta_destacada?: number | null;
  caso_oc49?: string | null;
  texto_ssw_sugerido?: string | null;
  motivo_extraido?: string | null;
}): string | null {
  if (decisao.proposta_destacada !== 41) return null;
  if (decisao.caso_oc49 === "acareacao" && pareceResultadoAcareacao(decisao.motivo_extraido)) {
    return null;
  }
  return decisao.texto_ssw_sugerido ?? null;
}

export interface Todo41 {
  id: string;
  status: string;
  proposta_payload: Payload;
}

export interface Marcacao41 {
  id: string;
  proposta_payload: Record<string, unknown>;
  /** true quando esta marcação também preencheu o texto pronto. */
  preencheu_texto: boolean;
}

/**
 * Marca a(s) 41 PENDENTE(S) do card como a 41 da acareação e, se a 49 for
 * pedido e a 41 ainda não tiver texto, preenche "Realizar acareação".
 * Nunca toca em todo aprovado/em execução, nunca troca texto existente.
 * Idempotente: a 41 já marcada (e já com texto, ou sem direito a texto) sai fora.
 */
export function planejarMarcacao41Acareacao(
  todos: readonly Todo41[],
  texto49: string | null | undefined,
): Marcacao41[] {
  const podeTexto = !pareceResultadoAcareacao(texto49);
  const saida: Marcacao41[] = [];
  for (const t of todos ?? []) {
    if (t?.status !== "pendente" || codigoDoTodo(t.proposta_payload) !== 41) continue;
    const pp = objeto(t.proposta_payload);
    const args = objeto(pp["args"]);
    const extras = objeto(args["extras"]);
    const meta = objeto(pp["meta"]);
    const textoAtual = typeof extras["texto_descricao"] === "string"
      ? (extras["texto_descricao"] as string).trim()
      : "";
    const jaMarcada = meta[MARCA_41_ACAREACAO] === true;
    const preencher = podeTexto && textoAtual === "";
    if (jaMarcada && !preencher) continue;

    const novoMeta: Record<string, unknown> = { ...meta, [MARCA_41_ACAREACAO]: true };
    const novoPayload: Record<string, unknown> = { ...pp, meta: novoMeta };
    if (preencher) {
      novoMeta["texto_ssw_sugerido"] = TEXTO_OC41_ACAREACAO;
      novoPayload["args"] = {
        ...args,
        extras: { ...extras, texto_descricao: TEXTO_OC41_ACAREACAO, origem: ORIGEM_TEXTO_41_ACAREACAO },
      };
    }

    saida.push({ id: t.id, proposta_payload: novoPayload, preencheu_texto: preencher });
  }
  return saida;
}
