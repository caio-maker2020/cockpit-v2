// =============================================================================
// cc-resposta — quem vai em cópia na resposta manual do Cockpit.
//
// Caio 22/09 (NF 691977 WÜRTH / Ingrid+Maria): quando a operadora marcava
// QUALQUER contato cadastrado no multi-select, o backend tratava a lista como
// "participantes FINAIS" e descartava quem o CLIENTE tinha posto em To/Cc
// (o Jackson do caso âncora). Medição 14d: 83 de 251 respostas (1 em 3, 100%
// delas com contato marcado) deixaram alguém de fora. As duas telas falavam
// de coisas diferentes: o multi-select é "contatos EXTRAS da carteira"; a
// derivação do inbound é "participantes da conversa".
//
// REGRA (INV-084 família threading): a resposta leva SEMPRE a UNIÃO —
// participantes do e-mail do cliente (To+Cc) ∪ contatos marcados pela
// operadora — sem duplicar, sem o destinatário do TO, sem a própria
// operadora. Exclusão consciente de participante não existe hoje na UI;
// se um dia existir, é feature de front (checkbox por participante), nunca
// volta a ser "lista explícita substitui derivação".
// =============================================================================

const EMAIL_REGEX = /[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}/g;

export function montarCcResposta(opts: {
  /** contatos marcados pela operadora no composer (podem vir com caixa mista). */
  ccExplicito: readonly string[];
  /** headers To/Cc CRUS da mensagem inbound do cliente (raw_payload). */
  rawTo: string | null | undefined;
  rawCc: string | null | undefined;
  /** destinatário da resposta (remetente original) — nunca vai em cópia. */
  toResposta: string | null | undefined;
  /** e-mails da operadora/caixa — nunca se auto-copiar. */
  emailsOperadora: readonly (string | null | undefined)[];
}): string[] {
  const excluir = new Set<string>();
  const toLower = (opts.toResposta ?? "").trim().toLowerCase();
  if (toLower) excluir.add(toLower);
  for (const e of opts.emailsOperadora) {
    const v = (e ?? "").trim().toLowerCase();
    if (v) excluir.add(v);
  }

  const derivados = `${opts.rawTo ?? ""}, ${opts.rawCc ?? ""}`.match(EMAIL_REGEX) ?? [];
  const marcados = opts.ccExplicito
    .map((e) => (e ?? "").trim())
    .filter((e) => e.length > 0);

  const visto = new Set<string>();
  const resultado: string[] = [];
  // derivados primeiro (participantes da conversa), depois os extras marcados.
  for (const e of [...derivados, ...marcados]) {
    const k = e.trim().toLowerCase();
    if (!k || excluir.has(k) || visto.has(k)) continue;
    visto.add(k);
    resultado.push(k);
  }
  return resultado;
}
