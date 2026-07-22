import React from "react";

/**
 * AIRBAG global — Caio 2026-07-22 (NF 556392, vídeo do FELIPE).
 *
 * Sem isto, QUALQUER exceção de render derruba a árvore React inteira e a
 * página fica 100% BRANCA e morta — sem mensagem, sem stack, sem recuperação.
 * Foi exatamente o sintoma do bug da tela branca, e a ausência de registro
 * impediu a captura do gatilho exato (não reproduzível em 4 tentativas).
 *
 * Com o airbag: o crash vira uma tela de erro amigável com botão de recarregar
 * e o STACK VISÍVEL (bloco expansível) — o operador manda um print e temos o
 * gatilho na hora. O erro também vai pro console com o prefixo [cockpit-crash]
 * (F12 → filtrar por cockpit-crash) e fica em localStorage (último crash).
 */
type Props = { children: React.ReactNode };
type State = { error: Error | null; info: string | null };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const registro = {
      quando: new Date().toISOString(),
      url: window.location.href,
      erro: String(error?.message ?? error),
      stack: error?.stack ?? null,
      componente: info?.componentStack ?? null,
    };
    // eslint-disable-next-line no-console
    console.error("[cockpit-crash]", registro);
    try {
      localStorage.setItem("cockpit_ultimo_crash", JSON.stringify(registro));
    } catch {
      /* localStorage cheio/indisponível — o console já registrou */
    }
    this.setState({ info: info?.componentStack ?? null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const { error, info } = this.state;
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#faf9f6", padding: 24 }}>
        <div style={{ maxWidth: 640, border: "2px solid #1a1a1a", background: "#fff", padding: 24, fontFamily: "ui-monospace, monospace" }}>
          <div style={{ fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
            ⚠️ Algo quebrou nesta tela
          </div>
          <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 16 }}>
            O erro foi registrado. Clique em recarregar pra voltar ao Cockpit —
            seu trabalho no SSW/e-mail <strong>não</strong> foi afetado por esta tela.
            Se acontecer de novo, tire um print desta caixa (incluindo os detalhes
            abaixo) e mande pro suporte.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{ background: "#1a1a1a", color: "#fff", padding: "10px 18px", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, border: 0, cursor: "pointer", marginBottom: 16 }}
          >
            ↻ Recarregar o Cockpit
          </button>
          <details style={{ fontSize: 11 }}>
            <summary style={{ cursor: "pointer", marginBottom: 8 }}>Detalhes técnicos (pro suporte)</summary>
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", background: "#f4f2ed", padding: 12, maxHeight: 240, overflow: "auto" }}>
              {String(error?.message ?? error)}
              {"\n\n"}
              {error?.stack ?? ""}
              {info ? `\n\ncomponente:\n${info}` : ""}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
