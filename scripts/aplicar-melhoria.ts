// =============================================================================
// scripts/aplicar-melhoria.ts — aplicação DETERMINÍSTICA de uma melhoria
// aprendida (Fase 4 do chat do agente-chefe; rodado pela GitHub Action
// melhoria-pr.yml, nunca à mão em produção).
//
// Decisão de desenho (ADR 0024): a "inteligência" já aconteceu ANTES — a regra
// nasceu na conversa com a gestão e passou pelo replay. Aqui é só INSERÇÃO
// MECÂNICA no bloco-âncora do prompt do agente-alvo, pra PR sair 100%
// revisável e o CI não precisar de chave de IA nenhuma.
//
// Uso:
//   deno run --allow-read --allow-write scripts/aplicar-melhoria.ts \
//     --agente interpretador-resposta-cliente --id abc123 \
//     --titulo "comprovante ilegível vira 56" --regra-b64 <base64>
//
// Agentes com âncora (inserção direta no prompt de runtime):
//   interpretador-resposta-cliente → SYSTEM_PROMPT (index.ts)
// Demais agentes: a regra vira arquivo em prompts/aprendizados-pendentes/ e a
// PR marca "aplicação manual necessária" (regras desses agentes são código).
// =============================================================================

const ARQUIVO_COM_ANCORA: Record<string, string> = {
  "interpretador-resposta-cliente": "supabase/functions/interpretador-resposta-cliente/index.ts",
};
const MARCA_FIM = "<!-- FIM-APRENDIZADOS-GESTAO -->";

function arg(nome: string): string | null {
  const i = Deno.args.indexOf(`--${nome}`);
  return i >= 0 ? Deno.args[i + 1] ?? null : null;
}

const agente = arg("agente");
const id = arg("id");
const titulo = arg("titulo") ?? "melhoria";
const regraB64 = arg("regra-b64");
if (!agente || !id || !regraB64) {
  console.error("uso: --agente <slug> --id <melhoria_id> --titulo <curto> --regra-b64 <b64>");
  Deno.exit(1);
}
const regra = new TextDecoder().decode(
  Uint8Array.from(atob(regraB64), (c) => c.charCodeAt(0)),
).trim();
if (regra.length < 10) {
  console.error("regra vazia/curta demais");
  Deno.exit(1);
}
const dataHoje = new Date().toISOString().slice(0, 10);

const alvo = ARQUIVO_COM_ANCORA[agente];
if (alvo) {
  const src = await Deno.readTextFile(alvo);
  if (!src.includes(MARCA_FIM)) {
    console.error(`âncora ${MARCA_FIM} não encontrada em ${alvo}`);
    Deno.exit(1);
  }
  if (src.includes(`[melhoria ${id}]`)) {
    console.log("já aplicada (idempotente) — nada a fazer");
    Deno.exit(0);
  }
  const bloco = `- [melhoria ${id} · ${dataHoje}] ${regra.replace(/\s+/g, " ")}\n${MARCA_FIM}`;
  await Deno.writeTextFile(alvo, src.replace(MARCA_FIM, bloco));
  console.log(`aplicada no prompt: ${alvo}`);
} else {
  const dir = "prompts/aprendizados-pendentes";
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}/${agente}-${id}.md`;
  await Deno.writeTextFile(
    path,
    `# Melhoria ${id} — ${titulo}\n\nAgente-alvo: \`${agente}\` (regras em código — APLICAÇÃO MANUAL)\nData: ${dataHoje}\n\n## Regra aprendida com a gestão\n\n${regra}\n`,
  );
  console.log(`agente sem âncora — registrado pra aplicação manual: ${path}`);
}
