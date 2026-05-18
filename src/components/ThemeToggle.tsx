import { useEffect, useState } from "react";
import { MdOutlineDarkMode, MdOutlineLightMode } from "react-icons/md";

function readTheme(): "dark" | "light" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [path, setPath] = useState("/");

  useEffect(() => {
    setTheme(readTheme());
    const update = () => {
      setPath(window.location.pathname);
      setTheme(readTheme());
    };
    update();
    document.addEventListener("astro:after-swap", update);
    return () => document.removeEventListener("astro:after-swap", update);
  }, []);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      localStorage.setItem("theme", next);
    } catch {}
  };

  if (path === "/") {
    return <div className="sm:w-8 sm:h-8" />;
  }

  return (
    <div className="w-8 h-8 flex items-center justify-center rounded-xl active:text-secondary-text">
      <button type="button" onClick={toggle} aria-label="Toggle theme">
        {theme === "dark" ? <MdOutlineLightMode size={22} /> : <MdOutlineDarkMode size={22} />}
      </button>
    </div>
  );
}
