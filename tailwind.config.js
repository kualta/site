/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        dark: {
          primary: "#d2ade9",
          secondary: "#1d1b1c",
          accent: "#efd2e1",
          bg: "#111111",
          text: "#fdf7fa",
          shadow: [
            "0 1px 2px 0 rgba(255, 255, 255, 0.05)",
            "0 1px 3px 1px rgba(255, 255, 255, 0.1)",
            "0 0 1px 0 rgba(255, 255, 255, 0.1)",
          ],
        },
        lit: {
          primary: "#e4bed2",
          secondary: "#f2d9f2",
          accent: "#607588",
          bg: "#e7e3e2",
          text: "#191517",
        },
      },
    },
  },
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}"],
  plugins: [require("@tailwindcss/typography")],
};
