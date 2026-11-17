import { useEffect, useRef, useState } from "react";
import { FLAKE_SVGS, makeFlakes, poseAt, snowSeconds } from "@/lib/snow";

const FLAKES = makeFlakes(75);
const PHONE_FLAKES = 35;

export function Snow() {
  const [isDark, setDark] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    setDark(document.documentElement.classList.contains("dark"));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!isDark || !canvas || !ctx) return;

    const designs = FLAKE_SVGS.map((svg) => {
      const image = new Image();
      image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
      return image;
    });
    // a flake never changes size, so it is rasterised once at its device-pixel size
    // and from then on only moved and turned
    const sprites = new Map<string, HTMLCanvasElement>();
    const sprite = (design: number, px: number) => {
      const key = `${design}:${px}`;
      let cached = sprites.get(key);
      if (!cached) {
        cached = document.createElement("canvas");
        cached.width = px;
        cached.height = px;
        cached.getContext("2d")?.drawImage(designs[design], 0, 0, px, px);
        sprites.set(key, cached);
      }
      return cached;
    };

    let width = 0;
    let height = 0;
    let dpr = 0;
    let count = FLAKES.length;
    const resize = () => {
      const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
      if (nextDpr !== dpr) sprites.clear();
      dpr = nextDpr;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      count = window.matchMedia("(max-width: 768px)").matches ? PHONE_FLAKES : FLAKES.length;
    };

    let frame = 0;
    const draw = () => {
      const seconds = snowSeconds();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < count; i++) {
        const flake = FLAKES[i];
        const px = Math.max(1, Math.round(flake.size * dpr));
        const pose = poseAt(flake, seconds, width, height);
        const cos = Math.cos(pose.angle);
        const sin = Math.sin(pose.angle);
        ctx.globalAlpha = flake.opacity;
        ctx.setTransform(cos, sin, -sin * pose.tilt, cos * pose.tilt, pose.x * dpr, pose.y * dpr);
        ctx.drawImage(sprite(flake.design, px), -px / 2, -px / 2);
      }
      frame = requestAnimationFrame(draw);
    };

    let stopped = false;
    // a browser that can't decode the designs simply shows no snow
    Promise.all(designs.map((image) => image.decode())).then(
      () => {
        if (stopped) return;
        resize();
        window.addEventListener("resize", resize);
        draw();
        canvas.style.opacity = "1";
      },
      () => {},
    );

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, [isDark]);

  if (!isDark) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed top-0 left-0 -z-[8] h-screen w-screen opacity-0 transition-opacity duration-500"
    />
  );
}
