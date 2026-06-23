// =============================================================================
// email-format — validação pragmática de formato de e-mail. Função PURA,
// testável, reusável (gmail-sender, executor, redator).
//
// Caio 2026-06-23 (NF 45156, VIP SPORTS NUTR): o contato `nfe@vipshowroom.com.b`
// estava truncado na fonte (faltou o "r" de `.com.br`). O Gmail rejeita com
// HTTP 400 "Invalid To header" e o front mostrava "nada" (envio é assíncrono).
// Validar o formato ANTES de chamar a API transforma o erro silencioso num
// erro claro e acionável. Exige local@host.tld com TLD de ≥2 letras → pega o
// `.com.b` (TLD de 1 char) e aceita `.com.br`.
// =============================================================================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

export function isEmailFormatoValido(email: string | null | undefined): boolean {
  if (typeof email !== "string") return false;
  return EMAIL_RE.test(email.trim());
}
