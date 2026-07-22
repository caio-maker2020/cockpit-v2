import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import "./index.css";

// Caio 2026-07-22 (tela branca NF 556392): erros fora do render também ganham
// registro com prefixo [cockpit-crash] — F12 → console → filtrar "cockpit-crash".
window.addEventListener("error", (e) => {
  console.error("[cockpit-crash] window.onerror:", e.message, e.filename, e.lineno);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[cockpit-crash] unhandledrejection:", e.reason);
});

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
