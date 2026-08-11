// =============================================================================
// FISCAL DO INV-066 — núcleo puro (testável sem deploy).
//
// Caio 2026-08-11: "Não podemos permitir que exista resposta dos clientes sem
// mover card e sem o operador estar ciente." O reconciliador conserta sozinho;
// este fiscal cobre o caso de ELE falhar — e aí quem precisa saber é o DONO do
// card, não só o gestor.
//
// O relatório entregue ao operador segue o mesmo ritual de diagnóstico que o
// projeto usa (sintoma → o que aconteceu → causa provável → o que verificar),
// em linguagem de operação, sem jargão de código.
// =============================================================================

/** Card que passou pelas 2 primeiras camadas e continuou sem acionamento. */
export interface CasoFiscal {
  card_id: string;
  nf: string | null;
  state: string;
  capturada_em: string;
  operador_id: string | null;
  operador_nome: string | null;
}

export interface RelatorioFiscal {
  sintoma: string;
  o_que_aconteceu: string[];
  qual_card: string;
  causa_provavel: string;
  o_que_verificar: string[];
  impacto: string;
  pedido: string;
}

/** Chave de dedupe: por card + instante da captura. Resposta NOVA no mesmo
 * card = ciclo novo = aviso novo (a exigência do Caio: vale em todo ciclo). */
export function chaveAlerta(caso: CasoFiscal): string {
  return `resposta_sem_acionamento:${caso.card_id}:${caso.capturada_em}`;
}

export function horasParado(capturadaEm: string, agoraMs: number): number {
  return Math.max(0, Math.floor((agoraMs - new Date(capturadaEm).getTime()) / 3_600_000));
}

function plural(n: number, sing: string, plur: string): string {
  return n === 1 ? `1 ${sing}` : `${n} ${plur}`;
}

export function descreverEspera(capturadaEm: string, agoraMs: number): string {
  const h = horasParado(capturadaEm, agoraMs);
  if (h < 24) return plural(Math.max(1, h), "hora", "horas");
  return plural(Math.floor(h / 24), "dia", "dias");
}

/**
 * Monta o relatório que o operador lê no Cockpit e recebe por e-mail.
 * Linguagem de operação: fala de card, cliente e NF — nunca de função ou fila.
 */
export function montarRelatorio(caso: CasoFiscal, agoraMs: number): RelatorioFiscal {
  const espera = descreverEspera(caso.capturada_em, agoraMs);
  const nf = caso.nf ?? "(sem NF)";
  const emAguardandoCliente = caso.state === "AGUARDANDO_CLIENTE";

  return {
    sintoma:
      `O cliente respondeu na NF ${nf} há ${espera}, mas o card não foi para CLIENTE RESPONDEU ` +
      `e eu não cheguei a ler a mensagem para te sugerir a próxima ação.`,
    o_que_aconteceu: [
      `A resposta do cliente CHEGOU e está anexada no card — ela não se perdeu. ` +
      `Você consegue ler agora na aba de mensagens da NF ${nf}.`,
      emAguardandoCliente
        ? `O card ficou parado na coluna AGUARDANDO CLIENTE, como se o cliente ainda ` +
          `estivesse devendo resposta. Por isso ele não apareceu para você.`
        : `O card está em ${caso.state} e não recebeu o selo de "cliente respondeu".`,
      `Nenhuma ocorrência foi lançada no SSW por causa disso — não há risco de ação errada.`,
    ],
    qual_card: `NF ${nf} — card em ${caso.state}, cliente respondeu há ${espera}.`,
    causa_provavel:
      `Quando a resposta chegou, o card estava momentaneamente num estado que não aciona ` +
      `(por exemplo: em monitoramento de extravio, recém-transferido, ou logo após uma ação ` +
      `que falhou e foi revertida). A decisão de acordar o card é tomada naquele instante e, ` +
      `neste caso, a correção automática que roda a cada minuto também não deu conta.`,
    o_que_verificar: [
      `Abra a NF ${nf} e leia a última mensagem do cliente.`,
      `Confirme se ela realmente exige uma ação sua (romaneio, autorização, boleto, endereço).`,
      `Se já tiver resolvido esse caso por fora, é só marcar como LIDO.`,
    ],
    impacto:
      emAguardandoCliente
        ? `Enquanto ficar assim, o cliente está esperando resposta e o card não aparece na sua fila.`
        : `O card está visível, mas sem a leitura da mensagem e sem a minha sugestão.`,
    pedido:
      `Confere se isso aconteceu mesmo com esse card. Se sim, me manda para o corretor oficial ` +
      `de bugs pelo botão abaixo — assim o problema é corrigido na raiz e não volta. ` +
      `Se estiver tudo certo, clica em LIDO que eu sumo daqui.`,
  };
}

export function montarTitulo(caso: CasoFiscal): string {
  return `Card possivelmente travado — NF ${caso.nf ?? "(sem NF)"}`;
}

/** Corpo do e-mail ao operador (texto puro, legível no celular). */
export function montarEmailTexto(
  caso: CasoFiscal,
  rel: RelatorioFiscal,
  urlCard: string | null,
): string {
  const linhas = [
    `Oi${caso.operador_nome ? `, ${caso.operador_nome.split(" ")[0]}` : ""}!`,
    ``,
    rel.sintoma,
    ``,
    `O QUE ACONTECEU`,
    ...rel.o_que_aconteceu.map((l) => `- ${l}`),
    ``,
    `QUAL CARD`,
    rel.qual_card,
    ``,
    `POR QUE ACONTECEU`,
    rel.causa_provavel,
    ``,
    `O QUE EU PRECISO QUE VOCÊ FAÇA`,
    ...rel.o_que_verificar.map((l) => `- ${l}`),
    ``,
    rel.pedido,
  ];
  if (urlCard) {
    linhas.push(``, `Abrir o card: ${urlCard}`);
  }
  linhas.push(
    ``,
    `— Agente do Cockpit (aviso automático; o mesmo aviso está te esperando dentro do Cockpit)`,
  );
  return linhas.join("\n");
}
