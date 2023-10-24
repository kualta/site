"use client";

import { PropsWithChildren, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  MdArrowBack,
  MdOutlineDarkMode,
  MdOutlineLightMode,
} from "react-icons/md";

export const MetaButton = (props: PropsWithChildren) => {
  return (
    <div className="w-8 h-8 flex items-center justify-center rounded-md hover:text-dark-primary hover:dark:text-primary">
      {props.children}
    </div>
  );
};

export function BackButton() {
  const path = usePathname();
  const isMainPage = path === "/";

  if (isMainPage) {
    return <div className="w-8 h-8" />;
  }

  return (
    <MetaButton>
      <Link href={"/"}>
        <MdArrowBack size={22} />
      </Link>
    </MetaButton>
  );
}

export default function ThemeToggle() {
  const [isDark, setIsDark] = useState(true);
  const path = usePathname();
  const isMainPage = path === "/";

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

  if (isMainPage) {
    return <div className="w-8 h-8" />;
  }

  return (
    <MetaButton>
      <button
        type="button"
        className="rounded-full flex items-center justify-center"
        onClick={handleToggle}
      >
        {isDark ? (
          <MdOutlineLightMode size={22} />
        ) : (
          <MdOutlineDarkMode size={22} />
        )}
      </button>
    </MetaButton>
  );
}
