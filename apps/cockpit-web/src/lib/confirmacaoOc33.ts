// =============================================================================
// confirmacaoOc33 — INV-155. "Dá pra perguntar à operadora, neste to-do?"
//
// REGRA (Carlos 2026-09-16): quando só a DESCRIÇÃO e/ou o VALOR dos itens
// faltam, o romaneio já está validado e o card tem anexo do cliente, a tela
// para de apenas apagar o botão e passa a PERGUNTAR: "o cliente informou por
// anexo?". SIM + texto digitado fecha o dossiê e libera o botão. NÃO não libera.
//
// ⚠ ESPELHO de `supabase/functions/_shared/oc33-confirmacao-operador.ts`
//   (`decidirPerguntaOc33`, os tetos, o piso) e de `extravio-parcial-dossie.ts`
//   (`montarTextoDescricaoValor`, `JANELA_VISIVEL_SSW`). Mudar nos dois — o
//   teste `confirmacaoOc33.test.ts` LÊ os arquivos do backend e falha se
//   divergirem, igual `dossie33Faltando.ts` já faz.
//
//   A tela é só a PORTA: quem decide de verdade é a edge function
//   `confirmar-dossie-oc33`, que roda a mesma decisão no servidor e recusa se
//   divergir. Este arquivo existe pra ela não oferecer o que o servidor nega.
//
// Só LEITURA. Puro, sem rede, sem efeito.
// =============================================================================

/** Espelho de JANELA_VISIVEL_SSW: o campo f6 do portal SSW (tela 101) tem
 * maxlength=70 e é a coluna "Instrução/Complemento" que o setor de Ressarcimento
 * realmente lê. O que passa disso vai pro backup de 500 e ninguém vê. */
export const JANELA_SETOR = 70;

/** Espelho de PISO_TEXTO_CONFIRMACAO: SIM em branco produz a mesma oc 33 vazia
 * que o Ressarcimento devolveu cobrando "DESCRIÇÃO E VALOR" (NF 660746). */
export const PISO_TEXTO = 3;

/** Espelho de LIMITE_DESCRICAO_CONFIRMACAO / LIMITE_VALOR_CONFIRMACAO. */
export const MAX_DESCRICAO = 60;
export const MAX_VALOR = 25;

export type AlvoConfirmacao = "descricao" | "valor";

export type MotivoSemPergunta =
  | "sem_dossie"
  | "nao_bloqueada"
  | "natureza_operacional"
  | "falta_romaneio"
  | "nada_faltando"
  | "card_sem_anexo";

/** Espelho de ROTULO_EVIDENCIA do backend (só os dois que o pop-up cobre). */
export const ROTULO_CONFIRMACAO: Record<AlvoConfirmacao, string> = {
  descricao: "descrição dos itens",
  valor: "valor dos itens",
};

export interface DecisaoPergunta {
  perguntar: boolean;
  motivo: MotivoSemPergunta | null;
  alvos: AlvoConfirmacao[];
  rotulos: string[];
}

type DossieLido = {
  romaneio?: { presente?: boolean };
  descricao?: { presente?: boolean };
  valor?: { presente?: boolean };
};

/**
 * Espelho EXATO de decidirPerguntaOc33. Mesma ordem de testes, mesmos motivos.
 *
 * `natureza` e `bloqueada` vêm do CARIMBO (`meta.gate_oc33`), não do dossiê
 * vivo: é o carimbo que a parede `aprovar_e_executar` lê. O dossiê entra só
 * para saber O QUE falta. Ver gateOc33Carimbo.ts.
 */
export function decidirPerguntaOc33(args: {
  natureza: "operacional" | "completude" | null;
  bloqueada: boolean;
  card: { agent_state?: Record<string, unknown> | null };
  temAnexoNoCard: boolean;
}): DecisaoPergunta {
  const vazio: DecisaoPergunta = { perguntar: false, motivo: null, alvos: [], rotulos: [] };
  const recusa = (motivo: MotivoSemPergunta): DecisaoPergunta => ({ ...vazio, motivo });

  const ep = args.card.agent_state?.["extravio_parcial"] as
    | { caso?: string | null; dossie?: DossieLido }
    | undefined
    | null;
  if (!ep || !ep.dossie) return recusa("sem_dossie");
  if (args.bloqueada !== true) return recusa("nao_bloqueada");
  if (args.natureza !== "completude") return recusa("natureza_operacional");
  if (ep.dossie.romaneio?.presente !== true) return recusa("falta_romaneio");

  const alvos: AlvoConfirmacao[] = [];
  if (ep.dossie.descricao?.presente !== true) alvos.push("descricao");
  if (ep.dossie.valor?.presente !== true) alvos.push("valor");
  if (alvos.length === 0) return recusa("nada_faltando");
  if (!args.temAnexoNoCard) return recusa("card_sem_anexo");

  return { perguntar: true, motivo: null, alvos, rotulos: alvos.map((a) => ROTULO_CONFIRMACAO[a]) };
}

/** Normalização idêntica à do servidor: sem quebra de linha, sem espaço duplo. */
export function limparTexto(t: string, teto: number): string {
  return t.replace(/\s+/g, " ").trim().slice(0, teto);
}

export interface PreviaSetor {
  /** O texto de descrição+valor que vai pra Instrução do SSW. */
  texto: string;
  /** Os primeiros 70 caracteres — o que o setor REALMENTE lê. */
  janela: string;
  /** true = sobrou texto fora da janela. */
  cortado: boolean;
  /** Falta digitar algo pra liberar? */
  completo: boolean;
}

/**
 * Prévia do que o setor de Ressarcimento vai ler. Espelho de
 * montarTextoDescricaoValor: rótulos CURTOS "Itens: " e "Valor: " (os longos
 * gastavam 38 dos 70 caracteres visíveis só em etiqueta) e junção por " | ".
 *
 * `jaNoDossie` é o texto das evidências que JÁ estão lá — quando só a descrição
 * falta, o valor já gravado continua aparecendo na frente do que ela digita.
 */
export function previaDoSetor(args: {
  alvos: readonly AlvoConfirmacao[];
  descricao: string;
  valor: string;
  jaNoDossie?: { descricao?: string | null; valor?: string | null };
}): PreviaSetor {
  const d = args.alvos.includes("descricao")
    ? limparTexto(args.descricao, MAX_DESCRICAO)
    : (args.jaNoDossie?.descricao ?? "").trim();
  const v = args.alvos.includes("valor")
    ? limparTexto(args.valor, MAX_VALOR)
    : (args.jaNoDossie?.valor ?? "").trim();

  const partes: string[] = [];
  if (d) partes.push(`Itens: ${d}`);
  if (v) partes.push(`Valor: ${v}`);
  const texto = partes.join(" | ");

  const falta = args.alvos.some((a) =>
    (a === "descricao" ? d : v).length < PISO_TEXTO
  );
  return {
    texto,
    janela: texto.slice(0, JANELA_SETOR),
    cortado: texto.length > JANELA_SETOR,
    completo: !falta,
  };
}
