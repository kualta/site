"use client";

import React, { useEffect, useRef, useState } from "react";
import { setupScene } from "./PolyhedronScene";

const Polyhedron = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [sceneRef, setSceneRef] = useState<ReturnType<typeof setupScene>>();
  const [isDarkMode, setDarkMode] = useState(true);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDarkMode(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, { attributes: true });

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!sceneRef) {
      return;
    }
    const color = isDarkMode ? 0xedb0e6 : 0x000000;
    sceneRef.wireframe.material.color.set(color);
  }, [isDarkMode]);

  useEffect(() => {
    if (!containerRef?.current) {
      return;
    }

    const scene = setupScene(containerRef.current);
    setSceneRef(scene);

    return () => {
      scene.dispose();
    };
  }, []);

  return <div className="w-screen h-screen" ref={containerRef} />;
};

export default Polyhedron;
