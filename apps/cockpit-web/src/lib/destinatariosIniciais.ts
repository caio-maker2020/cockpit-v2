// Memória da seleção de destinatários (Caio 2026-09-11 — relato do Felipe).
//
// O trilho AUTÔNOMO é o único que SALVA a edição do e-mail e fecha o card sem
// executar: quem envia é o motor no vencimento. Ao reabrir, o EditarEmailModal
// remonta do zero e só tinha UMA fonte de hidratação — `preview_email_todo`,
// cujo contrato de retorno é ESCALAR (`email_destino: text`). A RPC lê o array
// salvo em `args.extras.email_destinatarios` mas devolve `v_destinatarios->>0`
// (mig 320, linha 143) e não expõe o array. Resultado: 3 salvos → 1 marcado.
//
// O dado NUNCA se perdeu (NF 361612 / agendamento 4017 tem os 3 no banco, e o
// executor honra o array inteiro: [0] = TO, slice(1) = CC). O defeito é de
// RELEITURA — e o risco real é re-salvar por cima com 1 só.
//
// Esta função é a fonte única da seleção inicial. O BannerAcaoAutonoma já
// carrega `proposta_payload` inteiro, então a lista salva chega ao modal sem
// depender de mudança de backend (MODO FRONT PRÓPRIO).

/**
 * Decide quais destinatários já vêm marcados ao abrir o editor de e-mail.
 *
 * Precedência: a escolha SALVA pelo operador vence a sugestão automática.
 * Sem escolha salva, cai no destino escalar do preview — comportamento
 * idêntico ao de hoje (os outros 4 fluxos não passam `salvos` e não mudam).
 *
 * A ORDEM é significativa e preservada: o 1º vira TO, os demais viram CC
 * (executor/index.ts:1664-1672). Por isso nunca reordenar aqui.
 */
export function resolverDestinatariosIniciais(
  salvos: unknown,
  emailDestinoPreview: string | null | undefined,
): string[] {
  const limpos = normalizarLista(salvos);
  if (limpos.length > 0) return limpos;

  const unico = typeof emailDestinoPreview === "string" ? emailDestinoPreview.trim() : "";
  return unico ? [unico] : [];
}

/**
 * Higieniza a lista salva: descarta não-strings e vazios/espaços (o executor
 * também filtra `s.trim()`, então "" nunca foi destinatário válido), e remove
 * duplicados MANTENDO a primeira ocorrência — trocar a ordem trocaria o TO.
 */
function normalizarLista(salvos: unknown): string[] {
  if (!Array.isArray(salvos)) return [];
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const item of salvos) {
    if (typeof item !== "string") continue;
    const e = item.trim();
    if (!e || vistos.has(e)) continue;
    vistos.add(e);
    out.push(e);
  }
  return out;
}

/**
 * Seleção automática de TODOS os contatos do cliente (Caio 2026-09-11) —
 * EXCLUSIVA do trilho autônomo. Os outros fluxos não passam a flag e seguem
 * com o destino único sugerido pelo backend.
 *
 * Base do dado: em 128 seleções salvas, 94 (73%) marcaram exatamente todos os
 * contatos do cliente na mão. Nos clientes grandes o padrão se mantém (8 de 8;
 * 9 de 11 nas 5 ocorrências) — por isso NÃO há teto de quantidade.
 *
 * A `selecaoAtual` é preservada NA FRENTE de propósito: o 1º da lista vira o
 * TO (executor/index.ts:1664-1672) e ele já foi escolhido pelo backend com a
 * regra de tipo_uso/remetente/ordem (`resolver_email_cobranca_cliente`).
 * Marcar todos deve ACRESCENTAR cópias, nunca trocar quem recebe como
 * destinatário principal.
 */
export function unirSelecaoComTodosOsContatos(
  selecaoAtual: unknown,
  contatos: unknown,
): string[] {
  const base = normalizarLista(selecaoAtual);
  const todos = normalizarLista(contatos);
  const vistos = new Set(base);
  const out = [...base];
  for (const e of todos) {
    if (vistos.has(e)) continue;
    vistos.add(e);
    out.push(e);
  }
  return out;
}
