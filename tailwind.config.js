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
      dropShadow: {
        glow: ["0 0px 10px rgba(255, 255, 255, 0.5) ", "0 0px 10px rgba(255, 255, 255, 0.4)"],
        "glow-sm": ["0 0px 5px rgba(255, 255, 255, 0.5) ", "0 0px 5px rgba(255, 255, 255, 0.4)"],
        "glow-dark": ["0 0px 10px rgba(0, 0, 0, 0.4)", "0 0px 20px rgba(0, 0, 0, 0.4)"],
      },
    },
  },
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}"],
  plugins: [require("@tailwindcss/typography")],
};
