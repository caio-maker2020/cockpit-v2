// =============================================================================
// minutos-uteis — soma MINUTOS ÚTEIS a um instante (janela de veto, Caio 25/08).
//
// Expediente: 08:00–17:30 BRT, seg–sex, MENOS feriados (tabela `feriados`).
// BRT fixo -03:00 (convenção do projeto — sem DST; mesma regra do
// horario-comercial.ts). Fora do expediente o relógio NÃO anda. Corte das
// 17h (Caio 26/08): sugestão nascida às 17h00+ não fraciona o fim do dia —
// a janela inteira conta no dia útil seguinte (sexta 17:10 → segunda 09:00);
// nascida antes das 17h usa o resto do dia até 17:30 e completa no seguinte
// (16:59 → 31min hoje + 29min amanhã = 08:29).
//
// FONTE CANÔNICA deste cálculo. O front (countdown da aba AÇÃO AUTÔNOMA)
// exibe o alvo absoluto `executar_em` calculado AQUI — nunca recalcula a
// janela por conta própria, senão relógio da tela diverge do relógio real.
//
// Pura e testável (deno test). Feriados entram como Set de 'YYYY-MM-DD' (BRT)
// — quem chama busca da tabela; a função não toca banco.
// =============================================================================

const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;
/** Início do expediente em minutos desde 00:00 BRT (08:00). */
export const EXPEDIENTE_INICIO_MIN = 8 * 60;
/** Fim do expediente em minutos desde 00:00 BRT (17:30). */
export const EXPEDIENTE_FIM_MIN = 17 * 60 + 30;
/** Corte de INÍCIO da contagem (Caio 26/08): sugestão nascida às 17h00 ou
 *  depois NÃO fraciona o resto do dia — a janela inteira conta a partir das
 *  08h00 do próximo dia útil (60min → executa 09h00). Janela que COMEÇOU
 *  antes das 17h segue usando o dia até as 17h30 normalmente. */
export const CORTE_INICIO_MIN = 17 * 60;

/** ALMOÇO (Caio 27/08): 12h00–13h00 BRT NÃO conta. O dia útil vira dois
 *  segmentos: 08:00–12:00 e 13:00–17:30. Card nascido dentro do almoço só
 *  começa a contar às 13h (12h15 + 60min → 14h00); janela que cruza o almoço
 *  pausa e retoma (11h30 + 60min → 30min até 12h + 30min a partir das 13h =
 *  13h30). O front mostra o aviso da pausa (acaoAutonomaVeto.ts). */
export const ALMOCO_INICIO_MIN = 12 * 60;
export const ALMOCO_FIM_MIN = 13 * 60;

/** 'YYYY-MM-DD' do instante em BRT — a chave usada na tabela de feriados. */
export function chaveDataBRT(d: Date): string {
  const brt = new Date(d.getTime() - BRT_OFFSET_MS);
  const y = brt.getUTCFullYear();
  const m = String(brt.getUTCMonth() + 1).padStart(2, "0");
  const dia = String(brt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dia}`;
}

/** Dia útil = seg–sex E não-feriado (chave BRT). */
export function ehDiaUtil(d: Date, feriados: ReadonlySet<string>): boolean {
  const brt = new Date(d.getTime() - BRT_OFFSET_MS);
  const dow = brt.getUTCDay(); // 0=Dom..6=Sáb
  if (dow === 0 || dow === 6) return false;
  return !feriados.has(chaveDataBRT(d));
}

/** Minutos desde 00:00 BRT do instante (fração de minuto truncada). */
function minutoDoDiaBRT(d: Date): number {
  const brt = new Date(d.getTime() - BRT_OFFSET_MS);
  return brt.getUTCHours() * 60 + brt.getUTCMinutes();
}

/** Instante UTC correspondente a (dia BRT de `ref`) + `minutos` desde 00:00 BRT. */
function noDiaBRT(ref: Date, minutosDesdeMeiaNoite: number): Date {
  const brt = new Date(ref.getTime() - BRT_OFFSET_MS);
  const meiaNoiteBrtEmUtc = Date.UTC(
    brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate(), 0, 0, 0, 0,
  ) + BRT_OFFSET_MS;
  return new Date(meiaNoiteBrtEmUtc + minutosDesdeMeiaNoite * 60 * 1000);
}

/** Próximo dia útil a partir do dia SEGUINTE ao de `d`, às 08:00 BRT. */
function proximoDiaUtil0800(d: Date, feriados: ReadonlySet<string>): Date {
  let cursor = noDiaBRT(d, EXPEDIENTE_INICIO_MIN);
  for (let i = 0; i < 370; i++) { // teto defensivo: nunca varre mais que ~1 ano
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    if (ehDiaUtil(cursor, feriados)) return cursor;
  }
  throw new Error("minutos-uteis: nenhum dia útil em 370 dias — tabela de feriados corrompida?");
}

/**
 * Soma `minutos` ÚTEIS ao instante `inicio`.
 * Regras de borda:
 *  - início fora do expediente (antes das 08h, depois das 17h30, fim de
 *    semana, feriado) → o relógio só começa no próximo minuto útil;
 *  - a janela nunca "queima" minutos fora do expediente.
 */
export function adicionarMinutosUteis(
  inicio: Date,
  minutos: number,
  feriados: ReadonlySet<string>,
): Date {
  if (!(minutos >= 0) || isNaN(inicio.getTime())) {
    throw new Error(`minutos-uteis: entrada inválida (inicio=${inicio}, minutos=${minutos})`);
  }
  let cursor = new Date(inicio.getTime());
  // normaliza o ponto de partida pro primeiro instante útil.
  // Corte das 17h (Caio 26/08): nasceu >=17h00 → contagem inteira no dia
  // útil seguinte a partir das 08h (nada de fracionar o fim do dia).
  const normalizar = () => {
    const m = minutoDoDiaBRT(cursor);
    if (!ehDiaUtil(cursor, feriados) || m >= CORTE_INICIO_MIN) {
      cursor = proximoDiaUtil0800(cursor, feriados);
    } else if (m < EXPEDIENTE_INICIO_MIN) {
      cursor = noDiaBRT(cursor, EXPEDIENTE_INICIO_MIN);
    } else if (m >= ALMOCO_INICIO_MIN && m < ALMOCO_FIM_MIN) {
      // Caio 27/08: nasceu no almoço → só conta a partir das 13h.
      cursor = noDiaBRT(cursor, ALMOCO_FIM_MIN);
    }
  };
  normalizar();
  let restante = minutos;
  for (let i = 0; i < 800; i++) {
    // Dois segmentos por dia (Caio 27/08): manhã até 12h, tarde 13h–17h30.
    const m = minutoDoDiaBRT(cursor);
    const fimSegmento = m < ALMOCO_INICIO_MIN ? ALMOCO_INICIO_MIN : EXPEDIENTE_FIM_MIN;
    const disponivel = fimSegmento - m;
    if (restante <= disponivel) {
      return new Date(cursor.getTime() + restante * 60 * 1000);
    }
    restante -= disponivel;
    cursor = fimSegmento === ALMOCO_INICIO_MIN
      ? noDiaBRT(cursor, ALMOCO_FIM_MIN)       // pula o almoço, retoma 13h
      : proximoDiaUtil0800(cursor, feriados);  // fim do dia → próximo dia útil 08h
  }
  throw new Error("minutos-uteis: estouro do teto de iteração (janela absurda?)");
}
