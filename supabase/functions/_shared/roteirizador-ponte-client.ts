// =============================================================================
// roteirizador-ponte-client — adapter da PONTE Roteirizador ↔ Cockpit (ADR 0034).
//
// O Roteirizador Inteligente é dono da ROTA do dia (plano, carro, motorista,
// execução) e só LÊ o SSW. O Cockpit é dono da NF e do cliente. A ponte é o
// contrato entre os dois — fonte única: `docs/PONTE-COCKPIT.md` do repo do
// Roteirizador. Campos aqui são EXATAMENTE os do contrato; não inventar.
//
//   GET  /v3/ponte/notas/:ctrc               → onde está a nota
//   POST /v3/ponte/compromissos               → compromisso combinado com o cliente
//   GET  /v3/ponte/eventos?desde=&limite=     → fluxo de eventos por cursor
//
// Regras do adapter (convenção nº 2 do CLAUDE.md — agente nunca fala direto):
//   - env ausente (ROTEIRIZADOR_API_URL / ROTEIRIZADOR_PONTE_TOKEN) = cliente
//     DESLIGADO: `readRoteirizadorPonteEnv` devolve null e quem chama segue sem
//     a ponte. Nada aqui lança no caminho do agente: todo método devolve
//     `ResultadoPonte` ({ ok:true, dados } | { ok:false, erro }).
//   - timeout por tentativa (AbortController);
//   - retry exponencial CURTO só em 5xx / rede / timeout; 4xx nunca repete
//     (o pedido está errado — repetir não conserta);
//   - POST /compromissos é seguro de repetir: a idempotencyKey é do contrato
//     (200 = mesma chave reenviada, não duplica).
// =============================================================================

// ── contrato (docs/PONTE-COCKPIT.md) ─────────────────────────────────────────

export interface CarroPonte {
  indice: number;
  perfil: string;
  placa: string | null;
  motorista: string | null;
  telefoneMotorista: string | null;
}

export type StatusExecucaoPonte =
  | "pendente"
  | "seguida"
  | "removida"
  | "nao_coube"
  | "fora_da_doca";

export interface NotaNoPlano {
  noPlano: true;
  ctrc: string;
  dataRef: string;
  rotaNome: string;
  statusAprovacao: string;
  carro: CarroPonte | null;
  ordem: number | null;
  cidade: string | null;
  statusExecucao: StatusExecucaoPonte | string;
  motivoExecucao: string | null;
  fotoEvidenciaUrl: string | null;
  decididoEm: string | null;
  compromissos: unknown[];
  linkRastreio: string | null;
}

export interface NotaForaDoPlano {
  noPlano: false;
  compromissos: unknown[];
}

export type NotaPonte = NotaNoPlano | NotaForaDoPlano;

export type TipoCompromisso = "reentrega" | "agendamento" | "segurar";

export interface CompromissoPonte {
  ctrc: string;
  tipo: TipoCompromisso;
  /** YYYY-MM-DD */
  data: string;
  /** HH:MM */
  janelaInicio?: string;
  /** HH:MM */
  janelaFim?: string;
  observacao?: string;
  cardId?: string;
  idempotencyKey: string;
}

export interface CompromissoRegistrado {
  /** true = 201 (criado agora); false = 200 (mesma idempotencyKey, não duplicou). */
  criado: boolean;
  status: 200 | 201;
  corpo: unknown;
}

export type TipoEventoPonte =
  | "rota_aprovada"
  | "nota_seguida"
  | "nota_removida"
  | "nota_nao_coube"
  | "nota_fora_da_doca";

export interface EventoPonte {
  id: number;
  tipo: TipoEventoPonte | string;
  dataRef: string | null;
  rotaNome: string | null;
  ctrc: string | null;
  /** Só em rota_aprovada: as notas que saem na rota. */
  ctrcs?: string[];
  motivo: string | null;
  fotoEvidenciaUrl: string | null;
  ator: string | null;
}

export interface PaginaEventosPonte {
  desde: number;
  proximo: number;
  eventos: EventoPonte[];
}

// ── erros tipados ────────────────────────────────────────────────────────────

export type TipoErroPonte =
  | "desligado" // env ausente no Cockpit
  | "nao_autorizado" // 401/403 — token errado
  | "invalido" // 400/422 — pedido fora do contrato
  | "nao_encontrado" // 404
  | "cliente_4xx" // outro 4xx
  | "indisponivel" // 5xx (503 = ponte sem token no servidor do Roteirizador)
  | "timeout"
  | "rede"
  | "resposta_invalida"; // 2xx com corpo fora do contrato

export interface ErroPonte {
  tipo: TipoErroPonte;
  status: number | null;
  mensagem: string;
  tentativas: number;
}

export type ResultadoPonte<T> =
  | { ok: true; dados: T }
  | { ok: false; erro: ErroPonte };

// ── env ──────────────────────────────────────────────────────────────────────

export interface RoteirizadorPonteEnv {
  /** Base da API do Roteirizador, SEM o sufixo /v3/ponte. */
  apiUrl: string;
  token: string;
}

/** null = ponte desligada (qualquer das duas envs ausente/vazia). */
export function readRoteirizadorPonteEnv(
  env: Record<string, string | undefined>,
): RoteirizadorPonteEnv | null {
  const apiUrl = (env["ROTEIRIZADOR_API_URL"] ?? "").trim();
  const token = (env["ROTEIRIZADOR_PONTE_TOKEN"] ?? "").trim();
  if (!apiUrl || !token) return null;
  return { apiUrl: apiUrl.replace(/\/+$/, ""), token };
}

// ── cliente ──────────────────────────────────────────────────────────────────

export interface RoteirizadorPonteClient {
  /** false = env ausente; todo método devolve erro `desligado` sem rede. */
  readonly ligado: boolean;
  consultarNota(ctrc: string): Promise<ResultadoPonte<NotaPonte>>;
  registrarCompromisso(c: CompromissoPonte): Promise<ResultadoPonte<CompromissoRegistrado>>;
  listarEventos(desde: number, limite?: number): Promise<ResultadoPonte<PaginaEventosPonte>>;
}

export interface RoteirizadorPonteDeps {
  env: RoteirizadorPonteEnv | null;
  fetch?: typeof fetch;
  /** ms por tentativa. */
  timeoutMs?: number;
  /** total de tentativas (1 = sem retry). */
  maxTentativas?: number;
  /** base do backoff exponencial (ms): base, 2·base, 4·base… */
  backoffBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const PONTE_TIMEOUT_MS_PADRAO = 4000;
export const PONTE_MAX_TENTATIVAS_PADRAO = 3;
export const PONTE_BACKOFF_BASE_MS_PADRAO = 250;
export const PONTE_LIMITE_EVENTOS_PADRAO = 200;

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function tipoErroPorStatus(status: number): TipoErroPonte {
  if (status === 401 || status === 403) return "nao_autorizado";
  if (status === 400 || status === 422) return "invalido";
  if (status === 404) return "nao_encontrado";
  if (status >= 500) return "indisponivel";
  return "cliente_4xx";
}

function ehErroDeTimeout(e: unknown): boolean {
  return e instanceof DOMException
    ? e.name === "AbortError" || e.name === "TimeoutError"
    : (e as { name?: string } | null)?.name === "AbortError";
}

export function createRoteirizadorPonteClient(
  deps: RoteirizadorPonteDeps,
): RoteirizadorPonteClient {
  const f = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? PONTE_TIMEOUT_MS_PADRAO;
  const maxTentativas = Math.max(1, deps.maxTentativas ?? PONTE_MAX_TENTATIVAS_PADRAO);
  const backoffBaseMs = deps.backoffBaseMs ?? PONTE_BACKOFF_BASE_MS_PADRAO;
  const sleep = deps.sleep ?? dormir;
  const env = deps.env;

  async function chamar(
    metodo: "GET" | "POST",
    caminho: string,
    corpo?: unknown,
  ): Promise<ResultadoPonte<{ status: number; json: unknown }>> {
    if (!env) {
      return {
        ok: false,
        erro: { tipo: "desligado", status: null, mensagem: "ROTEIRIZADOR_API_URL/ROTEIRIZADOR_PONTE_TOKEN ausentes", tentativas: 0 },
      };
    }
    const url = `${env.apiUrl}/v3/ponte${caminho}`;
    let ultimo: ErroPonte = { tipo: "rede", status: null, mensagem: "sem tentativa", tentativas: 0 };

    for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await f(url, {
          method: metodo,
          headers: {
            "Authorization": `Bearer ${env.token}`,
            "Accept": "application/json",
            ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
          signal: ctrl.signal,
        });
        const texto = await res.text().catch(() => "");
        let json: unknown = null;
        if (texto) {
          try { json = JSON.parse(texto); } catch { json = null; }
        }
        if (res.ok) {
          if (json === null) {
            return {
              ok: false,
              erro: { tipo: "resposta_invalida", status: res.status, mensagem: "corpo não é JSON", tentativas: tentativa },
            };
          }
          return { ok: true, dados: { status: res.status, json } };
        }
        const tipo = tipoErroPorStatus(res.status);
        const detalhe = (json as { erro?: string; error?: string } | null)?.erro ??
          (json as { error?: string } | null)?.error ?? texto.slice(0, 200);
        ultimo = { tipo, status: res.status, mensagem: `HTTP ${res.status}: ${detalhe}`, tentativas: tentativa };
        // 4xx: o pedido está errado — repetir não conserta.
        if (res.status < 500) return { ok: false, erro: ultimo };
      } catch (e) {
        ultimo = ehErroDeTimeout(e)
          ? { tipo: "timeout", status: null, mensagem: `timeout ${timeoutMs}ms`, tentativas: tentativa }
          : { tipo: "rede", status: null, mensagem: e instanceof Error ? e.message : String(e), tentativas: tentativa };
      } finally {
        clearTimeout(timer);
      }
      if (tentativa < maxTentativas) await sleep(backoffBaseMs * 2 ** (tentativa - 1));
    }
    return { ok: false, erro: ultimo };
  }

  function invalida(status: number, mensagem: string): { ok: false; erro: ErroPonte } {
    return { ok: false, erro: { tipo: "resposta_invalida", status, mensagem, tentativas: 1 } };
  }

  return {
    ligado: env !== null,

    async consultarNota(ctrc) {
      const alvo = (ctrc ?? "").trim();
      if (!alvo) {
        return { ok: false, erro: { tipo: "invalido", status: null, mensagem: "ctrc vazio", tentativas: 0 } };
      }
      const r = await chamar("GET", `/notas/${encodeURIComponent(alvo)}`);
      if (!r.ok) return r;
      const j = r.dados.json as Partial<NotaNoPlano> & { noPlano?: unknown };
      if (typeof j?.noPlano !== "boolean") return invalida(r.dados.status, "noPlano ausente");
      if (!Array.isArray(j.compromissos)) j.compromissos = [];
      return { ok: true, dados: j as NotaPonte };
    },

    async registrarCompromisso(c) {
      if (!c.idempotencyKey) {
        return { ok: false, erro: { tipo: "invalido", status: null, mensagem: "idempotencyKey obrigatória", tentativas: 0 } };
      }
      const r = await chamar("POST", "/compromissos", c);
      if (!r.ok) return r;
      if (r.dados.status !== 200 && r.dados.status !== 201) {
        return invalida(r.dados.status, `status inesperado ${r.dados.status}`);
      }
      return {
        ok: true,
        dados: { criado: r.dados.status === 201, status: r.dados.status, corpo: r.dados.json },
      };
    },

    async listarEventos(desde, limite = PONTE_LIMITE_EVENTOS_PADRAO) {
      const d = Number.isFinite(desde) && desde > 0 ? Math.floor(desde) : 0;
      const l = Math.max(1, Math.min(PONTE_LIMITE_EVENTOS_PADRAO, Math.floor(limite)));
      const r = await chamar("GET", `/eventos?desde=${d}&limite=${l}`);
      if (!r.ok) return r;
      const j = r.dados.json as Partial<PaginaEventosPonte>;
      if (!Array.isArray(j?.eventos) || typeof j.proximo !== "number") {
        return invalida(r.dados.status, "página de eventos fora do contrato");
      }
      return { ok: true, dados: { desde: typeof j.desde === "number" ? j.desde : d, proximo: j.proximo, eventos: j.eventos } };
    },
  };
}

/** Atalho: cliente a partir do env do processo (Deno.env.toObject()). */
export function createRoteirizadorPonteClientFromEnv(
  env: Record<string, string | undefined>,
  extra: Omit<RoteirizadorPonteDeps, "env"> = {},
): RoteirizadorPonteClient {
  return createRoteirizadorPonteClient({ ...extra, env: readRoteirizadorPonteEnv(env) });
}
