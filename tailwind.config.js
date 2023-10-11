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
  },
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}"],
  plugins: [require("@tailwindcss/typography")],
};
