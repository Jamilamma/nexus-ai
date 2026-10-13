/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // "Aurora" — a unique teal → violet duotone (kept the `brand` name
        // so every existing bg-brand-*/text-brand-* class across the app
        // repaints automatically without touching every page).
        brand: {
          50: "#eefcf9",
          100: "#cdf7ec",
          200: "#96eed9",
          300: "#57dcc2",
          400: "#22c3a8",
          500: "#0ea896",
          600: "#0a8a80",
          700: "#0d6f69",
        },
        // Second accent used for gradients/glows only — new, not a rename.
        aurora: {
          400: "#a78bfa",
          500: "#8b5cf6",
          600: "#7c3aed",
        },
        // Deep, slightly-teal midnight base (replaces the old plain navy
        // `ink` so glass surfaces have something with real depth to float
        // on top of).
        ink: {
          950: "#04070d",
          900: "#070b14",
          800: "#0d1420",
          700: "#16202f",
          600: "#223144",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      backgroundImage: {
        "aurora-mesh":
          "radial-gradient(circle at 12% 8%, rgba(14,168,150,0.16), transparent 42%), radial-gradient(circle at 88% 18%, rgba(139,92,246,0.14), transparent 45%), radial-gradient(circle at 50% 100%, rgba(14,168,150,0.08), transparent 55%)",
        "aurora-line": "linear-gradient(135deg, #0ea896 0%, #22c3a8 45%, #8b5cf6 100%)",
      },
      boxShadow: {
        glass: "0 8px 32px 0 rgba(2, 6, 16, 0.45)",
        "glass-inset": "inset 0 1px 0 0 rgba(255,255,255,0.06)",
        glow: "0 0 24px 0 rgba(14, 168, 150, 0.25)",
      },
      backdropBlur: {
        xs: "2px",
      },
    },
  },
  plugins: [],
};
