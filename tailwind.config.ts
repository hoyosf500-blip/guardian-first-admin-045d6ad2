import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

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
        sans: ["'Inter'", "system-ui", "-apple-system", "sans-serif"],
        mono: ["'JetBrains Mono'", "monospace"],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
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
        accent2: "hsl(var(--accent2))",
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        surface: "hsl(var(--surface))",
        "border-strong": "hsl(var(--border-strong))",
        subtle: "hsl(var(--subtle))",
        "accent-muted": "hsl(var(--accent-muted))",
        "accent-border": "hsl(var(--accent-border))",
        card2: "hsl(var(--card2))",
        green: "hsl(var(--green))",
        red: "hsl(var(--red))",
        orange: "hsl(var(--orange))",
        blue: "hsl(var(--blue))",
        cyan: "hsl(var(--cyan))",
        purple: "hsl(var(--purple))",
        yellow: "hsl(var(--yellow))",
        // Design system v2 — semantic tokens (CRM Data-Dense)
        brand: {
          DEFAULT: "hsl(var(--brand))",
          foreground: "hsl(var(--brand-foreground))",
        },
        cta: {
          DEFAULT: "hsl(var(--cta))",
          foreground: "hsl(var(--cta-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        danger: {
          DEFAULT: "hsl(var(--danger))",
          foreground: "hsl(var(--danger-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
        },
        ai: {
          DEFAULT: "hsl(var(--ai))",
          foreground: "hsl(var(--ai-foreground))",
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
        lg: "var(--radius)",           /* 8px */
        md: "calc(var(--radius) - 2px)", /* 6px inputs/badges */
        sm: "calc(var(--radius) - 4px)", /* 4px tight */
        xl: "calc(var(--radius) + 4px)", /* 12px large cards */
      },
      boxShadow: {
        /* Dirección 3D — card, glow de acento y elevación del rail */
        card3d: "0 20px 50px -30px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.05)",
        "card3d-lg": "0 30px 70px -30px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.08)",
        glow3d: "0 0 18px -6px hsl(var(--accent))",
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
        /* ── Dirección 3D · solo transform/opacity (compositor GPU) ── */
        "gb-float": {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-10px)" },
        },
        "gb-spin": { to: { transform: "rotate(360deg)" } },
        "gb-draw": { to: { strokeDashoffset: "0" } },
        "gb-rise": {
          from: { transform: "scaleY(0)", opacity: "0" },
          to: { transform: "scaleY(1)", opacity: "1" },
        },
        "gb-pulse": {
          "0%, 100%": { opacity: ".5" },
          "50%": { opacity: "1" },
        },
        "gb-sheen": {
          "0%": { transform: "translateX(-130%) skewX(-18deg)" },
          "55%, 100%": { transform: "translateX(320%) skewX(-18deg)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "gb-float": "gb-float 11s ease-in-out infinite",
        "gb-spin": "gb-spin 9s linear infinite",
        "gb-draw": "gb-draw 1.4s ease .3s forwards",
        "gb-rise": "gb-rise .6s ease both",
        "gb-pulse": "gb-pulse 2s infinite",
        "gb-sheen": "gb-sheen 7s ease-in-out infinite",
      },
    },
  },
  plugins: [tailwindcssAnimate],
} satisfies Config;
