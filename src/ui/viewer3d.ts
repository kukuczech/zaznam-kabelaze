// 3D pohled podlaží: stěny jako kvádry z osy, tap = výběr stěny (včetně strany).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { project } from '../db';
import { axisDir, axisLen, wallNormal, type WallSide } from '../model/geometry';
import type { Wall } from '../model/types';
import { registerCleanup } from '../main';

const MM = 0.001; // mm → m

// půdorys (x, y) → three.js (x, výška, -y)
const toWorld = (x: number, y: number, h: number) => new THREE.Vector3(x * MM, h * MM, -y * MM);

export async function renderViewer3d(root: HTMLElement, storeyId: string): Promise<void> {
  const storey = project.storeys.find((s) => s.id === storeyId);
  if (!storey) {
    location.hash = '#/';
    return;
  }

  root.innerHTML = `
    <header class="bar">
      <button id="back">←</button>
      <h1>${storey.name}</h1>
    </header>
    <div class="viewer-wrap">
      <canvas class="viewer"></canvas>
      <div class="viewer-overlay">
        <button class="primary" id="open-wall" style="display:none"></button>
      </div>
    </div>`;
  root.querySelector('#back')!.addEventListener('click', () => (location.hash = '#/'));

  const canvas = root.querySelector('canvas')!;
  const wrap = root.querySelector('.viewer-wrap') as HTMLElement;
  const openBtn = root.querySelector('#open-wall') as HTMLButtonElement;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f172a);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 500);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(30, 50, 20);
  scene.add(sun);

  // Podlahy
  const slabMat = new THREE.MeshLambertMaterial({ color: 0x475569 });
  for (const poly of storey.slabs ?? []) {
    const shape = new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x * MM, -p.y * MM)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false });
    // Shape leží v rovině XY → položit do půdorysu (XZ), extruze dolů.
    geo.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geo, slabMat);
    mesh.position.y = 0;
    scene.add(mesh);
  }

  // Stěny
  const wallMeshes: THREE.Mesh[] = [];
  const baseMat = new THREE.MeshLambertMaterial({ color: 0xcbd5e1 });
  const routedMat = new THREE.MeshLambertMaterial({ color: 0x7dd3fc });
  for (const wall of storey.walls) {
    const len = axisLen(wall);
    if (len < 1) continue;
    const geo = new THREE.BoxGeometry(len * MM, wall.heightMm * MM, wall.thicknessMm * MM);
    const mesh = new THREE.Mesh(geo, wall.routes.length ? routedMat : baseMat);
    const [p0, p1] = wall.axis;
    const mid = toWorld((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, wall.heightMm / 2);
    mesh.position.copy(mid);
    const d = axisDir(wall);
    mesh.rotation.y = Math.atan2(d.y, d.x); // plan y → -z ⇒ úhel se neneguje dvakrát
    mesh.userData.wall = wall;
    scene.add(mesh);
    wallMeshes.push(mesh);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x334155 }),
    );
    edges.position.copy(mesh.position);
    edges.rotation.copy(mesh.rotation);
    scene.add(edges);
  }

  // Kamera podle bounding boxu stěn (podlahy mohou obsahovat vzdálené artefakty)
  const bbox = new THREE.Box3();
  for (const m of wallMeshes) bbox.expandByObject(m);
  if (bbox.isEmpty()) bbox.setFromObject(scene);
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3()).length() || 10;
  camera.position.copy(center).add(new THREE.Vector3(size * 0.6, size * 0.7, size * 0.6));
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(center);
  controls.maxPolarAngle = Math.PI / 2 - 0.05;

  // Výběr stěny tapem
  const raycaster = new THREE.Raycaster();
  let selected: THREE.Mesh | null = null;
  let selectedSide: WallSide = 'A';
  let downAt: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 8) return;
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(wallMeshes)[0];
    if (selected) (selected.material as THREE.MeshLambertMaterial).emissive.set(0x000000);
    if (!hit) {
      selected = null;
      openBtn.style.display = 'none';
      return;
    }
    selected = hit.object as THREE.Mesh;
    const wall = selected.userData.wall as Wall;
    // Materiál klonovat, ať zvýraznění neobarví všechny stěny se sdíleným materiálem.
    selected.material = (selected.material as THREE.MeshLambertMaterial).clone();
    (selected.material as THREE.MeshLambertMaterial).emissive.set(0x155e75);

    // Strana: světová normála zásahu → půdorys → porovnat s kanonickou normálou.
    const n = hit.face!.normal.clone().transformDirection(selected.matrixWorld);
    const planN = { x: n.x, y: -n.z };
    const wN = wallNormal(wall);
    selectedSide = planN.x * wN.x + planN.y * wN.y >= 0 ? 'A' : 'B';

    openBtn.textContent = `Otevřít ${wall.name} →`;
    openBtn.style.display = '';
    openBtn.onclick = () => (location.hash = `#/wall/${wall.id}/${selectedSide}`);
  });

  function resize(): void {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);
  resize();

  if (import.meta.env.DEV) {
    (window as any).__viewer = { scene, camera, wallMeshes, bbox, center, size };
  }

  let running = true;
  renderer.setAnimationLoop(() => {
    if (!running) return;
    controls.update();
    renderer.render(scene, camera);
  });

  registerCleanup(() => {
    running = false;
    renderer.setAnimationLoop(null);
    ro.disconnect();
    controls.dispose();
    renderer.dispose();
  });
}
