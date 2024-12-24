"use client";

import { useEffect, useState, type PropsWithChildren } from "react";
import Snowfall from "react-snowfall";

export const IsChristmas = (props: PropsWithChildren) => {
  const currentDate = new Date();
  const currentMonth = currentDate.getMonth();

  const itsTime = currentMonth >= 10;

  return <>{itsTime && props.children}</>;
};

export const Snow = () => {
  const [isDark, setDark] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [snowflakeImages, setSnowflakeImages] = useState<HTMLImageElement[]>([]);

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

  useEffect(() => {
    const images = ["/snowflake.webp"].map((src) => {
      const img = document.createElement("img");
      img.src = src;
      return img;
    });
    setSnowflakeImages(images);
  }, []);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.matchMedia("(max-width: 768px)").matches);
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);

    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  const snowflakeCount = isMobile ? 35 : 75;
  const speed: [number, number] = isMobile ? [1, 2] : [1, 3];

  if (!isDark) return null;

  return (
    <div className="fixed w-screen h-screen -z-[8] top-0">
      <Snowfall speed={speed} snowflakeCount={snowflakeCount} images={snowflakeImages} radius={[10, 20]} />
    </div>
  );
};
