// A demonstração servida pelo site do roteirizador v3 (`vite build --mode demo-v3`, em
// /operacao-cockpit/). A fila REAL vem da API do v3 — GET /v3/cockpit-demo/fila, calculada ao
// vivo e só leitura do legado — com a sessão do v3 (o mesmo localStorage do site). Nada de
// dado real no bundle. As ações da tela (assumir, lançar, encaminhar) seguem no adaptador em
// memória: nada vai ao SSW nem ao Relacionamento.
//
// Onde está a API: o site do v3 responde em /operacao-cockpit-config com {apiUrl} (a mesma
// NEXT_PUBLIC_API_URL do resto do site), para este build estático não levar URL fixa.
import { definirOrigemDemo } from "../modoDemo";
import { avisarSemSessaoV3, sessaoV3DoAparelho, type SessaoV3 } from "../sessaoV3";
import type { OpFilaLinha } from "../tipos";
import { criarAdaptadorDemo, lerFixtureFila } from "./adaptadorDemo";

export const URL_CONFIG_V3 = "/operacao-cockpit-config";

export type ResultadoFilaV3 =
  | { ok: true; linhas: OpFilaLinha[] }
  | { ok: false; motivo: "sem_sessao" | "sem_api" | "falhou"; detalhe: string };

type Busca = (url: string, init?: RequestInit) => Promise<Response>;

/** Busca a fila na API do v3. Nunca lança. */
export async function buscarFilaDoV3(
  sessao: SessaoV3 | null,
  buscar: Busca = (u, i) => fetch(u, i),
): Promise<ResultadoFilaV3> {
  if (!sessao) return { ok: false, motivo: "sem_sessao", detalhe: "sem sessão do roteirizador neste navegador" };
  let apiUrl: string;
  try {
    const r = await buscar(URL_CONFIG_V3, { headers: { accept: "application/json" } });
    const cfg = (await r.json()) as { apiUrl?: unknown };
    if (!r.ok || typeof cfg.apiUrl !== "string" || !cfg.apiUrl) throw new Error(`config ${r.status}`);
    apiUrl = cfg.apiUrl.replace(/\/+$/, "");
  } catch (e) {
    return { ok: false, motivo: "sem_api", detalhe: `não achei o endereço da API do roteirizador (${(e as Error).message})` };
  }
  try {
    const r = await buscar(`${apiUrl}/v3/cockpit-demo/fila`, {
      headers: { authorization: `Bearer ${sessao.token}`, accept: "application/json" },
    });
    if (r.status === 401 || r.status === 403) return { ok: false, motivo: "sem_sessao", detalhe: `a API recusou a sessão (${r.status})` };
    const corpo = (await r.json().catch(() => null)) as { linhas?: unknown; erro?: string } | unknown[] | null;
    if (!r.ok) {
      const erro = corpo && !Array.isArray(corpo) ? corpo.erro : null;
      return { ok: false, motivo: "falhou", detalhe: erro ?? `a API respondeu ${r.status}` };
    }
    const bruto = Array.isArray(corpo) ? corpo : corpo?.linhas;
    return { ok: true, linhas: lerFixtureFila(bruto) };
  } catch (e) {
    return { ok: false, motivo: "falhou", detalhe: `a API do roteirizador não respondeu (${(e as Error).message})` };
  }
}

/** O que `carregarOpApi` usa no build demo-v3. */
export async function criarAdaptadorDemoDoV3(buscar?: Busca) {
  const sessao = sessaoV3DoAparelho();
  const r = await buscarFilaDoV3(sessao, buscar);
  if ("linhas" in r && r.linhas.length > 0) {
    definirOrigemDemo("v3");
    return criarAdaptadorDemo({ linhasReais: r.linhas, origemReal: "v3" });
  }
  const falha = "motivo" in r ? r : null;
  if (falha?.motivo === "sem_sessao") avisarSemSessaoV3();
  definirOrigemDemo("ficticio");
  const aviso = falha ? falha.detalhe : "a fila real veio vazia";
  console.warn(`[operacao-demo-v3] usando os fictícios: ${aviso}`);
  return criarAdaptadorDemo({ avisoOrigem: aviso });
}
