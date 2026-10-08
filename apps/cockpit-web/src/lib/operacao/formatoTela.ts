// Formatação e download das telas da Operação (Gestão, Comprovantes). Sem estado, sem rede.

export const n = (v: number) => v.toLocaleString("pt-BR");
export const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

/** Baixa um texto (CSV) no navegador, com BOM para o Excel abrir em UTF-8. Não envia nada. */
export function baixarTexto(nomeArquivo: string, texto: string) {
  const blob = new Blob(["\uFEFF" + texto], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nomeArquivo;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const hojeIso = (agoraMs: number) => new Date(agoraMs - 3 * 3_600_000).toISOString().slice(0, 10);
