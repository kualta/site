"use client";

import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";

const Polyhedron = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rotationDirection, setRotationDirection] = useState(1);

  useEffect(() => {
    if (!containerRef?.current) {
      return;
    }
    const scene = new THREE.Scene();

    // Create a camera
    const camera = new THREE.PerspectiveCamera(
      60,
      containerRef.current.offsetWidth / containerRef.current.offsetHeight,
      0.1,
      1000,
    );
    camera.position.z = 3;

    // Create a renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); // Enable alpha for transparent background

    renderer.setSize(containerRef.current.offsetWidth, containerRef.current.offsetHeight);
    containerRef.current.appendChild(renderer.domElement);
    // Create a random regular polyhedron
    const polyhedronGeometries = [
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.OctahedronGeometry(1),
      new THREE.IcosahedronGeometry(1),
    ];

    const randomGeometry = polyhedronGeometries[Math.floor(Math.random() * polyhedronGeometries.length)];
    const material = new THREE.MeshBasicMaterial({ color: 0xedb0e6 }); // Render as wireframe
    const wireframeGeometry = new THREE.WireframeGeometry(randomGeometry);
    const wireframe = new THREE.LineSegments(wireframeGeometry, material);
    scene.add(wireframe);

    const handleResize = () => {
      if (!containerRef?.current) {
        return;
      }
      const { offsetWidth, offsetHeight } = containerRef.current;
      renderer.setSize(offsetWidth, offsetHeight);
      camera.aspect = offsetWidth / offsetHeight;
      camera.updateProjectionMatrix();
    };

    // Initialize and attach ResizeObserver
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    // Mount the renderer
    if (containerRef.current) {
      containerRef.current.appendChild(renderer.domElement);
    }

    const rotationInterval = setInterval(() => {
      const randomFactor = Math.random() * 2 - 1;
      setRotationDirection((rotationDirection) => -rotationDirection * randomFactor);
    }, 2000);

    // Create an animation loop
    const animate = () => {
      requestAnimationFrame(animate);
      wireframe.rotation.x += 0.006 * rotationDirection;
      wireframe.rotation.y += 0.006 * rotationDirection;
      renderer.render(scene, camera);
    };
    animate();

    // Clean up on unmount
    return () => {
      cancelAnimationFrame(animate as unknown as number);
      clearInterval(rotationInterval);
      scene.remove(wireframe);
      resizeObserver.disconnect();
      renderer.dispose();
    };
  }, []);

  return <div className="w-screen h-screen" ref={containerRef} />;
};

export default Polyhedron;
