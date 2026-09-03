// =============================================================================
// seguir-parcial-auto — decisão PURA da oc 55 automática (ADR 0025).
//
// Clientes que autorizam EM CADASTRO seguir parcial mesmo com avaria (oc 08) ou
// extravio parcial (oc 06). Para esses CNPJs o Cockpit lança a 55 sozinho, sem
// notificar e sem esperar o operador — o fluxo não trava perguntando algo cuja
// resposta já é conhecida.
//
// Este módulo NÃO faz I/O: recebe a whitelist já carregada e devolve a decisão
// com o MOTIVO. O motivo é o que alimenta o modo shadow (F7) — sem ele não dá
// pra auditar por que o robô deixou de agir.
//
// FAIL-CLOSED por construção: qualquer dúvida, qualquer campo faltando, qualquer
// cerca não avaliável → `aplica: false`. O caminho de hoje (operador decide)
// continua valendo. Nunca o contrário.
//
// A leitura da instrução é DELEGADA a `extrairQtdVolumes` (extravio-qtd-volumes),
// fonte única. Duplicar a regex aqui já foi a causa de bug no passado — os
// detectores de parcial que existem divergem entre si (ver D6 do ADR 0025).
// Esse módulo é puro de propósito: `extravio-enrichment` arrasta bastao-rules,
// que faz query em top-level await, e isso tornaria este arquivo não-testável.
// =============================================================================

import { extrairQtdVolumes } from "./extravio-qtd-volumes.ts";
import { removerMarcadoresSswmobile } from "./sanitizar-texto-ssw.ts";

/** Ocorrências que esta regra cobre. 09/16 (extravio) e 03/17 (avaria) ficam de
 *  FORA de propósito — o briefing do Caio (03/09) só cita 06 e 08. Ampliar é
 *  decisão dele, não inferência nossa. */
export const OCS_NO_ESCOPO: ReadonlySet<number> = new Set([6, 8]);

/** Texto que vai no campo Instrução do SSW no lançamento da 55.
 *  Sem acento e em caixa alta: o portal serve iso-8859-1 e o histórico do SSW
 *  é lido por gente da operação em telas de largura curta. */
export const TEXTO_SSW_55 = "AUTORIZACAO PERMANENTE EM CADASTRO - SEGUIR PARCIAL";

/** Uma linha de `cliente_config_seguir_parcial_auto` (mig 379). */
export interface ClienteSeguirParcial {
  cnpj_pagador: string;
  ativo: boolean;
  aplica_oc06: boolean;
  aplica_oc08: boolean;
}

export type MotivoNaoAplica =
  | "flag_off"
  | "oc_fora_do_escopo"
  | "cnpj_ausente"
  | "cnpj_fora_da_whitelist"
  | "cliente_inativo"
  | "oc_desligada_para_o_cliente"
  | "sinal_de_extravio_total"
  | "volumes_da_nf_desconhecidos";

export type DecisaoSeguirParcial =
  | { aplica: true; oc: number; cnpj: string; texto_ssw: string }
  | { aplica: false; motivo: MotivoNaoAplica };

/** Só dígitos, exatamente 14. Qualquer outra coisa → null (fail-closed). */
export function normalizarCnpj(v: string | null | undefined): string | null {
  if (v == null) return null;
  const d = String(v).replace(/\D/g, "");
  return d.length === 14 ? d : null;
}

/**
 * Lê a quantidade da instrução aplicando a limpeza FORTE antes do parser.
 *
 * Caio/Carlos 2026-09-03 — furo achado auditando a 3a cópia do parser. Existem
 * DOIS níveis de limpeza no repo e eles não são equivalentes:
 *
 *   - `limparInstrucao` (dentro de extravio-qtd-volumes): tira só (SSWMOBILE),
 *     GPS(...) e GPS.
 *   - `removerMarcadoresSswmobile`: chama `sanitizarTextoSsw` (que remove
 *     COMENTÁRIOS e TAGS HTML — caso de produção NF 1494821, o portal devolve
 *     `<!--...--><a href=# onclick=showMapaVeic(...)><u>GPS</u></a>`) e ainda
 *     limpa `Protocolo: N`, `SEFAZ-XX`, `cte.fazenda.gov.br` e o sufixo
 *     "comprovante registrado no ...".
 *
 * `agente-sugere-ocs-padrao` já usa o forte. Nós usávamos o fraco — e isso é
 * seguro em `analisarExtravio` (lá `qtd` nulo vira TOTAL, conservador) mas
 * PERIGOSO aqui, porque o D3 inverte o default: nulo vira parcial e lança 55.
 *
 * Caso concreto que o fraco erra: instrução `9 <!--x--><u>GPS</u>` numa NF de
 * 9 volumes. Forte lê 9 → 9>=9 → TOTAL → barrado. Fraco devolve null → ilegível
 * → parcial → lançaria 55 mandando entregar carga que não existe mais. É
 * exatamente o modo de falha que o D2/INV-141 existe pra impedir.
 *
 * Limpar mais forte NÃO afeta os casos legítimos do D3 (`1 V`, `F1 (SSWMOBILE)`,
 * `1 PROVAVELMENTE ERRO NO CARREGAMENTO OS 2 ESTAVA AQUI NA SEXTA`): esses
 * continuam ilegíveis depois da limpeza, e seguem parciais. A cerca só fecha
 * onde havia um número real escondido atrás de ruído removível.
 *
 * Não mexemos em `limparInstrucao`: ele é usado por `analisarExtravio`, que roda
 * pra TODOS os clientes. Mudar lá trocaria o comportamento de quem está fora da
 * whitelist — proibido pelo ADR 0025.
 */
export function lerQtdDaInstrucao(
  instrucao: string | null | undefined,
): { total: true } | { qtd: number } | null {
  return extrairQtdVolumes(removerMarcadoresSswmobile(instrucao ?? null));
}

/**
 * D2 do ADR 0025 — há sinal de EXTRAVIO TOTAL na ocorrência?
 *
 * O briefing diz "se não conter extravio total na mensagem, é parcial". Ao pé da
 * letra isso erra 17% dos casos reais (medição F0, 2026-09-03): a unidade escreve
 * SÓ O NÚMERO de volumes faltantes, sem a palavra TOTAL. Quando esse número é
 * igual ao total de volumes da NF, o extravio é total — escrito como número.
 * Caso âncora: NF 29642, instrução "9", NF de 9 volumes. Sob a regra literal
 * receberia uma 55 mandando entregar carga que não existe mais.
 *
 * Então há sinal de total quando QUALQUER uma for verdadeira:
 *   (1) a instrução casa a palavra TOTAL (EXTRAVIO/PERDA/FALTA TOTAL);
 *   (2) a quantidade lida >= a quantidade de volumes da NF.
 *
 * Casos não avaliáveis (D2b, decisão de engenharia registrada no ADR):
 *   - instrução ILEGÍVEL (não dá pra ler número nenhum) → NÃO é sinal de total.
 *     É o D3: dentro da whitelist, ausência de informação legível = parcial.
 *     Não há número que possa igualar o total, então (2) é vacuamente falsa.
 *     Casos reais: "1 V" (NF de 6 vol), "F1", "1 PROVAVELMENTE ERRO NO
 *     CARREGAMENTO OS 2 ESTAVA AQUI NA SEXTA" (NF de 2 vol) — parciais de verdade.
 *   - quantidade LEGÍVEL mas volumes da NF desconhecidos → NÃO decide aqui;
 *     `decidirSeguirParcialAuto` corta com motivo `volumes_da_nf_desconhecidos`.
 *     Diferente do anterior: existe um número que PODE ser o total, e lançar 55
 *     no escuro é irreversível.
 */
export function temSinalDeExtravioTotal(
  instrucao: string | null | undefined,
  qtdVolumesNf: number | null | undefined,
): boolean {
  const lido = lerQtdDaInstrucao(instrucao);
  if (lido != null && "total" in lido) return true;
  if (lido != null && "qtd" in lido && qtdVolumesNf != null && qtdVolumesNf > 0) {
    return lido.qtd >= qtdVolumesNf;
  }
  return false;
}

/** A quantidade é legível mas não dá pra comparar com o total da NF? */
function quantidadeSemReferencia(
  instrucao: string | null | undefined,
  qtdVolumesNf: number | null | undefined,
): boolean {
  const lido = lerQtdDaInstrucao(instrucao);
  if (lido == null || "total" in lido) return false;
  return qtdVolumesNf == null || qtdVolumesNf <= 0;
}

/** Acha o cliente na whitelist testando os CNPJs candidatos na ordem dada
 *  (pagador primeiro, remetente como fallback — ver premissas do ADR 0025). */
export function acharClienteNaWhitelist(
  whitelist: ReadonlyMap<string, ClienteSeguirParcial>,
  cnpjsCandidatos: ReadonlyArray<string | null | undefined>,
): { cliente: ClienteSeguirParcial; cnpj: string } | { cliente: null; motivo: MotivoNaoAplica } {
  let viuAlgumCnpj = false;
  let viuInativo = false;
  for (const bruto of cnpjsCandidatos) {
    const cnpj = normalizarCnpj(bruto);
    if (cnpj == null) continue;
    viuAlgumCnpj = true;
    const cliente = whitelist.get(cnpj);
    if (cliente == null) continue;
    if (!cliente.ativo) {
      viuInativo = true;
      continue;
    }
    return { cliente, cnpj };
  }
  if (!viuAlgumCnpj) return { cliente: null, motivo: "cnpj_ausente" };
  if (viuInativo) return { cliente: null, motivo: "cliente_inativo" };
  return { cliente: null, motivo: "cnpj_fora_da_whitelist" };
}

export interface EntradaSeguirParcial {
  /** feature_flags.seguir_parcial_auto_enabled */
  flagOn: boolean;
  /** oc atual do card (Bastão/SSW). */
  oc: number | null | undefined;
  /** CNPJ pagador do card. */
  cnpjPagador: string | null | undefined;
  /** CNPJ remetente — fallback quando o pagador não resolve. */
  cnpjRemetente?: string | null | undefined;
  /** Instrução que acompanha a ocorrência (só usada na oc 06). */
  instrucao?: string | null | undefined;
  /** Quantidade de volumes da NF (só usada na oc 06). */
  qtdVolumesNf?: number | null | undefined;
  /** Whitelist carregada de cliente_config_seguir_parcial_auto. */
  whitelist: ReadonlyMap<string, ClienteSeguirParcial>;
}

/**
 * A decisão. Ordem das cercas é deliberada — da mais barata e mais global para a
 * mais específica — e o PRIMEIRO motivo reprovado é o que sai, para o shadow
 * contar por motivo (o que mais barra vira pauta).
 */
export function decidirSeguirParcialAuto(e: EntradaSeguirParcial): DecisaoSeguirParcial {
  const nao = (motivo: MotivoNaoAplica): DecisaoSeguirParcial => ({ aplica: false, motivo });

  if (!e.flagOn) return nao("flag_off");
  if (e.oc == null || !OCS_NO_ESCOPO.has(e.oc)) return nao("oc_fora_do_escopo");

  const achado = acharClienteNaWhitelist(e.whitelist, [e.cnpjPagador, e.cnpjRemetente]);
  if (achado.cliente == null) return nao(achado.motivo);
  const { cliente, cnpj } = achado;

  if (e.oc === 6 && !cliente.aplica_oc06) return nao("oc_desligada_para_o_cliente");
  if (e.oc === 8 && !cliente.aplica_oc08) return nao("oc_desligada_para_o_cliente");

  // oc 08 (avaria) não tem condição extra: o briefing é explícito — toda 08 da
  // unidade segue para análise do cliente no destino, então lança 55 e entrega.
  if (e.oc === 8) {
    return { aplica: true, oc: 8, cnpj, texto_ssw: TEXTO_SSW_55 };
  }

  // oc 06: só parcial. Extravio total mantém o fluxo atual (49) — inegociável.
  if (temSinalDeExtravioTotal(e.instrucao, e.qtdVolumesNf)) {
    return nao("sinal_de_extravio_total");
  }
  if (quantidadeSemReferencia(e.instrucao, e.qtdVolumesNf)) {
    return nao("volumes_da_nf_desconhecidos");
  }
  return { aplica: true, oc: 6, cnpj, texto_ssw: TEXTO_SSW_55 };
}
