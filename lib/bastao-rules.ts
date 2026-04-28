/**
 * Regras canônicas que conectam Bastão (fonte de verdade de pendências) ao
 * Cockpit (work queue do Relacionamento).
 *
 * Todas as constantes deste módulo refletem decisões registradas em
 * `docs/decisions/0004-cockpit-relacionamento-only.md`. Quando algo aqui
 * mudar, atualize o ADR junto.
 */

/**
 * Códigos de ocorrência que disparam sync periódico Bastão → Cockpit.
 *
 * Origem: planilha `Ocor_respon.xlsx` filtrada por categoria
 * "Relacionamento" + a oc 54 (categoria "Cliente" — aguardando retorno
 * cliente pagador, default da operação).
 *
 * Quando uma carga muda no Bastão pra `cod_ultima_ocorrencia` FORA deste
 * conjunto, o sync fecha o card no Cockpit (`DevolvidoParaOperacao`).
 */
export const OCORRENCIAS_DE_RELACIONAMENTO: ReadonlySet<number> = new Set([
  3,  // Avaria na coleta
  8,  // Avaria na transferência
  10, // Recusa total da entrega
  11, // Entrega impossibilitada: problemas com endereço
  17, // Avaria na entrega
  19, // Entrega realizada com falta de volumes
  20, // Extravio localizado
  23, // Problemas com documentação
  26, // Conjunto de comprovantes incompletos
  28, // Retenção de carga pela fiscalização pública
  35, // Entrega realizada com recusa parcial
  43, // Manutenção perecível realizada
  49, // Tratativa de relacionamento
  52, // Finalização do processo de destroca
  54, // Aguardando retorno cliente pagador (categoria Cliente — default)
  58, // Volume da destroca coletado
]);

/**
 * Filtro adicional aplicado APENAS na fase de teste: o sync só importa cards
 * onde `Bastão.pendencias.responsavel_relacionamento` bate com o nome aqui.
 *
 * Quando subir os 11 operadores, vira `null` e a filtragem passa a ser
 * implícita por `cards.assigned_operator_id` + RLS — cada operador vê só os
 * seus, gestor vê tudo.
 *
 * Case-sensitive. Bastão guarda em maiúsculo (ex.: "MARIA", "LARISSA").
 */
export const BASTAO_TEST_FILTER_OPERATOR: string | null = "LARISSA";

/**
 * Bastão atualiza upstream do SSW a cada 40min. Após executor lançar uma
 * ocorrência, esperamos até 90min (40 + 50 de folga) pra ver a oc esperada
 * aparecer em `cod_ultima_ocorrencia`. Se passar disso, marca a ação como
 * `falhou` e escala humano (`AcaoExecutadaSemConfirmacao`).
 */
export const VERIFICATION_TIMEOUT_MINUTES = 90;

/**
 * Cadência do pg_cron que chama `sync-bastao`. Mais rápido que isso é
 * desperdício (Bastão não atualiza tão frequente). Mais lento que isso
 * aumenta latência percebida pelo operador após aprovar uma ação.
 */
export const SYNC_INTERVAL_MINUTES = 5;

/**
 * Helper de checagem. Retorna true se a ocorrência cai dentro da fila do
 * Cockpit. Usado pelo sync (Pass A — discover) e pela lógica de release
 * (Pass B — sair do Cockpit quando muda pra fora).
 */
export function isOcorrenciaDeRelacionamento(codigo: number | null | undefined): boolean {
  if (codigo == null) return false;
  return OCORRENCIAS_DE_RELACIONAMENTO.has(codigo);
}
