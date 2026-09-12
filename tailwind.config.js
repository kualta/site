/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  theme: {
    colors: {
      "secondary-text": "var(--secondary-text)",
      primary: "var(--primary)",
      secondary: "var(--secondary)",
      bg: "var(--bg)",
      text: "var(--text)",
      dark: {
        primary: "var(--primary-dark)",
        secondary: "var(--secondary-dark)",
        bg: "var(--bg-dark)",
        text: "var(--text-dark)",
      },
    },
    extend: {
      borderRadius: {
        sm: "0.25rem",
        DEFAULT: "0.375rem",
        md: "0.5rem",
        lg: "0.75rem",
        xl: "1rem",
        "2xl": "1.5rem",
        "3xl": "2rem",
      },
      dropShadow: {
        glow: ["0 0px 10px rgba(255, 255, 255, 0.5) ", "0 0px 10px rgba(255, 255, 255, 0.4)"],
        "glow-sm": ["0 0px 5px rgba(255, 255, 255, 0.5) ", "0 0px 5px rgba(255, 255, 255, 0.4)"],
        "glow-dark": ["0 0px 10px rgba(0, 0, 0, 0.4)", "0 0px 20px rgba(0, 0, 0, 0.4)"],
      },
    },
  },
  content: ["./src/**/*.{astro,html,js,jsx,ts,tsx,md,mdx}"],
  plugins: [require("@tailwindcss/typography")],
};
