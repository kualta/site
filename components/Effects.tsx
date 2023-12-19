"use client";

import { PropsWithChildren, useEffect, useState } from "react";
import Snowfall from "react-snowfall";

export const IsChristmas = (props: PropsWithChildren) => {
  const currentDate = new Date();
  const currentMonth = currentDate.getMonth();
  const itsTime = currentMonth >= 10 || currentMonth <= 0;

  return <>{itsTime && props.children}</>;
};

export const Snow = () => {
  const [isDark, setDark] = useState(true);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const observer = new MutationObserver((mutationsList) => {
      for (const mutation of mutationsList) {
        if (mutation.type === "attributes" && mutation.attributeName === "class") {
          const classList = Array.from(document.documentElement.classList);
          if (classList.includes("dark")) {
            setDark(true);
          } else {
            setDark(false);
          }
        }
      }
    });

    observer.observe(document.documentElement, { attributes: true });

    return () => {
      observer.disconnect();
    };
  }, []);

  const color = isDark ? "#e7e4e3" : "#191817";

  return (
    <div className="fixed w-screen h-screen -z-[8] top-0">
      <Snowfall speed={[2, 2]} color={color} />
    </div>
  );
};
