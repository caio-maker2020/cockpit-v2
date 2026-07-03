import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      fontFamily: {
        // Fatia 1: tipografia neutra moderna (system-ui), sem Bricolage.
        sans: ["-apple-system", "BlinkMacSystemFont", "SF Pro Text", "Segoe UI", "system-ui", "sans-serif"],
        ui: ["-apple-system", "BlinkMacSystemFont", "SF Pro Text", "Segoe UI", "system-ui", "sans-serif"],
        body: ["-apple-system", "BlinkMacSystemFont", "SF Pro Text", "Segoe UI", "system-ui", "sans-serif"],
        display: ["-apple-system", "BlinkMacSystemFont", "SF Pro Display", "Segoe UI", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      fontSize: {
        micro:    ["10px", { lineHeight: "1.3",  letterSpacing: "0.08em" }],
        label:    ["11px", { lineHeight: "1.4",  letterSpacing: "0.06em" }],
        caption:  ["12px", { lineHeight: "1.45" }],
        body:     ["14px", { lineHeight: "1.55" }],
        "body-lg":["15px", { lineHeight: "1.6"  }],
        lead:     ["17px", { lineHeight: "1.55" }],
        h6:       ["18px", { lineHeight: "1.4",  letterSpacing: "-0.005em" }],
        h5:       ["22px", { lineHeight: "1.3",  letterSpacing: "-0.01em" }],
        h4:       ["28px", { lineHeight: "1.2",  letterSpacing: "-0.015em" }],
        h3:       ["34px", { lineHeight: "1.15", letterSpacing: "-0.02em" }],
        h2:       ["44px", { lineHeight: "1.1",  letterSpacing: "-0.025em" }],
        h1:       ["56px", { lineHeight: "1.05", letterSpacing: "-0.03em" }],
      },
      colors: {
        /* === Cockpit 2.0 direct semantic tokens === */
        bg: "var(--bg)",
        "bg-elevated": "var(--bg-elevated)",
        "bg-subtle": "var(--bg-subtle)",
        "bg-muted": "var(--bg-muted)",
        signal: {
          DEFAULT: "var(--signal)",
          soft: "var(--signal-soft)",
          strong: "var(--signal-strong)",
        },
        ai: {
          DEFAULT: "var(--ai)",
          soft: "var(--ai-soft)",
          strong: "var(--ai-strong)",
        },
        positive: {
          DEFAULT: "var(--positive)",
          soft: "var(--positive-soft)",
        },
        warning: {
          DEFAULT: "var(--warning)",
          soft: "var(--warning-soft)",
        },
        negative: {
          DEFAULT: "var(--negative)",
          soft: "var(--negative-soft)",
        },
        /* === Legacy shadcn tokens (HSL) === */
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
          50: "hsl(var(--primary-50))",
          100: "hsl(var(--primary-100))",
          500: "hsl(var(--primary-500))",
          600: "hsl(var(--primary-600))",
          700: "hsl(var(--primary-700))",
        },
        sal: {
          DEFAULT: "hsl(var(--sal))",
          deep: "hsl(var(--sal-deep))",
          tint: "hsl(var(--sal-tint))",
        },
        paper: {
          DEFAULT: "hsl(var(--paper))",
          deep: "hsl(var(--paper-deep))",
        },
        ink: {
          DEFAULT: "hsl(var(--ink))",
          soft: "hsl(var(--ink-soft))",
        },
        rule: {
          DEFAULT: "hsl(var(--rule))",
          strong: "hsl(var(--rule-strong))",
        },
        warn: {
          DEFAULT: "hsl(var(--status-wait))",
          tint: "hsl(var(--status-wait-soft))",
        },
        good: {
          DEFAULT: "hsl(var(--status-ok))",
          tint: "hsl(var(--status-ok-soft))",
        },
        info: {
          DEFAULT: "hsl(var(--status-run))",
          tint: "hsl(var(--status-run-soft))",
        },
        surface: {
          DEFAULT: "hsl(var(--surface))",
          alt: "hsl(var(--surface-alt))",
        },
        kanban: {
          new: "hsl(var(--kanban-new))",
          processing: "hsl(var(--kanban-processing))",
          action: "hsl(var(--kanban-action))",
          client: "hsl(var(--kanban-client))",
          ssw: "hsl(var(--kanban-ssw))",
          done: "hsl(var(--kanban-done))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        status: {
          ok: {
            DEFAULT: "hsl(var(--status-ok))",
            foreground: "hsl(var(--status-ok-foreground))",
            soft: "hsl(var(--status-ok-soft))",
          },
          wait: {
            DEFAULT: "hsl(var(--status-wait))",
            foreground: "hsl(var(--status-wait-foreground))",
            soft: "hsl(var(--status-wait-soft))",
          },
          block: {
            DEFAULT: "hsl(var(--status-block))",
            foreground: "hsl(var(--status-block-foreground))",
            soft: "hsl(var(--status-block-soft))",
          },
          run: {
            DEFAULT: "hsl(var(--status-run))",
            foreground: "hsl(var(--status-run-foreground))",
            soft: "hsl(var(--status-run-soft))",
          },
          ai: {
            DEFAULT: "hsl(var(--status-ai))",
            foreground: "hsl(var(--status-ai-foreground))",
            soft: "hsl(var(--status-ai-soft))",
          },
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 0px)",
        sm: "calc(var(--radius) - 0px)",
      },
      boxShadow: {
        flat: "4px 4px 0 hsl(var(--ink))",
        "flat-sm": "2px 2px 0 hsl(var(--ink))",
        press: "1px 1px 0 hsl(var(--ink))",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        asteriskSpin: {
          "0%": { transform: "rotate(0deg)" },
          "100%": { transform: "rotate(360deg)" },
        },
        softFade: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "asterisk-spin": "asteriskSpin 18s linear infinite",
        "soft-fade": "softFade 0.6s ease-out both",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
