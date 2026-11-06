import type { Config } from "tailwindcss";
import colors from "tailwindcss/colors";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#20232d",       // Content and heading text
        muted: "#6b7280",     // Secondary text
        line: "#e9e9f0",      // Quiet dividers
        canvas: "#f8f9fc",    // Neutral workspace canvas
        panel: "#ffffff",     // Solid white panels
        brand: "#6236ff",     // Deep Indigo-Violet accent
        teal: { ...colors.teal, DEFAULT: "#10b981" },
        amber: { ...colors.amber, DEFAULT: "#f59e0b" },
        rose: { ...colors.rose, DEFAULT: "#ef4444" }
      },
      boxShadow: {
        soft: "0 1px 2px rgba(24, 24, 40, 0.025)"
      },
      animation: {
        "fade-in-up": "fade-in-up 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards"
      },
      keyframes: {
        "fade-in-up": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" }
        }
      }
    }
  },
  plugins: []
};

export default config;
