// =============================================================================
// theme — modo escuro OPCIONAL do Cockpit (Caio 2026-08-27).
//
// Contrato (INV-112):
//   1. O padrão é SEMPRE o claro — quem nunca clicou vê o Cockpit exatamente
//      como hoje (nenhum byte de CSS do claro muda com esta feature).
//   2. A escolha é por NAVEGADOR/pessoa (localStorage), não por conta — igual
//      a qualquer app com toggle de tema.
//   3. Aplicar tema = presença/ausência da classe `dark` no <html>. Nenhuma
//      lógica de negócio lê o tema; é 100% visual.
//   4. Valor desconhecido/corrompido no storage cai no claro (fail-safe).
// =============================================================================

export type Tema = "claro" | "escuro";

export const CHAVE_TEMA = "cockpit_tema";

/** PURO: normaliza qualquer valor de storage pro contrato (fail-safe claro). */
export function normalizarTema(bruto: string | null | undefined): Tema {
  return bruto === "escuro" ? "escuro" : "claro";
}

export function lerTema(): Tema {
  try {
    return normalizarTema(localStorage.getItem(CHAVE_TEMA));
  } catch {
    return "claro"; // storage bloqueado (iframe/priv) → padrão
  }
}

/** Aplica no DOM e persiste. Única porta de escrita do tema. */
export function aplicarTema(tema: Tema): void {
  document.documentElement.classList.toggle("dark", tema === "escuro");
  try {
    localStorage.setItem(CHAVE_TEMA, tema);
  } catch {
    // sem storage → o tema vale só pra sessão atual; nada quebra
  }
}

export function alternarTema(): Tema {
  const novo: Tema = lerTema() === "escuro" ? "claro" : "escuro";
  aplicarTema(novo);
  return novo;
}
