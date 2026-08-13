// Canal entre o placar e o chat do agente-chefe (Caio 2026-08-13).
//
// O placar mostra "quando sugere oc 54 → 17,4%, e o operador fez 21 em 81 casos".
// Isso É a pergunta — mas até agora o gestor teria que reescrever tudo à mão no
// chat. O botão "Perguntar ao agente" monta o texto e entrega aqui; o chat livre
// escuta, abre sozinho e já vem preenchido.
//
// Pub/sub de módulo em vez de context/prop-drilling: os dois componentes são
// primos distantes na árvore (placar no topo da aba, chat lá embaixo dentro de
// ChatAgenteChefe → ChatThread) e o chat tem estado próprio. Um canal de 20
// linhas evita levantar estado por 4 níveis só pra isso.

type Ouvinte = (texto: string) => void;

const ouvintes = new Set<Ouvinte>();
/** Guarda a última pergunta pra quem assinar depois (chat ainda não montado). */
let pendente: string | null = null;

/** O placar chama isto ao clicar em "Perguntar ao agente". */
export function enviarPerguntaParaChat(texto: string): void {
  const limpo = texto.trim();
  if (!limpo) return;
  if (ouvintes.size === 0) {
    pendente = limpo;
    return;
  }
  for (const o of ouvintes) o(limpo);
}

/** O chat livre assina na montagem. Devolve a função de cancelamento. */
export function ouvirPerguntasDoPlacar(ouvinte: Ouvinte): () => void {
  ouvintes.add(ouvinte);
  if (pendente !== null) {
    const t = pendente;
    pendente = null;
    // deixa o componente montar antes de mexer no estado dele
    queueMicrotask(() => ouvinte(t));
  }
  return () => {
    ouvintes.delete(ouvinte);
  };
}

/** Só pros testes: limpa canal e pendência entre casos. */
export function _resetCanalPergunta(): void {
  ouvintes.clear();
  pendente = null;
}
