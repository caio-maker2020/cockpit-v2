// =============================================================================
// CARGA PARADA e PRÉ-ENTREGA — regras do Pendências, calculadas só da fila.
//
// Fonte: tatiana-kelly/pendency-tracker @a884368.
//   - "Exportar carga parada (1+ dia)": src/pages/Gestao.tsx:795-991.
//   - "Pré-entrega: obrigatórias × podem esperar": src/components/gestao/GestaoEntregasPanel.tsx:96-122.
// Tudo puro: recebe as linhas da fila (OpFilaLinha) e o relógio; não grava, não chama rede.
//
// Vale o que o CÓDIGO do Pendências executa, não o texto de ajuda (ADR 0042, D-5):
// pré-entrega e "resolver rápido" com 1+ dia útil (a ajuda diz 2+).
//
// DIVERGÊNCIAS em relação ao Pendências (campos que a fila não tem ou tem diferente):
//   1. Base: lá é `baseDestino` (coluna gerada; para devolução/reversa, a base operacional
//      atual). Aqui é a base da SIGLA da unidade da fila (unidadesPendencias.ts), que segue
//      a regra de unidade do ADR 0041. Sigla sem base no seed sai com a própria sigla.
//   2. Tipo de documento: lá `tipoDocumento`; aqui `tipo_cte` (mesmo valor do Bastão:
//      NORMAL, DEVOLUCAO, REVERSA, REDESPACHO…). Nota com `tipo_cte` vazio NÃO entra (lá
//      também não: "" ≠ "normal"), mas é contada como dúvida ("sem tipo"), não some.
//   3. Status: lá o grupo sai do NOME do status da oc (tabela de status, StatusContext). Aqui
//      sai de listas fixas de oc (regua.ts: OCS_PRE_ENTREGA; 56 = informação faltante).
//      Se a tabela de status lá mudar, aqui não acompanha.
//   4. Coluna "Cliente Remetente": a fila não traz o remetente; sai o pagador.
//   5. Planilha: lá é XLSX com uma aba por base; aqui é UM CSV com a coluna Base,
//      ordenado por base (mesma ordem de linhas dentro da base).
//   6. Previsão vazia: lá vira atraso 0 e a nota some em silêncio; aqui também não entra,
//      mas é contada como dúvida ("sem previsão").
// =============================================================================
import { nomeDoSetor, setorDoItem } from "./setores";
import {
  OCS_PRE_ENTREGA,
  atrasoPrevisaoDias,
  baseDaUnidade,
  diaSP,
  diasUteisDesde,
  proximoDiaUtil,
  regionalDaUnidade,
} from "./regua";
import { SEM_REGIONAL } from "./regionais";
import type { OpFilaLinha } from "./tipos";

// --------------------------------------------------------------------------- grupos e mínimos

/** Devolução/reversa: entra se a última oc é a 02, sem mínimo de dias (Gestao.tsx:815-830). */
export const OC_DEVOLUCAO_REVERSA = 2;
/** Destroca: forçada no grupo "Informação faltante" (Gestao.tsx:844-848). */
export const OCS_DESTROCA: readonly number[] = [51, 52, 58];
/** Status "Informação faltante" pelo nome (Gestao.tsx:810); na tabela de status, a 56. */
export const OCS_INFO_FALTANTE: readonly number[] = [56];
export const OC_REDESPACHO_FINAL = 40;

/**
 * DÚVIDA PARA O DONO (D-5): mínimo de dias úteis da pré-entrega e do "resolver rápido".
 *   - CÓDIGO: 1 dia útil (Gestao.tsx:809-811 e 845-848; toast em :977 diz "1+");
 *   - AJUDA: 2 dias úteis (GestaoHelpPanel.tsx:144-145).
 * Usamos o código (1). Redespacho final (40) é 3 nos dois lugares (Gestao.tsx:838-843).
 */
export const MIN_DIAS_REGRA_CODIGO = 1;
export const MIN_DIAS_REGRA_AJUDA = 2;
export const MIN_DIAS_REDESPACHO_FINAL = 3;

export type GrupoCargaParada =
  | "Pré-entrega"
  | "Informação faltante - resolver rápido"
  | "Redespacho final"
  | "Devolução/reversa";

export const GRUPOS_CARGA_PARADA: readonly GrupoCargaParada[] = [
  "Pré-entrega",
  "Informação faltante - resolver rápido",
  "Redespacho final",
  "Devolução/reversa",
];

/** Por que a nota NÃO entrou (para contar dúvida, nunca para esconder). */
export type MotivoFora =
  | "sem-tipo" // tipo_cte vazio: não dá para saber se é NORMAL ou devolução
  | "dev-rev-sem-oc2" // devolução/reversa cuja última oc não é a 02
  | "tipo-fora" // REDESPACHO, SUBC… (só NORMAL e devolução/reversa entram)
  | "sem-previsao" // NORMAL no grupo, dias ok, sem previsão de entrega
  | "no-prazo" // NORMAL com previsão ainda não vencida
  | "fora-do-grupo" // oc fora de pré-entrega, info faltante, destroca e 40
  | "poucos-dias"; // no grupo, mas abaixo do mínimo de dias úteis

export interface RegraCargaParada {
  grupo: GrupoCargaParada | null;
  minDias: number;
  /** Dias úteis desde a última ocorrência (0 sem data, como lá). */
  dias: number;
  /** Atraso na previsão (dias corridos). */
  atraso: number;
  entra: boolean;
  motivo: MotivoFora | null;
}

const normTipo = (t: string | null | undefined) =>
  (t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();

export function ehDevolucaoOuReversa(tipo: string | null | undefined): boolean {
  const t = normTipo(tipo);
  return t.includes("DEVOLU") || t.includes("REVERS");
}

/** Grupo e mínimo de uma nota NORMAL pela oc (ordem do if/else de Gestao.tsx:838-856). */
export function grupoDaOc(cod: number | null | undefined): { grupo: GrupoCargaParada; minDias: number } | null {
  if (cod == null) return null;
  if (cod === OC_REDESPACHO_FINAL) return { grupo: "Redespacho final", minDias: MIN_DIAS_REDESPACHO_FINAL };
  if (OCS_DESTROCA.includes(cod) || OCS_INFO_FALTANTE.includes(cod)) return { grupo: "Informação faltante - resolver rápido", minDias: MIN_DIAS_REGRA_CODIGO };
  if (OCS_PRE_ENTREGA.includes(cod)) return { grupo: "Pré-entrega", minDias: MIN_DIAS_REGRA_CODIGO };
  return null;
}

/**
 * A regra do botão "Exportar carga parada (1+ dia)" (Gestao.tsx:815-856):
 *   1. devolução/reversa: entra só se a última oc é a 02, sem mínimo de dias e sem olhar a previsão;
 *   2. senão, só tipo NORMAL e só com a previsão de entrega vencida;
 *   3. 40 com 3+ dias úteis; 51/52/58 e 56 com 1+ ("Informação faltante - resolver rápido");
 *      pré-entrega com 1+. Qualquer outra oc fica fora.
 */
export function regraCargaParada(
  l: Pick<OpFilaLinha, "cod_ultima_ocorrencia" | "data_ultima_ocorrencia" | "previsao_entrega" | "tipo_cte">,
  agoraMs: number,
): RegraCargaParada {
  const dias = diasUteisDesde(l.data_ultima_ocorrencia, agoraMs);
  const atraso = atrasoPrevisaoDias(l.previsao_entrega, agoraMs);
  const fora = (motivo: MotivoFora, grupo: GrupoCargaParada | null = null, minDias = 0): RegraCargaParada => ({
    grupo,
    minDias,
    dias,
    atraso,
    entra: false,
    motivo,
  });

  if (!normTipo(l.tipo_cte)) return fora("sem-tipo");
  if (ehDevolucaoOuReversa(l.tipo_cte)) {
    if (l.cod_ultima_ocorrencia !== OC_DEVOLUCAO_REVERSA) return fora("dev-rev-sem-oc2");
    return { grupo: "Devolução/reversa", minDias: 0, dias, atraso, entra: true, motivo: null };
  }
  if (normTipo(l.tipo_cte) !== "NORMAL") return fora("tipo-fora");

  const g = grupoDaOc(l.cod_ultima_ocorrencia);
  if (!g) return fora("fora-do-grupo");
  // A ordem lá é: previsão primeiro (:834), dias depois. Aqui a previsão vazia vira dúvida
  // só quando os dias já bastariam, para a contagem de "sem previsão" ser útil.
  if (dias < g.minDias) return fora("poucos-dias", g.grupo, g.minDias);
  if (diaSP(l.previsao_entrega) == null) return fora("sem-previsao", g.grupo, g.minDias);
  if (atraso <= 0) return fora("no-prazo", g.grupo, g.minDias);
  return { grupo: g.grupo, minDias: g.minDias, dias, atraso, entra: true, motivo: null };
}

/** Ordem do status dentro da base (statusOrder, Gestao.tsx:875-882); devolução/reversa cai no 99 lá. */
export function ordemDoGrupo(g: GrupoCargaParada | null): number {
  if (g === "Pré-entrega") return 0;
  if (g === "Informação faltante - resolver rápido") return 2;
  if (g === "Redespacho final") return 3;
  return 99;
}

/** Base da nota para a planilha: base da sigla; sem seed, a própria sigla; sem unidade, "SEM BASE". */
export function baseDaNota(unidade: string | null | undefined): string {
  const sigla = unidade?.trim().toUpperCase() || null;
  if (!sigla) return "SEM BASE";
  return baseDaUnidade(sigla)?.base ?? sigla;
}

// --------------------------------------------------------------------------- resumo e CSV

export interface ResumoCargaParada {
  entram: number;
  bases: number;
  porGrupo: Record<GrupoCargaParada, number>;
  /** Dúvidas que não entram mas não podem sumir. */
  semTipo: number;
  semPrevisao: number;
}

interface Selecionada {
  l: OpFilaLinha;
  r: RegraCargaParada;
  base: string;
}

function selecionar(linhas: readonly OpFilaLinha[], agoraMs: number): { sel: Selecionada[]; semTipo: number; semPrevisao: number } {
  const sel: Selecionada[] = [];
  let semTipo = 0;
  let semPrevisao = 0;
  for (const l of linhas) {
    const r = regraCargaParada(l, agoraMs);
    if (r.entra) sel.push({ l, r, base: baseDaNota(l.unidade) });
    else if (r.motivo === "sem-tipo") semTipo++;
    else if (r.motivo === "sem-previsao") semPrevisao++;
  }
  // Bases em ordem alfabética (Gestao.tsx:865); dentro da base, status e depois a oc mais recente (:883-889).
  sel.sort(
    (a, b) =>
      a.base.localeCompare(b.base, "pt-BR") ||
      ordemDoGrupo(a.r.grupo) - ordemDoGrupo(b.r.grupo) ||
      (Date.parse(b.l.data_ultima_ocorrencia ?? "") || 0) - (Date.parse(a.l.data_ultima_ocorrencia ?? "") || 0) ||
      a.l.ctrc.localeCompare(b.l.ctrc),
  );
  return { sel, semTipo, semPrevisao };
}

export function resumirCargaParada(linhas: readonly OpFilaLinha[], agoraMs: number): ResumoCargaParada {
  const { sel, semTipo, semPrevisao } = selecionar(linhas, agoraMs);
  const porGrupo = Object.fromEntries(GRUPOS_CARGA_PARADA.map((g) => [g, 0])) as Record<GrupoCargaParada, number>;
  for (const s of sel) porGrupo[s.r.grupo!]++;
  return { entram: sel.length, bases: new Set(sel.map((s) => s.base)).size, porGrupo, semTipo, semPrevisao };
}

/** Campo CSV com ; (Excel pt-BR), aspas quando precisa. */
export function campoCsv(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Colunas da planilha do Pendências (Gestao.tsx:890-905), com Base primeiro e a Filial (sigla) a mais. */
export const COLUNAS_CARGA_PARADA = [
  "Base",
  "Gerente regional",
  "Filial",
  "CTRC",
  "NF",
  "Tipo documento",
  "Cidade destino",
  "Cliente (pagador)",
  "Destinatário",
  "Setor",
  "Status",
  "Ocorrência",
  "Qtd. volumes",
  "Dias desde a última ocorrência (úteis)",
  "Dias de atraso (previsão, corridos)",
] as const;

/** Texto do CSV; quem chama só baixa no navegador. */
export function linhasCargaParadaCsv(linhas: readonly OpFilaLinha[], agoraMs: number): string {
  const { sel } = selecionar(linhas, agoraMs);
  const out = [COLUNAS_CARGA_PARADA.join(";")];
  for (const { l, r, base } of sel) {
    const sigla = l.unidade?.trim().toUpperCase() || "";
    const cidade = l.cidade_destino ? `${l.cidade_destino}${l.uf_destino ? `/${l.uf_destino}` : ""}` : "";
    // Lá: `${cod} - ${instrucaoUltimaOcorrencia}` (Gestao.tsx:897-899); sem instrução, a descrição da oc.
    const texto = l.instrucao_ultima_ocorrencia || l.descricao_oc;
    const oc = l.cod_ultima_ocorrencia != null ? `${l.cod_ultima_ocorrencia}${texto ? ` - ${texto}` : ""}` : "";
    out.push(
      [
        base,
        regionalDaUnidade(sigla || null) ?? SEM_REGIONAL,
        sigla,
        l.ctrc,
        l.nf,
        l.tipo_cte,
        cidade,
        l.pagador,
        l.destinatario,
        nomeDoSetor(setorDoItem(l)),
        r.grupo,
        oc,
        l.qtd_volumes ?? 0,
        r.dias,
        r.atraso,
      ]
        .map(campoCsv)
        .join(";"),
    );
  }
  return out.join("\r\n");
}

// --------------------------------------------------------------------------- pré-entrega: obrigatórias × podem esperar

export interface Balde {
  notas: number;
  volumes: number;
}

export interface PreEntregaBase {
  base: string;
  /** Previsão até o próximo dia útil (inclui as atrasadas). */
  obrigatorias: Balde;
  /** Previsão antes de hoje (dentro das obrigatórias). */
  atrasadas: Balde;
  /** Previsão depois do próximo dia útil. */
  podemEsperar: Balde;
  semPrevisao: Balde;
  /** Notas da base, as mais urgentes primeiro (previsão mais antiga). */
  itens: string[];
}

export interface ResumoPreEntrega extends Omit<PreEntregaBase, "base" | "itens"> {
  total: number;
  /** 'YYYY-MM-DD' do próximo dia útil usado no corte. */
  proximoDiaUtil: string;
  porBase: PreEntregaBase[];
}

const vazio = (): Balde => ({ notas: 0, volumes: 0 });
const somar = (b: Balde, v: number) => {
  b.notas++;
  b.volumes += v;
};

/**
 * "Pré-entrega obrigatórias" (GestaoEntregasPanel.tsx:59-122): notas em pré-entrega,
 * fora devolução e reversa. Obrigatórias = previsão até o PRÓXIMO DIA ÚTIL; atrasadas =
 * previsão antes de hoje (são parte das obrigatórias); podem esperar = depois disso.
 *
 * CORREÇÃO do Pendências: lá o corte é "amanhã" em dia CORRIDO (:52-56, d.setDate(+1)).
 * Na sexta, uma nota com previsão para segunda "podia esperar", e segunda já vencia.
 * Aqui o corte é o próximo dia útil (sem sábado, domingo e feriado nacional).
 * Nota sem tipo_cte entra (não dá para dizer que é devolução; lá também entraria).
 */
export function resumirPreEntrega(linhas: readonly OpFilaLinha[], agoraMs: number): ResumoPreEntrega {
  const hoje = diaSP(agoraMs)!;
  const limite = proximoDiaUtil(hoje);
  const total = { obrigatorias: vazio(), atrasadas: vazio(), podemEsperar: vazio(), semPrevisao: vazio() };
  const porBase = new Map<string, PreEntregaBase & { _ord: { id: string; d: number }[] }>();
  let n = 0;
  for (const l of linhas) {
    if (l.cod_ultima_ocorrencia == null || !OCS_PRE_ENTREGA.includes(l.cod_ultima_ocorrencia)) continue;
    if (ehDevolucaoOuReversa(l.tipo_cte)) continue;
    n++;
    const base = baseDaNota(l.unidade);
    let b = porBase.get(base);
    if (!b) porBase.set(base, (b = { base, obrigatorias: vazio(), atrasadas: vazio(), podemEsperar: vazio(), semPrevisao: vazio(), itens: [], _ord: [] }));
    const v = l.qtd_volumes ?? 0;
    const d = diaSP(l.previsao_entrega);
    b._ord.push({ id: l.op_item_id, d: d ?? Number.POSITIVE_INFINITY });
    if (d == null) {
      somar(total.semPrevisao, v);
      somar(b.semPrevisao, v);
    } else if (d <= limite) {
      somar(total.obrigatorias, v);
      somar(b.obrigatorias, v);
      if (d < hoje) {
        somar(total.atrasadas, v);
        somar(b.atrasadas, v);
      }
    } else {
      somar(total.podemEsperar, v);
      somar(b.podemEsperar, v);
    }
  }
  const bases = [...porBase.values()]
    .map(({ _ord, ...b }) => ({ ...b, itens: _ord.sort((x, y) => x.d - y.d).map((x) => x.id) }))
    .sort((a, b) => b.obrigatorias.notas - a.obrigatorias.notas || b.atrasadas.notas - a.atrasadas.notas || a.base.localeCompare(b.base, "pt-BR"));
  return { total: n, ...total, proximoDiaUtil: new Date(limite * 86_400_000).toISOString().slice(0, 10), porBase: bases };
}
