import DOMPurify from "dompurify";

// Interop robusto DOMPurify v3: no browser (Vite build) o default já vem
// instanciado (tem `.sanitize`); em alguns ambientes (resolução CJS no vitest)
// o default é a FACTORY e precisa receber a window. Cobre os dois.
const purify: { sanitize: (dirty: string, cfg?: Record<string, unknown>) => string } =
  typeof (DOMPurify as unknown as { sanitize?: unknown }).sanitize === "function"
    ? (DOMPurify as unknown as { sanitize: (d: string, c?: Record<string, unknown>) => string })
    : (DOMPurify as unknown as (w: unknown) => { sanitize: (d: string, c?: Record<string, unknown>) => string })(
        typeof window !== "undefined" ? window : globalThis,
      );

/**
 * Sanitiza HTML antes de renderizar via `dangerouslySetInnerHTML`.
 *
 * Por que existe: dois pontos do front renderizam HTML cru — o corpo de e-mail
 * SUGERIDO PELA IA (`corpo_sugerido`) e o preview de cobrança montado por
 * interpolação de dados internos (base/usuário). HTML de IA ou interpolado sem
 * escape é vetor de XSS armazenado: um cliente malicioso pode injetar conteúdo
 * numa mensagem, a IA reproduz, e o `<script>`/`onerror=` executaria na sessão
 * do gestor. DOMPurify remove script, handlers de evento e URLs perigosas,
 * preservando a formatação legítima do e-mail (tabelas, negrito, links).
 */
export function sanitizeHtml(dirty: string | null | undefined): string {
  if (!dirty) return "";
  return purify.sanitize(dirty, {
    // Sem <script>, sem event handlers (on*), sem javascript: — default do
    // DOMPurify já bloqueia isso; deixamos explícito o alvo de links.
    ALLOWED_ATTR: [
      "href", "src", "alt", "title", "colspan", "rowspan",
      "border", "cellpadding", "cellspacing", "style", "align", "width", "height",
    ],
    ADD_ATTR: ["target"],
    FORBID_TAGS: ["script", "style", "iframe", "form", "object", "embed"],
    FORBID_ATTR: ["onerror", "onload", "onclick"],
  });
}
