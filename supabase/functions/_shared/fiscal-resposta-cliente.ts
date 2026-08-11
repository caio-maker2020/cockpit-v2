// =============================================================================
// FISCAL DO INV-067 — núcleo puro (testável sem deploy).
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
  /** Seção TÉCNICA — não aparece pro operador. Vai no e-mail ao Caio quando
   * ele clica em "mandar pro corretor de bugs". Segue o ritual de diagnóstico. */
  diagnostico_tecnico?: DiagnosticoTecnico;
}

export interface DiagnosticoTecnico {
  sintoma_observado: string;
  comportamento_esperado: string;
  evidencias: string[];
  causa_raiz: string;
  fix_sugerido: string[];
  como_validar: string[];
  onde_olhar: string[];
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
    diagnostico_tecnico: montarDiagnosticoTecnico(caso, agoraMs),
  };
}

/**
 * Diagnóstico técnico pro corretor de bugs (o Caio). Escrito no ritual do
 * projeto — o objetivo é que ele abra o e-mail e já saiba onde olhar, sem
 * precisar reconstruir o caso.
 */
export function montarDiagnosticoTecnico(caso: CasoFiscal, agoraMs: number): DiagnosticoTecnico {
  const nf = caso.nf ?? "(sem NF)";
  return {
    sintoma_observado:
      `NF ${nf}: RespostaClienteCapturada em ${caso.capturada_em} (há ${
        descreverEspera(caso.capturada_em, agoraMs)
      }) em card ${caso.state}, sem RetornoClienteEmAguardo nem ação de operador depois.`,
    comportamento_esperado:
      "Card acionável + resposta de cliente = card se move, com carimbo cliente_respondeu_em e sugestão da IA. Vale em TODO ciclo (Caio 2026-08-11).",
    evidencias: [
      `card_id=${caso.card_id}, state=${caso.state}, operador=${caso.operador_nome ?? "sem dono"}.`,
      "O detector é a RPC cards_resposta_cliente_nao_acionada — mesma fonte do reconciliador e do monitor INV-042.",
      "O caso passou do grace de 30min, ou seja, o reconciliador (cron 1min, grace 5min) teve pelo menos 25min e não resolveu.",
    ],
    causa_raiz:
      "Hipótese não confirmada — precisa de investigação. O padrão conhecido (INV-067) é a decisão de acionamento ficar presa ao estado do instante em que a resposta chegou. Se o reconciliador está ligado e mesmo assim sobrou, a causa é OUTRA e é nova.",
    fix_sugerido: [
      "Conferir se a flag reconciliador_resposta_pendente_enabled está ligada.",
      "Ler o retorno do cron-ia-resposta-pendentes (campo `reconciliador`) — ver se o caso apareceu e falhou, ou se nem foi listado.",
      "Se apareceu e falhou: olhar o erro do acionarRespostaCliente (provável interpretador ou RPC de propostas).",
      "Se NEM foi listado: o detector tem buraco novo — checar o state do card contra a lista de estados acionáveis da RPC.",
    ],
    como_validar: [
      `Depois do fix, a RPC cards_resposta_cliente_nao_acionada(200, 30, 90) tem que voltar vazia.`,
      `O card da NF ${nf} tem que aparecer em CLIENTE RESPONDEU com sugestão da IA.`,
      "INV-067 e INV-068 verdes no /verify-cockpit.",
    ],
    onde_olhar: [
      "supabase/functions/_shared/acionar-resposta-cliente.ts (efeito, fonte única)",
      "supabase/functions/_shared/acionamento-resposta-cliente.ts (decisão)",
      "supabase/functions/cron-ia-resposta-pendentes/index.ts (reconciliador, 3ª rede)",
      "migration/2026-08-11_327_reconciliador_resposta_pendente.sql (detector)",
    ],
  };
}

/** E-mail ao corretor de bugs, disparado quando o operador confirma o caso. */
export function montarEmailCorretorTexto(
  caso: CasoFiscal,
  dt: DiagnosticoTecnico,
  observacao: string | null,
  urlCard: string | null,
): string {
  const bloco = (titulo: string, linhas: string[]) => [titulo, ...linhas.map((l) => `  - ${l}`), ""];
  const linhas = [
    `Quem reportou: ${caso.operador_nome ?? "operador"} (confirmou no Cockpit que o card travou)`,
    `NF: ${caso.nf ?? "(sem NF)"} · card: ${caso.card_id} · estado: ${caso.state}`,
    "",
    ...(observacao ? [`Observação do operador: ${observacao}`, ""] : []),
    "SINTOMA OBSERVADO",
    `  ${dt.sintoma_observado}`,
    "",
    "COMPORTAMENTO ESPERADO",
    `  ${dt.comportamento_esperado}`,
    "",
    ...bloco("EVIDÊNCIAS VERIFICADAS", dt.evidencias),
    "CAUSA RAIZ",
    `  ${dt.causa_raiz}`,
    "",
    ...bloco("FIX SUGERIDO", dt.fix_sugerido),
    ...bloco("COMO VALIDAR", dt.como_validar),
    ...bloco("ONDE OLHAR", dt.onde_olhar),
  ];
  if (urlCard) linhas.push(`Abrir o card: ${urlCard}`, "");
  linhas.push("— Fiscal do Cockpit (INV-067/068), confirmado por operador.");
  return linhas.join("\n");
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
