"use client";

import { useEffect, useState } from "react";
import { MetaButton } from "./MetaButton";

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
      <button type="button" className="w-8 h-8 rounded-full flex items-center justify-center" onClick={handleToggle}>
        {isDark ? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-6 w-6"
            fill="none"
            role="image"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 7h5m0 0v5m0-5l-1.79-1.79a2 2 0 00-2.83 0l-2.83 2.83a2 2 0 000 2.83L13 17l2.83 2.83a2 2 0 002.83 0l2.83-2.83a2 2 0 000-2.83L18 12"
            />
          </svg>
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-6 w-6"
            fill="none"
            role="image"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M11 5.999V9m0 0V14m0-4.001L5.999 9m0 0L11 5.999M11 9l5 3-5 3"
            />
          </svg>
        )}
      </button>
    </MetaButton>
  );
}
