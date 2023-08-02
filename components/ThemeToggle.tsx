"use client";

import { useEffect, useState } from "react";
import { MetaButton } from "./MetaButton";
import { MdOutlineDarkMode, MdOutlineLightMode } from "react-icons/md";

export default function ThemeToggle() {
  const [isDark, setIsDark] = useState(true);

  const handleToggle = () => {
    setIsDark(!isDark);
  };

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [isDark]);

  return (
    <MetaButton>
      <button type="button" className="rounded-full flex items-center justify-center" onClick={handleToggle}>
        {isDark ? <MdOutlineLightMode size={20} /> : <MdOutlineDarkMode size={20} />}
      </button>
    </MetaButton>
  );
}
