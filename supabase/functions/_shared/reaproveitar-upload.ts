// =============================================================================
// reaproveitar-upload.ts — upload IDÊNTICO do mesmo to-do não vira cópia nova
// (Carlos 2026-10-07, NF 941225, INV-172).
//
// Bug: os modais da oc 33 (sozinha e 33+44) sobem TODAS as páginas JPEG do PDF
// convertido a cada clique em Confirmar, ANTES do `aprovar_e_executar`. Quando
// a RPC recusa (parede da 33, mig 365), a aprovação volta atrás mas o upload
// (outra chamada) fica pendente — e o clique seguinte sobe outra cópia. Na NF
// 941225, 4 cliques recusados em 27/08 + 1 em 28/09 encheram as 20 vagas do
// card (`limite-anexos.ts`) com só 6 arquivos distintos: quando o dossiê ficou
// completo, a oc 33 já não conseguia subir nem a 1ª página.
//
// Fix: o upload que PEDE (`reaproveitar_identico=1`) procura, ANTES do teto,
// um anexo pendente do MESMO card + MESMO to-do + mesmo nome + mesmo tamanho e
// compara os BYTES. Idêntico → devolve o registro existente (nenhuma cópia
// nova, nenhuma vaga gasta). Qualquer dúvida (sem to-do, falha de leitura,
// bytes diferentes) → segue o upload novo de sempre. O teto de 20 não muda.
//
// Por que é opt-in: o modal "e-mail + oc 33" usa o mesmo to-do em DOIS
// uploaders, e o executor apaga os anexos do e-mail (finalizarAnexosPosEnvio)
// ANTES de carregar os da 33. Se o mesmo arquivo fosse reaproveitado nas duas
// listas, a 33 ficaria sem ele. Só o caminho das páginas convertidas
// (`uploadFileAsAnexo` dos modais da 33, lista única) pede o reaproveitamento.
//
// Guard: INV-172 (docs/INVARIANTES_COCKPIT.md) + `reaproveitar-upload.test.ts`.
// =============================================================================

/** Campo do multipart com que o front pede o reaproveitamento. */
export const CAMPO_REAPROVEITAR = "reaproveitar_identico";

/** Quantas cópias candidatas, no máximo, são baixadas pra comparar os bytes. */
export const MAX_CANDIDATOS_COMPARADOS = 3;

/** True só quando o front pediu explicitamente (`"1"`). */
export function pedeReaproveitamento(valor: unknown): boolean {
  return valor === "1";
}

/** Anexo pendente que pode ser devolvido no lugar de uma cópia nova. */
export interface AnexoCandidato {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  uploaded_at: string;
}

// Mesmo padrão de `limite-anexos.ts`: só precisamos do `.from()`.
// deno-lint-ignore no-explicit-any
type SupabaseClientLike = { from(table: string): any };

/**
 * Anexos que o OPERADOR subiu (origem outbound), ainda pendentes, do mesmo
 * card e do mesmo to-do, com o mesmo nome e tamanho. Mais recente primeiro.
 * Inbound (arquivo do cliente) nunca entra: é outro registro, com outro dono.
 */
export function queryCandidatosReaproveitamento(
  supabase: SupabaseClientLike,
  args: { cardId: string; todoId: string; filename: string; sizeBytes: number },
): PromiseLike<{ data: AnexoCandidato[] | null; error: unknown }> {
  return supabase
    .from("email_anexos")
    .select("id, filename, mime_type, size_bytes, storage_path, uploaded_at")
    .eq("card_id", args.cardId)
    .eq("todo_id", args.todoId)
    .eq("origem", "outbound")
    .eq("filename", args.filename)
    .eq("size_bytes", args.sizeBytes)
    .is("enviado_em", null)
    .is("deletado_em", null)
    .order("uploaded_at", { ascending: false })
    .limit(MAX_CANDIDATOS_COMPARADOS);
}

/** Igualdade byte a byte. */
export function bytesIguais(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Primeiro candidato cujo arquivo guardado é IDÊNTICO ao novo. Nome e tamanho
 * só filtram; quem decide são os bytes. Falha ao baixar um candidato = pula
 * pro próximo (nunca lança: na dúvida, o chamador sobe cópia nova).
 */
export async function acharAnexoIdentico(
  candidatos: readonly AnexoCandidato[],
  novo: { filename: string; bytes: Uint8Array },
  baixar: (storagePath: string) => Promise<Uint8Array | null>,
): Promise<AnexoCandidato | null> {
  for (const c of candidatos.slice(0, MAX_CANDIDATOS_COMPARADOS)) {
    if (c.filename !== novo.filename) continue;
    if (Number(c.size_bytes) !== novo.bytes.byteLength) continue;
    let guardado: Uint8Array | null = null;
    try {
      guardado = await baixar(c.storage_path);
    } catch {
      guardado = null;
    }
    if (guardado && bytesIguais(guardado, novo.bytes)) return c;
  }
  return null;
}

// deno-lint-ignore no-explicit-any
type SupabaseComStorage = SupabaseClientLike & { storage: { from(bucket: string): any } };

/**
 * Por que o reaproveitamento deu ou não deu (diagnóstico, Carlos 08/10). Só
 * DESCREVE o que `reaproveitarUploadIdentico` decidiu — nunca muda a decisão.
 */
export type ResultadoReaproveitamento =
  | "reaproveitado"      // devolveu o registro existente
  | "sem_todo"           // upload sem to-do: não há escopo
  | "erro_consulta"      // a busca de candidatos falhou
  | "sem_candidato"      // nenhum pendente com mesmo to-do + nome + tamanho
  | "bytes_diferentes"   // havia candidato, baixou, e o conteúdo é outro
  | "download_falhou";   // havia candidato, mas não deu para ler o guardado

export interface DiagnosticoReaproveitamento {
  resultado: ResultadoReaproveitamento;
  candidatos: number;
  baixados: number;
}

/**
 * Devolve o anexo pendente idêntico deste to-do, ou null (= subir cópia nova).
 * Sem to-do não há reaproveitamento: o escopo é sempre UM to-do.
 * `onDiagnostico` (opcional) recebe o motivo do resultado; erro nele é ignorado.
 */
export async function reaproveitarUploadIdentico(
  supabase: SupabaseComStorage,
  args: { cardId: string; todoId: string | null; filename: string; bytes: Uint8Array },
  onDiagnostico?: (d: DiagnosticoReaproveitamento) => void,
): Promise<AnexoCandidato | null> {
  const avisar = (d: DiagnosticoReaproveitamento) => {
    try {
      onDiagnostico?.(d);
    } catch {
      // diagnóstico nunca interfere no upload
    }
  };
  if (!args.todoId) {
    avisar({ resultado: "sem_todo", candidatos: 0, baixados: 0 });
    return null;
  }
  const { data, error } = await queryCandidatosReaproveitamento(supabase, {
    cardId: args.cardId,
    todoId: args.todoId,
    filename: args.filename,
    sizeBytes: args.bytes.byteLength,
  });
  if (error || !data) {
    avisar({ resultado: "erro_consulta", candidatos: 0, baixados: 0 });
    return null;
  }
  if (data.length === 0) {
    avisar({ resultado: "sem_candidato", candidatos: 0, baixados: 0 });
    return null;
  }
  let baixados = 0;
  const achado = await acharAnexoIdentico(data, { filename: args.filename, bytes: args.bytes }, async (path) => {
    const { data: blob, error: dlErr } = await supabase.storage
      .from("email_anexos")
      .download(path);
    if (dlErr || !blob) return null;
    const bytes = new Uint8Array(await (blob as Blob).arrayBuffer());
    baixados++;
    return bytes;
  });
  avisar({
    resultado: achado ? "reaproveitado" : baixados > 0 ? "bytes_diferentes" : "download_falhou",
    candidatos: data.length,
    baixados,
  });
  return achado;
}

// ---------------------------------------------------------------------------
// Registro de diagnóstico (Carlos 08/10, NF 941225 e NF 1561134): a mesma
// página, no mesmo to-do, subiu de novo duas vezes depois da publicação, e não
// havia como saber se a tela PEDIU o reaproveitamento ou se o servidor não
// achou a cópia igual. Cada upload de página convertida de PDF (ou que pediu o
// reaproveitamento) ganha UMA linha em `audit_log` dizendo isso.
//
// Por que `audit_log` e não `card_events`: evento no card mexe no
// `last_event_at` (o relógio do card na fila) e um upload não é mudança de
// estado. Best-effort com teto de tempo: falha ou demora do registro NUNCA
// atrasa nem quebra o upload.
// ---------------------------------------------------------------------------

/** Nome que a conversão do front dá às páginas: `<pdf>_p<N>.jpg`. */
const RE_PAGINA_CONVERTIDA = /_p\d+\.jpg$/i;

/** Teto de espera do registro: passou disso, o upload segue sem ele. */
export const TIMEOUT_REGISTRO_DIAGNOSTICO_MS = 3000;

/** Registra quem pediu o reaproveitamento OU sobe página convertida com to-do. */
export function deveRegistrarDiagnostico(args: {
  pedido: boolean;
  filename: string;
  todoId: string | null;
}): boolean {
  if (args.pedido) return true;
  return !!args.todoId && RE_PAGINA_CONVERTIDA.test(args.filename);
}

export interface RegistroDiagnosticoReaproveitamento {
  cardId: string;
  todoId: string | null;
  operadorId: string;
  filename: string;
  sizeBytes: number;
  /** A tela mandou `reaproveitar_identico=1`? `false` = versão antiga da tela. */
  pedido: boolean;
  /** `null` quando não pedido (não houve busca). */
  diagnostico: DiagnosticoReaproveitamento | null;
  /** Exceção capturada no reaproveitamento, se houve. */
  erro?: string | null;
}

/** Linha do `audit_log` (pura, testável). */
export function linhaAuditDiagnostico(r: RegistroDiagnosticoReaproveitamento, idempotencyKey: string) {
  return {
    card_id: r.cardId,
    action_type: "upload_reaproveitamento_diagnostico",
    actor_type: "operator",
    actor_id: r.operadorId,
    external_system: "internal",
    idempotency_key: idempotencyKey,
    request_payload: {
      todo_id: r.todoId,
      filename: r.filename,
      size_bytes: r.sizeBytes,
      pedido: r.pedido,
      resultado: r.pedido ? (r.diagnostico?.resultado ?? (r.erro ? "erro" : null)) : "nao_pedido",
      candidatos: r.diagnostico?.candidatos ?? null,
      baixados: r.diagnostico?.baixados ?? null,
      erro: r.erro ?? null,
    },
    status: "success",
  };
}

/**
 * Grava o diagnóstico. NUNCA lança e nunca espera mais que o teto: o upload
 * segue igual com ou sem o registro.
 */
export async function registrarDiagnosticoReaproveitamento(
  supabase: SupabaseClientLike,
  r: RegistroDiagnosticoReaproveitamento,
  timeoutMs: number = TIMEOUT_REGISTRO_DIAGNOSTICO_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const insercao = Promise.resolve(
      supabase.from("audit_log").insert(linhaAuditDiagnostico(r, crypto.randomUUID())),
    ).then(() => undefined, () => undefined);
    const teto = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([insercao, teto]);
  } catch {
    // diagnóstico nunca interfere no upload
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
