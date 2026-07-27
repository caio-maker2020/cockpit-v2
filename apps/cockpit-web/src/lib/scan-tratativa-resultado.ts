/**
 * Mapeia o `resultado` da edge `scan-email-pre-card` (chamada sob demanda pelo
 * BotaoBuscarTratativa) para a mensagem + severidade que o operador vê.
 *
 * NF 108141 (Duílio, 2026-07-27): o botão "Já tem tratativa? Buscar" mostrava
 * "Resultado inesperado" (toast de ERRO) quando o scan tinha SUCESSO — o switch
 * do componente só tratava sugerido, nenhum_candidato, os sem_* e card_inexistente,
 * e jogava `adotado`/`ja_decidido`/`card_terminal` no `default: toast.error`. O
 * card 108141 já tinha a thread adotada (11:12); a materialização da tratativa
 * atrasou ~7h (fila congestionada), o botão seguiu visível (só some com
 * total_tratativas > 0), e a re-checagem devolvia `ja_decidido` → operador via
 * "dá um erro e não puxa". Aqui esses códigos viram mensagem INFORMATIVA +
 * refresh, nunca erro. Código desconhecido também não vira erro (a edge
 * respondeu ok — o caminho de erro real é tratado antes, no !ok/transport).
 */
export type ScanTratativaTipo = "success" | "info" | "error";

export interface ScanTratativaMensagem {
  tipo: ScanTratativaTipo;
  texto: string;
  /** true → invalidar as queries do card/tratativas pra refletir na hora. */
  refresh: boolean;
}

export function mensagemDoResultadoScan(
  resultado: string | undefined,
  candidatosTotal = 0,
): ScanTratativaMensagem {
  switch (resultado) {
    case "sugerido":
      return {
        tipo: "success",
        texto:
          candidatosTotal > 1
            ? `${candidatosTotal} tratativas encontradas — confira no painel.`
            : "Tratativa encontrada — confira no painel.",
        refresh: true,
      };

    // Sucesso silencioso: a thread JÁ está vinculada ao card (adoção automática
    // ou "Seguir"/"Já tem tratativa" anterior). Se a resposta ainda não apareceu,
    // está sendo processada — o refresh puxa assim que a fila drenar. NUNCA erro.
    case "adotado":
    case "ja_decidido":
      return {
        tipo: "info",
        texto:
          "Tratativa já vinculada a este card — atualizando o painel. Se a resposta ainda não apareceu, ela está sendo processada.",
        refresh: true,
      };

    case "nenhum_candidato":
    case "descartado":
      return {
        tipo: "info",
        texto: "Nenhuma tratativa encontrada para esta NF.",
        refresh: false,
      };

    case "card_terminal":
      return {
        tipo: "info",
        texto: "Card já finalizado — não há tratativa a buscar.",
        refresh: false,
      };

    case "sem_credencial_gmail":
      return { tipo: "error", texto: "Operador sem Gmail conectado — reconectar.", refresh: false };
    case "sem_operador":
      return { tipo: "error", texto: "Card sem operador atribuído.", refresh: false };
    case "sem_nf":
      return { tipo: "error", texto: "Card sem NF — não dá pra buscar tratativa.", refresh: false };
    case "card_inexistente":
      return { tipo: "error", texto: "Card não encontrado.", refresh: false };
    case "erro":
      return { tipo: "error", texto: "Erro ao buscar tratativa — tente de novo em instantes.", refresh: false };

    default:
      // A edge respondeu ok com um código não mapeado: trata como neutro (não
      // assusta o operador com "erro" falso) e dá refresh por segurança.
      return { tipo: "info", texto: "Busca concluída — confira o painel.", refresh: true };
  }
}
