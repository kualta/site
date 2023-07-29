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
        },
        lit: {
          primary: "#e4bed2",
          secondary: "#f2d9f2",
          accent: "#607588",
          bg: "#fcfCfc",
          text: "#191517",
        },
      },
    },
  },
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}"],
  plugins: [require("@tailwindcss/typography")],
};
