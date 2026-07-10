// @vitest-environment jsdom
// DOMPurify precisa de um DOM real; o resto da suíte roda em node (default).
import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "./sanitizeHtml";

describe("sanitizeHtml", () => {
  it("remove <script>", () => {
    const out = sanitizeHtml('oi<script>alert(1)</script>tchau');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
  });

  it("remove handler de evento (onerror)", () => {
    const out = sanitizeHtml('<img src=x onerror="alert(1)">');
    expect(out.toLowerCase()).not.toContain("onerror");
  });

  it("remove javascript: em href", () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    expect(out.toLowerCase()).not.toContain("javascript:");
  });

  it("preserva a formatação legítima do e-mail (tabela, negrito)", () => {
    const out = sanitizeHtml("<table><tr><td><b>Base</b></td></tr></table>");
    expect(out).toContain("<table");
    expect(out).toContain("<b>");
    expect(out).toContain("Base");
  });

  it("null/undefined viram string vazia", () => {
    expect(sanitizeHtml(null)).toBe("");
    expect(sanitizeHtml(undefined)).toBe("");
  });
});
