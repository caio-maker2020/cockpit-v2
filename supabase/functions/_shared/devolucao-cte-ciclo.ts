// =============================================================================
// devolucao-cte-ciclo.ts — o "tick" do ciclo de devolução: cobrar o cliente,
// escalonar pra MARIA, e vigiar ciclo parado.
//
// POR QUE O VIGIA EXISTE (e não é enfeite): a oc 56 (pedido de NFD pra unidade)
// **não está** em `OCORRENCIAS_DE_RELACIONAMENTO`, então
// `stateFinalAposBastao(56) = TRANSFERIDO` e o card SAI do painel da MARIA. A
// espera dura semanas — a própria thread da AGV diz *"há mais de um mês"*. A
// decisão nº 15 foi segurar o caso por controle próprio (`devolucoes_cte`), mas
// controle próprio SEM vigia só troca "card invisível" por "linha invisível":
// o problema volta com outra roupa. O vigia é o que fecha isso.
//
// POR QUE A COBRANÇA NASCE AQUI e não religando o cron antigo (decisão nº 12):
// `cobranca-cliente-aguardando-daily` está `active = false` em produção
// (medido). Religar faria a 1ª execução varrer TODO o backlog acumulado de
// cards em AGUARDANDO_CLIENTE e disparar e-mail EXTERNO em volume, sobre casos
// antigos — irreversível. Cron dormente não é neutro. Este nasce com população
// zero e dirigido por `devolucoes_cte.status`, nunca por `cards.state` (imune ao
// INV-019, que tirava o card de AGUARDANDO_CLIENTE e desligava a cobrança pra
// sempre).
//
// Cadência do Caio (2026-09-01): UM lembrete 2 dias úteis após a primeira
// notificação; passados outros 2 dias úteis sem retorno, PARA de cobrar e avisa
// a MARIA. Dias ÚTEIS via `ehDiaUtil` (reusado — seg-sex E não-feriado, tabela
// `feriados`), não uma conta nova.
// =============================================================================
import { chaveDataBRT, ehDiaUtil } from "./minutos-uteis.ts";

/** Teto de dias varridos ao contar — trava anti-runaway, não regra de negócio. */
const MAX_DIAS_VARREDURA = 400;

/**
 * Dias ÚTEIS COMPLETOS decorridos de `de` até `ate`.
 *
 * Conta o número de dias úteis DEPOIS do dia de `de`, até e incluindo o dia de
 * `ate`. Ou seja: marco na terça ⇒ quarta = 1, quinta = 2. Mesmo dia = 0.
 *
 * Reusa `ehDiaUtil` (seg-sex E não-feriado) em vez de reimplementar — a
 * definição de dia útil do projeto vive lá, com a tabela de feriados.
 */
export function diasUteisDecorridos(
  de: Date,
  ate: Date,
  feriados: ReadonlySet<string>,
): number {
  if (!(de instanceof Date) || !(ate instanceof Date)) return 0;
  if (isNaN(de.getTime()) || isNaN(ate.getTime())) return 0;
  if (ate.getTime() <= de.getTime()) return 0;

  const chaveDe = chaveDataBRT(de);
  const chaveAte = chaveDataBRT(ate);
  if (chaveDe === chaveAte) return 0;

  let contador = 0;
  const cursor = new Date(de.getTime());
  for (let i = 0; i < MAX_DIAS_VARREDURA; i++) {
    cursor.setTime(cursor.getTime() + 24 * 60 * 60 * 1000);
    const chave = chaveDataBRT(cursor);
    if (ehDiaUtil(cursor, feriados)) contador++;
    if (chave === chaveAte || cursor.getTime() > ate.getTime()) break;
  }
  return contador;
}

export type AcaoTick =
  /** Nada a fazer neste ciclo agora. */
  | "nada"
  /** Manda o lembrete ao cliente pedindo o CT-e. */
  | "cobrar"
  /** Para de cobrar e avisa a MARIA (teto atingido, sem retorno). */
  | "escalonar"
  /** Ciclo aberto e parado — avisa a MARIA pra não ficar invisível. */
  | "alertar_parado";

export interface CicloTick {
  id: string;
  status: string;
  aguardando_cte_desde: string | null;
  cobrancas_feitas: number | null;
  ultima_cobranca_em: string | null;
  escalonado_para_humano_em: string | null;
  alerta_parado_em: string | null;
  updated_at: string | null;
  encerrado_em: string | null;
}

export interface ConfigTick {
  lembrete_dias_uteis: number;
  lembretes_teto: number;
  escalonar_dias_uteis: number;
  vigia_dias_uteis: number;
}

export interface DecisaoTick {
  acao: AcaoTick;
  motivo: string;
  /** Dias úteis que sustentaram a decisão — vai pro card_event. */
  diasUteis: number;
}

const STATUS_AGUARDANDO_CTE = "aguardando_cte";

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * O que fazer com UM ciclo, agora.
 *
 * Ordem das checagens é regra, não estilo:
 *  1. ciclo encerrado ⇒ nada (nunca cobrar caso resolvido);
 *  2. já escalonado ⇒ nada (o humano assumiu; insistir é spam);
 *  3. esperando o CT-e ⇒ cobrança/escalonamento pela cadência;
 *  4. qualquer outro status aberto ⇒ vigia de parado.
 */
export function decidirTickCiclo(params: {
  ciclo: CicloTick;
  config: ConfigTick;
  agora: Date;
  feriados: ReadonlySet<string>;
}): DecisaoTick {
  const { ciclo, config, agora, feriados } = params;
  const nada = (motivo: string, dias = 0): DecisaoTick => ({ acao: "nada", motivo, diasUteis: dias });

  if (ciclo.encerrado_em) return nada("ciclo_encerrado");
  // Já entregue ao humano: não cobra mais, não alerta mais. Quem reabre é gente.
  if (ciclo.escalonado_para_humano_em) return nada("ja_escalonado_para_humano");

  // ── Esperando o CT-e do cliente: cadência de cobrança ────────────────────
  if (ciclo.status === STATUS_AGUARDANDO_CTE) {
    // O relógio conta do ÚLTIMO contato: se já cobramos, do lembrete; senão, da
    // primeira notificação. Sem marco não se cobra — cobrar sem saber desde
    // quando é chutar na cara do cliente.
    const marco = parse(ciclo.ultima_cobranca_em) ?? parse(ciclo.aguardando_cte_desde);
    if (!marco) return nada("sem_marco_de_espera");

    const dias = diasUteisDecorridos(marco, agora, feriados);
    const feitas = ciclo.cobrancas_feitas ?? 0;

    if (feitas >= config.lembretes_teto) {
      // Teto atingido. Espera o prazo do escalonamento e entrega pra MARIA.
      if (dias >= config.escalonar_dias_uteis) {
        return { acao: "escalonar", motivo: "teto_de_lembretes_sem_retorno", diasUteis: dias };
      }
      return nada("aguardando_prazo_de_escalonamento", dias);
    }

    if (dias >= config.lembrete_dias_uteis) {
      return { acao: "cobrar", motivo: "prazo_do_lembrete_vencido", diasUteis: dias };
    }
    return nada("aguardando_prazo_do_lembrete", dias);
  }

  // ── Qualquer outro status ABERTO: vigia de ciclo parado ──────────────────
  // Marco = último alerta (pra não repetir todo dia) ou o último movimento.
  const marcoVigia = parse(ciclo.alerta_parado_em) ?? parse(ciclo.updated_at);
  if (!marcoVigia) return nada("sem_marco_de_movimento");
  const diasParado = diasUteisDecorridos(marcoVigia, agora, feriados);
  if (diasParado >= config.vigia_dias_uteis) {
    return { acao: "alertar_parado", motivo: `parado_em_${ciclo.status}`, diasUteis: diasParado };
  }
  return nada("com_movimento_recente", diasParado);
}

/**
 * Texto do lembrete ao cliente. Curto de propósito: é um lembrete, não uma nova
 * tratativa. O assunto casa com o que a operadora já usa à mão.
 */
export function montarLembreteCte(d: { nf: string; ctrc: string }): {
  subject: string;
  texto: string;
} {
  return {
    subject: `Devolução - NF ${d.nf} - aguardando CT-e`,
    texto: [
      "Boa tarde,",
      "",
      `Seguimos no aguardo do CT-e de devolução referente à NF ${d.nf} (CTRC ${d.ctrc}) para`,
      "darmos andamento ao retorno da mercadoria.",
      "",
      "Assim que o documento for enviado, seguimos com o processo.",
      "",
      "Obrigado!",
    ].join("\n"),
  };
}
