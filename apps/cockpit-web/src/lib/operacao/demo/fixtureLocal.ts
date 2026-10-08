// Fixture real OPCIONAL da demonstração em `vite dev` (VITE_OPERACAO_DEMO=true):
// apps/cockpit-web/demo/fila-real.json (fora do git), um array de linhas de op_v_fila.
// `import.meta.glob` devolve {} quando o arquivo não existe — sem erro de build. Só
// `carregarOpApi` importa este módulo, no ramo do `vite dev`: o build demo-v3 nunca o
// alcança, e por isso o arquivo nunca entra num bundle.
import { criarAdaptadorDemo, lerFixtureFila, type OpcoesDemo } from "./adaptadorDemo";

const FIXTURES = import.meta.glob("/demo/fila-real.json", { import: "default" });

/** O que `carregarOpApi` usa em `vite dev`: fixture real se existir e for válido; senão, os fictícios. */
export async function criarAdaptadorDemoComFixture(opcoes: OpcoesDemo = {}) {
  const carregar = FIXTURES["/demo/fila-real.json"];
  if (carregar) {
    try {
      const linhas = lerFixtureFila(await carregar());
      if (linhas.length > 0) {
        console.info(`[operacao-demo] usando a fila REAL do arquivo local: ${linhas.length} linhas.`);
        return criarAdaptadorDemo({ ...opcoes, linhasReais: linhas });
      }
      console.warn("[operacao-demo] demo/fila-real.json existe mas não tem linhas válidas; usando os fictícios.");
    } catch (e) {
      console.warn("[operacao-demo] não deu para ler demo/fila-real.json; usando os fictícios.", e);
    }
  }
  return criarAdaptadorDemo(opcoes);
}
