import * as THREE from "three";

export function setupScene(container: any) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, container.offsetWidth / container.offsetHeight, 0.1, 1000);
  camera.position.z = 3;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); 
  renderer.setSize(container.offsetWidth, container.offsetHeight);
  container.appendChild(renderer.domElement);

  const polyhedronGeometries = [
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.OctahedronGeometry(1),
    new THREE.IcosahedronGeometry(1),
  ];

  const randomGeometry = polyhedronGeometries[Math.floor(Math.random() * polyhedronGeometries.length)];
  const isDarkMode = document.documentElement.classList.contains("dark");
  const material = new THREE.MeshBasicMaterial({ color: isDarkMode ? 0xedb0e6 : 0x000000 }); 
  const wireframeGeometry = new THREE.WireframeGeometry(randomGeometry);
  const wireframe = new THREE.LineSegments(wireframeGeometry, material);
  scene.add(wireframe);

  const handleResize = () => {
    if (!container) {
      return;
    }
    const { offsetWidth, offsetHeight } = container;
    renderer.setSize(offsetWidth, offsetHeight);
    camera.aspect = offsetWidth / offsetHeight;
    camera.updateProjectionMatrix();
  };

  const resizeObserver = new ResizeObserver(handleResize);
  resizeObserver.observe(container);

  const animate = () => {
    requestAnimationFrame(animate);
    wireframe.rotation.x += 0.005;
    wireframe.rotation.y += 0.005;
    wireframe.rotation.z += 0.005;
    renderer.render(scene, camera);
  };
  animate();

  return {
    renderer,
    scene,
    camera,
    wireframe,
    dispose: () => {
      cancelAnimationFrame(animate as unknown as number);
      wireframe.geometry.dispose();
      scene.remove(wireframe);
      resizeObserver.disconnect();
      renderer.forceContextLoss();
      renderer.dispose();
    },
  };
}
