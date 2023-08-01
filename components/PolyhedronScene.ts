import * as THREE from "three";

export function init(container: any) {
  const scene = new THREE.Scene();

  // Create a camera
  const camera = new THREE.PerspectiveCamera(
    60,
    container.offsetWidth / container.offsetHeight,
    0.1,
    1000,
  );
  camera.position.z = 3;

  // Create a renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); // Enable alpha for transparent background

  renderer.setSize(container.offsetWidth, container.offsetHeight);
  container.appendChild(renderer.domElement);
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
    if (!container) {
      return;
    }
    const { offsetWidth, offsetHeight } = container;
    renderer.setSize(offsetWidth, offsetHeight);
    camera.aspect = offsetWidth / offsetHeight;
    camera.updateProjectionMatrix();
  };

  // Initialize and attach ResizeObserver
  const resizeObserver = new ResizeObserver(handleResize);
  resizeObserver.observe(container);

  // Create an animation loop
  const animate = () => {
    requestAnimationFrame(animate);
    wireframe.rotation.x += 0.005 ;
    wireframe.rotation.y += 0.005 ;
    wireframe.rotation.z += 0.005 ;
    renderer.render(scene, camera);
  };
  animate();

  // Return a reference that can be used to interact with the scene
  return {
    renderer,
    scene,
    camera,
    wireframe,
    dispose: () => {
      cancelAnimationFrame(animate as unknown as number);
      scene.remove(wireframe);
      resizeObserver.disconnect();
      renderer.dispose();
    },
  };
}