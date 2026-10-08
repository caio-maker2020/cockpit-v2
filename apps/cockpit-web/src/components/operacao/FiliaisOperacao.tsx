// Escolha de FILIAL (unidade do SSW: VIT, MTC, MTZ…). O seletor fica na barra da Operação
// (BarraOperacao); a escolha é lembrada no navegador (usePersistentState, com try/catch).
// Operador de filial começa nas filiais dele; supervisão e gestão começam em "Todas".

export const FILIAL_PADRAO = "__padrao";
export const FILIAL_MINHAS = "__minhas";
/** null = todas; FILIAL_MINHAS = as do cadastro; FILIAL_PADRAO = ainda não escolheu; senão a sigla. */
export type EscolhaFilial = string | null;
