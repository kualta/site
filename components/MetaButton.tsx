"use client";

import { PropsWithChildren, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MdArrowBack, MdOutlineDarkMode, MdOutlineLightMode } from "react-icons/md";

export const MetaButton = (props: PropsWithChildren) => {
  return (
    <div
      className="w-8 h-8 flex items-center justify-center rounded-md 
      hover:text-primary hover:dark:text-dark-primary 
      hover:shadow-primary/30 hover:dark:shadow-dark-primary/50 
      dark:shadow-dark-text/50 shadow-md bg-secondary dark:bg-dark-secondary m-2"
    >
      {props.children}
    </div>
  );
};

export function BackButton() {
  const path = usePathname();
  const isMainPage = path === "/";

  if (isMainPage) {
    return null;
  }

  return (
    <MetaButton>
      <Link href={"/"}>
        <MdArrowBack />
      </Link>
    </MetaButton>
  );
}

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
