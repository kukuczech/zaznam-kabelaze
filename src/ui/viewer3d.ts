// 3D pohled podlaží: stěny jako kvádry z osy, tap = výběr stěny (včetně strany).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { project, getPhoto } from '../db';
import { axisDir, axisLen, ceilingHeightAt, faceCeilingPolyline, faceLenMm, faceStartMm, faceEndMm, projectToAxis, resolveStorey, slopeCeilingSurface, slopeHeightAt, slopePlanRun, slopeTrueLength, slopesForRoom, wallNormal, type WallSide } from '../model/geometry';
import { saveProject } from '../db';
import { isCategoryVisible, newId, resolveBackgrounds, roomSurface, type Corner, type Diagonal, type Room, type SlopePlane, type Storey, type Wall, type WallBackground, type WallFace, type XY } from '../model/types';
import { affine3, meshTriangles, rectDisplayRect, toDisplay, wallSvgContent } from './wall-svg';
import { registerCleanup, route } from '../main';
import { setDistoTarget, clearDistoTarget } from '../disto';

const MM = 0.001; // mm → m

/** Celá fotka do čtyřúhelníku P (TL,TR,BR,BL) — HLADKÁ homografie přes síť (jako mesh). */
function drawImageQuad(g: CanvasRenderingContext2D, img: CanvasImageSource, P: { x: number; y: number }[]): void {
  const srcQ = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  for (const t of meshTriangles(srcQ, P)) {
    const m = affine3(t.s[0], t.s[1], t.s[2], t.d[0], t.d[1], t.d[2]);
    g.save();
    g.beginPath(); g.moveTo(t.d[0].x, t.d[0].y); g.lineTo(t.d[1].x, t.d[1].y); g.lineTo(t.d[2].x, t.d[2].y); g.closePath();
    g.clip();
    g.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    g.drawImage(img, 0, 0, 1, 1);
    g.restore();
  }
}

/** Síťová dlaždice: umístění řídí VŠECHNY body (homografie=perspektiva), ořez mnohoúhelníkem. */
function drawImageMesh(g: CanvasRenderingContext2D, img: CanvasImageSource, src: { x: number; y: number }[], dst: { x: number; y: number }[]): void {
  g.save();
  g.beginPath(); // vnější ořez na celý mnohoúhelník
  dst.forEach((p, i) => { if (i === 0) g.moveTo(p.x, p.y); else g.lineTo(p.x, p.y); });
  g.closePath();
  g.clip();
  for (const t of meshTriangles(src, dst)) {
    const m = affine3(t.s[0], t.s[1], t.s[2], t.d[0], t.d[1], t.d[2]);
    g.save();
    g.beginPath(); g.moveTo(t.d[0].x, t.d[0].y); g.lineTo(t.d[1].x, t.d[1].y); g.lineTo(t.d[2].x, t.d[2].y); g.closePath();
    g.clip();
    g.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    g.drawImage(img, 0, 0, 1, 1);
    g.restore();
  }
  g.restore();
}

// půdorys (x, y) → three.js (x, výška, -y)
const toWorld = (x: number, y: number, h: number) => new THREE.Vector3(x * MM, h * MM, -y * MM);

type CapTri = [XY, XY, XY];

/**
 * Adaptivní triangulace půdorysu místnosti pro strop. Strop je po částech rovinný:
 * šikmina stoupá od kolenní stěny a v místě, kde dosáhne výšky stěn / hřebene, se
 * LÁME do rovné plochy. Samotné rohy místnosti ten zlom nezachytí (šikmina by
 * „přetekla" přes celý strop) — proto výchozí triangulaci obrysu adaptivně dělíme
 * na 4, dokud hrany výškově nesedí s `ceilingHeightAt`. Vrací trojúhelníky (mm).
 */
function ceilingCapTriangles(storey: Storey, polygon: XY[], capH: number): CapTri[] {
  const h = (p: XY): number => ceilingHeightAt(storey, p, capH);
  const mid = (a: XY, b: XY): XY => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const TOL = 12;   // mm — max odchylka lineární hrany od skutečného stropu
  const MAX = 6;    // hloubka dělení (hrana / 64 v nejhorším → ~zlom ostrý)

  const idx = THREE.ShapeUtils.triangulateShape(polygon.map((p) => new THREE.Vector2(p.x, p.y)), []);
  const out: CapTri[] = [];
  const refine = (t: CapTri, depth: number): void => {
    const [a, b, c] = t;
    const ha = h(a), hb = h(b), hc = h(c);
    const err = Math.max(
      Math.abs(h(mid(a, b)) - (ha + hb) / 2),
      Math.abs(h(mid(b, c)) - (hb + hc) / 2),
      Math.abs(h(mid(c, a)) - (hc + ha) / 2),
    );
    if (depth >= MAX || err <= TOL) { out.push(t); return; }
    const mab = mid(a, b), mbc = mid(b, c), mca = mid(c, a);
    refine([a, mab, mca], depth + 1);
    refine([mab, b, mbc], depth + 1);
    refine([mca, mbc, c], depth + 1);
    refine([mab, mbc, mca], depth + 1); // vnitřní trojúhelník → vše zůstává uvnitř obrysu
  };
  for (const [a, b, c] of idx) refine([polygon[a], polygon[b], polygon[c]], 0);
  return out;
}

/** Zapeče trojúhelníky stropu do BufferGeometry (baked výšky) a vrátí, zda je skloněná. */
function capGeometry(storey: Storey, tris: CapTri[], capH: number): { geo: THREE.BufferGeometry; sloped: boolean } {
  let sloped = false;
  const pos = new Float32Array(tris.length * 9);
  let o = 0;
  for (const t of tris) for (const v of t) {
    const y = ceilingHeightAt(storey, v, capH);
    if (Math.abs(y - capH) > 1) sloped = true;
    pos[o++] = v.x * MM; pos[o++] = y * MM; pos[o++] = -v.y * MM;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return { geo, sloped };
}

/**
 * Rozdělí strop místnosti na samostatné klikatelné kusy: rovnou část (slopeId
 * undefined) + jeden kus za každou šikminu. Trojúhelník patří té šikmině, která
 * v jeho těžišti dává nejnižší (rozhodující) výšku pod rovným stropem; jinak je
 * rovný. Sdílí adaptivní tesselaci s 3D vizuálem.
 */
function buildCeilingCaps(storey: Storey, room: Room, capH: number): { slopeId?: string; geo: THREE.BufferGeometry; sloped: boolean }[] {
  const tris = ceilingCapTriangles(storey, room.polygon, capH);
  const slopes = slopesForRoom(storey, room);
  const groups = new Map<string, CapTri[]>(); // '' = rovná část, jinak slopeId
  for (const t of tris) {
    const c = { x: (t[0].x + t[1].x + t[2].x) / 3, y: (t[0].y + t[1].y + t[2].y) / 3 };
    let ownerId = '', best = capH - 1; // musí klesnout aspoň 1 mm pod strop, aby „patřil" šikmině
    for (const sp of slopes) {
      const sh = slopeHeightAt(storey, sp, c);
      if (sh != null && sh < best) { best = sh; ownerId = sp.id; }
    }
    let g = groups.get(ownerId);
    if (!g) groups.set(ownerId, g = []);
    g.push(t);
  }
  const out: { slopeId?: string; geo: THREE.BufferGeometry; sloped: boolean }[] = [];
  for (const [key, gtris] of groups) {
    const { geo, sloped } = capGeometry(storey, gtris, capH);
    out.push({ slopeId: key || undefined, geo, sloped });
  }
  return out;
}

/**
 * Profil horní hrany stěny (lokální X v metrech od +half k −half, výška v mm)
 * podle `ceilingHeightAt` podél osy stěny. Vzorkuje hustě a nechá jen body, kde
 * se mění sklon → zachytí ZLOM šikmina/rovný strop (jinak rovná hrana přes celou
 * stěnu). Volný běh vrátí jen dva krajní body (čistý trojúhelník/lichoběžník).
 */
function wallTopProfile(storey: Storey, cx: number, cy: number, d: XY, halfMm: number, capH: number): { x: number; h: number }[] {
  const N = Math.min(160, Math.max(2, Math.round((halfMm * 2) / 50)));
  const raw: { xmm: number; h: number }[] = [];
  for (let i = 0; i <= N; i++) {
    const xmm = halfMm - (2 * halfMm * i) / N; // +half → −half (zprava doleva)
    raw.push({ xmm, h: ceilingHeightAt(storey, { x: cx + d.x * xmm, y: cy + d.y * xmm }, capH) });
  }
  const keep = [raw[0]];
  for (let i = 1; i < raw.length - 1; i++) {
    const a = raw[i - 1], b = raw[i], c = raw[i + 1];
    const gPrev = (b.h - a.h) / (b.xmm - a.xmm);
    const gNext = (c.h - b.h) / (c.xmm - b.xmm);
    if (Math.abs(gPrev - gNext) > 0.01) keep.push(b); // změna sklonu = zlom
  }
  keep.push(raw[raw.length - 1]);
  return keep.map((p) => ({ x: p.xmm * MM, h: p.h }));
}

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
      <div class="viewer-topbar" style="position:absolute;top:8px;right:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
        <span id="measure-badge" class="measure-badge" title="Kolik stěn je přeměřeno laserem (zbytek je LiDAR odhad)"></span>
        <select id="phase-sel" title="Fáze fotek zobrazená ve 3D"></select>
        <button id="toggle-tex" title="Zobrazit / skrýt fotky stěn">🖼️ Textury</button>
        <button id="toggle-overlay" title="Zobrazit trasy a prvky na líci stěn">🔌 Rozvody</button>
        <button id="toggle-diag" title="Měřit úhlopříčku mezi dvěma rohy — zafixuje tvar zkosené místnosti">📐 Úhlopříčka</button>
        <button id="toggle-ceil">🔒 Stropy</button>
        <button id="toggle-inside" title="Pohled zevnitř místnosti na strop (podlaha se skryje)">👁️ Zevnitř</button>
        <select id="room-sel" title="Postavit kameru doprostřed vybrané místnosti"></select>
      </div>
      <div class="viewer-overlay">
        <div id="sel-panel" class="sel-panel" style="display:none"></div>
      </div>
    </div>`;
  root.querySelector('#back')!.addEventListener('click', () => (location.hash = '#/'));

  const canvas = root.querySelector('canvas')!;
  const wrap = root.querySelector('.viewer-wrap') as HTMLElement;
  const selPanel = root.querySelector('#sel-panel') as HTMLElement;
  const ceilBtn = root.querySelector('#toggle-ceil') as HTMLButtonElement;
  const insideBtn = root.querySelector('#toggle-inside') as HTMLButtonElement;
  const roomSel = root.querySelector('#room-sel') as HTMLSelectElement;
  const texBtn = root.querySelector('#toggle-tex') as HTMLButtonElement;
  const overlayBtn = root.querySelector('#toggle-overlay') as HTMLButtonElement;
  const diagBtn = root.querySelector('#toggle-diag') as HTMLButtonElement;
  const phaseSel = root.querySelector('#phase-sel') as HTMLSelectElement;
  const measureBadge = root.querySelector('#measure-badge') as HTMLElement;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f172a);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 500);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(30, 50, 20);
  scene.add(sun);

  // Místnosti: z každého polygonu podlaha (dole) i strop (nahoře pod výškou stěn).
  // Strop je defaultně skrytý, ať je vidět dovnitř; přepínač ho zobrazí.
  const roomMeshes: THREE.Mesh[] = []; // podlahy i stropy (výběr)
  const ceilMeshes: THREE.Mesh[] = []; // jen stropy (přepínání viditelnosti)
  const floorMeshes: THREE.Mesh[] = []; // jen podlahy (skrytí při pohledu zevnitř)
  const floorMat = new THREE.MeshLambertMaterial({ color: 0x475569 });
  const ceilMat = new THREE.MeshLambertMaterial({ color: 0x3f4b5f, side: THREE.DoubleSide });
  // Plocha s nakreslenými trasami se zvýrazní (jako u stěn), ať je vidět, kde už se kreslilo.
  const floorRoutedMat = new THREE.MeshLambertMaterial({ color: 0x3f6d7a });
  const ceilRoutedMat = new THREE.MeshLambertMaterial({ color: 0x3a5d6b, side: THREE.DoubleSide });
  const hasRoutes = (w?: Wall): boolean => !!w && (w.faces.A.routes.length > 0 || w.faces.B.routes.length > 0);
  // Strop místnosti má rozvody, pokud je má rovná část NEBO kterákoli šikmina.
  const roomCeilHasRoutes = (room: Room): boolean =>
    hasRoutes(room.ceiling) || (room.slopeCeilings ?? []).some((sc) => hasRoutes(sc.surface));
  const ceilH = storey.wallHeightMm; // výška stropu = výška podlaží
  for (const room of storey.rooms ?? []) {
    if (room.polygon.length < 3) continue;
    const shape = new THREE.Shape(room.polygon.map((p) => new THREE.Vector2(p.x * MM, -p.y * MM)));
    // Shape leží v rovině XY → položit do půdorysu (XZ). Horní plocha extruze je v y=0.
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false });
    geo.rotateX(Math.PI / 2);

    const floor = new THREE.Mesh(geo, hasRoutes(room.floor) ? floorRoutedMat : floorMat);
    floor.position.y = 0; // horní plocha podlahy na úrovni dna stěn
    floor.userData = { room, roomKind: 'floor' };
    scene.add(floor);
    roomMeshes.push(floor);
    floorMeshes.push(floor);

    // Strop: rovná místnost = jedna deska ve výšce podlaží; podkroví = víc kusů —
    // rovná část + samostatný klikatelný „cap" za každou šikminu (podkroví, fáze 3).
    const roomSlopes = slopesForRoom(storey, room);
    const addCeil = (mesh: THREE.Mesh, slopeId?: string): void => {
      mesh.userData = { room, roomKind: 'ceiling', slopeId };
      mesh.visible = false;
      scene.add(mesh);
      roomMeshes.push(mesh);
      ceilMeshes.push(mesh);
    };
    if (!roomSlopes.length) {
      const ceil = new THREE.Mesh(geo, roomCeilHasRoutes(room) ? ceilRoutedMat : ceilMat);
      ceil.position.y = ceilH * MM; // horní plocha stropu na výšce stěn, deska visí dolů
      addCeil(ceil);
    } else {
      // Výšky vrcholů jsou zapečené v geometrii → position.y = 0. Zvýraznění „má
      // rozvody" per kus: rovná část z room.ceiling, šikmina z její vlastní plochy.
      for (const cap of buildCeilingCaps(storey, room, ceilH)) {
        const surf = cap.slopeId
          ? room.slopeCeilings?.find((sc) => sc.slopeId === cap.slopeId)?.surface
          : room.ceiling;
        addCeil(new THREE.Mesh(cap.geo, hasRoutes(surf) ? ceilRoutedMat : ceilMat), cap.slopeId);
      }
    }
  }

  // Rohové spoje: každý konec stěny, který se stýká s koncem jiné stěny,
  // prodloužíme podél osy o polovinu tloušťky souseda → kvádry se v rohu
  // překryjí a mezera/klín zmizí. Volné konce (dveřní ostění) neprodlužujeme.
  const JOINT_TOL = 60; // mm — tolerance shody koncových bodů os
  const extensionAtEnd = (wall: Wall, end: XY): number => {
    let ext = 0;
    for (const other of storey.walls) {
      if (other === wall) continue;
      for (const p of other.axis) {
        if (Math.hypot(p.x - end.x, p.y - end.y) <= JOINT_TOL) {
          ext = Math.max(ext, other.thicknessMm / 2);
        }
      }
    }
    return ext;
  };

  // Stěny
  const wallMeshes: THREE.Mesh[] = [];
  // Data pro pozdější napasování textury (fotky) na stranu A stěny.
  type Texturable = { mesh: THREE.Mesh; wall: Wall; len: number; boxLen: number; height: number; thickness: number; shiftX: number; centerY: number;
    /** Šikmina: profil horní hrany líce (lokální X v m, výška h v mm) pro seříznuté zvýraznění; sloped = má-li ho použít. */
    prof: { x: number; h: number }[]; sloped: boolean };
  const texturables: Texturable[] = [];
  const baseMat = new THREE.MeshLambertMaterial({ color: 0xcbd5e1 });
  const routedMat = new THREE.MeshLambertMaterial({ color: 0x7dd3fc });
  // „Odhad" (stěna bez naměřené délky, jen LiDAR) — ztlumená a průsvitná, ať je
  // na první pohled vidět, co ještě čeká na přeměření laserem. „Potvrzeno" = plná.
  const baseEstMat = new THREE.MeshLambertMaterial({ color: 0x8a97a8, transparent: true, opacity: 0.5 });
  const routedEstMat = new THREE.MeshLambertMaterial({ color: 0x5b8fb0, transparent: true, opacity: 0.55 });
  // Stěna se obarví „má rozvody", jen pokud má trasu ve viditelné vrstvě (na kterékoli straně).
  const hasVisibleRoute = (wall: Wall): boolean =>
    [wall.faces.A, wall.faces.B].some((f) =>
      f.routes.some((r) => isCategoryVisible(project.categories.find((c) => c.id === r.categoryId))));
  // Přeměřená stěna (má naměřenou délku) = „potvrzeno"; jinak „odhad" (LiDAR).
  const isMeasured = (wall: Wall): boolean => !!wall.measuredLengthMm && wall.measuredLengthMm > 0;
  const wallMat = (wall: Wall): THREE.Material => {
    const routed = hasVisibleRoute(wall);
    if (isMeasured(wall)) return routed ? routedMat : baseMat;
    return routed ? routedEstMat : baseEstMat;
  };
  for (const wall of storey.walls) {
    const len = axisLen(wall);
    if (len < 1) continue;
    const [p0, p1] = wall.axis;
    const d = axisDir(wall);
    // Prodloužení konců o spoje se sousedy; střed se posune o (e1 − e0)/2.
    const e0 = extensionAtEnd(wall, p0);
    const e1 = extensionAtEnd(wall, p1);
    const boxLen = len + e0 + e1;
    const cx = (p0.x + p1.x) / 2 + d.x * (e1 - e0) / 2;
    const cy = (p0.y + p1.y) / 2 + d.y * (e1 - e0) / 2;
    // Šikmý strop (podkroví): horní hrana líce podle šikminy. Profil podél osy
    // vzorkujeme (ne jen konce) — jinak by rovná hrana od konce ke konci ignorovala
    // zlom, kde šikmina přejde v rovný strop. Konec kvádru v lokálu X = ±boxLen/2
    // leží v půdorysu v cx,cy ± d·boxLen/2.
    const half = boxLen / 2;
    const prof = wallTopProfile(storey, cx, cy, d, half, wall.heightMm);
    const isSloped = prof.some((p) => p.h < wall.heightMm - 1);
    let geo: THREE.BufferGeometry;
    let centerY: number; // lokální Y (m) středu líce: box je vycentrovaný, seříznutý sedí na podlaze
    if (isSloped) {
      // Profil líce v lokálu (X = délka, Y = výška ode dna), extruze do tloušťky (Z).
      const hl = half * MM;
      const sh = new THREE.Shape();
      sh.moveTo(-hl, 0);
      sh.lineTo(hl, 0);
      for (const p of prof) sh.lineTo(p.x, Math.max(1, p.h) * MM); // horní hrana zprava (+half) doleva
      sh.closePath();
      geo = new THREE.ExtrudeGeometry(sh, { depth: wall.thicknessMm * MM, bevelEnabled: false });
      geo.translate(0, 0, -(wall.thicknessMm / 2) * MM); // vycentrovat na Z = 0 (osu líce)
      centerY = (wall.heightMm / 2) * MM;
    } else {
      geo = new THREE.BoxGeometry(boxLen * MM, wall.heightMm * MM, wall.thicknessMm * MM);
      centerY = 0;
    }
    const mesh = new THREE.Mesh(geo, wallMat(wall));
    const mid = toWorld(cx, cy, isSloped ? 0 : wall.heightMm / 2); // seříznutá geometrie má Y od dna
    mesh.position.copy(mid);
    mesh.rotation.y = Math.atan2(d.y, d.x); // plan y → -z ⇒ úhel se neneguje dvakrát
    mesh.userData.wall = wall;
    scene.add(mesh);
    wallMeshes.push(mesh);
    // Osa stěny je vůči středu kvádru posunutá o (e1−e0)/2 (kvůli prodloužení
    // konců); texturu (délky len) proto v lokálu boxu posuneme zpět na osu.
    texturables.push({ mesh, wall, len, boxLen, height: wall.heightMm, thickness: wall.thicknessMm, shiftX: -(e1 - e0) / 2, centerY, prof, sloped: isSloped });
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x334155 }),
    );
    edges.position.copy(mesh.position);
    edges.rotation.copy(mesh.rotation);
    scene.add(edges);
  }

  // Otvory (dveře/okna): geometrii stěny neměníme, jen na oba líce vyznačíme rám
  // otvoru — poloprůhledný panel + obrys. 3D zůstává objemové, ale je vidět, kde
  // otvory jsou (viewer je jinak nekreslí). Dveře hnědě, okna modře. Panely nejsou
  // mezi cíli raycastu (wallMeshes/roomMeshes), takže neblokují výběr stěn.
  const mkFill = (color: number) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false });
  const doorFill = mkFill(0x8b5e3c), windowFill = mkFill(0x38bdf8);
  const doorLine = new THREE.LineBasicMaterial({ color: 0xd97706 });
  const windowLine = new THREE.LineBasicMaterial({ color: 0x0284c7 });
  for (const wall of storey.walls) {
    if (wall.planOutline || !wall.openings.length) continue;
    const d = axisDir(wall);
    const n = wallNormal(wall);
    const [p0] = wall.axis;
    for (const op of wall.openings) {
      const isDoor = op.kind === 'door';
      const hw = op.widthMm / 2, hh = op.heightMm / 2;
      // Rám na obou lících: posun po normále o ½ tloušťky + malý přesah, ať nezapadne do stěny.
      for (const s of [1, -1] as const) {
        const off = s * (wall.thicknessMm / 2 + 6);
        const corner = (du: number, dv: number): THREE.Vector3 =>
          toWorld(p0.x + d.x * (op.uMm + du) + n.x * off, p0.y + d.y * (op.uMm + du) + n.y * off, op.vMm + dv);
        const bl = corner(-hw, -hh), br = corner(hw, -hh), tr = corner(hw, hh), tl = corner(-hw, hh);
        const fill = new THREE.BufferGeometry();
        fill.setAttribute('position', new THREE.Float32BufferAttribute(
          [...bl.toArray(), ...br.toArray(), ...tr.toArray(), ...bl.toArray(), ...tr.toArray(), ...tl.toArray()], 3));
        scene.add(new THREE.Mesh(fill, isDoor ? doorFill : windowFill));
        scene.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([bl, br, tr, tl, bl]),
          isDoor ? doorLine : windowLine));
      }
    }
  }

  // Ukazatel pokrytí: kolik reálných stěn (ne kreslicí plochy) je přeměřeno laserem.
  const realWalls = storey.walls.filter((w) => !w.planOutline);
  const measuredCount = realWalls.filter(isMeasured).length;
  measureBadge.textContent = `📏 ${measuredCount}/${realWalls.length} přeměřeno`;
  measureBadge.classList.toggle('all-measured', realWalls.length > 0 && measuredCount === realWalls.length);

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

  // V režimu „zevnitř" řídíme kameru sami (first-person rozhlížení z pevného bodu);
  // OrbitControls.update() by ji přepsal zpět na orbit kolem cíle → v tom režimu ho
  // vynecháme.
  let insideView = false;

  // Render on-demand: nespoléháme na trvalou rAF smyčku (prohlížeč ji na skryté
  // kartě / uspaném mobilu pozastaví → černý canvas). Kreslíme při každé změně.
  let renderQueued = false;
  function requestRender(): void {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!insideView) controls.update();
      renderer.render(scene, camera);
    });
  }
  // Fallback, kdyby rAF byl pozastavený: vykreslit i synchronně teď hned.
  function renderNow(): void {
    if (!insideView) controls.update();
    renderer.render(scene, camera);
  }
  controls.addEventListener('change', requestRender);

  // --- přepínače stropů / podlah (defaultně strop skrytý, ať je vidět dovnitř) ---
  let ceilVisible = false;
  let floorVisible = true;
  function setCeilVisible(v: boolean): void {
    ceilVisible = v;
    for (const m of ceilMeshes) m.visible = v;
    for (const rt of roomTexMeshes) if (rt.kind === 'ceiling') rt.mesh.visible = v;
    ceilBtn.textContent = v ? '🔓 Stropy' : '🔒 Stropy';
    ceilBtn.classList.toggle('active', v);
    if (!v && selected?.userData.roomKind === 'ceiling') clearSelection();
  }
  function setFloorVisible(v: boolean): void {
    floorVisible = v;
    for (const m of floorMeshes) m.visible = v;
    for (const rt of roomTexMeshes) if (rt.kind === 'floor') rt.mesh.visible = v;
    if (!v && selected?.userData.roomKind === 'floor') clearSelection();
  }
  ceilBtn.addEventListener('click', () => {
    setCeilVisible(!ceilVisible);
    requestRender();
  });

  // --- pohled zevnitř: strop viditelný, podlaha pryč, kamera zakotvená uprostřed
  //     místnosti (first-person rozhlížení). Vypnutí obnoví původní vnější pohled. ---
  const defaultCamPos = camera.position.clone();
  const defaultTarget = controls.target.clone();
  const defaultMaxPolar = controls.maxPolarAngle;
  const defaultFov = camera.fov;
  // Stav first-person rozhlížení: pevná pozice očí + azimut (yaw) a náklon (pitch).
  const eyePos = new THREE.Vector3();
  let yaw = 0;    // otočení kolem svislé osy
  let pitch = 0;  // náklon nahoru/dolů (kladné = vzhůru)

  /** Leží bod uvnitř polygonu (ray-casting, souřadnice v mm)? */
  function pointInPoly(x: number, y: number, poly: XY[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  /** „Stojím uprostřed" bod místnosti: plošně vážené těžiště; když u nekonvexní
   *  místnosti padne mimo obrys, fallback na střed bboxu, případně průměr vrcholů.
   *  Vrací i menší rozměr bboxu (pro odsazení kamery). Vše v mm. */
  function roomCentroid(room: Room): { cx: number; cy: number; minDim: number } {
    const poly = room.clearPolygon?.length ? room.clearPolygon : room.polygon;
    let sx = 0, sy = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let A = 0, gx = 0, gy = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      sx += a.x; sy += a.y;
      minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x);
      minY = Math.min(minY, a.y); maxY = Math.max(maxY, a.y);
      const cr = a.x * b.y - b.x * a.y;
      A += cr; gx += (a.x + b.x) * cr; gy += (a.y + b.y) * cr;
    }
    A /= 2;
    const minDim = Math.min(maxX - minX, maxY - minY);
    let cx: number, cy: number;
    if (Math.abs(A) > 1e-6) { cx = gx / (6 * A); cy = gy / (6 * A); } // plošné těžiště
    else { cx = sx / poly.length; cy = sy / poly.length; }
    if (!pointInPoly(cx, cy, poly)) {                                // těžiště mimo (L-tvar) →
      const bx = (minX + maxX) / 2, by = (minY + maxY) / 2;
      if (pointInPoly(bx, by, poly)) { cx = bx; cy = by; }           // zkus střed bboxu
      else { cx = sx / poly.length; cy = sy / poly.length; }         // poslední záchrana
    }
    return { cx, cy, minDim };
  }

  /** Kterou místnost postavit doprostřed: vybraná má přednost, jinak nejbližší středu podlaží. */
  function insideRoom(): Room | null {
    const rooms = (storey?.rooms ?? []).filter((r) => r.polygon.length >= 3);
    if (!rooms.length) return null;
    const sel = selected?.userData.room as Room | undefined;
    if (sel && sel.polygon.length >= 3) return sel;
    const c0x = center.x / MM, c0y = -center.z / MM; // střed podlaží v půdorysu (mm)
    let best = rooms[0], bestD = Infinity;
    for (const r of rooms) {
      const c = roomCentroid(r);
      const d = Math.hypot(c.cx - c0x, c.cy - c0y);
      if (d < bestD) { bestD = d; best = r; }
    }
    return best;
  }

  const EYE_MM = 1400; // výška očí nad podlahou

  /** Nasměruje kameru z pevné pozice očí podle yaw/pitch (first-person). */
  function applyLook(): void {
    pitch = Math.max(-1.45, Math.min(1.45, pitch)); // ať se pohled nepřeklopí
    const cp = Math.cos(pitch);
    const dir = new THREE.Vector3(cp * Math.sin(yaw), Math.sin(pitch), cp * Math.cos(yaw));
    camera.position.copy(eyePos);
    camera.lookAt(eyePos.clone().add(dir));
  }

  /** Zakotví kameru doprostřed dané místnosti ve výšce očí; pohled výchozí vzhůru. */
  function placeInsideCamera(room: Room | null): void {
    const c = room ? roomCentroid(room) : { cx: center.x / MM, cy: -center.z / MM, minDim: 2000 };
    eyePos.copy(toWorld(c.cx, c.cy, EYE_MM)); // pevná pozice očí uprostřed místnosti
    pitch = 0.6; // výchozí náklon vzhůru (ať je hned vidět strop)
    applyLook();
  }

  /** Zapne/vypne pohled zevnitř; volitelně postaví kameru do konkrétní místnosti. */
  function setInsideView(on: boolean, room?: Room | null): void {
    insideView = on;
    insideBtn.classList.toggle('active', on);
    if (on) {
      setCeilVisible(true);      // strop viditelný a klikatelný
      setFloorVisible(true);     // podlaha zůstává (kamera je nad ní) — též klikatelná
      controls.enabled = false;  // OrbitControls stranou — řídíme kameru sami
      camera.fov = 75; camera.updateProjectionMatrix(); // širší záběr v interiéru
      const r = room ?? insideRoom();
      placeInsideCamera(r);
      roomSel.value = r?.id ?? ''; // seznam ukáže, kde stojím
    } else {
      setFloorVisible(true);
      setCeilVisible(false);
      controls.enabled = true;
      controls.maxPolarAngle = defaultMaxPolar;
      camera.fov = defaultFov; camera.updateProjectionMatrix();
      controls.target.copy(defaultTarget);
      camera.position.copy(defaultCamPos);
      roomSel.value = '';
    }
    requestRender();
  }
  insideBtn.addEventListener('click', () => setInsideView(!insideView));

  // Seznam místností: výběr postaví kameru dovnitř (a zapne režim, pokud vypnutý).
  const selectableRooms = (storey?.rooms ?? []).filter((r) => r.polygon.length >= 3);
  roomSel.innerHTML =
    `<option value="">🚪 Do místnosti…</option>` +
    selectableRooms.map((r) => `<option value="${r.id}">${r.name || 'Místnost'}</option>`).join('');
  roomSel.style.cssText = 'max-width:150px';
  if (!selectableRooms.length) roomSel.style.display = 'none'; // podlaží bez místností
  roomSel.addEventListener('change', () => {
    const room = selectableRooms.find((r) => r.id === roomSel.value);
    if (room) setInsideView(true, room);
  });

  // --- textury stěn: na líc strany A složíme fotku (podklad) a/nebo overlay
  //     s trasami/prvky/výdřevami (vyrenderovaný z elevačního SVG) do jedné textury ---
  const EPS = 3; // mm — odsazení textury od líce stěny (proti z-fightingu)
  let texVisible = true;      // fotky stěn
  let overlayVisible = false; // trasy a osazené prvky na líci
  let texToken = 0;           // zneplatní rozběhnuté async načítání při přepnutí
  const texPlanes: THREE.Mesh[] = [];
  const texObjs: THREE.Texture[] = [];
  // Texturované plochy podlah/stropů (fotka oříznutá na tvar místnosti) — samostatné.
  const roomTexMeshes: { mesh: THREE.Mesh; kind: 'floor' | 'ceiling' }[] = [];

  const catVisible = (id?: string): boolean =>
    isCategoryVisible(project.categories.find((c) => c.id === id));
  /** Má líc stěny co kreslit do overlay (viditelná trasa / prvek / výdřeva)? */
  function faceHasOverlay(f: WallFace): boolean {
    return f.routes.some((r) => catVisible(r.categoryId))
      || f.fixtures.some((x) => catVisible(x.categoryId))
      || (f.areas ?? []).some((a) => catVisible(a.categoryId));
  }

  function disposeTextures(): void {
    for (const p of texPlanes) {
      p.parent?.remove(p);
      (p.material as THREE.Material).dispose();
      p.geometry.dispose();
    }
    texPlanes.length = 0;
    for (const rt of roomTexMeshes) {
      rt.mesh.parent?.remove(rt.mesh);
      (rt.mesh.material as THREE.Material).dispose();
      rt.mesh.geometry.dispose();
    }
    roomTexMeshes.length = 0;
    for (const t of texObjs) t.dispose();
    texObjs.length = 0;
  }

  /** Počká na načtení obrázku (onload). Vrací false při chybě. Pozn.: NE `decode()` —
   *  ten na blob-URL v Chrome umí viset, i když se obrázek reálně načte. */
  function imgLoaded(img: HTMLImageElement): Promise<boolean> {
    if (img.complete && img.naturalWidth) return Promise.resolve(true);
    return new Promise((res) => { img.onload = () => res(true); img.onerror = () => res(false); });
  }

  /** Načte fotku (blob) jako obrázek; objectURL uvolní volající. */
  async function loadPhoto(photoId: string): Promise<{ img: HTMLImageElement; url: string } | null> {
    const blob = await getPhoto(photoId);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    if (!(await imgLoaded(img))) { URL.revokeObjectURL(url); return null; }
    return { img, url };
  }

  /**
   * Složí dlaždice (podklady) do 2D kontextu: podklad s `region` na svůj výřez líce
   * (přes rectDisplayRect → px), bez regionu přes celý canvas. `FL`/`H` = zobrazovací
   * šířka/výška líce (u stěny faceLen×height, u plochy w×h). Vrací 'abort' když se
   * mezitím zneplatnil token, jinak zda se něco vykreslilo.
   */
  async function drawTiles(
    g: CanvasRenderingContext2D, bgs: WallBackground[], wall: Wall, side: WallSide,
    FL: number, H: number, texW: number, texH: number, token: number,
  ): Promise<'abort' | boolean> {
    let drawn = false;
    for (const bg of bgs) {
      const p = await loadPhoto(bg.photoId);
      if (token !== texToken) { if (p) URL.revokeObjectURL(p.url); return 'abort'; }
      if (!p) continue;
      if (bg.mesh && bg.mesh.src.length >= 3) {
        const dst = bg.mesh.dst.map((q) => { const d = toDisplay(wall, side, q.x, q.y); return { x: (d.x / FL) * texW, y: (d.y / H) * texH }; });
        drawImageMesh(g, p.img, bg.mesh.src, dst);
      } else if (bg.quad?.length === 4) {
        const P = bg.quad.map((q) => { const d = toDisplay(wall, side, q.x, q.y); return { x: (d.x / FL) * texW, y: (d.y / H) * texH }; });
        drawImageQuad(g, p.img, P);
      } else if (bg.region) {
        const r = rectDisplayRect(wall, side, bg.region);
        const dx = (r.x / FL) * texW, dy = (r.y / H) * texH, dw = (r.w / FL) * texW, dh = (r.h / H) * texH;
        const rd = bg.region.rotDeg;
        if (rd) { // otočení dlaždice kolem středu
          g.save();
          g.translate(dx + dw / 2, dy + dh / 2);
          g.rotate((rd * Math.PI) / 180);
          g.drawImage(p.img, -dw / 2, -dh / 2, dw, dh);
          g.restore();
        } else {
          g.drawImage(p.img, dx, dy, dw, dh);
        }
      } else {
        g.drawImage(p.img, 0, 0, texW, texH);
      }
      URL.revokeObjectURL(p.url);
      drawn = true;
    }
    return drawn;
  }

  /** Vyrenderuje holý overlay líce stěny (trasy/prvky/výdřevy) z elevačního SVG do obrázku. */
  async function loadOverlay(wall: Wall, side: WallSide, w: number, h: number): Promise<HTMLImageElement | null> {
    // Obsah líce je v šířce viditelného líce (faceLen), ne střednice → viewBox musí sedět.
    const len = faceLenMm(wall, side), H = wall.heightMm;
    const content = wallSvgContent(wall, { side, categories: project.categories, bare: true });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${len} ${H}" width="${w}" height="${h}">${content}</svg>`;
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    return (await imgLoaded(img)) ? img : null;
  }

  async function applyTextures(): Promise<void> {
    const token = ++texToken;
    disposeTextures();
    if (!texVisible && !overlayVisible) { requestRender(); return; }
    const phaseId = project.activePhaseId;
    for (const t of texturables) {
      // Každý líc (A/B) má vlastní podklady (dlaždice) i overlay → dvě samostatné textury/roviny.
      for (const side of ['A', 'B'] as WallSide[]) {
        const face = t.wall.faces[side];
        const bgs = texVisible ? resolveBackgrounds(face, phaseId, true) : [];
        const wantOverlay = overlayVisible && faceHasOverlay(face);
        if (!bgs.length && !wantOverlay) continue;

        // rozlišení textury podle délky stěny (0,25 px/mm, strop 2048)
        const texW = Math.min(2048, Math.max(256, Math.round(t.len * 0.25)));
        const texH = Math.max(64, Math.round(texW * t.height / t.len));
        const canvas = document.createElement('canvas');
        canvas.width = texW; canvas.height = texH;
        const g = canvas.getContext('2d')!;

        let hasPhoto = false;
        if (bgs.length) {
          const FL = faceLenMm(t.wall, side);
          const res = await drawTiles(g, bgs, t.wall, side, FL, t.height, texW, texH, token);
          if (res === 'abort') return;
          hasPhoto = res;
        }
        if (wantOverlay) {
          const ov = await loadOverlay(t.wall, side, texW, texH);
          if (token !== texToken) return;
          if (ov) g.drawImage(ov, 0, 0, texW, texH);
        }
        if (!hasPhoto && !wantOverlay) continue;

        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        texObjs.push(tex);
        addTexPlane(t, tex, hasPhoto, side);
        requestRender();
      }
    }

    // Podlahy/stropy: fotka oříznutá na reálný tvar místnosti (plocha = maska).
    if (texVisible) {
      for (const room of storey?.rooms ?? []) {
        for (const kind of ['floor', 'ceiling'] as const) {
          const surf = room[kind];
          if (!surf) continue;
          const bgs = resolveBackgrounds(surf.faces.A, phaseId, true);
          if (!bgs.length) continue;
          const tex = await buildRoomTexture(room, surf, bgs, token);
          if (tex === 'abort') return;
          if (tex) { addRoomTexMesh(room, kind, tex); requestRender(); }
        }

        // Šikmé stropy (podkroví): fotka narovnaná na skloněnou rovinu. Plocha
        // šikminy existuje jen, když ji uživatel aspoň jednou otevřel (lazy).
        const slopeCeils = room.slopeCeilings ?? [];
        if (slopeCeils.length) {
          const caps = buildCeilingCaps(storey!, room, ceilH);
          const capBySlope = new Map(caps.filter((c) => c.slopeId).map((c) => [c.slopeId!, c]));
          const roomSlopes = slopesForRoom(storey!, room);
          for (const sc of slopeCeils) {
            const cap = capBySlope.get(sc.slopeId);         // geometrie kusu šikminy (baked výšky)
            const sp = roomSlopes.find((s) => s.id === sc.slopeId);
            if (!cap || !sp) continue;                       // šikmina bez kusu ve 3D → přeskoč
            const bgs = resolveBackgrounds(sc.surface.faces.A, phaseId, true);
            if (!bgs.length) continue;                       // bez podkladu → nic nekreslit
            const w = sc.surface.axis[1].x, h = sc.surface.heightMm; // šířka = délka base, výška = délka po sklonu
            const tex = await buildTexFromDims(sc.surface, w, h, bgs, token);
            if (tex === 'abort') return;
            if (tex) { addSlopeTexMesh(sp, sc.surface, cap.geo, tex); requestRender(); }
          }
        }
      }
    }
    requestRender();
  }

  /**
   * Nasadí narovnanou fotku na skloněnou rovinu šikmého stropu. Používá klon
   * geometrie kusu z `buildCeilingCaps` (má správný tvar i baked výšky) a dopočte
   * vlastní UV: `u` = průmět půdorysného bodu na osu kolenní (base) stěny, `v` =
   * vzdálenost po sklonu od base stěny. Materiál je oboustranný, mesh se odsadí
   * podél normály roviny proti z-fightingu s plným stropem.
   */
  function addSlopeTexMesh(sp: SlopePlane, surf: Wall, capGeo: THREE.BufferGeometry, tex: THREE.CanvasTexture): void {
    const st = storey!;
    const base = st.walls.find((wl) => wl.id === sp.baseWallId);
    if (!base) return;                                       // kolenní stěna chybí → přeskoč
    const geo = capGeo.clone();
    const surfaceWidth = surf.axis[1].x;                     // = axisLen(base)
    const surfaceHeight = surf.heightMm;                     // = slopeTrueLength
    const planRun = slopePlanRun(sp);
    const slopeFactor = planRun > 0 ? slopeTrueLength(sp) / planRun : 1; // √(1+grad²)
    // Orientace normály base stěny „dovnitř" místnosti — shodně se slopeHeightAt.
    const n = wallNormal(base);
    const [b0] = base.axis;
    let cx = 0, cy = 0; const cs = st.corners ?? [];
    for (const c of cs) { cx += c.x; cy += c.y; }
    if (cs.length) { cx /= cs.length; cy /= cs.length; }
    const inward = (cx - b0.x) * n.x + (cy - b0.y) * n.y >= 0 ? 1 : -1;

    const pos = geo.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i) / MM;
      const py = -pos.getZ(i) / MM;
      const pr = projectToAxis(base, { x: px, y: py });
      // u podél osy base stěny; strop se dívá zdola → zrcadlíme (jako rovný strop).
      const u = 1 - pr.u / surfaceWidth;
      // v = kolmá půdorysná vzdálenost dovnitř × sklon → skutečná délka po sklonu.
      const v = (pr.dist * inward * slopeFactor) / surfaceHeight;
      uv[i * 2] = u; uv[i * 2 + 1] = v;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));

    // Odsazení proti z-fightingu: podél normály roviny (skloněná → ne jen −y).
    // Normálu vezmeme z prvního trojúhelníku a orientujeme dolů (do místnosti).
    let nx = 0, ny = -1, nz = 0;
    if (pos.count >= 3) {
      const ax = pos.getX(0), ay = pos.getY(0), az = pos.getZ(0);
      const bx = pos.getX(1), by = pos.getY(1), bz = pos.getZ(1);
      const cx2 = pos.getX(2), cy2 = pos.getY(2), cz2 = pos.getZ(2);
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx2 - ax, e2y = cy2 - ay, e2z = cz2 - az;
      let fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
      const len = Math.hypot(fx, fy, fz) || 1;
      fx /= len; fy /= len; fz /= len;
      if (fy > 0) { fx = -fx; fy = -fy; fz = -fz; } // dolů do místnosti
      nx = fx; ny = fy; nz = fz;
    }
    const EPS_M = 0.004;
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(nx * EPS_M, ny * EPS_M, nz * EPS_M);
    mesh.visible = ceilVisible;
    mesh.raycast = () => {}; // fotka nesmí přebíjet výběr plné plochy šikminy
    scene.add(mesh);
    roomTexMeshes.push({ mesh, kind: 'ceiling' });
  }

  /** Poměr bboxu půdorysu místnosti (světlý obrys, shodně s roomSurface). */
  function roomBBox(room: Room): { minX: number; minY: number; w: number; h: number } {
    const poly = room.clearPolygon?.length ? room.clearPolygon : room.polygon;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of poly) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    return { minX, minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  }

  /** Složí dlaždice plochy (podlaha/strop/šikmina) do CanvasTexture o daných rozměrech
   *  `w`×`h` (mm) plochy — dlaždice jsou uložené v jejích souřadnicích (u, v), strana A. */
  async function buildTexFromDims(surf: Wall, w: number, h: number, bgs: WallBackground[], token: number): Promise<THREE.CanvasTexture | 'abort' | null> {
    const texW = Math.min(2048, Math.max(256, Math.round(w * 0.25)));
    const texH = Math.min(2048, Math.max(64, Math.round(texW * h / w)));
    const canvas = document.createElement('canvas');
    canvas.width = texW; canvas.height = texH;
    const g = canvas.getContext('2d')!;
    const res = await drawTiles(g, bgs, surf, 'A', w, h, texW, texH, token);
    if (res === 'abort') return 'abort';
    if (!res) return null;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    texObjs.push(tex);
    return tex;
  }

  /** Složí dlaždice podlahy/stropu do CanvasTexture (poměr bboxu místnosti). */
  function buildRoomTexture(room: Room, surf: Wall, bgs: WallBackground[], token: number): Promise<THREE.CanvasTexture | 'abort' | null> {
    const { w, h } = roomBBox(room);
    return buildTexFromDims(surf, w, h, bgs, token);
  }

  /** Vytvoří plochu podlahy/stropu ve tvaru půdorysu s nasazenou (oříznutou) fotkou. */
  function addRoomTexMesh(room: Room, kind: 'floor' | 'ceiling', tex: THREE.CanvasTexture): void {
    const poly = room.clearPolygon?.length ? room.clearPolygon : room.polygon;
    if (poly.length < 3) return;
    const { minX, minY, w, h } = roomBBox(room);
    // Plocha = polygon místnosti (ShapeGeometry = plochý cap, sám ořezává tvar).
    const shape = new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x * MM, -p.y * MM)));
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(Math.PI / 2);
    // Vlastní UV: z world pozice zpět na plán (px, py) a normalizace na bbox fotky.
    // Fotka je uložená v (u = px−minX, v = maxY−py); flipY textury → v = (py−minY)/h.
    const pos = geo.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i) / MM;
      const py = -pos.getZ(i) / MM;
      let u = (px - minX) / w;
      const v = (py - minY) / h;
      if (kind === 'ceiling') u = 1 - u; // strop se dívá zdola → zrcadlit u
      uv[i * 2] = u; uv[i * 2 + 1] = v;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));

    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    const EPS_M = 0.004; // odsazení od plné plochy (proti z-fightingu)
    mesh.position.y = kind === 'floor' ? EPS_M : ceilH * MM - 0.08 - EPS_M;
    mesh.visible = kind === 'floor' ? floorVisible : ceilVisible;
    mesh.raycast = () => {}; // fotka podlahy/stropu nesmí přebíjet výběr plné plochy
    scene.add(mesh);
    roomTexMeshes.push({ mesh, kind });
  }

  /** Nasadí texturu na líc stěny. Strana A = lokální −Z líc kvádru (rotace π kolem Y),
   *  strana B = protilehlý +Z líc (bez rotace). Orientace u/v odpovídá čelnímu pohledu
   *  editoru dané strany (side:'A' vs 'B' už zrcadlí u). opaque=false (jen overlay bez
   *  fotky) → průhledné pozadí, prosvítá stěna. */
  function addTexPlane(t: Texturable, tex: THREE.Texture, opaque: boolean, side: WallSide): void {
    // MeshBasic = neosvětlená (fotka má světlo „zapečené"), plný jas.
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: !opaque });
    // Textura je složená v prostoru VIDITELNÉHO líce (faceLen = světlá míra, osový
    // úsek [faceStart, faceEnd]), ne přes celou střednici. Rovina proto musí mít
    // šířku faceLen a sedět na tomto úseku osy — jinak se fotka roztáhne přes
    // celý axisLen a posune (roh navíc řeže per-líc, A≠B). shiftX v lokálu boxu:
    // střed viditelného líce (faceStart+faceEnd)/2 posunutý na osu (t.shiftX řeší
    // prodloužení konců (e1−e0)/2, t.len/2 sráží z osy-od-p0 na střed boxu).
    const fl = faceLenMm(t.wall, side);
    const shiftX = t.shiftX + (faceStartMm(t.wall, side) + faceEndMm(t.wall, side)) / 2 - t.len / 2;
    const H = t.height;
    // Seříznutá stěna (šikmý strop): textura musí respektovat tvar líce i ve 3D —
    // jinak plný obdélník přeteče nad šikminu. Silueta viditelného líce (dole rovně,
    // nahoře profil šikminy) jako ShapeGeometry s vlastními UV (u=x/faceLen shodně
    // s obdélníkovou rovinou, v=výška; textura je složená v prostoru [0..faceLen]×[0..H]).
    const top = t.sloped ? faceCeilingPolyline(storey!, t.wall, side) : null;
    let geo: THREE.BufferGeometry;
    if (top && top.length >= 2) {
      const outline = [
        { dx: 0, dy: H },
        ...top.map((p) => ({ dx: p.x, dy: H - p.h })),
        { dx: fl, dy: H },
      ];
      const sh = new THREE.Shape();
      outline.forEach((p, i) => {
        const X = (p.dx / fl - 0.5) * fl * MM, Y = (0.5 - p.dy / H) * H * MM;
        if (i === 0) sh.moveTo(X, Y); else sh.lineTo(X, Y);
      });
      sh.closePath();
      geo = new THREE.ShapeGeometry(sh);
      const pos = geo.attributes.position;
      const uv = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) {
        uv[i * 2] = pos.getX(i) / (fl * MM) + 0.5;     // u: −fl/2→0, +fl/2→1
        uv[i * 2 + 1] = pos.getY(i) / (H * MM) + 0.5;  // v: dno→0, strop→1 (flipY textury srovná)
      }
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    } else {
      geo = new THREE.PlaneGeometry(fl * MM, t.height * MM);
    }
    const plane = new THREE.Mesh(geo, mat);
    const z = (t.thickness / 2 + EPS) * MM;
    plane.position.set(shiftX * MM, t.centerY, side === 'A' ? -z : z);
    plane.rotation.y = side === 'A' ? Math.PI : 0;
    plane.raycast = () => {}; // textura je child stěny → nesmí přebíjet výběr líce
    t.mesh.add(plane);
    texPlanes.push(plane);
  }

  texBtn.classList.toggle('active', texVisible);
  texBtn.addEventListener('click', () => {
    texVisible = !texVisible;
    texBtn.classList.toggle('active', texVisible);
    void applyTextures();
  });

  overlayBtn.classList.toggle('active', overlayVisible);
  overlayBtn.addEventListener('click', () => {
    overlayVisible = !overlayVisible;
    overlayBtn.classList.toggle('active', overlayVisible);
    void applyTextures();
  });

  // Přepínač fáze fotek (co se zobrazí ve 3D) — synchronní s project.activePhaseId.
  phaseSel.style.cssText = 'max-width:150px';
  phaseSel.innerHTML =
    `<option value="">Auto (aktivní)</option>` +
    project.photoPhases.map((ph) => `<option value="${ph.id}">${ph.name}</option>`).join('');
  phaseSel.value = project.activePhaseId ?? '';
  phaseSel.addEventListener('change', () => {
    project.activePhaseId = phaseSel.value || undefined;
    saveProject();
    void applyTextures();
  });

  void applyTextures();

  // --- Úhlopříčky (fáze 2): značky rohů + režim měření pro zafixování zkoseného tvaru ---
  // Zkosenou (neortogonální) místnost samotné délky stěn nezafixují — čtyřúhelník se
  // „viklá". Změřená úhlopříčka mezi dvěma rohy tvar zaškvárkuje (tvrdá vazba solveru).
  let diagMode = false;
  let diagFirst: string | null = null; // id prvního zvoleného rohu
  const diagGroup = new THREE.Group();
  diagGroup.visible = false;
  scene.add(diagGroup);
  const cornerMarkers: THREE.Mesh[] = [];
  const markerR = Math.max(0.05, size * 0.012);
  const cornerGeo = new THREE.SphereGeometry(markerR, 16, 12);
  const cornerMat = new THREE.MeshBasicMaterial({ color: 0xfacc15 });
  const cornerSelMat = new THREE.MeshBasicMaterial({ color: 0xf97316 });
  const diagLineMat = new THREE.LineDashedMaterial({ color: 0xfacc15, dashSize: 0.15, gapSize: 0.1 });
  const cornerById = (id: string): Corner | undefined => (storey!.corners ?? []).find((c) => c.id === id);

  function clearDiagOverlay(): void {
    for (const ch of [...diagGroup.children]) {
      if ((ch as THREE.Line).isLine) (ch as THREE.Line).geometry.dispose(); // značky sdílí cornerGeo
      diagGroup.remove(ch);
    }
    cornerMarkers.length = 0;
  }
  function buildDiagOverlay(): void {
    clearDiagOverlay();
    for (const c of storey!.corners ?? []) {
      const m = new THREE.Mesh(cornerGeo, cornerMat);
      m.position.copy(toWorld(c.x, c.y, 0));
      m.userData.cornerId = c.id;
      diagGroup.add(m);
      cornerMarkers.push(m);
    }
    for (const d of storey!.diagonals ?? []) {
      const a = cornerById(d.a), b = cornerById(d.b);
      if (!a || !b) continue;
      const g = new THREE.BufferGeometry().setFromPoints([toWorld(a.x, a.y, 0), toWorld(b.x, b.y, 0)]);
      const line = new THREE.Line(g, diagLineMat);
      line.computeLineDistances(); // nutné pro čárkovaný materiál
      diagGroup.add(line);
    }
  }
  const resetMarkerColors = (): void => { for (const m of cornerMarkers) m.material = cornerMat; };

  function showDiagPanel(): void {
    const diags = storey!.diagonals ?? [];
    const rows = diags.map((d, i) =>
      `<div class="diag-row"><span>📐 ${Math.round(d.lengthMm)} mm</span><button class="diag-del" data-i="${i}" title="Smazat">✕</button></div>`).join('');
    const hint = diagFirst ? 'Klepni na <b>druhý roh</b> úhlopříčky.' : 'Klepni na <b>dva rohy</b> a zadej naměřenou vzdálenost.';
    selPanel.innerHTML =
      `<div class="sel-title">📐 <span class="muted">Úhlopříčky</span></div>
       <div class="diag-hint">${hint}</div>
       ${rows || '<div class="muted diag-empty">Zatím žádná úhlopříčka.</div>'}`;
    selPanel.querySelectorAll('.diag-del').forEach((btn) => btn.addEventListener('click', () => {
      const i = Number((btn as HTMLElement).dataset.i);
      (storey!.diagonals ?? []).splice(i, 1);
      resolveStorey(storey!);
      saveProject();
      void route(); // překreslí podlaží z nové geometrie
    }));
    selPanel.style.display = '';
  }

  function promptDiagLength(aId: string, bId: string): void {
    const a = cornerById(aId), b = cornerById(bId);
    const est = a && b ? Math.round(Math.hypot(a.x - b.x, a.y - b.y)) : 0;
    selPanel.innerHTML =
      `<div class="sel-title">📐 <span class="muted">Nová úhlopříčka</span></div>
       <label class="sel-measure">📏 Naměřená vzdálenost rohů (mm)
         <input class="sel-len" type="number" inputmode="numeric" min="0" step="1" placeholder="${est} (odhad)" />
       </label>
       <div class="diag-actions"><button class="ghost diag-cancel">Zrušit</button><button class="primary diag-ok">Přidat</button></div>`;
    const lenIn = selPanel.querySelector('.sel-len') as HTMLInputElement;
    const commit = (mm: number | null): void => {
      clearDistoTarget(lenIn);
      if (mm && mm > 0) {
        (storey!.diagonals ??= []).push({ id: newId(), a: aId, b: bId, lengthMm: Math.round(mm) } as Diagonal);
        resolveStorey(storey!);
        saveProject();
        void route();
      } else {
        showDiagPanel();
      }
    };
    const arm = () => setDistoTarget(lenIn, (mm) => commit(mm)); // DISTO: naměř metrem
    lenIn.addEventListener('focus', arm);
    lenIn.addEventListener('pointerdown', arm);
    selPanel.querySelector('.diag-ok')!.addEventListener('click', () => {
      const raw = lenIn.value.trim();
      commit(raw === '' ? null : Number(raw));
    });
    selPanel.querySelector('.diag-cancel')!.addEventListener('click', () => { clearDistoTarget(lenIn); showDiagPanel(); });
    lenIn.focus();
    selPanel.style.display = '';
  }

  function setDiagMode(on: boolean): void {
    diagMode = on;
    diagFirst = null;
    diagBtn.classList.toggle('active', on);
    if (on) {
      clearSelection();
      buildDiagOverlay();
      diagGroup.visible = true;
      showDiagPanel();
    } else {
      diagGroup.visible = false;
      selPanel.style.display = 'none';
      clearDistoTarget();
    }
    requestRender();
  }
  diagBtn.addEventListener('click', () => setDiagMode(!diagMode));

  // --- výběr stěny / místnosti tapem ---
  const raycaster = new THREE.Raycaster();
  let selected: THREE.Mesh | null = null;
  let selectedSide: WallSide = 'A';

  // Zvýraznění líce stěny: průsvitná rovina jen na trefené straně (A/B), ať je
  // jasné, kterou stranu edituji (ne celý oboustranný kvádr).
  const faceHlMat = new THREE.MeshBasicMaterial({
    color: 0x22d3ee, transparent: true, opacity: 0.35, side: THREE.DoubleSide,
  });
  let faceHl: THREE.Mesh | null = null;

  function highlight(mesh: THREE.Mesh): void {
    // Materiál klonovat, ať zvýraznění neobarví všechny prvky se sdíleným materiálem.
    mesh.material = (mesh.material as THREE.MeshLambertMaterial).clone();
    (mesh.material as THREE.MeshLambertMaterial).emissive.set(0x155e75);
  }
  /** Podsvítí jen zvolený líc stěny (na trefené straně), ne celý kvádr. Zvýraznění
   *  pokrývá CELÝ líc kvádru (boxLen, tj. i prodloužení do rohů), ne jen střednicový
   *  úsek (len) — u rohových stěn kvádr přesahuje osu o ½ tloušťky sousedů, a kdyby
   *  se podsvítila jen osa, zvýraznění by končilo dřív, než kam stěna viditelně vede. */
  function highlightWallFace(wall: Wall, side: WallSide): void {
    const t = texturables.find((x) => x.wall === wall);
    if (!t) return;
    const z = (t.thickness / 2 + EPS + 2) * MM; // kousek nad texturou (proti z-fightingu)
    let plane: THREE.Mesh;
    if (t.sloped && t.prof.length) {
      // Seříznutá stěna (šikmý strop): zvýraznění kopíruje SILUETU líce (stejný tvar
      // jako geometrie stěny), ne plný obdélník — jinak přesahuje nad skloněnou hranu.
      const hl = (t.boxLen / 2) * MM;
      const sh = new THREE.Shape();
      sh.moveTo(-hl, 0);
      sh.lineTo(hl, 0);
      for (const p of t.prof) sh.lineTo(p.x, Math.max(1, p.h) * MM); // horní hrana zprava (+half) doleva
      sh.closePath();
      plane = new THREE.Mesh(new THREE.ShapeGeometry(sh), faceHlMat);
      plane.position.set(0, 0, side === 'A' ? -z : z); // silueta má Y ode dna (jako geometrie stěny)
    } else {
      plane = new THREE.Mesh(new THREE.PlaneGeometry(t.boxLen * MM, t.height * MM), faceHlMat);
      plane.position.set(0, t.centerY, side === 'A' ? -z : z); // střed líce
    }
    t.mesh.add(plane);
    faceHl = plane;
  }
  function clearSelection(): void {
    if (selected?.userData.room) (selected.material as THREE.MeshLambertMaterial).emissive.set(0x000000);
    if (faceHl) { faceHl.parent?.remove(faceHl); faceHl.geometry.dispose(); faceHl = null; }
    selected = null;
    selPanel.style.display = 'none';
    selPanel.innerHTML = '';
  }

  function showWallPanel(wall: Wall): void {
    const measured = !!wall.measuredLengthMm && wall.measuredLengthMm > 0;
    selPanel.innerHTML = `
      <div class="sel-title">🧱 <span class="muted">Stěna</span> · <span class="muted">strana ${selectedSide}</span>
        <span class="wall-state ${measured ? 'confirmed' : 'estimate'}">${measured ? '✔ potvrzeno' : '~ odhad (LiDAR)'}</span></div>
      <input class="sel-name" placeholder="Název stěny" />
      <label class="sel-measure">📏 Naměřená délka mezi rohy (mm)
        <input class="sel-len" type="number" inputmode="numeric" min="0" step="1" />
      </label>
      <textarea class="sel-note" rows="2" placeholder="Poznámka ke stěně…"></textarea>
      <div class="wall-slope">
        <label class="slope-toggle"><input type="checkbox" class="slope-on" /> 🏠 Šikmý strop nad stěnou (podkroví)</label>
        <div class="slope-fields" style="display:none">
          <label class="sel-measure">📏 Výška nadezdívky (mm)
            <input class="slope-knee" type="number" inputmode="numeric" min="0" step="1" />
          </label>
          <label class="sel-measure">📐 Sklon střechy (°)
            <input class="slope-angle" type="number" inputmode="numeric" min="0" max="89" step="0.5" />
          </label>
          <label class="sel-measure">📏 Výška hřebene (mm) — zastropí stoupání
            <input class="slope-ridge" type="number" inputmode="numeric" min="0" step="1" />
          </label>
        </div>
      </div>
      <button class="primary sel-open"></button>`;
    const nameIn = selPanel.querySelector('.sel-name') as HTMLInputElement;
    const lenIn = selPanel.querySelector('.sel-len') as HTMLInputElement;
    const noteIn = selPanel.querySelector('.sel-note') as HTMLTextAreaElement;
    const openBtn = selPanel.querySelector('.sel-open') as HTMLButtonElement;
    nameIn.value = wall.name;
    noteIn.value = wall.note ?? '';
    // Placeholder = aktuální osová délka (LiDAR odhad), value = naměřená (pokud je).
    lenIn.value = measured ? String(Math.round(wall.measuredLengthMm!)) : '';
    lenIn.placeholder = `${Math.round(axisLen(wall))} (odhad)`;
    const syncOpen = () => (openBtn.textContent = `Otevřít ${wall.name || 'stěnu'} →`);
    syncOpen();

    // Zadání/změna naměřené délky → přesolví podlaží a překreslí 3D scénu.
    // Prázdná hodnota (nebo 0) měření zruší a stěna se vrátí na LiDAR odhad.
    const applyMeasured = (mm: number | null): void => {
      if (mm && mm > 0) wall.measuredLengthMm = Math.round(mm);
      else delete wall.measuredLengthMm;
      resolveStorey(storey!); // po úvodním guardu vždy definováno
      clearDistoTarget(lenIn);
      saveProject();
      void route(); // přebuduje scénu z nové geometrie (rohy se posunuly)
    };
    const commitLen = (): void => {
      const raw = lenIn.value.trim();
      applyMeasured(raw === '' ? null : Number(raw));
    };
    // DISTO: po tapnutí do pole ho označíme jako cíl příštího měření metrem.
    const arm = () => setDistoTarget(lenIn, (mm) => applyMeasured(mm));
    lenIn.addEventListener('focus', arm);
    lenIn.addEventListener('pointerdown', arm);
    lenIn.addEventListener('change', commitLen);
    lenIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitLen(); } });

    nameIn.addEventListener('change', () => { wall.name = nameIn.value.trim(); saveProject(); syncOpen(); });
    noteIn.addEventListener('change', () => { wall.note = noteIn.value; saveProject(); });

    // --- Šikmý strop (podkroví, fáze 3): SlopePlane navázaná na tuto stěnu ---
    // Šikmina není součástí solveru — po změně stačí uložit a přebudovat 3D scénu
    // (route()), která z parametrů dopočte skloněný strop i seříznuté stěny.
    const slopeOn = selPanel.querySelector('.slope-on') as HTMLInputElement;
    const slopeFields = selPanel.querySelector('.slope-fields') as HTMLElement;
    const kneeIn = selPanel.querySelector('.slope-knee') as HTMLInputElement;
    const angleIn = selPanel.querySelector('.slope-angle') as HTMLInputElement;
    const ridgeIn = selPanel.querySelector('.slope-ridge') as HTMLInputElement;
    const findSlope = (): SlopePlane | undefined => storey!.slopes?.find((s) => s.baseWallId === wall.id);
    const sp0 = findSlope();
    slopeOn.checked = !!sp0;
    slopeFields.style.display = sp0 ? '' : 'none';
    if (sp0) {
      kneeIn.value = String(Math.round(sp0.kneeHeightMm));
      if (sp0.angleDeg != null) angleIn.value = String(sp0.angleDeg);
      if (sp0.ridgeHeightMm != null) ridgeIn.value = String(Math.round(sp0.ridgeHeightMm));
    }
    const writeSlope = (): void => {
      const sp = findSlope();
      if (!slopeOn.checked) {
        if (sp && storey!.slopes) storey!.slopes = storey!.slopes.filter((s) => s !== sp);
      } else {
        const target: SlopePlane = sp ?? { id: newId(), baseWallId: wall.id, kneeHeightMm: 1200 };
        if (!sp) (storey!.slopes ??= []).push(target);
        const knee = Number(kneeIn.value);
        if (kneeIn.value.trim() && knee > 0) target.kneeHeightMm = Math.round(knee);
        const ang = Number(angleIn.value);
        if (angleIn.value.trim() && ang > 0 && ang < 90) target.angleDeg = ang; else delete target.angleDeg;
        const ridge = Number(ridgeIn.value);
        if (ridgeIn.value.trim() && ridge > 0) target.ridgeHeightMm = Math.round(ridge); else delete target.ridgeHeightMm;
      }
      clearDistoTarget(kneeIn);
      clearDistoTarget(ridgeIn);
      saveProject();
      void route(); // přebuduje scénu se skloněným stropem / seříznutými stěnami
    };
    slopeOn.addEventListener('change', () => {
      slopeFields.style.display = slopeOn.checked ? '' : 'none';
      if (slopeOn.checked && !kneeIn.value.trim()) kneeIn.value = '1200';
      writeSlope();
    });
    for (const inp of [kneeIn, angleIn, ridgeIn]) {
      inp.addEventListener('change', writeSlope);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); writeSlope(); } });
    }
    // DISTO na výškové míry (nadezdívka, hřeben) — plnění laserem jako u délky.
    const armKnee = () => setDistoTarget(kneeIn, (mm) => { kneeIn.value = String(Math.round(mm)); writeSlope(); });
    const armRidge = () => setDistoTarget(ridgeIn, (mm) => { ridgeIn.value = String(Math.round(mm)); writeSlope(); });
    kneeIn.addEventListener('focus', armKnee); kneeIn.addEventListener('pointerdown', armKnee);
    ridgeIn.addEventListener('focus', armRidge); ridgeIn.addEventListener('pointerdown', armRidge);

    openBtn.addEventListener('click', () => (location.hash = `#/wall/${wall.id}/${selectedSide}`));
    selPanel.style.display = '';
  }

  function showRoomPanel(room: Room, kind: string, clickedSlopeId?: string): void {
    const isCeil = kind === 'ceiling';
    // Strop podkroví se dělí na rovnou část + samostatnou plochu za každou šikminu.
    const slopes = isCeil ? slopesForRoom(storey!, room) : [];
    const suffixOf = (i: number): string => (slopes.length > 1 ? ` ${i + 1}` : '');
    const clickedIdx = clickedSlopeId ? slopes.findIndex((s) => s.id === clickedSlopeId) : -1;
    const titleLabel = clickedIdx >= 0 ? `šikmina${suffixOf(clickedIdx)}` : (isCeil ? 'strop' : 'podlaha');
    selPanel.innerHTML = `
      <div class="sel-title">${isCeil ? '⬆️' : '⬇️'} <span class="muted">Místnost — ${titleLabel}</span></div>
      <input class="sel-name" placeholder="Název místnosti" />
      <textarea class="sel-note" rows="2" placeholder="Poznámka k místnosti…"></textarea>
      <div class="sel-openlist"></div>`;
    const nameIn = selPanel.querySelector('.sel-name') as HTMLInputElement;
    const noteIn = selPanel.querySelector('.sel-note') as HTMLTextAreaElement;
    const list = selPanel.querySelector('.sel-openlist') as HTMLElement;
    nameIn.value = room.name;
    noteIn.value = room.note ?? '';
    nameIn.addEventListener('change', () => { room.name = nameIn.value.trim(); saveProject(); });
    noteIn.addEventListener('change', () => { room.note = noteIn.value; saveProject(); });

    const openSurface = (surf: Wall, label: string): void => {
      // Plocha vznikne až při prvním otevření; název držíme v souladu s místností.
      surf.name = label;
      saveProject();
      location.hash = `#/wall/${surf.id}/A`;
    };
    const addBtn = (text: string, onClick: () => void): void => {
      const b = document.createElement('button');
      b.className = 'primary';
      b.style.width = '100%';
      b.style.marginTop = '6px';
      b.textContent = text;
      b.addEventListener('click', onClick);
      list.appendChild(b);
    };
    const openFlat = (): void => {
      const k = kind as 'floor' | 'ceiling';
      if (!room[k]) room[k] = roomSurface(room, k);
      openSurface(room[k]!, `${room.name} — ${isCeil ? 'strop' : 'podlaha'}`);
    };
    const openSlope = (i: number): void => {
      const sp = slopes[i];
      const scs = (room.slopeCeilings ??= []);
      let entry = scs.find((sc) => sc.slopeId === sp.id);
      if (!entry) { entry = { slopeId: sp.id, surface: slopeCeilingSurface(storey!, room, sp) }; scs.push(entry); }
      openSurface(entry.surface, `${room.name} — šikmina${suffixOf(i)}`);
    };

    if (clickedIdx >= 0) {
      // Klik na konkrétní šikminu → přímo její plocha (+ zkratka na rovný strop).
      addBtn(`Otevřít šikminu${suffixOf(clickedIdx)} →`, () => openSlope(clickedIdx));
      addBtn('Otevřít rovný strop →', openFlat);
    } else {
      // Podlaha, nebo rovná část stropu; u podkroví nabídni i každou šikminu (fallback).
      addBtn(isCeil && slopes.length ? 'Otevřít rovný strop →' : `Otevřít ${isCeil ? 'strop' : 'podlaha'} →`, openFlat);
      slopes.forEach((_, i) => addBtn(`Otevřít šikminu${suffixOf(i)} →`, () => openSlope(i)));
    }
    selPanel.style.display = '';
  }

  let downAt: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));

  // First-person rozhlížení v režimu „zevnitř": tažením otáčíme pohled z pevného bodu.
  let lookPrev: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => { lookPrev = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointermove', (e) => {
    if (!insideView || !lookPrev) return;
    const dx = e.clientX - lookPrev.x, dy = e.clientY - lookPrev.y;
    lookPrev = { x: e.clientX, y: e.clientY };
    yaw += dx * 0.005;   // tažení vpravo → pohled vpravo
    pitch -= dy * 0.005; // tažení nahoru → pohled vzhůru
    applyLook();
    requestRender();
  });
  const endLook = () => { lookPrev = null; };
  canvas.addEventListener('pointerup', endLook);
  canvas.addEventListener('pointercancel', endLook);
  canvas.addEventListener('pointerleave', endLook);
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 8) return;
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    // Režim úhlopříčky: klepání vybírá rohy (ne stěny/místnosti).
    if (diagMode) {
      const chit = raycaster.intersectObjects(cornerMarkers)[0];
      if (!chit) { requestRender(); return; }
      const cid = chit.object.userData.cornerId as string;
      if (!diagFirst) {
        diagFirst = cid;
        resetMarkerColors();
        (chit.object as THREE.Mesh).material = cornerSelMat;
        showDiagPanel();
      } else if (cid === diagFirst) {
        diagFirst = null; // klepnutí na týž roh výběr zruší
        resetMarkerColors();
        showDiagPanel();
      } else {
        const first = diagFirst;
        diagFirst = null;
        resetMarkerColors();
        promptDiagLength(first, cid);
      }
      requestRender();
      return;
    }
    // Skryté stropy nejdou vybrat.
    const targets = [
      ...wallMeshes,
      ...roomMeshes.filter((m) => m.visible),
    ];
    const hit = raycaster.intersectObjects(targets)[0];
    clearSelection();
    if (!hit) { requestRender(); return; }
    selected = hit.object as THREE.Mesh;
    const ud = selected.userData;
    if (ud.wall) {
      const wall = ud.wall as Wall;
      // Strana = ta, ze které se dívám (kde je kamera), aby editor ukázal čelní
      // pohled „z místnosti", ne zrcadlově od souseda. Bereme směr od bodu zásahu
      // ke kameře, promítneme do půdorysu (x=x, y=−z) a porovnáme s kanonickou
      // normálou (strana A). Výška kamery se vyruší (normála je vodorovná), takže
      // na úhlu pohledu shora nezáleží — rozhoduje jen, z které strany stěny koukám.
      const toCam = camera.position.clone().sub(hit.point);
      const camPlan = { x: toCam.x, y: -toCam.z };
      const wN = wallNormal(wall);
      selectedSide = camPlan.x * wN.x + camPlan.y * wN.y >= 0 ? 'A' : 'B';
      highlightWallFace(wall, selectedSide); // podsvítit jen trefenou stranu
      showWallPanel(wall);
    } else if (ud.room) {
      highlight(selected);
      showRoomPanel(ud.room as Room, ud.roomKind as string, ud.slopeId as string | undefined);
      // V režimu „zevnitř" přeskoč kameru do zvolené místnosti.
      if (insideView) {
        placeInsideCamera(ud.room as Room);
        roomSel.value = (ud.room as Room).id;
      }
    }
    requestRender();
  });

  function resize(): void {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderNow();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);
  resize();
  renderNow(); // první snímek hned, i kdyby rAF byl pozastavený

  if (import.meta.env.DEV) {
    // Ověření orientace textur: nasadí na každou stěnu popsanou testovací
    // texturu (šipka „u→", značka LH), ať je vidět, zda není zrcadlená / vzhůru nohama.
    const texTest = (): void => {
      disposeTextures();
      texVisible = true;
      for (const t of texturables) {
        const c = document.createElement('canvas');
        c.width = 512; c.height = Math.max(64, Math.round(512 * t.height / t.len));
        const g = c.getContext('2d')!;
        g.fillStyle = '#1e293b'; g.fillRect(0, 0, c.width, c.height);
        g.strokeStyle = '#38bdf8'; g.lineWidth = 6; g.strokeRect(3, 3, c.width - 6, c.height - 6);
        g.fillStyle = '#f87171'; g.font = 'bold 40px sans-serif';
        g.fillText('LH (u=0, v=max)', 16, 48);           // levý horní roh
        g.fillStyle = '#4ade80';
        g.fillText('u →', c.width / 2 - 40, c.height / 2); // směr u
        g.fillStyle = '#facc15';
        g.fillText('LD (u=0, v=0)', 16, c.height - 20);   // levý dolní roh
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        texObjs.push(tex);
        addTexPlane(t, tex, true, 'A');
      }
      requestRender();
    };
    (window as any).__viewer = { scene, camera, wallMeshes, texturables, applyTextures, texTest, bbox, center, size, renderer, controls, renderNow, storey, resolveStorey };
  }

  registerCleanup(() => {
    clearDistoTarget(); // odpojit DISTO od pole naměřené délky (mizí z DOM)
    controls.removeEventListener('change', requestRender);
    ro.disconnect();
    disposeTextures();
    clearDiagOverlay();
    cornerGeo.dispose();
    cornerMat.dispose();
    cornerSelMat.dispose();
    diagLineMat.dispose();
    faceHlMat.dispose();
    controls.dispose();
    renderer.dispose();
  });
}
