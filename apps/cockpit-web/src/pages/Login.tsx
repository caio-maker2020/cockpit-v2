import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";
import { SalLogo } from "@/components/SalLogo";

function Field({
  label, type, value, onChange, placeholder, autoFocus, disabled,
}: {
  label: string;
  type: "email" | "password";
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-2 block font-body text-label uppercase text-ink-mute">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete={type === "email" ? "username" : "current-password"}
        className="w-full rounded-md border border-hairline-strong bg-bg-elevated px-3 py-2.5 font-body text-body text-ink-2 placeholder:text-ink-disabled focus:border-ink-2 focus:outline-none focus:ring-2 focus:ring-ink-2/10 disabled:opacity-50 transition-colors"
        style={{ borderColor: "var(--c-border-strong)", color: "var(--c-ink)" }}
      />
    </label>
  );
}

export default function Login() {
  const { session, signIn, configured } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotMessage, setForgotMessage] = useState<string | null>(null);

  useEffect(() => {
    if (session) navigate("/inbox", { replace: true });
  }, [session, navigate]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!configured) {
      setErro("Sistema não conectado.");
      return;
    }
    setLoading(true);
    setErro(null);
    const { error } = await signIn(email.trim().toLowerCase(), senha);
    setLoading(false);
    if (error) {
      setErro("Email ou senha incorretos.");
      return;
    }
    navigate("/inbox", { replace: true });
  };

  const handleForgot = async (e: FormEvent) => {
    e.preventDefault();
    if (!forgotEmail.trim()) return;
    setForgotLoading(true);
    setForgotMessage(null);
    try {
      if (supabase) {
        await supabase.functions.invoke("recuperar-senha-operador", {
          body: { email: forgotEmail.trim().toLowerCase() },
        });
      }
    } catch {
      // genérico de propósito
    }
    setForgotLoading(false);
    setForgotMessage(
      "Se o e-mail estiver cadastrado, você receberá uma nova senha em instantes. Confira a caixa de entrada (e o spam). Recomendamos trocar a senha após entrar."
    );
  };

  const year = new Date().getFullYear();

  return (
    <div
      className="relative min-h-screen w-full overflow-hidden"
      style={{ backgroundColor: "var(--bg)" }}
    >
      {/* Decorativo: COCKPIT gigante display, baixíssima opacidade, bottom-left */}
      <div
        className="pointer-events-none absolute inset-0 flex items-end justify-start overflow-hidden"
        aria-hidden
      >
        <span
          className="font-display select-none leading-[0.8]"
          style={{
            fontSize: "clamp(200px, 32vw, 520px)",
            opacity: 0.04,
            color: "var(--c-ink)",
            fontWeight: 500,
            letterSpacing: "-0.04em",
            transform: "translate(-3vw, 6vw)",
            whiteSpace: "nowrap",
          }}
        >
          COCKPIT
        </span>
      </div>

      <div className="relative z-10 grid min-h-screen md:grid-cols-[1fr_minmax(420px,40%)]">
        {/* Esquerda: marca + tagline */}
        <div className="hidden md:flex flex-col justify-between p-10">
          <SalLogo size={22} subtag="Logistics OS · v2026.05" />

          <div className="max-w-md">
            <p className="font-body text-label uppercase" style={{ color: "var(--signal)", letterSpacing: "0.08em" }}>
              / 01 · Operacional
            </p>
            <p className="mt-4 font-display" style={{ color: "var(--c-ink)", fontSize: "44px", fontWeight: 700, letterSpacing: "-0.025em", lineHeight: 1.05 }}>
              Cockpit do time de <em style={{ fontStyle: "italic", fontWeight: 700 }}>relacionamento.</em>
            </p>
            <p className="mt-5 font-body text-body-lg" style={{ color: "var(--c-ink-soft)" }}>
              Cards, propostas e ações dos agentes —
              acompanhados em tempo real, validados por gente.
            </p>
          </div>

          <div className="font-mono text-micro uppercase" style={{ letterSpacing: "0.2em", color: "var(--c-ink-mute)" }}>
            Sal·Express · {year}
          </div>
        </div>

        {/* Direita: form */}
        <div className="flex flex-col justify-center px-6 py-12 md:px-12 md:border-l" style={{ borderColor: "var(--c-border)" }}>
          {/* Brand mobile */}
          <div className="mb-10 md:hidden">
            <SalLogo size={20} subtag="Logistics OS" />
          </div>

          <div className="w-full max-w-[360px]">
            <p className="font-body text-label uppercase" style={{ color: "var(--signal)", letterSpacing: "0.08em" }}>
              / 01 · Acesso
            </p>
            <h1
              className="mt-2 font-display"
              style={{ color: "var(--c-ink)", fontSize: "34px", fontWeight: 700, letterSpacing: "-0.025em", lineHeight: 1.1 }}
            >
              Entrar no <em style={{ fontStyle: "italic", fontWeight: 700 }}>Cockpit</em>
            </h1>
            <p className="mt-1.5 font-mono text-caption" style={{ color: "var(--c-ink-mute)", letterSpacing: "0.04em" }}>
              Time de Relacionamento · Sal·Express
            </p>

            <div className="my-8 h-px w-full" style={{ background: "var(--c-border)" }} aria-hidden />

            <form onSubmit={handleSubmit} className="space-y-5">
              <Field
                label="Email"
                type="email"
                value={email}
                onChange={setEmail}
                placeholder="nome@salexpress.com.br"
                autoFocus
                disabled={loading}
              />
              <Field
                label="Senha"
                type="password"
                value={senha}
                onChange={setSenha}
                placeholder="••••••••"
                disabled={loading}
              />

              {erro && (
                <div
                  role="alert"
                  className="rounded-md px-3 py-2.5 font-body text-caption"
                  style={{
                    background: "var(--negative-soft)",
                    color: "var(--negative)",
                    borderLeft: "3px solid var(--negative)",
                  }}
                >
                  {erro}
                </div>
              )}

              <button
                type="submit"
                disabled={loading || !email || !senha}
                className="group mt-2 flex w-full items-center justify-between rounded-md px-5 py-3 font-body text-body font-medium transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40 active:scale-[0.99]"
                style={{
                  background: "var(--c-ink)",
                  color: "var(--bg)",
                }}
              >
                <span>{loading ? "Entrando…" : "Entrar"}</span>
                <span className="inline-block transition-transform duration-200 group-hover:translate-x-1">→</span>
              </button>

              {!forgotOpen && !forgotMessage && (
                <button
                  type="button"
                  onClick={() => setForgotOpen(true)}
                  className="mt-1 block font-body text-caption underline-offset-2 hover:underline"
                  style={{ color: "var(--c-ink-soft)" }}
                >
                  Esqueci minha senha
                </button>
              )}

              {!configured && (
                <p className="mt-4 font-mono text-micro uppercase" style={{ color: "var(--c-ink-mute)", letterSpacing: "0.12em" }}>
                  Lovable Cloud não conectado — habilite a integração.
                </p>
              )}
            </form>

            {forgotOpen && (
              <div
                className="mt-6 rounded-md p-4"
                style={{ background: "var(--bg-subtle)", border: "1px solid var(--c-border)" }}
              >
                {forgotMessage ? (
                  <>
                    <p className="font-body text-caption" style={{ color: "var(--c-ink)" }}>
                      {forgotMessage}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setForgotOpen(false);
                        setForgotMessage(null);
                        setForgotEmail("");
                      }}
                      className="mt-3 font-body text-caption underline-offset-2 hover:underline"
                      style={{ color: "var(--c-ink-soft)" }}
                    >
                      ← Voltar ao login
                    </button>
                  </>
                ) : (
                  <form onSubmit={handleForgot} className="space-y-3">
                    <p className="font-body text-caption" style={{ color: "var(--c-ink-soft)" }}>
                      Informe o e-mail cadastrado. Vamos enviar uma nova senha para você.
                    </p>
                    <Field
                      label="Email"
                      type="email"
                      value={forgotEmail}
                      onChange={setForgotEmail}
                      placeholder="nome@salexpress.com.br"
                      disabled={forgotLoading}
                    />
                    <div className="flex items-center gap-3">
                      <button
                        type="submit"
                        disabled={forgotLoading || !forgotEmail}
                        className="rounded-md px-4 py-2 font-body text-body font-medium transition-all disabled:cursor-not-allowed disabled:opacity-40"
                        style={{ background: "var(--c-ink)", color: "var(--bg)" }}
                      >
                        {forgotLoading ? "Enviando…" : "Enviar nova senha"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setForgotOpen(false);
                          setForgotEmail("");
                        }}
                        disabled={forgotLoading}
                        className="font-body text-caption underline-offset-2 hover:underline"
                        style={{ color: "var(--c-ink-soft)" }}
                      >
                        Cancelar
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}

            <p className="mt-10 font-mono text-micro uppercase md:hidden" style={{ color: "var(--c-ink-mute)", letterSpacing: "0.2em" }}>
              Sal Express · {year} · v0.4
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
