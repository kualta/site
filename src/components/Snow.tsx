import { useEffect, useState } from "react";
import Snowfall from "react-snowfall";

export function Snow() {
  const [isDark, setDark] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [snowflakeImages, setSnowflakeImages] = useState<HTMLImageElement[]>([]);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    setDark(document.documentElement.classList.contains("dark"));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const img = document.createElement("img");
    img.src = "/snowflake.webp";
    setSnowflakeImages([img]);
  }, []);

  useEffect(() => {
    const check = () => setIsMobile(window.matchMedia("(max-width: 768px)").matches);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  if (!isDark) return null;

  const snowflakeCount = isMobile ? 35 : 75;
  const speed: [number, number] = isMobile ? [1, 2] : [1, 3];

  return (
    <div className="fixed w-screen h-screen -z-[8] top-0">
      <Snowfall speed={speed} snowflakeCount={snowflakeCount} images={snowflakeImages} radius={[10, 20]} />
    </div>
  );
}
