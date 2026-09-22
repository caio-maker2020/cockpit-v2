// =============================================================================
// Guard da FIAÇÃO da segregação no painel direito (ProposedActions).
//
// Achado da auditoria pré-merge (21/09): o modal de e-mail ganhou teste de
// componente, mas o caminho do painel expandido — a outra metade da feature —
// ficou sem guard nenhum. A prop `podeSegregarCtrc` tem default `false`, então
// remover a fiação NÃO quebra `npm run typecheck` nem o vitest, e o
// /verify-cockpit seguia verde: a caixa sumiria da tela em silêncio.
//
// Renderizar o ProposedActions inteiro exigiria replicar dezenas de mocks
// (supabase, react-query, auth, uploader, pdf.js). Este guard lê o FONTE e
// cobra os elos que, se sumirem, matam a feature sem sinal — mesma técnica dos
// guards de fonte do backend (tools-registrados-no-front, oc13-visibilidade).
// =============================================================================
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Caminho a partir da RAIZ do front (vitest roda com cwd=apps/cockpit-web).
// `import.meta.url` nao serve: no vitest ele nao e uma URL file://.
const FONTE = resolve(process.cwd(), "src/components/cards/ProposedActions.tsx");
// Comentários fora: apagar o código e deixar a prosa manteria tudo verde.
const src = readFileSync(FONTE, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

describe("fiação da marcação Segregar CTRC no painel", () => {
  it("a visibilidade vem da RPC cliente_pode_segregar_ctrc", () => {
    // Sem a RPC, ou a caixa some pra todo mundo, ou aparece pra todo mundo —
    // a whitelist é service-only e o front não consegue ler a tabela.
    expect(src).toContain("cliente_pode_segregar_ctrc");
  });

  it("a prop é repassada às DUAS chamadas do EditarEmailModal", () => {
    // Uma é a ★ RECOMENDADA, a outra é a linha "Notificar cliente + lançar".
    // Perder uma delas apaga a caixa só num dos caminhos — o pior dos mundos,
    // porque a operadora conclui que "às vezes funciona".
    const n = src.match(/podeSegregarCtrc=\{podeSegregarCtrc\}/g)?.length ?? 0;
    expect(n).toBe(2);
  });

  it("o payload manda SEMPRE o booleano, nunca só quando true", () => {
    // O coração do achado bloqueia-merge: `aprovar_e_executar` grava os extras
    // no to-do com `extras_existentes || p_extras`, e o `||` do jsonb mantém
    // chave ausente. Omitir quando desmarcada deixa marcação velha gravada e a
    // reaprovação seguinte segrega sozinha.
    expect(src).toContain("payload.segregar_ctrc = extras.segregar_ctrc === true");
    // a forma antiga (só quando true) não pode voltar
    expect(src).not.toContain("payload.segregar_ctrc = true");
  });

  it("render e payload usam a MESMA constante de ocorrências", () => {
    // Se o render usar uma lista e o payload outra, a caixa aparece numa oc que
    // o payload descarta: a operadora marca e nada acontece, sem mensagem.
    const n = src.match(/OCS_COM_SEGREGACAO_FRONT\.includes\(codigo\)/g)?.length ?? 0;
    expect(n).toBe(2);
    // e a lista do kanban não pode voltar a gatear a caixa
    expect(src).not.toContain("podeSegregarCtrc && ehOcCliente(codigo)");
  });

  it("a caixa continua avisando que o Cockpit não desfaz", () => {
    // O texto é a única coisa que separa "marquei sem querer" de "eu sabia".
    expect(src).toContain("091");
  });

  it("o modal é remontado por todo (key), pra marcação não viajar entre cards", () => {
    const n = src.match(/key=\{email(Aprovacao|Extravio)ModalTodo\.id\}/g)?.length ?? 0;
    expect(n).toBe(2);
  });
});
