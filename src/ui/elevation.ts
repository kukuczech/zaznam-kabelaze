// Elevation editor stěny: kreslení tras, kóty, fotky, DISTO plnění délek.
import { project, saveProject, savePhoto, getPhoto, deletePhoto, undo, redo, canUndo, canRedo, onHistoryChange } from '../db';
import { distToSegment, faceCeilingPolyline, faceEndMm, faceLenMm, faceStartMm, type WallSide } from '../model/geometry';
import { newId, resolveBackgrounds, roomSurfaces, FIXTURE_DEFS, FIXTURE_KINDS, FIXTURE_LAYER, MAX_FIXTURE_COUNT, MULTI_FIXTURE_KINDS, fixtureSize, fixtureCount, fixtureUnitWidth, defaultCategoryForFixture, fixtureLayerIds, fixtureKindsForLayer, isCategoryVisible, type Anchor, type Dimension, type Fixture, type FixtureKind, type Route, type Wall, type WallArea, type WallBackground, type XY } from '../model/types';
import { clearDistoTarget, connectDisto, onDistoStatus, setDistoTarget } from '../disto';
import { affine3, areaDisplayRect, rectDisplayRect, dimEndpoints, dimGeomLengthMm, fixtureThumbSvg, fromDisplay, meshTriangles, resolveAnchor, toDisplay, wallSvgContent, wallViewBox, type ViewBox } from './wall-svg';
import { registerCleanup, route } from '../main';
import { mapPhotoToWall, rewarpToAspect } from './photo-map';
import { buildCostField, snapPathPx, simplifyPath, type CostField } from './chase-trace';

type Mode = 'select' | 'draw' | 'area' | 'dim' | 'place' | 'photo';

/** Hrana líce, ke které se kótuje (levá/pravá jsou kanonické, zobrazení může zrcadlit). */
type EdgeName = 'top' | 'bottom' | 'left' | 'right';

/**
 * Rozkreslený šlic, ve kterém se má po překreslení obrazovky pokračovat.
 * Undo/redo překreslí celou elevaci (route()), takže by se rozkreslený šlic ztratil
 * a uživatel by po kroku zpět vypadl z kreslení. Tímhle si ho obrazovka předá sama
 * sobě; přežít musí jen jedno překreslení, proto se hodnota při vyzvednutí maže.
 */
let resumeDraw: { wallId: string; side: WallSide; routeId: string } | null = null;

/** Vyzvedne (a zahodí) pokyn k pokračování v kreslení, patří-li této ploše a líci. */
function takeResumeDraw(wallId: string, side: WallSide): string | null {
  const r = resumeDraw;
  resumeDraw = null;
  return r && r.wallId === wallId && r.side === side ? r.routeId : null;
}

/**
 * Pohled (přiblížení a střed) přenesený přes překreslení po undo/redo — jinak by každý
 * krok zpět skočil na „vejít se" a při kroku po jednotlivých bodech by se s tím nedalo
 * pracovat. Nese se PŘIBLÍŽENÍ A STŘED, ne hotový viewBox: ten je vztažený k boxu
 * srovnanému na poměr stran plochy, který se počítá až z rozměrů vykresleného SVG.
 * Platí jen pro tutéž plochu a líc a jen na jedno překreslení.
 */
let resumeView: { wallId: string; side: WallSide; zoom: number; cx: number; cy: number } | null = null;

function takeResumeView(wallId: string, side: WallSide): { zoom: number; cx: number; cy: number } | null {
  const v = resumeView;
  resumeView = null;
  return v && v.wallId === wallId && v.side === side ? v : null;
}

/** Nejmenší rozumný rozměr výdřevy (mm) — pod ním se ťuknutí bere jako omyl. */
const MIN_AREA_MM = 50;

export async function renderElevation(root: HTMLElement, wallId: string, side: WallSide): Promise<void> {
  let storeyId = '';
  let storey: (typeof project.storeys)[number] | undefined;
  let wall: Wall | undefined;
  for (const s of project.storeys) {
    const w = s.walls.find((x) => x.id === wallId);
    if (w) { wall = w; storeyId = s.id; storey = s; break; }
    // Kreslicí plochy místností (podlaha/rovný strop/šikminy) — editor je generický.
    for (const rm of s.rooms ?? []) {
      const hit = roomSurfaces(rm).find((x) => x.id === wallId);
      if (hit) { wall = hit; storeyId = s.id; storey = s; break; }
    }
    if (wall) break;
  }
  if (!wall) { location.hash = '#/'; return; }
  const W = wall;
  const F = W.faces[side]; // obsah tohoto líce (trasy, kóty, prvky, podklady); otvory jsou sdílené na W
  const isPlan = !!W.planOutline;   // podlaha/strop místnosti (půdorysná plocha), ne svislá stěna
  const isPhotoWall = !!W.photoWall; // fotostěna (identita — platí i po přeměření)
  const oneFace = isPlan || isPhotoWall; // plochy s jediným lícem — přepínač strany nemá smysl
  /** Plocha bez měřítka: rozměry jsou jen poměr stran fotky (mizí po přeměření). */
  const noScale = (): boolean => !!W.freeScale;
  // Viditelný líc stěny: kreslíme a ořezáváme na [U0, U1] v ose (u od axis[0]);
  // zobrazovací šířka je FL. Uložené souřadnice zůstávají v ose stěny.
  const FL = faceLenMm(W, side); // délka viditelného líce (zobrazovací šířka)
  const U0 = faceStartMm(W, side); // začátek líce v ose stěny
  const U1 = faceEndMm(W, side); // konec líce v ose stěny

  /** Právě vybraný podklad (dlaždice) pro editaci, nebo undefined když žádný není. */
  const activeBg = (): WallBackground | undefined =>
    F.backgrounds.find((b) => b.id === F.activeBackgroundId) ?? F.backgrounds[0];

  /** Oblast dlaždice (u,v mm, střed+rozměr); chybí-li region, bere se celá zeď. */
  const bgRegion = (bg: WallBackground): { uMm: number; vMm: number; widthMm: number; heightMm: number; rotDeg?: number } =>
    bg.region ?? { uMm: (U0 + U1) / 2, vMm: W.heightMm / 2, widthMm: FL, heightMm: W.heightMm };

  /** Body struktury líce (kanonické u,v) — cíle přichycení kotev: rohy líce + rohy otvorů. */
  function structurePoints(): { uMm: number; vMm: number }[] {
    const pts: { uMm: number; vMm: number }[] = [
      { uMm: U0, vMm: 0 }, { uMm: U1, vMm: 0 }, { uMm: U0, vMm: W.heightMm }, { uMm: U1, vMm: W.heightMm },
    ];
    for (const o of W.openings) {
      for (const du of [-1, 1]) for (const dv of [-1, 1]) {
        pts.push({ uMm: o.uMm + du * o.widthMm / 2, vMm: o.vMm + dv * o.heightMm / 2 });
      }
    }
    if (W.planOutline?.length) for (const p of W.planOutline) pts.push({ uMm: p.x, vMm: p.y });
    return pts;
  }

  root.innerHTML = `
    <header class="bar">
      <button id="back">←</button>
      <h1>${W.name} <span class="muted" style="font-size:13px">(${isPlan ? 'půdorys' : isPhotoWall ? 'fotostěna' : `strana ${side}`})</span></h1>
      ${oneFace ? '' : `<button id="flip-side" title="Přepnout na druhý líc stěny">⇄ strana ${side === 'A' ? 'B' : 'A'}</button>`}
      <button id="undo" title="Zpět (Ctrl+Z)">↶</button>
      <button id="redo" title="Vpřed (Ctrl+Shift+Z)">↷</button>
      <button id="disto"><span id="disto-dot" class="dot" style="background:#64748b"></span> Metr</button>
    </header>
    <div class="viewer-wrap">
      <svg class="elevation"></svg>
      <div class="zoom-ctl">
        <button id="zin" title="Přiblížit">＋</button>
        <input id="zoom" type="range" min="0" max="1000" value="0" title="Lupa" />
        <button id="zout" title="Oddálit">－</button>
        <div class="zpct" id="zpct">100 %</div>
      </div>
    </div>
    <div id="panel"></div>
    <div class="toolbar">
      <button data-mode="select">👆 Vybrat</button>
      <button data-mode="draw">✏️ Trasa</button>
      <button data-mode="area">🪵 Výdřeva</button>
      <button data-mode="dim">📏 Kóta</button>
      <button data-mode="place">🔌 Prvky</button>
      <button data-mode="photo">🖼️ Fotky</button>
      <button id="ortho" class="active">⊾ Pravé úhly</button>
      <button id="snap">🧲 Šlic</button>
      <button id="layers">🗂️ Vrstvy</button>
      <button id="fixorder">⚙️ Prvky</button>
    </div>`;

  // Fotostěna 3D pohled nemá — zpět se vrací na titulku, odkud se zakládá.
  root.querySelector('#back')!.addEventListener('click', () =>
    (location.hash = isPhotoWall ? '#/' : `#/storey/${storeyId}`));
  // Přepnout na druhý líc téže stěny (šlice/kóty/prvky má každá strana vlastní).
  root.querySelector('#flip-side')?.addEventListener('click', () => {
    commitDraft(); // rozkreslený šlic uzavřít, ať se neztratí
    location.hash = `#/wall/${W.id}/${side === 'A' ? 'B' : 'A'}`;
  });

  // --- undo / redo ---
  const undoBtn = root.querySelector('#undo') as HTMLButtonElement;
  const redoBtn = root.querySelector('#redo') as HTMLButtonElement;
  const syncHistoryBtns = () => { undoBtn.disabled = !canUndo(); redoBtn.disabled = !canRedo(); };
  syncHistoryBtns();
  registerCleanup(onHistoryChange(syncHistoryBtns));
  // Kreslíme-li zrovna šlic, ať v něm krok zpět/vpřed pokračuje — jen o bod jinde.
  // Zároveň si přeneseme výřez, ať krok zpět neskočí na „vejít se".
  const markResume = (): void => {
    if (mode === 'draw' && draft) resumeDraw = { wallId: W.id, side, routeId: draft.id };
    resumeView = { wallId: W.id, side, zoom: zoomNow(), cx: vb.x + vb.w / 2, cy: vb.y + vb.h / 2 };
  };
  undoBtn.addEventListener('click', async () => { markResume(); if (await undo()) await route(); });
  redoBtn.addEventListener('click', async () => { markResume(); if (await redo()) await route(); });

  // --- DISTO ---
  const distoDot = root.querySelector('#disto-dot') as HTMLElement;
  const offStatus = onDistoStatus((s) => {
    distoDot.style.background = s === 'connected' ? '#4ade80' : s === 'connecting' ? '#fbbf24' : '#64748b';
  });
  registerCleanup(offStatus);
  root.querySelector('#disto')!.addEventListener('click', () => connectDisto());

  // --- stav editoru ---
  const svg = root.querySelector('svg')!;
  const panel = root.querySelector('#panel') as HTMLElement;
  let mode: Mode = 'select';
  let ortho = true;
  let selectedRouteId: string | null = null;
  let draft: Route | null = null;
  let dimFirst: Anchor | null = null;
  let selectedDimId: string | null = null;
  // Kóta rozkresleného šlicu, která právě čeká na zadání míry (pole je cílem metru).
  let pendingDimId: string | null = null;
  let selectedFixtureId: string | null = null;
  let selectedAreaId: string | null = null;
  let areaFirst: XY | null = null;          // 1. roh rozkreslené výdřevy (2 ťuknutí)
  // Kreslení tažením: pointerdown zapíše počáteční roh, tažení kreslí živě, pointerup
  // desku dokončí — bez nutnosti pustit myš mezi rohy (dvě ťuknutí zůstávají jako záloha).
  let areaDown: XY | null = null;
  let draggingAreaId: string | null = null; // tažení vybrané výdřevy (posun)
  let areaGrab = { du: 0, dv: 0 };           // odsazení úchopu od středu desky
  let areaMoved = false;
  let areaCategoryId = 'vydreva';           // vrstva nové výdřevy
  // Wizard bloku nosníků — aktivní, když je areaCategoryId vrstva nosníků (nosnik-*).
  let beamDir: 'u' | 'v' = 'u';             // osa skladu: 'u' = svislé nosníky, 'v' = vodorovné
  let beamWidthMm = 60;                     // šířka jednoho nosníku (mm)
  let beamSpacingMm = 625;                  // osová rozteč nosníků (mm)
  let beamCount = 5;                        // počet nosníků v bloku
  let paletteLayerId = defaultCategoryForFixture('socket'); // vrstva zvolená v paletě (řídí filtr ikon)
  let placeKind: FixtureKind = 'socket';
  let placeCategoryId = paletteLayerId; // vrstva nově osazovaných prvků = zvolená vrstva palety
  let lastPlacedId: string | null = null; // naposledy osazený prvek (paleta k němu nabízí kóty)
  let draggingFixtureId: string | null = null;
  let fixtureGrab = { dx: 0, dy: 0 };        // odsazení středu prvku od kurzoru (px) — úchop za roh
  let fixtureMoved = false;
  let draggingRouteVertex: { routeId: string; index: number } | null = null; // tažený uzel vybraného šlicu
  let routeVertexMoved = false;
  let lastVtap: { routeId: string; index: number; t: number } | null = null; // detekce dvojkliku na uzel (smazání)
  let fitVb: ViewBox = wallViewBox(W, side); // referenční „vejít se" = lupa 100 %; srovná se na poměr plochy v refit()
  let vb: ViewBox = { ...fitVb };
  const ZMIN = 0.5, ZMAX = 12; // rozsah lupy (0.5× … 12×)
  let categoryId = project.categories[0]?.id ?? '';
  let brushWidthMm = 50; // výchozí šířka nového šlicu: 5 cm (lze změnit na libovolnou)
  let snap = false; // magnetické přichytávání trasy na tmavý šlic v podkladu
  let costField: CostField | null = null;
  let costFieldSig: string | null = null;
  // Editace oblasti dlaždice (režim Fotky): posun / roztažení za rohy / otočení.
  let draggingBgId: string | null = null;
  let bgGrab = { du: 0, dv: 0 };           // odsazení úchopu od středu dlaždice (posun)
  let bgResizeCorner: { du: -1 | 1; dv: -1 | 1 } | null = null; // tažený roh (resize)
  let bgRotating = false;                  // tažení rotačního úchopu
  let bgQuadCorner: number | null = null;  // tažený roh dlaždice s volnými rohy (quad)
  let bgMeshVertex: number | null = null;  // tažený vrchol síťové dlaždice (mesh)
  let bgMoved = false;
  /** Je zobrazovací bod uvnitř polygonu (ray‑casting)? */
  const pointInPoly = (pt: { x: number; y: number }, poly: { x: number; y: number }[]): boolean => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };

  const catById = (id: string) => project.categories.find((c) => c.id === id);

  // --- magnetické trasování šlicu ---
  async function ensureCostField(): Promise<void> {
    // Rastr nákladů skládá VŠECHNY textury líce dohromady (rovnocenné) — každou
    // na svůj výřez; nepokryté místo světlé (netahá cestu k sobě).
    const bgs = resolveBackgrounds(F);
    const sig = bgs.map((b) => b.photoId + (b.mesh ? `~${b.mesh.dst.map((q) => `${q.x},${q.y}`).join(';')}` : b.quad ? `#${b.quad.map((q) => `${q.x},${q.y}`).join(';')}` : b.region ? `@${b.region.uMm},${b.region.vMm},${b.region.widthMm},${b.region.heightMm},${b.region.rotDeg ?? 0}` : '')).join('|');
    if (!bgs.length) { costField = null; costFieldSig = null; return; }
    if (costField && costFieldSig === sig) return;
    const cw = Math.min(1400, Math.max(400, Math.round(FL * 0.5)));
    const ch = Math.max(64, Math.round(cw * W.heightMm / FL));
    const cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    const g = cv.getContext('2d')!;
    g.fillStyle = '#fff'; g.fillRect(0, 0, cw, ch); // nepokryté = světlé
    for (const b of bgs) {
      const blob = await getPhoto(b.photoId);
      if (!blob) continue;
      const bmp = await createImageBitmap(blob);
      if (b.mesh && b.mesh.src.length >= 3) {
        const dst = b.mesh.dst.map((q) => { const d = toDisplay(W, side, q.x, q.y); return { x: (d.x / FL) * cw, y: (d.y / W.heightMm) * ch }; });
        g.save();
        g.beginPath(); dst.forEach((p, i) => { if (i === 0) g.moveTo(p.x, p.y); else g.lineTo(p.x, p.y); }); g.closePath(); g.clip();
        for (const t of meshTriangles(b.mesh.src, dst)) {
          const m = affine3(t.s[0], t.s[1], t.s[2], t.d[0], t.d[1], t.d[2]);
          g.save();
          g.beginPath(); g.moveTo(t.d[0].x, t.d[0].y); g.lineTo(t.d[1].x, t.d[1].y); g.lineTo(t.d[2].x, t.d[2].y); g.closePath(); g.clip();
          g.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
          g.drawImage(bmp, 0, 0, 1, 1);
          g.restore();
        }
        g.restore();
      } else if (b.quad?.length === 4) {
        const P = b.quad.map((q) => { const d = toDisplay(W, side, q.x, q.y); return { x: (d.x / FL) * cw, y: (d.y / W.heightMm) * ch }; });
        for (const t of meshTriangles([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], P)) {
          const m = affine3(t.s[0], t.s[1], t.s[2], t.d[0], t.d[1], t.d[2]);
          g.save();
          g.beginPath(); g.moveTo(t.d[0].x, t.d[0].y); g.lineTo(t.d[1].x, t.d[1].y); g.lineTo(t.d[2].x, t.d[2].y); g.closePath(); g.clip();
          g.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
          g.drawImage(bmp, 0, 0, 1, 1);
          g.restore();
        }
      } else if (b.region) {
        const r = rectDisplayRect(W, side, b.region);
        const dx = (r.x / FL) * cw, dy = (r.y / W.heightMm) * ch, dw = (r.w / FL) * cw, dh = (r.h / W.heightMm) * ch;
        const rd = b.region.rotDeg;
        if (rd) {
          g.save();
          g.translate(dx + dw / 2, dy + dh / 2);
          g.rotate((rd * Math.PI) / 180);
          g.drawImage(bmp, -dw / 2, -dh / 2, dw, dh);
          g.restore();
        } else {
          g.drawImage(bmp, dx, dy, dw, dh);
        }
      } else {
        g.drawImage(bmp, 0, 0, cw, ch);
      }
      bmp.close?.();
    }
    costField = await buildCostField(cv);
    costFieldSig = sig;
  }
  function invalidateCostField(): void { costField = null; costFieldSig = null; }

  /** Bod stěny (u, v mm) → pixel rastru podkladu (přes zobrazovací souřadnice). */
  function wallToPx(uMm: number, vMm: number): { x: number; y: number } {
    const d = toDisplay(W, side, uMm, vMm);
    return { x: (d.x / FL) * costField!.w, y: (d.y / W.heightMm) * costField!.h };
  }
  /** Pixel rastru → bod stěny (u, v mm), oříznutý do viditelného líce. */
  function pxToWall(x: number, y: number): XY {
    const w = fromDisplay(W, side, (x / costField!.w) * FL, (y / costField!.h) * W.heightMm);
    return { x: Math.round(Math.min(Math.max(w.uMm, U0), U1)), y: Math.round(Math.min(Math.max(w.vMm, 0), W.heightMm)) };
  }
  /**
   * Magneticky přichycená lomená čára z prev do bodu p (bez počátku prev).
   * Zjednodušení běží v reálných mm (tolerance SNAP_TOL_MM), aby vzniklo jen
   * pár kótovatelných bodů, ne stovky pixelových kroků. Strop MAX_SNAP_PTS.
   */
  function snapDraftPath(prev: XY, p: { uMm: number; vMm: number }): XY[] {
    const SNAP_TOL_MM = 50, MAX_SNAP_PTS = 12;
    const a = wallToPx(prev.x, prev.y);
    const b = wallToPx(Math.min(Math.max(p.uMm, U0), U1), Math.min(Math.max(p.vMm, 0), W.heightMm));
    const mm = snapPathPx(costField!, a, b).map((pt) => pxToWall(pt.x, pt.y));
    mm[0] = { x: prev.x, y: prev.y }; // přesně navázat na předchozí bod
    let tol = SNAP_TOL_MM;
    let simp = simplifyPath(mm, tol);
    while (simp.length - 1 > MAX_SNAP_PTS) { tol *= 1.6; simp = simplifyPath(mm, tol); }
    const out = simp.slice(1); // bez počátku (== prev)
    if (out.length === 0) out.push({ x: Math.round(Math.min(Math.max(p.uMm, U0), U1)), y: Math.round(Math.min(Math.max(p.vMm, 0), W.heightMm)) });
    return out;
  }

  // --- podklad (narovnané fotky stěny — dlaždice) ---
  // ObjectURL pro každou fotku podle jejího id (víc dlaždic naráz).
  let bgUrls = new Map<string, string>();
  function revokeBgUrls(): void {
    for (const u of bgUrls.values()) URL.revokeObjectURL(u);
    bgUrls = new Map();
  }
  async function loadBackground(): Promise<void> {
    revokeBgUrls();
    for (const bg of F.backgrounds) {
      const blob = await getPhoto(bg.photoId);
      if (blob) bgUrls.set(bg.photoId, URL.createObjectURL(blob));
    }
  }
  /** Podklady ke složení do SVG (odspodu nahoru) — href + opacity + region. */
  function bgLayers(): { href: string; opacity: number; region?: WallBackground['region']; quad?: XY[]; mesh?: { src: XY[]; dst: XY[]; anchor: boolean[] } }[] {
    const out: { href: string; opacity: number; region?: WallBackground['region']; quad?: XY[]; mesh?: { src: XY[]; dst: XY[]; anchor: boolean[] } }[] = [];
    for (const b of resolveBackgrounds(F)) {
      const href = bgUrls.get(b.photoId);
      if (href) out.push({ href, opacity: b.opacity, region: b.region, quad: b.quad, mesh: b.mesh });
    }
    return out;
  }
  registerCleanup(revokeBgUrls);

  function setViewBox(): void {
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  }

  // --- lupa (posuvník + kolečko + pinch, vše propojené) ---
  const zoomSlider = root.querySelector('#zoom') as HTMLInputElement;
  const zpct = root.querySelector('#zpct') as HTMLElement;
  const clamp = (z: number) => Math.min(Math.max(z, ZMIN), ZMAX);
  const zoomNow = () => fitVb.w / vb.w; // aktuální přiblížení vůči „vejít se"
  const sliderToZoom = (s: number) => ZMIN * Math.pow(ZMAX / ZMIN, s / 1000);
  const zoomToSlider = (z: number) => (1000 * Math.log(z / ZMIN)) / Math.log(ZMAX / ZMIN);

  /** Sladí posuvník a procento s aktuálním viewBoxem. */
  function syncZoom(): void {
    const z = zoomNow();
    zoomSlider.value = String(Math.round(zoomToSlider(z)));
    zpct.textContent = `${Math.round(z * 100)} %`;
  }

  /**
   * Nastaví přiblížení na z× a zachová pevný bod (screenX/Y) — kolečko drží bod
   * pod kurzorem, posuvník/tlačítka drží střed plochy.
   */
  function zoomTo(z: number, screenX?: number, screenY?: number): void {
    z = clamp(z);
    const r = svg.getBoundingClientRect();
    const px = screenX ?? r.left + r.width / 2;
    const py = screenY ?? r.top + r.height / 2;
    const fx = vb.x + ((px - r.left) / r.width) * vb.w;
    const fy = vb.y + ((py - r.top) / r.height) * vb.h;
    const nw = fitVb.w / z, nh = fitVb.h / z;
    vb = {
      w: nw, h: nh,
      x: fx - ((px - r.left) / r.width) * nw,
      y: fy - ((py - r.top) / r.height) * nh,
    };
    setViewBox();
    syncZoom();
  }

  zoomSlider.addEventListener('input', () => zoomTo(sliderToZoom(Number(zoomSlider.value))));
  (root.querySelector('#zin') as HTMLButtonElement).addEventListener('click', () => zoomTo(zoomNow() * 1.4));
  (root.querySelector('#zout') as HTMLButtonElement).addEventListener('click', () => zoomTo(zoomNow() / 1.4));

  /** „Vejít se" box rozšířený na poměr stran plochy, aby preserveAspectRatio nic neolemoval. */
  function computeFitVb(): ViewBox {
    const base = wallViewBox(W, side); // stěna + okraj, vycentrovaná
    const rect = svg.getBoundingClientRect();
    const elAsp = rect.width > 1 && rect.height > 1 ? rect.width / rect.height : base.w / base.h;
    const baseAsp = base.w / base.h;
    let { x, y, w, h } = base;
    if (elAsp > baseAsp) { const nw = h * elAsp; x -= (nw - w) / 2; w = nw; }
    else { const nh = w / elAsp; y -= (nh - h) / 2; h = nh; }
    return { x, y, w, h };
  }

  /**
   * Sladí viewBox s poměrem stran plochy a zachová přiblížení i střed. Bez toho by
   * default preserveAspectRatio="meet" obraz vycentroval s prázdnými pruhy a lineární
   * přepočet myš→stěna by byl posunutý/škálovaný („přemapování z celé obrazovky").
   */
  function refit(): void {
    const z = zoomNow();
    const cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2;
    fitVb = computeFitVb();
    const nw = fitVb.w / z, nh = fitVb.h / z;
    vb = { w: nw, h: nh, x: cx - nw / 2, y: cy - nh / 2 };
    setViewBox();
    syncZoom();
  }

  const containerRO = new ResizeObserver(() => refit());
  containerRO.observe(svg);
  registerCleanup(() => containerRO.disconnect());

  function redraw(): void {
    svg.innerHTML = wallSvgContent(W, {
      side,
      categories: project.categories,
      selectedRouteId,
      // „+" úchopy jen v Trase a jen dokud nezačneš kreslit nový šlic (draft prázdný).
      showInsertHandles: mode === 'draw' && (draft?.points.length ?? 0) === 0,
      draftPoints: draft?.points,
      draftColor: catById(draft?.categoryId ?? categoryId)?.color,
      draftWidthMm: draft?.widthMm ?? brushWidthMm,
      draftRouteId: draft?.id,
      backgrounds: bgLayers(),
      selectedDimId,
      selectedFixtureId,
      selectedAreaId,
      // Kontrolní kóta rozměru (světlá míra) pro porovnání s naměřeným. Fotostěna
      // měřítko nemá, tam by ukazovala nesmyslné číslo → vynechat.
      refDims: !noScale(),
      // Šikmý strop (podkroví): líc se ukončí skloněnou hranou a obsah nad ni se ořízne.
      ceilingTop: storey ? faceCeilingPolyline(storey, W, side) ?? undefined : undefined,
    });
    // Vodítko obrysu místnosti (jen u podlahy/stropu) — plocha sama je obdélník bboxu.
    if (W.planOutline?.length) {
      const pts = W.planOutline.map((p) => toDisplay(W, side, p.x, p.y));
      const d = pts.map((q, i) => `${i ? 'L' : 'M'} ${q.x} ${q.y}`).join(' ') + ' Z';
      svg.insertAdjacentHTML('beforeend',
        `<path d="${d}" fill="none" stroke="#38bdf8" stroke-width="30" stroke-dasharray="80 50" opacity="0.55" pointer-events="none"/>`);
    }
    // Rámeček + úchopy vybrané dlaždice (jen režim Fotky).
    if (mode === 'photo') {
      const bg = activeBg();
      if (bg?.mesh && bg.mesh.dst.length >= 3) {
        // Síťová dlaždice: kotvy (🎯 modrý terč) + ořezové body (žlutě), a cíle struktury (zeleně).
        const P = bg.mesh.dst.map((p) => toDisplay(W, side, p.x, p.y));
        const poly = P.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
        const struct = structurePoints().map((s) => toDisplay(W, side, s.uMm, s.vMm));
        const sm = struct.map((s) => `<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="55" fill="none" stroke="#22c55e" stroke-width="10" opacity="0.6" pointer-events="none"/><circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="10" fill="#22c55e" pointer-events="none"/>`).join('');
        // Duté úchopy (průhledný střed → vidíš na roh, kam kotvu umisťuješ) + přesný bod.
        const hs = P.map((c, i) => {
          const col = bg.mesh!.anchor[i] ? '#38bdf8' : '#facc15';
          const dash = bg.mesh!.anchor[i] ? '' : ' stroke-dasharray="34 24"';
          return `<circle data-bgm="${i}" cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="100" fill="transparent" pointer-events="all"/>` +
            `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="80" fill="none" stroke="#0f172a" stroke-width="30" pointer-events="none"/>` +
            `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="80" fill="none" stroke="${col}" stroke-width="16"${dash} pointer-events="none"/>` +
            `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="10" fill="${col}" stroke="#0f172a" stroke-width="4" pointer-events="none"/>`;
        }).join('');
        svg.insertAdjacentHTML('beforeend',
          sm + `<polygon points="${poly}" fill="none" stroke="#38bdf8" stroke-width="14" stroke-dasharray="50 34" pointer-events="none"/>${hs}`);
      } else if (bg?.quad?.length === 4) {
        // Volné rohy (corner‑pin): 4 nezávislé úchopy, bez rotace/roztažení.
        const cs = bg.quad.map((p) => toDisplay(W, side, p.x, p.y));
        const poly = cs.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
        const hs = cs.map((c, i) => `<circle data-bgc="${i}" cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="80" fill="#fff" stroke="#38bdf8" stroke-width="22"/>`).join('');
        svg.insertAdjacentHTML('beforeend',
          `<polygon points="${poly}" fill="none" stroke="#38bdf8" stroke-width="16" stroke-dasharray="60 40" pointer-events="none"/>${hs}`);
      } else if (bg) {
        const info = bgDisp(bg);
        const cs = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([du, dv]) => bgCornerPos(info, du, dv));
        const poly = cs.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
        const hs = cs.map((c) => `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="70" fill="#fff" stroke="#38bdf8" stroke-width="20"/>`).join('');
        // rotační úchop: spojnice od horní hrany + kolečko
        const rp = bgRotPos(info);
        const top = { x: (cs[0].x + cs[1].x) / 2, y: (cs[0].y + cs[1].y) / 2 };
        svg.insertAdjacentHTML('beforeend',
          `<polygon points="${poly}" fill="none" stroke="#38bdf8" stroke-width="16" stroke-dasharray="60 40" pointer-events="none"/>` +
          `<line x1="${top.x.toFixed(1)}" y1="${top.y.toFixed(1)}" x2="${rp.x.toFixed(1)}" y2="${rp.y.toFixed(1)}" stroke="#38bdf8" stroke-width="12" pointer-events="none"/>` +
          `<circle cx="${rp.x.toFixed(1)}" cy="${rp.y.toFixed(1)}" r="80" fill="#38bdf8" stroke="#fff" stroke-width="18"/>` +
          hs);
      }
    }
    setViewBox();
  }

  // --- geometrie ---
  const mmPerPx = () => vb.w / svg.getBoundingClientRect().width;

  function screenToWall(clientX: number, clientY: number): { uMm: number; vMm: number } {
    const d = screenToDisplay(clientX, clientY);
    return fromDisplay(W, side, d.x, d.y);
  }

  /** Bod na obrazovce → zobrazovací (svg) souřadnice líce. */
  function screenToDisplay(clientX: number, clientY: number): { x: number; y: number } {
    const r = svg.getBoundingClientRect();
    return {
      x: vb.x + ((clientX - r.left) / r.width) * vb.w,
      y: vb.y + ((clientY - r.top) / r.height) * vb.h,
    };
  }

  function snapPoint(p: { uMm: number; vMm: number }, prev: XY | null): XY {
    let u = Math.min(Math.max(p.uMm, U0), U1);
    let v = Math.min(Math.max(p.vMm, 0), W.heightMm);
    if (prev && ortho) {
      const du = u - prev.x;
      const dv = v - prev.y;
      const adu = Math.abs(du), adv = Math.abs(dv);
      // 45° pásmo ±10° kolem diagonály, jinak svisle/vodorovně
      const ratio = adu === 0 || adv === 0 ? 0 : Math.min(adu, adv) / Math.max(adu, adv);
      if (ratio > 0.7) {
        const m = Math.max(adu, adv);
        u = prev.x + Math.sign(du) * m;
        v = prev.y + Math.sign(dv) * m;
      } else if (adu > adv) v = prev.y;
      else u = prev.x;
    }
    return { x: Math.round(u), y: Math.round(v) };
  }

  function setSegmentLength(route: Route, i: number, mm: number): void {
    const a = route.points[i], b = route.points[i + 1];
    if (!a || !b || mm <= 0) return;
    const cur = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const dx = ((b.x - a.x) / cur) * mm - (b.x - a.x);
    const dy = ((b.y - a.y) / cur) * mm - (b.y - a.y);
    for (let k = i + 1; k < route.points.length; k++) {
      route.points[k] = { x: Math.round(route.points[k].x + dx), y: Math.round(route.points[k].y + dy) };
    }
    route.segLengthsMm[i] = Math.round(mm);
    saveProject();
    redraw();
  }

  /** Posouvatelná kotva kóty (trasa nebo prvek), kterou lze míru „doladit" posunem. */
  const movAnchor = (d: Dimension): Anchor | null => {
    for (const a of [d.from, d.to]) {
      if (a.kind === 'routePoint' || a.kind === 'routeSeg' || a.kind === 'fixture' || a.kind === 'area') return a;
    }
    return null;
  };
  /** Osa, kterou hrana svazuje: svislé hrany drží u, vodorovné (podlaha/strop) drží v. */
  const edgeAxis = (e: 'top' | 'bottom' | 'left' | 'right'): 'u' | 'v' =>
    e === 'top' || e === 'bottom' ? 'v' : 'u';
  const dimEdge = (d: Dimension) =>
    d.from.kind === 'edge' ? d.from : d.to.kind === 'edge' ? d.to : null;

  /**
   * Kóta trasa↔hrana posune okótovaný bod na naměřenou vzdálenost od hrany, a to
   * podél osy, kterou hrana svazuje (svislé hrany → u, vodorovné → v). Posune se
   * jen „svá" flood‑fill množina (bod + rigidně spojené sousedi, viz níže) — takže
   * kóty na RŮZNÉ body téže osy, spojené neměřeným (natažitelným) úsekem, se
   * splní SOUČASNĚ a nepřebíjí se (spodní bod ↔ podlaha i horní bod ↔ strop platí
   * naráz, mezilehlý úsek se natáhne/zkrátí).
   *
   * Skutečné rozpory (dvě kóty na TÝŽ bod, nebo body spojené jen MĚŘENÝMI úseky —
   * over‑constrained) se neřeší silou: geometrie se posune, jak umí, a kóta, která
   * pak nesedí, se vykreslí červeně s „≠ skutečnost" (viz wall-svg.ts).
   */
  function applyDimValue(dim: Dimension, mm: number): void {
    dim.valueMm = Math.round(mm);
    const ra = movAnchor(dim);        // posouvaná entita (trasa nebo prvek)
    const ed = dimEdge(dim);          // hrana, od které se měří
    // Fotostěna nemá měřítko: kóta je jen zapsaná naměřená hodnota (vztažená
    // k rohu / hraně fotky). Geometrií nehýbeme — zákres by se rozjel.
    if (ra && ed && !noScale()) {
      const axis = edgeAxis(ed.edge);
      const p = resolveAnchor(W, side, ra); // aktuální poloha kótované entity
      if (p) {
        let du = 0, dv = 0;
        if (ed.edge === 'bottom') dv = mm - p.vMm;
        else if (ed.edge === 'top') dv = (W.heightMm - mm) - p.vMm;
        else if (ed.edge === 'left') du = (U0 + mm) - p.uMm;
        else du = (U1 - mm) - p.uMm;
        if (ra.kind === 'fixture') {
          const f = F.fixtures.find((x) => x.id === ra.fixtureId);
          if (f) { f.uMm = Math.round(f.uMm + du); f.vMm = Math.round(f.vMm + dv); }
        } else if (ra.kind === 'area') {
          const ar = F.areas.find((x) => x.id === ra.areaId);
          if (ar) {
            ar.uMm = Math.round(ar.uMm + du); ar.vMm = Math.round(ar.vMm + dv);
            // Nosník bloku: kóta podél osy skladu ho PŘIPNE (má přednost před roztečí)
            // a přerovná zbytek bloku; kóta v kolmém směru jen posune, nepřipíná.
            if (ar.beamGroupId) {
              if ((ar.beamAxis ?? 'u') === axis) ar.beamPinned = true;
              reflowBeamGroup(ar.beamGroupId);
            }
          }
        } else if (ra.kind === 'routePoint' || ra.kind === 'routeSeg') {
          const route = F.routes.find((r) => r.id === ra.routeId);
          if (route && route.points.length) {
            // Neposouváme celou trasu (odlepila by se od podlahy / utekla mimo líc),
            // ale jen souvislou část kolem okótovaného bodu. Priorita: NAMĚŘENÉ segmenty
            // jsou pravda a nesmí se protahovat — hýbou se rigidně (oba body spolu).
            // Neměřené segmenty jsou volné. Flood‑fill se šíří RIGIDNĚ přes segment, který
            // je KOLMÝ na osu posunu (drží pravý úhel) NEBO má naměřenou délku; „povolí"
            // (natáhne se) jen NEMĚŘENÝ segment ROVNOBĚŽNÝ s posunem — ten je jediná vůle.
            const moveU = axis === 'u';
            const EPS = 1; // mm — ortho segmenty mají souřadnici shodnou přesně
            const rigid = (k: number): boolean => route.segLengthsMm[k] != null || (moveU
              ? Math.abs(route.points[k].x - route.points[k + 1].x) <= EPS
              : Math.abs(route.points[k].y - route.points[k + 1].y) <= EPS);
            const inSet = new Array(route.points.length).fill(false);
            const seeds = ra.kind === 'routeSeg' ? [ra.index, ra.index + 1] : [ra.index];
            const stack: number[] = [];
            for (const s of seeds) { if (!inSet[s]) { inSet[s] = true; stack.push(s); } }
            while (stack.length) {
              const i = stack.pop()!;
              if (i > 0 && rigid(i - 1) && !inSet[i - 1]) { inSet[i - 1] = true; stack.push(i - 1); }
              if (i < route.points.length - 1 && rigid(i) && !inSet[i + 1]) { inSet[i + 1] = true; stack.push(i + 1); }
            }
            for (let k = 0; k < route.points.length; k++) {
              if (inSet[k]) route.points[k] = { x: route.points[k].x + du, y: route.points[k].y + dv };
            }
            // Naměřené délky nepřepisujeme — protahují se jen neměřené (null) segmenty.
          }
        }
      }
    }
    saveProject();
    redraw();
  }

  /**
   * Nejbližší existující kóta pod bodem p. Klikací zóna je celý pás mezi kótovací
   * čárou (odsazení OFF) a popiskem míry (dál o LABEL_OFF) — ne jen tenká čára, ať
   * se dá kóta pohodlně trefit i na dotyku klikem na číslo. BAND_HALF je pevná
   * polovina tloušťky pásu v mm (nezávislá na zoomu), tolMm je navíc „tlustý prst".
   */
  function hitDim(p: { uMm: number; vMm: number }, tolMm: number): Dimension | null {
    const OFF = 300;        // odsazení kótovací čáry — musí sedět s wall-svg.ts
    const LABEL_OFF = 95;   // popisek míry je kolmo ještě dál — viz wall-svg.ts
    const BAND_MID = OFF + LABEL_OFF * 0.5;     // střed pásu čára↔popisek
    const BAND_HALF = OFF - BAND_MID + LABEL_OFF + 90; // pokryje čáru i výšku textu
    const cx = FL / 2, cy = W.heightMm / 2; // střed v zobrazovacích souřadnicích
    const click = toDisplay(W, side, p.uMm, p.vMm);
    let best: Dimension | null = null;
    let bestD = Infinity;
    for (const dim of F.dims) {
      const ep = dimEndpoints(W, side,dim);
      if (!ep) continue;
      const a = toDisplay(W, side, ep.a.uMm, ep.a.vMm);
      const b = toDisplay(W, side, ep.b.uMm, ep.b.vMm);
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      let d: number, eff: number;
      if (seg < 1) {
        // degenerovaná kóta = bod (kroužek + text nad ním); velkorysý kruhový zásah
        d = Math.hypot(click.x - a.x, click.y - (a.y - 60));
        eff = tolMm + 140;
      } else {
        const dxu = (b.x - a.x) / seg, dyu = (b.y - a.y) / seg;
        let nx = -dyu, ny = dxu;
        if (nx * ((a.x + b.x) / 2 - cx) + ny * ((a.y + b.y) / 2 - cy) < 0) { nx = -nx; ny = -ny; }
        const A = { x: a.x + nx * BAND_MID, y: a.y + ny * BAND_MID };
        const B = { x: b.x + nx * BAND_MID, y: b.y + ny * BAND_MID };
        d = distToSegment({ uMm: click.x, vMm: click.y }, A, B);
        eff = tolMm + BAND_HALF;
      }
      if (d <= eff && d < bestD) { bestD = d; best = dim; }
    }
    return best;
  }

  /** Vzdálenost bodu k obdélníkové značce prvku (0 uvnitř), + tolerance kolem. */
  function fixtureDist(f: Fixture, p: { uMm: number; vMm: number }): number {
    const { w, h } = fixtureSize(f);
    const dx = Math.abs(p.uMm - f.uMm) - w / 2;
    const dy = Math.abs(p.vMm - f.vMm) - h / 2;
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  }

  /** Prvek pod bodem p (uvnitř značky + tolerance); z překrytých vybere ten s nejbližším středem. */
  function hitFixture(p: { uMm: number; vMm: number }, tolMm: number): Fixture | null {
    let best: Fixture | null = null;
    let bestD = Infinity;
    for (const f of F.fixtures) {
      const d = fixtureDist(f, p);
      if (d > tolMm) continue;
      const center = Math.hypot(f.uMm - p.uMm, f.vMm - p.vMm);
      if (center < bestD) { bestD = center; best = f; }
    }
    return best;
  }

  function hitRoute(p: { uMm: number; vMm: number }, tolMm: number): Route | null {
    let best: Route | null = null;
    let bestD = tolMm;
    for (const r of F.routes) {
      for (let i = 0; i < r.points.length - 1; i++) {
        const d = distToSegment(p, r.points[i], r.points[i + 1]) - r.widthMm / 2;
        if (d < bestD) { bestD = d; best = r; }
      }
    }
    return best;
  }

  /**
   * Uzel vybraného šlicu pod kurzorem (kolečka jsou vidět jen u vybrané trasy).
   * Hledá se v ZOBRAZOVACÍCH souřadnicích, kde je i render koleček (r≈60).
   */
  function hitRouteVertex(routeId: string | null, clientX: number, clientY: number): { routeId: string; index: number } | null {
    if (!routeId) return null;
    const r = F.routes.find((x) => x.id === routeId);
    if (!r || r.points.length < 1) return null;
    const d = screenToDisplay(clientX, clientY);
    const tol = Math.max(30 * mmPerPx(), 90); // štědrý úchop kolem kolečka
    let best = -1, bestD = tol;
    r.points.forEach((pt, i) => {
      const c = toDisplay(W, side, pt.x, pt.y);
      const dd = Math.hypot(c.x - d.x, c.y - d.y);
      if (dd < bestD) { bestD = dd; best = i; }
    });
    return best >= 0 ? { routeId, index: best } : null;
  }

  /** Střed segmentu vybraného šlicu pod kurzorem (úchop „+" pro vložení uzlu). */
  function hitRouteMidpoint(routeId: string | null, clientX: number, clientY: number): { routeId: string; seg: number } | null {
    if (!routeId) return null;
    const r = F.routes.find((x) => x.id === routeId);
    if (!r || r.points.length < 2) return null;
    const d = screenToDisplay(clientX, clientY);
    const tol = Math.max(30 * mmPerPx(), 70);
    let best = -1, bestD = tol;
    for (let i = 0; i < r.points.length - 1; i++) {
      const a = toDisplay(W, side, r.points[i].x, r.points[i].y);
      const b = toDisplay(W, side, r.points[i + 1].x, r.points[i + 1].y);
      const dd = Math.hypot((a.x + b.x) / 2 - d.x, (a.y + b.y) / 2 - d.y);
      if (dd < bestD) { bestD = dd; best = i; }
    }
    return best >= 0 ? { routeId, seg: best } : null;
  }

  /** Cíl taženého uzlu: přichycení na střed prvku, jinak (volitelně ortho k sousedům) + ořez do líce. */
  function vertexTarget(r: Route, idx: number, p: { uMm: number; vMm: number }): XY {
    const fx = hitFixture(p, 30 * mmPerPx()); // šlic často končí na zásuvce → přichyť přesně
    if (fx) return { x: fx.uMm, y: fx.vMm };
    const clamped = { uMm: Math.min(Math.max(p.uMm, U0), U1), vMm: Math.min(Math.max(p.vMm, 0), W.heightMm) };
    if (!ortho) return { x: Math.round(clamped.uMm), y: Math.round(clamped.vMm) };
    // ortho: zarovnej H/V/45° vůči sousedovi; u vnitřního uzlu vyber toho, který je blíž kurzoru
    const cands: XY[] = [];
    if (r.points[idx - 1]) cands.push(snapPoint(clamped, r.points[idx - 1]));
    if (r.points[idx + 1]) cands.push(snapPoint(clamped, r.points[idx + 1]));
    if (!cands.length) return { x: Math.round(clamped.uMm), y: Math.round(clamped.vMm) };
    let best = cands[0], bd = Infinity;
    for (const c of cands) { const dd = Math.hypot(c.x - clamped.uMm, c.y - clamped.vMm); if (dd < bd) { bd = dd; best = c; } }
    return best;
  }

  /**
   * Vloží nový uzel do půli segmentu `seg` (index nového bodu = seg+1) a srovná
   * indexy kót ukotvených na tuto trasu. Vrací index vloženého uzlu (k tažení).
   */
  function insertRouteVertex(r: Route, seg: number): number {
    const a = r.points[seg], b = r.points[seg + 1];
    remapDimsInsert(r.id, seg, 0.5); // před splicem: přemapuj kóty (bod v půli → t = 0.5)
    r.points.splice(seg + 1, 0, { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) });
    r.segLengthsMm.splice(seg, 1, null, null); // rozdělený segment → dvě neznámé délky
    return seg + 1;
  }

  /** Odebere uzel `k`; drží aspoň 2 body. Přemapuje/odebere dotčené kóty. Vrací, zda smazal. */
  function removeRouteVertex(routeId: string, k: number): boolean {
    const r = F.routes.find((x) => x.id === routeId);
    if (!r || r.points.length <= 2) return false; // pod 2 body by trasa zanikla
    remapDimsRemove(routeId, k, r.points.length); // před splicem (počítá se ze starých indexů)
    if (k === 0) { r.points.splice(0, 1); r.segLengthsMm.splice(0, 1); }
    else if (k === r.points.length - 1) { r.points.splice(k, 1); r.segLengthsMm.splice(k - 1, 1); }
    else { r.points.splice(k, 1); r.segLengthsMm.splice(k, 1); r.segLengthsMm[k - 1] = null; } // splynulý segment = neznámá délka
    return true;
  }

  /** Posun indexů kót po VLOŽENÍ uzlu (segment `seg` se dělí v parametru `ts`). */
  function remapDimsInsert(routeId: string, seg: number, ts: number): void {
    const fix = (a: Anchor): Anchor => {
      if (a.kind === 'routePoint' && a.routeId === routeId) return a.index >= seg + 1 ? { ...a, index: a.index + 1 } : a;
      if (a.kind === 'routeSeg' && a.routeId === routeId) {
        if (a.index < seg) return a;
        if (a.index > seg) return { ...a, index: a.index + 1 };
        // dělený segment: kóta zůstane na té polovině, kam padne její parametr t
        return a.t <= ts
          ? { ...a, index: seg, t: ts > 0 ? Math.min(1, a.t / ts) : a.t }
          : { ...a, index: seg + 1, t: ts < 1 ? Math.max(0, (a.t - ts) / (1 - ts)) : a.t };
      }
      return a;
    };
    for (const dm of F.dims) { dm.from = fix(dm.from); dm.to = fix(dm.to); }
  }

  /** Posun/odebrání kót po ODEBRÁNÍ uzlu `k` (stará délka trasy `n` bodů). */
  function remapDimsRemove(routeId: string, k: number, n: number): void {
    const last = n - 1;
    const fix = (a: Anchor): Anchor | null => {
      if (a.kind === 'routePoint' && a.routeId === routeId) {
        if (a.index === k) return null;              // uzel zaniká → kótu zahodit
        return a.index > k ? { ...a, index: a.index - 1 } : a;
      }
      if (a.kind === 'routeSeg' && a.routeId === routeId) {
        if (k === 0) return a.index === 0 ? null : { ...a, index: a.index - 1 };
        if (k === last) return a.index === last - 1 ? null : a;
        if (a.index === k - 1 || a.index === k) return null; // splynulé segmenty → kótu zahodit
        return a.index > k ? { ...a, index: a.index - 1 } : a;
      }
      return a;
    };
    F.dims = F.dims.filter((dm) => {
      const nf = fix(dm.from), nt = fix(dm.to);
      if (!nf || !nt) return false;
      dm.from = nf; dm.to = nt;
      return true;
    });
  }

  // --- výdřevy (plošné desky) ---
  const clampU = (u: number) => Math.min(Math.max(u, U0), U1);
  const clampV = (v: number) => Math.min(Math.max(v, 0), W.heightMm);
  /** Střed + rozměry obdélníku ze dvou protilehlých rohů. */
  function areaFromCorners(u0: number, v0: number, u1: number, v1: number): Pick<WallArea, 'uMm' | 'vMm' | 'widthMm' | 'heightMm'> {
    const uMin = Math.min(u0, u1), uMax = Math.max(u0, u1);
    const vMin = Math.min(v0, v1), vMax = Math.max(v0, v1);
    return { uMm: Math.round((uMin + uMax) / 2), vMm: Math.round((vMin + vMax) / 2), widthMm: Math.round(uMax - uMin), heightMm: Math.round(vMax - vMin) };
  }
  /** Vzdálenost bodu k obdélníku výdřevy (0 uvnitř). */
  function areaDist(a: WallArea, p: { uMm: number; vMm: number }): number {
    const dx = Math.abs(p.uMm - a.uMm) - a.widthMm / 2;
    const dy = Math.abs(p.vMm - a.vMm) - a.heightMm / 2;
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  }
  /** Výdřeva pod bodem (uvnitř + tolerance); z překrytých ta s nejbližším středem. */
  function hitArea(p: { uMm: number; vMm: number }, tolMm: number): WallArea | null {
    let best: WallArea | null = null;
    let bestD = Infinity;
    for (const a of F.areas) {
      if (areaDist(a, p) > tolMm) continue;
      const center = Math.hypot(a.uMm - p.uMm, a.vMm - p.vMm);
      if (center < bestD) { bestD = center; best = a; }
    }
    return best;
  }

  // --- bloky nosníků (wizard: stropní / SDK nosníky) ---
  /** Je vrstva stavební konstrukce, pro kterou platí wizard bloku nosníků? */
  const isBeamLayer = (id: string): boolean => id === 'nosnik-sdk' || id === 'nosnik-strop';

  /**
   * Vloží celý blok rovnoběžných nosníků najednou (dle wizardu) jako skupinu
   * `WallArea`. Nosníky běží od stěny ke stěně (délka = celé plátno v ose kolmé na
   * osu skladu); blok se vycentruje doprostřed plátna. SDK má směr natvrdo svislý.
   */
  function insertBeamBlock(): void {
    const axis: 'u' | 'v' = areaCategoryId === 'nosnik-sdk' ? 'u' : beamDir;
    const n = Math.max(1, Math.round(beamCount));
    const w = Math.max(MIN_AREA_MM, Math.round(beamWidthMm));
    const spacing = Math.max(1, Math.round(beamSpacingMm));
    const groupId = newId();
    const span = (n - 1) * spacing;
    const uC = (U0 + U1) / 2, vC = W.heightMm / 2;
    const fullW = Math.round(U1 - U0), fullH = Math.round(W.heightMm);
    const start = (axis === 'u' ? uC : vC) - span / 2;
    // Pozice středů podél osy skladu (u nebo v), vzestupně.
    const positions = Array.from({ length: n }, (_, i) => Math.round(start + i * spacing));
    // Pořadí NA OBRAZOVCE: displayU může osu zrcadlit → beamIndex i znaménko rozteče
    // srovnáme podle zobrazení, aby „první" (nejnižší index = kotva reflow) byl nosník
    // vlevo/nahoře v čelním pohledu, jak ho uživatel vnímá.
    const disp = (p: number): number =>
      axis === 'u' ? toDisplay(W, side, p, vC).x : toDisplay(W, side, uC, p).y;
    const reversed = n > 1 && disp(positions[1]) < disp(positions[0]);
    const signedSpacing = reversed ? -spacing : spacing;
    let firstId: string | null = null;
    for (let i = 0; i < n; i++) {
      const along = positions[i];
      const idx = reversed ? n - 1 - i : i; // beamIndex v pořadí na obrazovce
      const a: WallArea = {
        id: newId(), categoryId: areaCategoryId, note: '',
        uMm: axis === 'u' ? along : Math.round(uC),
        vMm: axis === 'v' ? along : Math.round(vC),
        widthMm: axis === 'u' ? w : fullW,
        heightMm: axis === 'v' ? w : fullH,
        beamGroupId: groupId, beamIndex: idx, beamAxis: axis, beamSpacingMm: signedSpacing, beamPinned: false,
      };
      F.areas.push(a);
      if (idx === 0) firstId = a.id;
    }
    ensureCategoryVisible(areaCategoryId); // ať se nosníky neschovají ve skryté vrstvě
    selectedAreaId = firstId;
    saveProject();
    redraw();
    showAreaPanel();
  }

  /**
   * Přerovná nosníky bloku podle rozteče. Kotva = PRVNÍ připnutý nosník (nejnižší
   * index), jinak nosník 0 na své současné pozici. NEPŘIPNUTÉ nosníky se dopočítají
   * od nejbližšího připnutého při procházení podle indexu — nosníky před prvním
   * připnutým od té kotvy (i „dozadu"), nosníky za připnutým od něj. Připnutý nosník
   * (má vlastní kótu) drží → kóta má přednost před roztečí a připnutí KTERÉHOKOLI
   * nosníku posune celý blok relativně k němu (nezávisí na směru zobrazení / indexu).
   * Mění se jen pozice podél osy skladu; šířka i délka zůstávají.
   */
  function reflowBeamGroup(groupId: string): void {
    const beams = F.areas
      .filter((a) => a.beamGroupId === groupId)
      .sort((a, b) => (a.beamIndex ?? 0) - (b.beamIndex ?? 0));
    if (!beams.length) return;
    const axis = beams[0].beamAxis ?? 'u';
    const spacing = beams[0].beamSpacingMm ?? 1;
    const pos = (a: WallArea): number => (axis === 'u' ? a.uMm : a.vMm);
    const setPos = (a: WallArea, v: number): void => { if (axis === 'u') a.uMm = Math.round(v); else a.vMm = Math.round(v); };
    // Referenční nosník: první připnutý (nejnižší index), jinak nosník 0.
    let ref = beams.find((b) => b.beamPinned) ?? beams[0];
    for (const b of beams) {
      if (b.beamPinned) { ref = b; continue; } // připnutý drží a stává se referencí pro další
      setPos(b, pos(ref) + ((b.beamIndex ?? 0) - (ref.beamIndex ?? 0)) * spacing);
    }
  }

  /** Smaže celý blok nosníků (všechny nosníky skupiny + jejich kóty). */
  function deleteBeamGroup(groupId: string): void {
    const ids = new Set(F.areas.filter((a) => a.beamGroupId === groupId).map((a) => a.id));
    F.areas = F.areas.filter((a) => !ids.has(a.id));
    F.dims = F.dims.filter((d) =>
      !(d.from.kind === 'area' && ids.has(d.from.areaId)) &&
      !(d.to.kind === 'area' && ids.has(d.to.areaId)));
    selectedAreaId = null;
    saveProject();
    redraw();
    panel.innerHTML = '';
    panel.className = '';
  }

  // --- editace oblasti dlaždice (režim Fotky): posun / roztažení / OTOČENÍ ---
  // Vše se počítá v ZOBRAZOVACÍCH souřadnicích (svg), kde je i render dlaždice —
  // rotace je tak přímočará a konzistentní s <g rotate> ve wall-svg.
  /** Rotace bodu (x,y) o `deg` po směru hodin (svg y-dolů). */
  const rot2 = (x: number, y: number, deg: number): { x: number; y: number } => {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    return { x: x * c - y * s, y: x * s + y * c };
  };
  const ROT_GAP = 260; // odsazení rotačního úchopu nad horní hranu (zobrazovací mm)
  /** Zobrazovací info dlaždice: střed, rozměr, otočení. */
  function bgDisp(bg: WallBackground): { cx: number; cy: number; w: number; h: number; rot: number } {
    const rg = bgRegion(bg);
    const r = rectDisplayRect(W, side, rg);
    return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w, h: r.h, rot: rg.rotDeg ?? 0 };
  }
  /** Zobrazovací poloha rohu (du,dv = ±1) otočené dlaždice. */
  function bgCornerPos(info: { cx: number; cy: number; w: number; h: number; rot: number }, du: number, dv: number): { x: number; y: number } {
    const l = rot2((du * info.w) / 2, (dv * info.h) / 2, info.rot);
    return { x: info.cx + l.x, y: info.cy + l.y };
  }
  /** Zobrazovací poloha rotačního úchopu (nad horní hranou dlaždice). */
  function bgRotPos(info: { cx: number; cy: number; w: number; h: number; rot: number }): { x: number; y: number } {
    const l = rot2(0, -(info.h / 2 + ROT_GAP), info.rot);
    return { x: info.cx + l.x, y: info.cy + l.y };
  }
  /** Roh dlaždice pod zobrazovacím bodem d, nebo null. */
  function bgCornerAt(info: { cx: number; cy: number; w: number; h: number; rot: number }, d: { x: number; y: number }, tolMm: number): { du: -1 | 1; dv: -1 | 1 } | null {
    let best: { du: -1 | 1; dv: -1 | 1 } | null = null;
    let bestD = tolMm;
    for (const du of [-1, 1] as const) for (const dv of [-1, 1] as const) {
      const c = bgCornerPos(info, du, dv);
      const dist = Math.hypot(c.x - d.x, c.y - d.y);
      if (dist < bestD) { bestD = dist; best = { du, dv }; }
    }
    return best;
  }
  /** Je zobrazovací bod d uvnitř otočené dlaždice (+ tolerance)? */
  function bgHit(info: { cx: number; cy: number; w: number; h: number; rot: number }, d: { x: number; y: number }, tolMm: number): boolean {
    const l = rot2(d.x - info.cx, d.y - info.cy, -info.rot);
    return Math.abs(l.x) <= info.w / 2 + tolMm && Math.abs(l.y) <= info.h / 2 + tolMm;
  }

  /**
   * Kotva pod kurzorem — vybere NEJBLIŽŠÍ cíl podle skutečné vzdálenosti:
   * vrchol/roh trasy, úsečka šlicu, a u 2. bodu i hrana stěny. Dřív měla hrana
   * pevnou přednost a „přebíjela" šlic, kdykoli byl blízko okraje.
   */
  function dimAnchorAt(p: { uMm: number; vMm: number }, tolMm: number): Anchor {
    const free: Anchor = { kind: 'point', uMm: Math.round(p.uMm), vMm: Math.round(p.vMm) };
    const cands: { a: Anchor; d: number }[] = [];
    const consider = (a: Anchor, d: number): void => {
      if (d <= tolMm) cands.push({ a, d });
    };

    // osazené prvky — hlavní cíle kótování; vzdálenost k boxu (0 uvnitř), ať
    // se kóta chytne kdekoli na značce (i u velkých prvků jako rozvaděč/klima)
    for (const f of F.fixtures) {
      consider({ kind: 'fixture', fixtureId: f.id }, fixtureDist(f, p));
    }
    // výdřevy/nosníky — celé TĚLO desky je cíl (chytne střed), plus rohy jako přesné
    // body. Tělo přes vzdálenost k obdélníku (0 uvnitř): u dlouhých nosníků nelze
    // trefovat jen 5 diskrétních bodů — ťuknutí kdekoli po délce se chytí na střed.
    const AREA_BONUS = 0.35 * tolMm;
    const areaCorners: [-1 | 1, -1 | 1][] = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (const ar of F.areas) {
      consider({ kind: 'area', areaId: ar.id, du: 0, dv: 0 }, areaDist(ar, p) - AREA_BONUS);
      for (const [du, dv] of areaCorners) {
        const u = ar.uMm + du * ar.widthMm / 2, v = ar.vMm + dv * ar.heightMm / 2;
        consider({ kind: 'area', areaId: ar.id, du, dv }, Math.hypot(u - p.uMm, v - p.vMm) - AREA_BONUS);
      }
    }
    // vrcholy/rohy tras — malý bonus, ať jdou chytit i těsně vedle úsečky
    const VERTEX_BONUS = 0.35 * tolMm;
    for (const r of F.routes) {
      r.points.forEach((pt, i) => {
        consider({ kind: 'routePoint', routeId: r.id, index: i }, Math.hypot(pt.x - p.uMm, pt.y - p.vMm) - VERTEX_BONUS);
      });
    }
    // úsečky tras — kolmý průmět oříznutý na segment
    for (const r of F.routes) {
      for (let i = 0; i < r.points.length - 1; i++) {
        const a = r.points[i], b = r.points[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
        if (len2 === 0) continue;
        const t = Math.min(1, Math.max(0, ((p.uMm - a.x) * dx + (p.vMm - a.y) * dy) / len2));
        consider({ kind: 'routeSeg', routeId: r.id, index: i, t }, Math.hypot(p.uMm - (a.x + t * dx), p.vMm - (a.y + t * dy)));
      }
    }
    // hrany stěny — nabídnout pro 1. i 2. bod, JEN když druhý konec kóty není taky
    // hrana (edge↔edge je degenerované — hrana se řeší kolmým průmětem té druhé
    // kotvy, viz dimEndpoints). Druh hrany je geometrický: 'left' = konec U0
    // (faceStart), 'right' = konec U1 (faceEnd). Vzdálenosti v osových uMm, takže
    // nezávisí na zrcadlení displayU → platí pro stěnu (A/B) i půdorys stejně.
    if (!dimFirst || dimFirst.kind !== 'edge') {
      const ec: ['top' | 'bottom' | 'left' | 'right', number][] = [
        ['top', Math.abs(W.heightMm - p.vMm)],
        ['bottom', Math.abs(p.vMm)],
        ['left', Math.abs(p.uMm - U0)],
        ['right', Math.abs(p.uMm - U1)],
      ];
      ec.sort((a, b) => a[1] - b[1]);
      consider({ kind: 'edge', edge: ec[0][0] }, ec[0][1]);
    }
    return cands.length ? cands.reduce((m, c) => (c.d < m.d ? c : m)).a : free;
  }

  /**
   * SVG zvýraznění kotvy jen pro skutečný cíl přichycení (hrana = pruh,
   * bod trasy = celá trasa + kroužek). Volný bod záměrně nekreslíme — jinak by
   * jeho značka jezdila za kurzorem jako druhá „pomalá myš".
   */
  function anchorHighlightSvg(a: Anchor, color: string): string {
    if (a.kind === 'edge') {
      const e = a.edge;
      const p1 = e === 'top' ? toDisplay(W, side, U0, W.heightMm)
        : e === 'bottom' ? toDisplay(W, side, U0, 0)
        : e === 'left' ? toDisplay(W, side, U0, 0)
        : toDisplay(W, side, U1, 0);
      const p2 = e === 'top' ? toDisplay(W, side, U1, W.heightMm)
        : e === 'bottom' ? toDisplay(W, side, U1, 0)
        : e === 'left' ? toDisplay(W, side, U0, W.heightMm)
        : toDisplay(W, side, U1, W.heightMm);
      return `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="${color}" stroke-width="70" stroke-linecap="round" opacity="0.55"/>`;
    }
    if (a.kind === 'routePoint' || a.kind === 'routeSeg') {
      const r = F.routes.find((x) => x.id === a.routeId);
      if (!r || r.points.length < 2) return '';
      const pt = resolveAnchor(W, side,a);
      if (!pt) return '';
      const pts = r.points.map((q) => toDisplay(W, side, q.x, q.y));
      const d = pts.map((q, i) => `${i ? 'L' : 'M'} ${q.x} ${q.y}`).join(' ');
      const c = toDisplay(W, side, pt.uMm, pt.vMm);
      const routeGlow = `<path d="${d}" stroke="${color}" stroke-width="${Math.max(r.widthMm, 30) + 60}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.3"/>`;
      // uzel (bod, kam jsi klikal) = plný puntík; bod na úsečce = prstenec
      const marker = a.kind === 'routePoint'
        ? `<circle cx="${c.x}" cy="${c.y}" r="85" fill="${color}" stroke="#0f172a" stroke-width="14"/>`
        : `<circle cx="${c.x}" cy="${c.y}" r="90" fill="none" stroke="${color}" stroke-width="26"/>`;
      return routeGlow + marker;
    }
    if (a.kind === 'fixture') {
      const f = F.fixtures.find((x) => x.id === a.fixtureId);
      if (!f) return '';
      const c = toDisplay(W, side, f.uMm, f.vMm);
      const { w, h } = fixtureSize(f);
      const def = FIXTURE_DEFS[f.kind];
      const pad = 70;
      if (def.shape === 'round') {
        return `<ellipse cx="${c.x}" cy="${c.y}" rx="${w / 2 + pad}" ry="${h / 2 + pad}" fill="none" stroke="${color}" stroke-width="30" opacity="0.75"/>`;
      }
      return `<rect x="${c.x - w / 2 - pad}" y="${c.y - h / 2 - pad}" width="${w + pad * 2}" height="${h + pad * 2}" rx="${Math.min(w, h) * 0.14}" fill="none" stroke="${color}" stroke-width="30" opacity="0.75"/>`;
    }
    if (a.kind === 'area') {
      const ar = F.areas.find((x) => x.id === a.areaId);
      if (!ar) return '';
      const pt = resolveAnchor(W, side, a);
      if (!pt) return '';
      const r = areaDisplayRect(W, side, ar);
      const c = toDisplay(W, side, pt.uMm, pt.vMm);
      // obrys celé desky + značka cíleného bodu (roh = puntík, střed = prstenec)
      const outline = `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="${color}" stroke-width="30" opacity="0.55"/>`;
      const marker = a.du === 0 && a.dv === 0
        ? `<circle cx="${c.x}" cy="${c.y}" r="90" fill="none" stroke="${color}" stroke-width="26"/>`
        : `<circle cx="${c.x}" cy="${c.y}" r="85" fill="${color}" stroke="#0f172a" stroke-width="14"/>`;
      return outline + marker;
    }
    return ''; // volný bod: bez značky
  }

  // Vrstva živého zvýraznění při kótování (mimo hlavní redraw, aktualizuje se při pohybu myši).
  let dimHoverLayer: SVGGElement | null = null;
  function clearDimHover(): void { dimHoverLayer?.remove(); dimHoverLayer = null; }
  function showDimHover(clientX: number, clientY: number): void {
    const p = screenToWall(clientX, clientY);
    const tol = 30 * mmPerPx();
    const target = dimAnchorAt(p, tol * 2);
    clearDimHover();
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('pointer-events', 'none');
    let markup = '';
    // „Gumička" odkud→kam: spojnice počátku a živého cíle. Na dotyku (bez hoveru)
    // je to hlavní vodítko, kde kóta začne a kde skončí.
    if (dimFirst) {
      const r0 = resolveAnchor(W, side, dimFirst);            // {uMm,vMm} | null (null u hrany)
      const rT = resolveAnchor(W, side, target);
      const a0 = r0 ? toDisplay(W, side, r0.uMm, r0.vMm) : null;
      const aT = rT ? toDisplay(W, side, rT.uMm, rT.vMm) : toDisplay(W, side, p.uMm, p.vMm);
      if (a0) {
        markup += `<line x1="${a0.x.toFixed(1)}" y1="${a0.y.toFixed(1)}" x2="${aT.x.toFixed(1)}" y2="${aT.y.toFixed(1)}" stroke="#fbbf24" stroke-width="14" stroke-dasharray="70 45" opacity="0.85" pointer-events="none"/>`;
      }
    }
    if (dimFirst) markup += anchorHighlightSvg(dimFirst, '#fbbf24'); // pevný počáteční bod
    markup += anchorHighlightSvg(target, '#22d3ee');                 // živý cíl pod kurzorem
    g.innerHTML = markup;
    svg.appendChild(g);
    dimHoverLayer = g;
  }

  // Živý náhled rozkreslené výdřevy (1. roh je zadaný, 2. sleduje kurzor).
  let areaHoverLayer: SVGGElement | null = null;
  function clearAreaHover(): void { areaHoverLayer?.remove(); areaHoverLayer = null; }
  function showAreaPreview(clientX: number, clientY: number): void {
    const anchor = areaFirst ?? areaDown;
    if (!anchor) { clearAreaHover(); return; }
    const p = screenToWall(clientX, clientY);
    const b = areaFromCorners(anchor.x, anchor.y, clampU(p.uMm), clampV(p.vMm));
    const r = areaDisplayRect(W, side, { id: 'draft', categoryId: areaCategoryId, note: '', ...b });
    const color = catById(areaCategoryId)?.color ?? '#b45309';
    clearAreaHover();
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('pointer-events', 'none');
    g.innerHTML =
      `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${color}" opacity="0.14"/>` +
      `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="${color}" stroke-width="24" stroke-dasharray="90 60"/>` +
      `<text x="${r.x + r.w / 2}" y="${r.y + r.h / 2}" text-anchor="middle" dominant-baseline="central" font-size="150" font-weight="bold" fill="${color}" paint-order="stroke" stroke="#0f172a" stroke-width="40">${b.widthMm}×${b.heightMm}</text>`;
    svg.appendChild(g);
    areaHoverLayer = g;
  }

  // --- panely ---
  function lengthInput(value: number | null, apply: (mm: number) => void): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.inputMode = 'numeric';
    input.placeholder = 'mm';
    if (value != null) input.value = String(value);
    input.addEventListener('focus', () => setDistoTarget(input, apply));
    input.addEventListener('pointerdown', () => setDistoTarget(input, apply));
    input.addEventListener('change', () => {
      const mm = Number(input.value);
      if (mm > 0) apply(mm);
    });
    // Alternativa k metru: napsat číslo z klávesnice a potvrdit Enterem.
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const mm = Number(input.value);
      if (mm > 0) {
        apply(mm);
        input.animate([{ background: '#0ea5e9' }, { background: 'transparent' }], { duration: 400 });
      }
    });
    return input;
  }

  /**
   * Rozkreslený šlic je „živým" členem F.routes už od prvního bodu — díky tomu
   * na něj jde kótovat průběžně (dimAnchorAt/resolveAnchor prochází F.routes).
   * V kreslení se zobrazuje jako náčrt (draftRouteId ho vynechá z normálního výčtu).
   */
  function ensureDraftLive(): void {
    if (draft && draft.points.length >= 1 && !F.routes.includes(draft)) F.routes.push(draft);
  }
  /** Zahodí rozkreslený šlic i kóty, které na něj vedly (Zrušit, nebo uzavření pod 2 body). */
  function discardDraft(): void {
    if (!draft) return;
    const id = draft.id;
    const refsDraft = (a: Anchor): boolean =>
      (a.kind === 'routePoint' || a.kind === 'routeSeg') && a.routeId === id;
    F.routes = F.routes.filter((r) => r.id !== id);
    F.dims = F.dims.filter((d) => !refsDraft(d.from) && !refsDraft(d.to));
    draft = null;
    saveProject();
  }
  /** Uzavře rozpracovaný šlic jako hotovou trasu, má-li aspoň 2 body. Vrací, zda uložil. */
  function commitDraft(): boolean {
    if (!draft) return false;
    if (draft.points.length < 2) { discardDraft(); return false; } // 0–1 bod = k ničemu
    ensureDraftLive();
    ensureCategoryVisible(draft.categoryId); // hotová trasa se nesmí ztratit ve skryté vrstvě
    selectedRouteId = draft.id;
    saveProject();
    return true;
  }
  function newDraft(): void {
    draft = { id: newId(), categoryId, widthMm: brushWidthMm, note: '', points: [], segLengthsMm: [] };
    pendingDimId = null;
  }

  /** Hrana líce, která je v čelním pohledu vlevo (displayU může osu zrcadlit). */
  const leftEdgeName = (): EdgeName =>
    toDisplay(W, side, U0, 0).x <= toDisplay(W, side, U1, 0).x ? 'left' : 'right';

  /** Lidský popis hrany z pohledu uživatele (vlevo/vpravo dle zobrazení, ne dle osy). */
  function edgeLabel(e: EdgeName): string {
    if (e === 'top') return isPlan ? 'od horního okraje' : 'od stropu';
    if (e === 'bottom') return isPlan ? 'od dolního okraje' : 'od podlahy';
    return e === leftEdgeName() ? 'od levého kraje' : 'od pravého kraje';
  }

  /**
   * Kóta z právě natažené úsečky šlicu k hraně líce. Kotví se na střed segmentu
   * (routeSeg, t = 0.5) — celý rovný úsek se pak posune jako celek (viz applyDimValue).
   * Existuje-li už táž kóta, jen se znovu nabídne k zadání míry.
   */
  function dimDraftSegToEdge(edge: EdgeName): void {
    if (!draft || draft.points.length < 2) return;
    const i = draft.points.length - 2;
    ensureDraftLive(); // kóta musí kotvit na trasu dohledatelnou v F.routes
    const id = draft.id;
    const existing = F.dims.find((d) =>
      d.from.kind === 'routeSeg' && d.from.routeId === id && d.from.index === i &&
      d.to.kind === 'edge' && d.to.edge === edge);
    const dim: Dimension = existing ?? {
      id: newId(),
      from: { kind: 'routeSeg', routeId: id, index: i, t: 0.5 },
      to: { kind: 'edge', edge },
      valueMm: null,
    };
    if (!existing) F.dims.push(dim);
    pendingDimId = dim.id;
    saveProject();
    redraw();
    showDrawPanel();
  }

  function showDrawPanel(): void {
    if (!draft) { panel.innerHTML = ''; return; }
    panel.className = 'card no-print';
    panel.innerHTML = '';
    const info = document.createElement('div');
    info.className = 'muted';
    info.textContent = draft.points.length < 2
      ? 'Ťukněte do stěny — začátek trasy, pak další body.'
      : `Segment ${draft.points.length - 1}: délka (klik do pole → vyplní metr)`;
    panel.appendChild(info);
    const row = document.createElement('div');
    row.className = 'row';
    if (draft.points.length >= 2) {
      const i = draft.points.length - 2;
      const input = lengthInput(draft.segLengthsMm[i], (mm) => setSegmentLength(draft!, i, mm));
      row.appendChild(input);
      setDistoTarget(input, (mm) => setSegmentLength(draft!, i, mm));
    }
    // Pravé úhly rovnou po ruce — nejčastější přepínač při tažení šlicu.
    const orthoTgl = document.createElement('button');
    orthoTgl.textContent = '⊾ Pravé úhly';
    orthoTgl.title = 'Zarovnávat úsečky svisle/vodorovně/45°';
    orthoTgl.classList.toggle('active', ortho);
    orthoTgl.onclick = () => setOrtho(!ortho);
    row.appendChild(orthoTgl);
    const undo = document.createElement('button');
    undo.textContent = '↩ Zpět bod';
    undo.onclick = () => { draft!.points.pop(); draft!.segLengthsMm.pop(); pendingDimId = null; redraw(); showDrawPanel(); };
    const next = document.createElement('button');
    next.textContent = '＋ Nový šlic';
    next.title = 'Uzavře tenhle šlic a začne rovnou další';
    next.onclick = () => { commitDraft(); newDraft(); redraw(); showDrawSetupPanel(); };
    const done = document.createElement('button');
    done.className = 'primary';
    done.textContent = '✓ Hotovo';
    done.onclick = () => { commitDraft(); draft = null; setMode('select'); };
    const cancel = document.createElement('button');
    cancel.className = 'danger';
    cancel.textContent = '✕ Zrušit';
    cancel.onclick = () => { discardDraft(); setMode('select'); };
    row.append(undo, next, done, cancel);
    panel.appendChild(row);

    // Kóta právě natažené úsečky k hraně líce: svislý úsek k bočním krajům,
    // vodorovný k podlaze/stropu. U šikmého (45°) nabídneme všechny čtyři.
    if (draft.points.length >= 2) {
      const a = draft.points[draft.points.length - 2], b = draft.points[draft.points.length - 1];
      const adu = Math.abs(b.x - a.x), adv = Math.abs(b.y - a.y);
      const edges: EdgeName[] =
        adv > adu * 1.2 ? ['left', 'right']
        : adu > adv * 1.2 ? ['top', 'bottom']
        : ['left', 'right', 'top', 'bottom'];
      const dimRow = document.createElement('div');
      dimRow.className = 'row';
      const lbl = document.createElement('span');
      lbl.className = 'muted';
      lbl.textContent = 'Kóta úsečky:';
      dimRow.appendChild(lbl);
      // Vlevo/vpravo seřadit tak, jak to uživatel vidí na obrazovce.
      const ord = (e: EdgeName): number =>
        e === leftEdgeName() ? 0 : e === 'left' || e === 'right' ? 1 : e === 'top' ? 2 : 3;
      const shown = edges.slice().sort((x, y) => ord(x) - ord(y));
      for (const e of shown) {
        const btn = document.createElement('button');
        btn.textContent = `📏 ${edgeLabel(e)}`;
        btn.onclick = () => dimDraftSegToEdge(e);
        dimRow.appendChild(btn);
      }
      panel.appendChild(dimRow);
    }

    // Rozepsaná kóta čeká na míru — napiš ji, nebo pípni metrem; pak se hned kreslí dál.
    const pending = pendingDimId ? F.dims.find((d) => d.id === pendingDimId) : undefined;
    if (!pending) pendingDimId = null;
    else {
      const ed = pending.to.kind === 'edge' ? pending.to.edge : pending.from.kind === 'edge' ? pending.from.edge : null;
      const valRow = document.createElement('div');
      valRow.className = 'row';
      const lbl = document.createElement('span');
      lbl.className = 'muted';
      lbl.textContent = `Míra ${ed ? edgeLabel(ed) : ''} (mm):`;
      const apply = (mm: number) => {
        applyDimValue(pending, mm);
        pendingDimId = null;
        showDrawPanel(); // zpět k tažení šlicu
      };
      const geom = dimGeomLengthMm(W, side, pending);
      const input = lengthInput(pending.valueMm ?? (geom != null ? Math.round(geom) : null), apply);
      input.style.width = '110px';
      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = '✕';
      del.title = 'Kótu zrušit';
      del.onclick = () => {
        F.dims = F.dims.filter((x) => x.id !== pending.id);
        pendingDimId = null;
        saveProject();
        redraw();
        showDrawPanel();
      };
      valRow.append(lbl, input, del);
      panel.appendChild(valRow);
      setDistoTarget(input, apply);
      input.focus();
      input.select();
    }
  }

  function showDrawSetupPanel(): void {
    panel.className = 'card no-print';
    panel.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'row';
    const catSel = document.createElement('select');
    for (const c of project.categories) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      if (c.id === categoryId) o.selected = true;
      catSel.appendChild(o);
    }
    catSel.onchange = () => { categoryId = catSel.value; if (draft) draft.categoryId = categoryId; ensureCategoryVisible(categoryId); redraw(); };
    const widthIn = document.createElement('input');
    widthIn.type = 'number';
    widthIn.value = String(brushWidthMm);
    widthIn.style.width = '90px';
    widthIn.title = 'Šířka šlicu (mm)';
    widthIn.onchange = () => { brushWidthMm = Number(widthIn.value) || 50; if (draft) draft.widthMm = brushWidthMm; redraw(); };
    const widthLbl = document.createElement('span');
    widthLbl.className = 'muted';
    widthLbl.textContent = 'šířka mm:';
    row.append(catSel, widthLbl, widthIn);
    panel.appendChild(row);
    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.textContent = 'Ťukněte do stěny — začátek trasy. Do vybraného šlicu vložíš uzel klikem na „+" v půli segmentu.';
    panel.appendChild(hint);
  }

  function showSelectPanel(): void {
    panel.innerHTML = '';
    const r = F.routes.find((x) => x.id === selectedRouteId);
    // Čerstvá fotostěna (bez měřítka) a nic vybraného → nabídnout ořez rovnou,
    // ať se nemusí hledat v panelu fotek. Po oříznutí naváže přeměření.
    if (!r && isPhotoWall && noScale()) { showCropOffer(); return; }
    if (!r) { panel.className = ''; return; }
    panel.className = 'card no-print';

    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.textContent = 'Uzly: táhni puntík = posun (přichytí se na prvek), dvojklik na uzel = smazat. Nový uzel se vkládá v ✏️ Trase. Delete smaže celou trasu.';
    panel.appendChild(hint);

    const row = document.createElement('div');
    row.className = 'row';
    const catSel = document.createElement('select');
    for (const c of project.categories) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      if (c.id === r.categoryId) o.selected = true;
      catSel.appendChild(o);
    }
    catSel.onchange = () => { r.categoryId = catSel.value; saveProject(); redraw(); };
    const widthIn = document.createElement('input');
    widthIn.type = 'number';
    widthIn.value = String(r.widthMm);
    widthIn.style.width = '90px';
    widthIn.onchange = () => { r.widthMm = Number(widthIn.value) || r.widthMm; saveProject(); redraw(); };
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '🗑 Smazat';
    del.onclick = () => { if (confirm('Smazat trasu?')) deleteRoute(r); };
    row.append(catSel, widthIn, del);
    panel.appendChild(row);

    const segs = document.createElement('div');
    segs.className = 'row';
    for (let i = 0; i < r.points.length - 1; i++) {
      const wrapEl = document.createElement('label');
      wrapEl.className = 'muted';
      wrapEl.style.display = 'inline-flex';
      wrapEl.style.alignItems = 'center';
      wrapEl.style.gap = '4px';
      wrapEl.textContent = `s${i + 1}:`;
      const input = lengthInput(r.segLengthsMm[i], (mm) => setSegmentLength(r, i, mm));
      input.style.width = '90px';
      wrapEl.appendChild(input);
      segs.appendChild(wrapEl);
    }
    panel.appendChild(segs);

    const note = document.createElement('input');
    note.placeholder = 'Poznámka (např. „zásuvky kuchyň")';
    note.value = r.note;
    note.onchange = () => { r.note = note.value; saveProject(); };
    panel.appendChild(note);
  }

  /** @param focusDimId ID kóty, jejíž políčko se rovnou nastaví jako cíl metru (podbarví se). */
  function showDimPanel(focusDimId?: string): void {
    panel.className = 'card no-print';
    panel.innerHTML = `<div class="muted">${
      dimFirst
        ? '2. bod: ťukněte na hranu stěny (strop/podlaha/okraj) nebo další bod trasy.'
        : selectedDimId
          ? 'Kóta vybrána — upravte míru v poli (nebo změřte metrem). Klik jinam začne novou kótu.'
          : '1. bod: ťukněte na prvek nebo bod trasy (roh/konec), nebo na hotovou kótu pro úpravu.'
    }</div>`;
    const dims = F.dims;
    if (dims.length) {
      const list = document.createElement('div');
      list.className = 'row';
      dims.forEach((d, idx) => {
        const wrapEl = document.createElement('label');
        wrapEl.className = 'muted';
        wrapEl.style.display = 'inline-flex';
        wrapEl.style.alignItems = 'center';
        wrapEl.style.gap = '4px';
        wrapEl.textContent = `k${idx + 1}:`;
        if (d.id === selectedDimId) wrapEl.style.outline = '2px solid #fbbf24';
        wrapEl.style.borderRadius = '6px';
        wrapEl.style.padding = '2px 4px';
        const apply = (mm: number) => applyDimValue(d, mm);
        const input = lengthInput(d.valueMm ?? (dimGeomLengthMm(W, side,d) != null ? Math.round(dimGeomLengthMm(W, side,d)!) : null), apply);
        input.style.width = '90px';
        wrapEl.appendChild(input);
        const del = document.createElement('button');
        del.textContent = '✕';
        del.onclick = () => {
          F.dims = F.dims.filter((x) => x.id !== d.id);
          if (selectedDimId === d.id) selectedDimId = null;
          saveProject();
          redraw();
          showDimPanel();
        };
        wrapEl.appendChild(del);
        list.appendChild(wrapEl);
        // čerstvě zanesená / vybraná kóta rovnou čeká na míru z metru a zaostří pole
        if (d.id === focusDimId) {
          setDistoTarget(input, apply);
          input.focus();
          input.select();
          wrapEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      });
      panel.appendChild(list);
    }
  }

  /**
   * Otevře editor napasování a uloží narovnaný podklad. targetBgId → doladí
   * existující podklad (zachová id/popisek/průhlednost); jinak přidá NOVÝ podklad
   * a přepne na něj (stěna tak může mít víc napasovaných fotek).
   */
  /** Vrací true, když uživatel pasování dokončil (false = zrušil). */
  async function mapAsBackground(sourceBlob: Blob, sourcePhotoId?: string, targetBgId?: string): Promise<boolean> {
    const existing = targetBgId ? F.backgrounds.find((b) => b.id === targetBgId) : undefined;
    // Podlaha/strop: rohy místnosti (planOutline) mají známou cílovou pozici v líci
    // → naklikat je a narovnat least-squares homografií (i nepravidelný tvar).
    // Šikmá stěna (seříznutá stropem podkroví): stejný princip — cílový obrys líce
    // není obdélník, ale lichoběžník / lomená hrana (dole rovně, nahoře profil
    // šikminy). Naklikáš jeho rohy a fotka se narovná a ořízne na tvar, ne na plný
    // obdélník (obsah nad šikminou by se jinak roztáhl špatně a pak uřízl).
    let plan: { targets: { x: number; y: number }[] } | undefined;
    if (W.planOutline?.length) {
      plan = { targets: W.planOutline.map((p) => { const d = toDisplay(W, side, p.x, p.y); return { x: d.x / FL, y: d.y / W.heightMm }; }) };
    } else {
      const top = storey ? faceCeilingPolyline(storey, W, side) : null;
      if (top) {
        // Obrys líce v zobrazovacích souřadnicích: dolní rohy + horní hrana (L→R).
        const outline = [
          { x: 0, y: W.heightMm },
          ...top.map((p) => ({ x: p.x, y: W.heightMm - p.h })),
          { x: FL, y: W.heightMm },
        ];
        plan = { targets: outline.map((p) => ({ x: p.x / FL, y: p.y / W.heightMm })) };
      }
    }
    const result = await mapPhotoToWall(sourceBlob, FL / W.heightMm, {
      initialCorners: existing?.corners,
      initialRotDeg: existing?.rotDeg,
      initialMirror: existing?.mirror,
      plan,
    });
    if (!result) return false;
    const photoId = newId();
    await savePhoto(photoId, result.blob);
    if (existing) {
      await deletePhoto(existing.photoId);
      existing.photoId = photoId;
      existing.corners = result.corners;
      existing.rotDeg = result.rotDeg;
      existing.mirror = result.mirror;
      if (sourcePhotoId) existing.sourcePhotoId = sourcePhotoId;
      F.activeBackgroundId = existing.id;
    } else {
      const bg: WallBackground = {
        id: newId(),
        photoId,
        opacity: activeBg()?.opacity ?? 0.6,
        sourcePhotoId,
        corners: result.corners,
        rotDeg: result.rotDeg,
        mirror: result.mirror,
      };
      F.backgrounds.push(bg);
      F.activeBackgroundId = bg.id;
    }
    saveProject();
    invalidateCostField();
    await loadBackground();
    redraw();
    // Vykreslit panel SYNCHRONNĚ vůči volajícímu: showPhotoPanel je async (čte fotky
    // z úložiště) a bez čekání by se dokreslil až přes panel, který volající zobrazí
    // po nás (např. přeměření po ořezu fotostěny).
    await showPhotoPanel();
    return true;
  }

  /**
   * FOTOSTĚNA — ořez na skutečnou stěnu: označíš 4 rohy stěny na fotce, obraz se
   * perspektivně narovná a vyplní celý líc. Hned potom se nabídne přeměření šířky
   * a výšky (viz showSizePanel), po kterém plocha získá skutečné měřítko.
   */
  async function cropPhotoWall(): Promise<void> {
    const bg = activeBg();
    // Pasujeme vždy z ORIGINÁLU (ne z už narovnaného obrazu), ať se nevrství zkreslení.
    const sourceId = bg?.sourcePhotoId ?? bg?.photoId ?? F.photoIds[0];
    if (!sourceId) return;
    const blob = await getPhoto(sourceId);
    if (!blob) return;
    if (await mapAsBackground(blob, sourceId, bg?.id)) showSizePanel();
  }

  /** Nabídka ořezu na čerstvé fotostěně — první, co uvidíš po založení. */
  function showCropOffer(): void {
    panel.className = 'card no-print';
    panel.innerHTML = '';
    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.style.cssText = 'font-size:12px;margin-bottom:6px';
    hint.textContent = 'Můžeš rovnou kreslit (kóty budou popisky naměřených hodnot). Nebo fotku ořízni na stěnu: označíš 4 rohy, perspektiva se narovná a po přeměření šířky a výšky dostane plocha skutečné měřítko.';
    const row = document.createElement('div');
    row.className = 'row';
    const crop = document.createElement('button');
    crop.className = 'primary';
    crop.textContent = '✂️ Oříznout na stěnu';
    crop.onclick = () => void cropPhotoWall();
    row.append(crop);
    panel.append(hint, row);
  }

  /**
   * Přeměření fotostěny: šířka → výška. Pole je rovnou cílem metru, takže stačí
   * odpípnout — hodnota se doplní a cíl přeskočí na druhé pole. Po potvrzení dostane
   * plocha skutečné rozměry (viz applyRealSize).
   */
  function showSizePanel(): void {
    panel.className = 'card no-print';
    panel.innerHTML = '';
    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.style.cssText = 'font-size:12px;margin-bottom:6px';
    hint.textContent = 'Přeměř stěnu: klikni do pole a odpípni metrem (nebo napiš ručně). Po změření šířky přeskočí cíl na výšku. Tím plocha získá skutečné měřítko a kóty začnou fungovat jako u naskenované stěny.';
    panel.appendChild(hint);

    const row = document.createElement('div');
    row.className = 'row';
    row.style.cssText = 'align-items:center;gap:8px;flex-wrap:wrap';

    const mkInput = (ph: string, val: number): HTMLInputElement => {
      const i = document.createElement('input');
      i.type = 'number'; i.inputMode = 'numeric'; i.placeholder = ph;
      i.value = String(Math.round(val));
      i.style.width = '110px';
      return i;
    };
    const wIn = mkInput('šířka mm', FL);
    const hIn = mkInput('výška mm', W.heightMm);

    // Metr míří nejdřív na šířku; po naměření sám přeskočí na výšku.
    const aimHeight = (): void => {
      hIn.focus(); hIn.select();
      setDistoTarget(hIn, () => { /* hodnotu zapíše disto do pole */ });
    };
    const aimWidth = (): void => {
      wIn.focus(); wIn.select();
      setDistoTarget(wIn, () => aimHeight());
    };
    wIn.addEventListener('focus', () => setDistoTarget(wIn, () => aimHeight()));
    hIn.addEventListener('focus', () => setDistoTarget(hIn, () => { /* poslední pole */ }));
    registerCleanup(() => clearDistoTarget());

    const go = document.createElement('button');
    go.className = 'primary';
    go.textContent = '✓ Použít rozměry';
    go.onclick = () => {
      const w = Number(wIn.value), h = Number(hIn.value);
      if (!(w > 0) || !(h > 0)) return;
      clearDistoTarget();
      applyRealSize(Math.round(w), Math.round(h));
    };
    const skip = document.createElement('button');
    skip.textContent = 'Zatím neměřit';
    skip.onclick = () => { clearDistoTarget(); showPhotoPanel(); };

    row.append(
      Object.assign(document.createElement('span'), { className: 'muted', textContent: 'Šířka' }), wIn,
      Object.assign(document.createElement('span'), { className: 'muted', textContent: 'Výška' }), hIn,
      go, skip,
    );
    panel.appendChild(row);
    aimWidth();
  }

  /**
   * Nastaví fotostěně skutečné rozměry (mm). Zákres se přeškáluje ve stejném poměru
   * jako plocha, aby zůstal sedět na fotce, podklad se znovu narovná z originálu na
   * nový poměr stran a `freeScale` zmizí — od téhle chvíle jsou milimetry skutečné
   * a kóty posouvají geometrii jako u naskenované stěny.
   */
  async function applyRealSize(widthMm: number, heightMm: number): Promise<void> {
    const kx = widthMm / FL, ky = heightMm / W.heightMm;
    scaleFaceContent(kx, ky);
    W.axis = [{ x: 0, y: 0 }, { x: widthMm, y: 0 }];
    W.heightMm = heightMm;
    W.measuredLengthMm = widthMm; // šířka je naměřená pravda
    delete W.freeScale;
    // Podklad přepočítat z originálu podle už označených rohů — jedno převzorkování
    // místo roztažení už narovnaného obrazu.
    const bg = activeBg();
    if (bg?.corners?.length === 4 && bg.sourcePhotoId) {
      const src = await getPhoto(bg.sourcePhotoId);
      if (src) {
        const blob = await rewarpToAspect(src, bg.corners, bg.rotDeg ?? 0, !!bg.mirror, widthMm / heightMm);
        if (blob) {
          const id = newId();
          await savePhoto(id, blob);
          await deletePhoto(bg.photoId);
          bg.photoId = id;
        }
      }
    }
    saveProject();
    invalidateCostField();
    // Rozměry líce jsou v uzávěrách (FL, U0, U1) — nejjistější je obrazovku překreslit.
    await route();
  }

  /** Přepočítá obsah líce při změně rozměrů plochy, ať zůstane sedět na fotce. */
  function scaleFaceContent(kx: number, ky: number): void {
    if (Math.abs(kx - 1) < 1e-9 && Math.abs(ky - 1) < 1e-9) return;
    for (const r of F.routes) {
      r.points = r.points.map((p) => ({ x: Math.round(p.x * kx), y: Math.round(p.y * ky) }));
    }
    for (const f of F.fixtures) { f.uMm = Math.round(f.uMm * kx); f.vMm = Math.round(f.vMm * ky); }
    for (const a of F.areas) {
      a.uMm = Math.round(a.uMm * kx); a.vMm = Math.round(a.vMm * ky);
      a.widthMm = Math.round(a.widthMm * kx); a.heightMm = Math.round(a.heightMm * ky);
    }
    for (const d of F.dims) {
      for (const anc of [d.from, d.to]) {
        if (anc.kind === 'point') { anc.uMm = Math.round(anc.uMm * kx); anc.vMm = Math.round(anc.vMm * ky); }
      }
    }
    // Dlaždice (fotka na výřezu líce) — podklad přes celou stěnu region nemá.
    for (const b of F.backgrounds) {
      if (b.region) {
        b.region.uMm = Math.round(b.region.uMm * kx); b.region.vMm = Math.round(b.region.vMm * ky);
        b.region.widthMm = Math.round(b.region.widthMm * kx); b.region.heightMm = Math.round(b.region.heightMm * ky);
      }
      if (b.quad) b.quad = b.quad.map((q) => ({ x: Math.round(q.x * kx), y: Math.round(q.y * ky) }));
      if (b.mesh) b.mesh.dst = b.mesh.dst.map((q) => ({ x: Math.round(q.x * kx), y: Math.round(q.y * ky) }));
    }
  }

  /**
   * Vloží fotku jako DLAŽDICI bez pasování — surový obrázek na výřez líce, který
   * pak jde volně posouvat / roztahovat / otáčet. Pro ruční skládání víc fotek
   * podlahy/stropu (partial snímky, kde nejsou všechny rohy).
   */
  async function addAsTile(sourceBlob: Blob, sourcePhotoId?: string): Promise<void> {
    const photoId = newId();
    await savePhoto(photoId, sourceBlob); // vlastní kopie (nezávislá na smazání zdrojové fotky)
    let aspect = 1;
    try { const im = await createImageBitmap(sourceBlob); aspect = im.width / im.height; im.close?.(); } catch { /* fallback 1:1 */ }
    let w = FL * 0.6, h = w / aspect;
    if (h > W.heightMm * 0.8) { h = W.heightMm * 0.6; w = h * aspect; }
    const bg: WallBackground = {
      id: newId(),
      photoId,
      opacity: activeBg()?.opacity ?? 0.6,
      sourcePhotoId,
      region: { uMm: Math.round((U0 + U1) / 2), vMm: Math.round(W.heightMm / 2), widthMm: Math.round(w), heightMm: Math.round(h) },
    };
    F.backgrounds.push(bg);
    F.activeBackgroundId = bg.id;
    saveProject();
    invalidateCostField();
    await loadBackground();
    redraw();
    showPhotoPanel();
  }

  /**
   * „Narovnat podle obdélníku" — otevře pasovák v režimu keepWhole: uživatel označí
   * 4 rohy libovolného obdélníku na stěně (okno, panel…), fotka se perspektivně
   * srovná a ZŮSTANE CELÁ → rovná dlaždice (PNG). Pak jde volně posunout/otočit
   * a přes překryv slícovat s dalšími snímky (partial fotky s perspektivou).
   */
  async function rectifyAsTile(sourceBlob: Blob, sourcePhotoId?: string, targetBgId?: string): Promise<void> {
    return fitAsTile('rect', sourceBlob, sourcePhotoId, targetBgId);
  }

  /**
   * „Oříznout a vložit" — otevře pasovák v režimu cropPoly: obtáhneš oblast
   * (mnohoúhelník), co je uvnitř zůstane, zbytek se ořízne (maska, bez zkreslení).
   * Vznikne dlaždice, kterou pak umístíš a případně srovnáš volnými rohy.
   */
  async function cropAsTile(sourceBlob: Blob, sourcePhotoId?: string, targetBgId?: string): Promise<void> {
    const existing = targetBgId ? F.backgrounds.find((b) => b.id === targetBgId) : undefined;
    const result = await mapPhotoToWall(sourceBlob, FL / W.heightMm, {
      cropPoly: true,
      initialAnchor: existing?.mesh?.anchor,
      initialCropSrc: existing?.mesh?.src, // znovuotevření: stejný tvar mnohoúhelníku
      initialRotDeg: existing?.rotDeg,
      initialMirror: existing?.mirror,
    });
    if (!result || !result.mesh) return;
    const photoId = newId();
    await savePhoto(photoId, result.blob); // CELÝ orientovaný zdroj (ne oříznutý)
    // Počáteční umístění: mnohoúhelník (src [0,1] obrazu) → box ~60 % líce, poměr dle fotky.
    let iw = 1, ih = 1;
    try { const im = await createImageBitmap(result.blob); iw = im.width; ih = im.height; im.close?.(); } catch { /* fallback */ }
    const sx = result.mesh.src.map((s) => s.x), sy = result.mesh.src.map((s) => s.y);
    const bxMin = Math.min(...sx), byMin = Math.min(...sy);
    const bxW = Math.max(1e-3, Math.max(...sx) - bxMin), byH = Math.max(1e-3, Math.max(...sy) - byMin);
    const aspect = (bxW * iw) / (byH * ih);
    let boxW = FL * 0.6, boxH = boxW / aspect;
    if (boxH > W.heightMm * 0.8) { boxH = W.heightMm * 0.6; boxW = boxH * aspect; }
    const cx = FL / 2, cy = W.heightMm / 2; // střed líce v zobrazovacích souřadnicích
    // Doladění se stejným počtem bodů → ZACHOVEJ umístění (dst), jinak nový box.
    const keepDst = existing?.mesh && existing.mesh.dst.length === result.mesh.src.length;
    const dst = keepDst
      ? existing!.mesh!.dst.map((p) => ({ ...p }))
      : result.mesh.src.map((s) => {
          const nx = (s.x - bxMin) / bxW, ny = (s.y - byMin) / byH; // 0..1 v rámci bboxu mnohoúhelníku
          const c = fromDisplay(W, side, cx - boxW / 2 + nx * boxW, cy - boxH / 2 + ny * boxH);
          return { x: Math.round(c.uMm), y: Math.round(c.vMm) };
        });
    const meshData = { src: result.mesh.src.map((p) => ({ ...p })), dst, anchor: [...result.mesh.anchor] };
    if (existing) {
      await deletePhoto(existing.photoId);
      existing.photoId = photoId; existing.rotDeg = result.rotDeg; existing.mirror = result.mirror;
      existing.fitMode = 'crop'; existing.mesh = meshData;
      if (sourcePhotoId) existing.sourcePhotoId = sourcePhotoId;
      F.activeBackgroundId = existing.id;
    } else {
      const bg: WallBackground = {
        id: newId(), photoId, opacity: activeBg()?.opacity ?? 0.6, sourcePhotoId,
        rotDeg: result.rotDeg, mirror: result.mirror, fitMode: 'crop', mesh: meshData,
      };
      F.backgrounds.push(bg);
      F.activeBackgroundId = bg.id;
    }
    saveProject();
    invalidateCostField();
    await loadBackground();
    redraw();
    showPhotoPanel();
  }

  async function fitAsTile(mode: 'rect' | 'crop', sourceBlob: Blob, sourcePhotoId?: string, targetBgId?: string): Promise<void> {
    const existing = targetBgId ? F.backgrounds.find((b) => b.id === targetBgId) : undefined;
    const result = await mapPhotoToWall(sourceBlob, FL / W.heightMm, {
      keepWhole: mode === 'rect',
      cropPoly: mode === 'crop',
      initialCorners: existing?.corners,
      initialRotDeg: existing?.rotDeg,
      initialMirror: existing?.mirror,
    });
    if (!result) return;
    const photoId = newId();
    await savePhoto(photoId, result.blob);
    const aspect = result.aspect || 1;
    if (existing) {
      // Doladění — zachovej polohu/střed dlaždice, jen sruvnej rozměr na nový poměr.
      await deletePhoto(existing.photoId);
      existing.photoId = photoId;
      existing.corners = result.corners;
      existing.rotDeg = result.rotDeg;
      existing.mirror = result.mirror;
      existing.fitMode = mode;
      if (sourcePhotoId) existing.sourcePhotoId = sourcePhotoId;
      const rw = existing.region?.widthMm ?? FL * 0.6;
      existing.region = {
        uMm: existing.region?.uMm ?? Math.round((U0 + U1) / 2),
        vMm: existing.region?.vMm ?? Math.round(W.heightMm / 2),
        widthMm: Math.round(rw), heightMm: Math.round(rw / aspect),
        rotDeg: existing.region?.rotDeg,
      };
      F.activeBackgroundId = existing.id;
    } else {
      let w = FL * 0.6, h = w / aspect;
      if (h > W.heightMm * 0.8) { h = W.heightMm * 0.6; w = h * aspect; }
      const bg: WallBackground = {
        id: newId(),
        photoId,
        opacity: activeBg()?.opacity ?? 0.6,
        sourcePhotoId,
        corners: result.corners,
        rotDeg: result.rotDeg,
        mirror: result.mirror,
        fitMode: mode,
        region: { uMm: Math.round((U0 + U1) / 2), vMm: Math.round(W.heightMm / 2), widthMm: Math.round(w), heightMm: Math.round(h) },
      };
      F.backgrounds.push(bg);
      F.activeBackgroundId = bg.id;
    }
    saveProject();
    invalidateCostField();
    await loadBackground();
    redraw();
    showPhotoPanel();
  }

  async function showPhotoPanel(): Promise<void> {
    panel.className = 'card no-print';
    panel.innerHTML = '';

    // Fotostěna: ořez na skutečnou stěnu (4 rohy + narovnání) a přeměření rozměrů.
    if (isPhotoWall) {
      const row = document.createElement('div');
      row.className = 'row';
      row.style.cssText = 'gap:8px;flex-wrap:wrap;margin-bottom:8px';
      const crop = document.createElement('button');
      crop.textContent = '✂️ Oříznout na stěnu';
      crop.title = 'Označíš 4 rohy stěny na fotce; obraz se perspektivně narovná a vyplní celou plochu.';
      crop.onclick = () => void cropPhotoWall();
      const size = document.createElement('button');
      size.textContent = '📏 Přeměřit rozměry';
      size.title = 'Zadat (nebo odpípnout metrem) skutečnou šířku a výšku stěny.';
      size.onclick = () => showSizePanel();
      row.append(crop, size);
      if (noScale()) {
        const b = document.createElement('span');
        b.className = 'muted';
        b.style.fontSize = '12px';
        b.textContent = 'zatím bez měřítka';
        row.append(b);
      }
      panel.appendChild(row);
    }

    // --- Napasované podklady (dlaždice — zobrazí se všechny naráz) ---
    const active = activeBg();
    if (active && F.backgrounds.length) {
      const hint = document.createElement('div');
      hint.className = 'muted';
      hint.style.cssText = 'font-size:12px;margin-bottom:6px';
      hint.textContent = 'Dlaždici posuň tažením, roztáhni za rohy, otoč modrým úchopem. „⇱ Volné rohy" = tahej každý roh zvlášť (perspektiva, pro slícování fotek).';
      panel.appendChild(hint);

      const switcher = document.createElement('div');
      switcher.className = 'row';
      switcher.style.cssText = 'flex-wrap:wrap;gap:8px;margin-bottom:8px';
      for (let i = 0; i < F.backgrounds.length; i++) {
        const b = F.backgrounds[i];
        const phaseName = project.photoPhases.find((ph) => ph.id === b.phaseId)?.name;
        const thumb = document.createElement('button');
        thumb.title = [b.label || `Podklad ${i + 1}`, phaseName].filter(Boolean).join(' · ');
        thumb.style.cssText = `position:relative;width:64px;height:64px;padding:0;border-radius:8px;overflow:hidden;flex:0 0 auto;cursor:pointer;border:3px solid ${b.id === active.id ? '#38bdf8' : 'transparent'}`;
        const blob = await getPhoto(b.photoId);
        if (blob) {
          const im = document.createElement('img');
          im.src = URL.createObjectURL(blob);
          im.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
          thumb.appendChild(im);
        }
        const cap = document.createElement('span');
        cap.textContent = phaseName || b.label || `#${i + 1}`;
        cap.style.cssText = 'position:absolute;left:0;right:0;bottom:0;font-size:10px;line-height:1.3;background:#000a;color:#fff;padding:1px 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
        thumb.appendChild(cap);
        thumb.onclick = async () => {
          if (b.id === F.activeBackgroundId) return;
          F.activeBackgroundId = b.id;
          saveProject();
          invalidateCostField();
          await loadBackground();
          redraw();
          showPhotoPanel();
        };
        switcher.appendChild(thumb);
      }
      panel.appendChild(switcher);

      // Ovládání AKTIVNÍHO podkladu: popisek · průhlednost · doladit · odebrat
      const ctl = document.createElement('div');
      ctl.className = 'row';
      ctl.style.cssText = 'align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px';

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0'; slider.max = '100';
      slider.value = String(Math.round(active.opacity * 100));
      slider.style.flex = '1';
      slider.title = 'Průhlednost podkladu';
      slider.addEventListener('input', () => { active.opacity = Number(slider.value) / 100; redraw(); });
      slider.addEventListener('change', () => saveProject());

      const label = document.createElement('input');
      label.placeholder = 'Popisek';
      label.value = active.label ?? '';
      label.style.width = '130px';
      label.title = 'Popisek podkladu (např. „před omítkou")';
      label.onchange = () => { active.label = label.value.trim() || undefined; saveProject(); showPhotoPanel(); };

      // Fáze podkladu (neomítnuté / omítnuté / …) — dovolí hromadně přepnout,
      // co se ukáže ve 3D a vizualizaci (viz resolveBackground / project.activePhaseId).
      const phaseSel = document.createElement('select');
      phaseSel.title = 'Fáze fotky (neomítnuté / omítnuté / …)';
      phaseSel.innerHTML =
        `<option value="">— fáze —</option>` +
        project.photoPhases.map((ph) => `<option value="${ph.id}">${ph.name}</option>`).join('');
      phaseSel.value = active.phaseId ?? '';
      phaseSel.onchange = () => { active.phaseId = phaseSel.value || undefined; saveProject(); showPhotoPanel(); };

      ctl.append(Object.assign(document.createElement('span'), { textContent: '🌫️' }), slider, label, phaseSel);

      // Doladění perspektivy — znovu otevře editor s původní fotkou a rohy. Jen
      // u fotek s označenými rohy (ne u surové dlaždice). Rectifikovaná dlaždice
      // (region + rohy) → keepWhole režim; jinak klasické pasování na celou stěnu.
      if (active.sourcePhotoId && active.corners?.length) {
        const rectified = !!active.region;
        const tune = document.createElement('button');
        tune.className = 'primary';
        tune.textContent = '🔧 Doladit';
        tune.onclick = async () => {
          if (!active.sourcePhotoId) return;
          const src = await getPhoto(active.sourcePhotoId);
          if (!src) { alert('Původní fotka už není k dispozici (asi byla smazána).'); return; }
          if (active.fitMode === 'crop') await cropAsTile(src, active.sourcePhotoId, active.id);
          else if (rectified) await rectifyAsTile(src, active.sourcePhotoId, active.id);
          else await mapAsBackground(src, active.sourcePhotoId, active.id);
        };
        ctl.append(tune);
      }

      // Přepínač volné rohy (perspektiva) ↔ obdélník — jen u dlaždice (má region/quad).
      if (active.region || active.quad) {
        const qbtn = document.createElement('button');
        if (active.quad?.length === 4) {
          qbtn.textContent = '▭ Zpět na obdélník';
          qbtn.title = 'Zruší volné rohy — vrátí dlaždici do obdélníku (bounding box)';
          qbtn.onclick = () => {
            const q = active.quad!;
            const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
            const uMm = Math.round((Math.min(...xs) + Math.max(...xs)) / 2);
            const vMm = Math.round((Math.min(...ys) + Math.max(...ys)) / 2);
            active.region = { uMm, vMm, widthMm: Math.round(Math.max(...xs) - Math.min(...xs)), heightMm: Math.round(Math.max(...ys) - Math.min(...ys)) };
            active.quad = undefined;
            saveProject(); invalidateCostField(); redraw(); showPhotoPanel();
          };
        } else {
          qbtn.textContent = '⇱ Volné rohy';
          qbtn.title = 'Perspektiva: každý roh dlaždice půjde táhnout zvlášť (pro slícování partial fotek)';
          qbtn.onclick = () => {
            const info = bgDisp(active);
            // rohy TL,TR,BR,BL v zobrazení → kanonické (u,v)
            active.quad = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([du, dv]) => {
              const c = bgCornerPos(info, du, dv);
              const p = fromDisplay(W, side, c.x, c.y);
              return { x: Math.round(p.uMm), y: Math.round(p.vMm) };
            });
            saveProject(); invalidateCostField(); redraw(); showPhotoPanel();
          };
        }
        ctl.append(qbtn);
      }

      // Roztáhnout dlaždici zpět na celou zeď (smaže region).
      if (active.region && !active.quad) {
        const full = document.createElement('button');
        full.textContent = '◱ Celá zeď';
        full.title = 'Roztáhne tuto fotku zpět přes celou zeď';
        full.onclick = () => {
          active.region = undefined;
          saveProject();
          invalidateCostField();
          redraw();
          showPhotoPanel();
        };
        ctl.append(full);
      }

      const rm = document.createElement('button');
      rm.className = 'danger';
      rm.textContent = '✕ Odebrat';
      rm.title = 'Odebere tento podklad (šlice a kóty zůstanou)';
      rm.onclick = async () => {
        if (!confirm('Odebrat tento podklad?')) return;
        await deletePhoto(active.photoId);
        F.backgrounds = F.backgrounds.filter((x) => x.id !== active.id);
        F.activeBackgroundId = F.backgrounds[0]?.id;
        saveProject();
        invalidateCostField();
        if (!F.backgrounds.length) { snap = false; snapBtn.classList.remove('active'); }
        await loadBackground();
        redraw();
        showPhotoPanel();
      };
      ctl.append(rm);
      panel.appendChild(ctl);
    }

    const row = document.createElement('div');
    row.className = 'row';
    for (const id of F.photoIds) {
      const blob = await getPhoto(id);
      if (!blob) continue;
      const img = document.createElement('img');
      img.src = URL.createObjectURL(blob);
      img.style.cssText = 'width:72px;height:72px;object-fit:cover;border-radius:8px;cursor:pointer';
      img.onclick = () => {
        const ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;background:#000d;z-index:99;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px';
        const closeOverlay = (): void => {
          ov.remove();
          document.removeEventListener('keydown', onKey);
        };
        const onKey = (e: KeyboardEvent): void => {
          if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); }
        };
        document.addEventListener('keydown', onKey);

        // Zavírací křížek v pravém horním rohu
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.title = 'Zavřít (Esc)';
        closeBtn.style.cssText = 'position:absolute;top:12px;right:16px;width:40px;height:40px;border-radius:50%;border:none;background:#fff3;color:#fff;font-size:20px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center';
        closeBtn.onclick = (e) => { e.stopPropagation(); closeOverlay(); };
        ov.append(closeBtn);

        const big = document.createElement('img');
        big.src = img.src;
        big.style.cssText = 'max-width:100%;max-height:78%';
        const mapBtn = document.createElement('button');
        mapBtn.className = 'primary';
        mapBtn.textContent = '🗺️ Na fotografii je celá stěna';
        mapBtn.title = 'Fotka zabírá celou stěnu — označíš 4 rohy stěny a fotka se perspektivně napasuje jako podklad elevace.';
        mapBtn.onclick = async (e) => {
          e.stopPropagation();
          closeOverlay();
          await mapAsBackground(blob, id);
        };
        const cropBtn = document.createElement('button');
        cropBtn.textContent = '✂️ Oříznout a vložit';
        cropBtn.title = 'Obtáhneš oblast (mnohoúhelník), co je uvnitř zůstane, zbytek se ořízne. Vznikne dlaždice, kterou umístíš (a případně srovnáš volnými rohy).';
        cropBtn.onclick = async (e) => {
          e.stopPropagation();
          closeOverlay();
          await cropAsTile(blob, id);
        };
        const tileBtn = document.createElement('button');
        tileBtn.textContent = '🧩 Použít celý obrázek bez ořezu';
        tileBtn.title = 'Vloží celou fotku bez pasování a bez ořezu — pak ji posuneš / roztáhneš / otočíš. Pro skládání víc fotek.';
        tileBtn.onclick = async (e) => {
          e.stopPropagation();
          closeOverlay();
          await addAsTile(blob, id);
        };
        const delBtn = document.createElement('button');
        delBtn.className = 'danger';
        delBtn.textContent = '🗑 Smazat fotku';
        delBtn.onclick = async (e) => {
          e.stopPropagation();
          if (!confirm('Smazat fotku?')) return;
          F.photoIds = F.photoIds.filter((x) => x !== id);
          await deletePhoto(id);
          saveProject();
          closeOverlay();
          showPhotoPanel();
        };
        ov.onclick = () => closeOverlay();
        const btns = document.createElement('div');
        btns.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center';
        btns.append(mapBtn, cropBtn, tileBtn, delBtn);
        ov.append(big, btns);
        document.body.appendChild(ov);
      };
      row.appendChild(img);
    }

    // Přidání fotek: soubory + přímé focení (mobil)
    const addFiles = async (files: FileList | null, mapFirst: boolean): Promise<void> => {
      const arr = Array.from(files ?? []);
      let firstBlob: Blob | null = null;
      let firstId: string | null = null;
      for (const f of arr) {
        const id = newId();
        await savePhoto(id, f);
        F.photoIds.push(id);
        if (!firstBlob) { firstBlob = f; firstId = id; }
      }
      saveProject();
      if (mapFirst && firstBlob) await mapAsBackground(firstBlob, firstId ?? undefined);
      else showPhotoPanel();
    };

    const add = document.createElement('label');
    add.className = 'btn';
    add.innerHTML = '📁 Nahrát<input type="file" accept="image/*" hidden multiple />';
    add.querySelector('input')!.addEventListener('change', (e) => addFiles((e.target as HTMLInputElement).files, false));

    const shoot = document.createElement('label');
    shoot.className = 'btn';
    shoot.innerHTML = '📷 Vyfotit a napasovat<input type="file" accept="image/*" capture="environment" hidden />';
    shoot.querySelector('input')!.addEventListener('change', (e) => addFiles((e.target as HTMLInputElement).files, true));

    row.append(add, shoot);
    panel.appendChild(row);
  }

  /** Osadí prvek daného typu na bod stěny (ořízne do rozměrů stěny). Vrací nový prvek. */
  function placeFixtureAt(kind: FixtureKind, p: { uMm: number; vMm: number }): Fixture {
    const f: Fixture = {
      id: newId(),
      kind,
      categoryId: placeCategoryId,
      uMm: Math.round(Math.min(Math.max(p.uMm, U0), U1)),
      vMm: Math.round(Math.min(Math.max(p.vMm, 0), W.heightMm)),
    };
    F.fixtures.push(f);
    selectedFixtureId = f.id;
    lastPlacedId = f.id; // paleta k němu hned nabídne kóty k hranám
    ensureCategoryVisible(placeCategoryId); // ať osazený prvek hned neschová skrytá vrstva
    saveProject();
    redraw();
    return f;
  }

  /**
   * Tažení miniatury z palety na stěnu. Malý posun = jen vybrat typ (pak jde
   * osadit ťuknutím do stěny); tažení nad plátno = osadí prvek na místo puštění.
   */
  function startPaletteDrag(e: PointerEvent, kind: FixtureKind, item: HTMLElement): void {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    let ghost: HTMLElement | null = null;
    // Odsazení bodu položení (= střed prvku) od špičky kurzoru, v px. Kurzor drží
    // LEVÝ HORNÍ ROH prvku; ten visí dolů-vpravo a je v přesné výsledné velikosti
    // (mm → px dle zoomu), takže kam ho opticky dovezeš, tam se i položí.
    let dropOffsetPx = 0;
    const GAP = 6; // malá mezera mezi špičkou kurzoru a rohem prvku
    try { item.setPointerCapture(e.pointerId); } catch { /* ok */ }
    const move = (ev: PointerEvent): void => {
      if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) {
        const def = FIXTURE_DEFS[kind];
        const pxPerMm = 1 / mmPerPx();
        // Miniatura kreslí prvek na 78 % své čtvercové plochy → aby byl přesně
        // ve výsledné velikosti, zvětši čtverec o tento poměr.
        const sizePx = Math.max(def.wMm, def.hMm) * pxPerMm / 0.78;
        dropOffsetPx = GAP + sizePx / 2; // z rohu (kurzoru) do středu prvku
        ghost = document.createElement('div');
        ghost.style.cssText = `position:fixed;pointer-events:none;z-index:200;opacity:0.85;transform:translate(${GAP}px,${GAP}px);filter:drop-shadow(0 4px 6px #000a)`;
        ghost.innerHTML = fixtureThumbSvg(kind, sizePx);
        document.body.appendChild(ghost);
        item.style.cursor = 'grabbing';
      }
      if (ghost) { ghost.style.left = `${ev.clientX}px`; ghost.style.top = `${ev.clientY}px`; }
    };
    const cleanup = (): void => {
      item.style.cursor = 'grab';
      ghost?.remove();
      item.removeEventListener('pointermove', move);
      item.removeEventListener('pointerup', up);
      item.removeEventListener('pointercancel', cancel);
    };
    const up = (ev: PointerEvent): void => {
      const dragged = ghost != null;
      cleanup();
      if (!dragged) { // klik = jen vybrat typ pro ťukání do stěny
        placeKind = kind;
        placeCategoryId = paletteLayerId;
        showPlacePanel();
        return;
      }
      // Bod položení = střed prvku (visel dolů-vpravo od kurzoru), ne špička kurzoru,
      // aby prvek zůstal přesně tam, kam byl opticky dovezen.
      const cx = ev.clientX + dropOffsetPx, cy = ev.clientY + dropOffsetPx;
      const r = svg.getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
        placeKind = kind;
        placeCategoryId = paletteLayerId;
        const f = placeFixtureAt(kind, screenToWall(cx, cy));
        // Po nasunutí přepni do režimu Vybrat a hned ukaž panel prvku (jméno, číslo,
        // rozměry, smazání) — ať se dá rovnou nastavit i posunout/smazat (i klávesou Delete).
        setMode('select');
        showFixturePanel(f); // nastaví selectedFixtureId
        redraw();
      }
    };
    const cancel = (): void => cleanup();
    item.addEventListener('pointermove', move);
    item.addEventListener('pointerup', up);
    item.addEventListener('pointercancel', cancel);
  }

  /** Prvky aktuálně zvolené vrstvy palety, v uživatelském pořadí. */
  function paletteKinds(): FixtureKind[] {
    return fixtureKindsForLayer(paletteLayerId, project.fixtureOrder);
  }

  /**
   * Paleta prvků řízená vrstvou — nahoře výběr vrstvy, pod ním jen ikony patřící
   * dané vrstvě. Táhni je na stěnu (nebo klikni a ťukni do stěny).
   */
  function showPlacePanel(focusEdge?: EdgeName): void {
    panel.className = 'card no-print';
    panel.innerHTML = '';
    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.textContent = 'Přetáhni prvek na stěnu (nebo ho klikni a ťukni do stěny). Kóty právě osazeného prvku zadáš dole. Pořadí ikon nastavíš v ⚙️ Prvky.';
    panel.appendChild(hint);

    // Vrstva palety — nabídne jen vrstvy, které mají prvky; její volba filtruje ikony.
    const layerRow = document.createElement('label');
    layerRow.className = 'muted';
    layerRow.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin:2px 0 6px';
    layerRow.textContent = 'Vrstva:';
    const catSel = document.createElement('select');
    for (const id of fixtureLayerIds()) {
      const c = catById(id);
      if (!c) continue;
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      if (c.id === paletteLayerId) o.selected = true;
      catSel.appendChild(o);
    }
    catSel.onchange = () => {
      paletteLayerId = catSel.value;
      placeCategoryId = paletteLayerId;
      const first = paletteKinds()[0];
      if (first) placeKind = first;
      showPlacePanel();
    };
    layerRow.appendChild(catSel);
    panel.appendChild(layerRow);

    const grid = document.createElement('div');
    grid.className = 'row';
    grid.style.cssText = 'flex-wrap:wrap;gap:6px';
    for (const kind of paletteKinds()) {
      const def = FIXTURE_DEFS[kind];
      const item = document.createElement('div');
      item.title = def.label;
      item.style.cssText = `display:flex;flex-direction:column;align-items:center;gap:2px;width:66px;padding:5px 3px;border-radius:8px;cursor:grab;touch-action:none;user-select:none;border:1px solid ${kind === placeKind ? def.color : 'transparent'};background:${kind === placeKind ? '#ffffff10' : 'transparent'}`;
      const thumb = document.createElement('div');
      thumb.innerHTML = fixtureThumbSvg(kind, 42);
      const cap = document.createElement('span');
      cap.textContent = def.label;
      cap.style.cssText = 'font-size:11px;line-height:1.1;text-align:center;color:#cbd5e1';
      item.append(thumb, cap);
      item.addEventListener('pointerdown', (e) => startPaletteDrag(e, kind, item));
      grid.appendChild(item);
    }
    panel.appendChild(grid);

    // Právě osazený prvek: kóty k hranám rovnou tady, ať se nemusí přepínat režim.
    const last = lastPlacedId ? F.fixtures.find((x) => x.id === lastPlacedId) : undefined;
    if (last) {
      const cap = document.createElement('div');
      cap.className = 'muted';
      cap.style.marginTop = '6px';
      cap.textContent = `Osazeno: ${last.label || FIXTURE_DEFS[last.kind].label}${last.code ? ` (${last.code})` : ''}`;
      panel.appendChild(cap);
      const cntRow = document.createElement('div');
      cntRow.className = 'row';
      appendFixtureCount(cntRow, last, () => showPlacePanel());
      if (cntRow.childElementCount) panel.appendChild(cntRow);
      appendFixtureEdgeDims(panel, last, (fe) => showPlacePanel(fe), focusEdge);
    }
  }

  /**
   * Výběr počtu kusů v bloku (1× až 5×) — u typů, které se osazují vedle sebe do
   * společného rámečku (zásuvky). Blok zůstává JEDNÍM prvkem: roste symetricky
   * kolem svého středu, takže kóty se měří od středu bloku.
   */
  function appendFixtureCount(host: HTMLElement, f: Fixture, rerender: () => void): void {
    if (!MULTI_FIXTURE_KINDS.includes(f.kind)) return;
    const row = document.createElement('label');
    row.className = 'muted';
    row.style.cssText = 'display:inline-flex;align-items:center;gap:6px';
    row.textContent = 'Počet v bloku:';
    const sel = document.createElement('select');
    sel.title = 'Kolik kusů vedle sebe (kótuje se od středu bloku)';
    for (let n = 1; n <= MAX_FIXTURE_COUNT; n++) {
      const o = document.createElement('option');
      o.value = String(n);
      o.textContent = n === 1 ? '1× (jednoduchá)' : `${n}×`;
      if (n === fixtureCount(f)) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => {
      const n = Number(sel.value);
      f.count = n > 1 ? n : undefined; // 1 = výchozí, do dat se nezapisuje
      saveProject();
      redraw();
      rerender();
    };
    row.appendChild(sel);
    host.appendChild(row);
  }

  /** Kóta prvku k dané hraně líce (nejvýš jedna na hranu), pokud už existuje. */
  function fixtureEdgeDim(fixtureId: string, edge: EdgeName): Dimension | undefined {
    return F.dims.find((d) =>
      d.from.kind === 'fixture' && d.from.fixtureId === fixtureId &&
      d.to.kind === 'edge' && d.to.edge === edge);
  }

  /** Hrany v pořadí, v jakém je uživatel vidí: vlevo, vpravo, nahoře, dole. */
  const edgesInViewOrder = (): EdgeName[] => {
    const l = leftEdgeName();
    return [l, l === 'left' ? 'right' : 'left', 'top', 'bottom'];
  };

  /**
   * Kóty prvku ke čtyřem hranám líce. Zadávat je lze postupně a nezávisle (klidně
   * všechny čtyři): hrana bez kóty se nabídne tlačítkem, hotová kóta má pole (cíl
   * metru) a ✕ ke zrušení. Zadaná míra prvek rovnou posune (applyDimValue).
   * `rerender` překreslí hostitelský panel (prvek / paleta), `focusEdge` zaostří
   * právě přidanou kótu, ať se míra dá hned napsat nebo pípnout.
   */
  function appendFixtureEdgeDims(host: HTMLElement, f: Fixture, rerender: (focus?: EdgeName) => void, focusEdge?: EdgeName): void {
    const btnRow = document.createElement('div');
    btnRow.className = 'row';
    btnRow.style.flexWrap = 'wrap';
    const cap = document.createElement('span');
    cap.className = 'muted';
    cap.textContent = 'Kóta prvku:';
    btnRow.appendChild(cap);
    let any = false;
    for (const e of edgesInViewOrder()) {
      if (fixtureEdgeDim(f.id, e)) continue;
      const b = document.createElement('button');
      b.textContent = `📏 ${edgeLabel(e)}`;
      b.onclick = () => {
        F.dims.push({ id: newId(), from: { kind: 'fixture', fixtureId: f.id }, to: { kind: 'edge', edge: e }, valueMm: null });
        saveProject();
        redraw();
        rerender(e);
      };
      btnRow.appendChild(b);
      any = true;
    }
    if (any) host.appendChild(btnRow);
    for (const e of edgesInViewOrder()) {
      const d = fixtureEdgeDim(f.id, e);
      if (!d) continue;
      const row = document.createElement('div');
      row.className = 'row';
      const lbl = document.createElement('span');
      lbl.className = 'muted';
      lbl.textContent = `${edgeLabel(e)} (mm):`;
      const apply = (mm: number) => { applyDimValue(d, mm); rerender(); };
      const geom = dimGeomLengthMm(W, side, d);
      const input = lengthInput(d.valueMm ?? (geom != null ? Math.round(geom) : null), apply);
      input.style.width = '110px';
      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = '✕';
      del.title = 'Kótu zrušit';
      del.onclick = () => {
        F.dims = F.dims.filter((x) => x.id !== d.id);
        saveProject();
        redraw();
        rerender();
      };
      row.append(lbl, input, del);
      host.appendChild(row);
      if (e === focusEdge) { setDistoTarget(input, apply); input.focus(); input.select(); }
    }
  }

  /** Smaže prvek i kóty, které z něj vedou. Používá tlačítko 🗑 i klávesa Delete. */
  function deleteFixture(f: Fixture): void {
    F.fixtures = F.fixtures.filter((x) => x.id !== f.id);
    F.dims = F.dims.filter((d) =>
      !(d.from.kind === 'fixture' && d.from.fixtureId === f.id) &&
      !(d.to.kind === 'fixture' && d.to.fixtureId === f.id));
    selectedFixtureId = null;
    if (lastPlacedId === f.id) lastPlacedId = null;
    saveProject();
    redraw();
    panel.innerHTML = '';
    panel.className = '';
  }

  /** Smaže šlic/trasu i kóty, které z něj vedou. Tlačítko 🗑 i klávesa Delete. */
  function deleteRoute(r: Route): void {
    F.routes = F.routes.filter((x) => x.id !== r.id);
    F.dims = F.dims.filter((d) =>
      !(d.from.kind === 'routePoint' && d.from.routeId === r.id) &&
      !(d.to.kind === 'routePoint' && d.to.routeId === r.id));
    selectedRouteId = null;
    saveProject();
    redraw();
    panel.innerHTML = '';
    panel.className = '';
  }

  /** Smaže výdřevu i kóty, které z ní vedou. Tlačítko 🗑 i klávesa Delete. */
  function deleteArea(a: WallArea): void {
    F.areas = F.areas.filter((x) => x.id !== a.id);
    F.dims = F.dims.filter((d) =>
      !(d.from.kind === 'area' && d.from.areaId === a.id) &&
      !(d.to.kind === 'area' && d.to.areaId === a.id));
    selectedAreaId = null;
    saveProject();
    redraw();
    panel.innerHTML = '';
    panel.className = '';
  }

  /** Panel vybraného prvku — změna typu, popisek, smazání. */
  /** @param focusEdge hrana, jejíž právě přidaná kóta se rovnou zaostří (cíl metru). */
  function showFixturePanel(f: Fixture, focusEdge?: EdgeName): void {
    selectedFixtureId = f.id;
    panel.className = 'card no-print';
    panel.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'row';
    const kindSel = document.createElement('select');
    for (const kind of FIXTURE_KINDS) {
      const o = document.createElement('option');
      o.value = kind;
      o.textContent = FIXTURE_DEFS[kind].label;
      if (kind === f.kind) o.selected = true;
      kindSel.appendChild(o);
    }
    // změna typu vrátí rozměry na výchozí nového typu (jiný tvar/velikost)
    kindSel.onchange = () => { f.kind = kindSel.value as FixtureKind; f.widthMm = undefined; f.heightMm = undefined; saveProject(); redraw(); showFixturePanel(f); };
    const catSel = document.createElement('select');
    catSel.title = 'Vrstva prvku';
    for (const c of project.categories) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      if (c.id === f.categoryId) o.selected = true;
      catSel.appendChild(o);
    }
    catSel.onchange = () => { f.categoryId = catSel.value; ensureCategoryVisible(f.categoryId); saveProject(); redraw(); };
    const codeIn = document.createElement('input');
    codeIn.placeholder = 'č.';
    codeIn.value = f.code ?? '';
    codeIn.style.width = '70px';
    codeIn.title = 'Označení / číslo prvku dle projektu (např. „Z1")';
    codeIn.onchange = () => { f.code = codeIn.value.trim() || undefined; saveProject(); redraw(); };
    const labelIn = document.createElement('input');
    labelIn.placeholder = FIXTURE_DEFS[f.kind].label;
    labelIn.value = f.label ?? '';
    labelIn.style.width = '150px';
    labelIn.title = 'Vlastní popisek (např. „lednička")';
    labelIn.onchange = () => { f.label = labelIn.value.trim() || undefined; saveProject(); redraw(); };
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '🗑 Smazat';
    del.onclick = () => { if (confirm('Smazat prvek?')) deleteFixture(f); };
    row.append(kindSel, catSel, codeIn, labelIn, del);
    panel.appendChild(row);

    // rozměry prvku (mm) — š × v; prázdné/0 vrátí výchozí rozměr typu
    const sizeRow = document.createElement('div');
    sizeRow.className = 'row';
    sizeRow.style.alignItems = 'center';
    const eff = fixtureSize(f);
    const round = FIXTURE_DEFS[f.kind].shape === 'round';
    const mkSize = (val: number, apply: (mm: number) => void, title: string): HTMLInputElement => {
      const inp = document.createElement('input');
      inp.type = 'number'; inp.inputMode = 'numeric'; inp.value = String(val);
      inp.style.width = '80px'; inp.title = title;
      inp.onchange = () => { const mm = Number(inp.value); apply(mm > 0 ? mm : NaN); saveProject(); redraw(); };
      return inp;
    };
    // U bloku (dvojzásuvka…) je šířka rozměrem JEDNOHO kusu — celek = počet × šířka.
    const wIn = mkSize(fixtureUnitWidth(f), (mm) => { f.widthMm = Number.isFinite(mm) ? Math.round(mm) : undefined; if (round) { f.heightMm = f.widthMm; } showFixturePanel(f); }, 'Šířka jednoho kusu (mm)');
    const hIn = mkSize(eff.h, (mm) => { f.heightMm = Number.isFinite(mm) ? Math.round(mm) : undefined; if (round) { f.widthMm = f.heightMm; } showFixturePanel(f); }, 'Výška / průměr (mm)');
    const lbl = document.createElement('span');
    lbl.className = 'muted';
    lbl.textContent = round ? 'průměr mm:' : fixtureCount(f) > 1 ? 'rozměr 1 ks š × v mm:' : 'rozměr š × v mm:';
    if (round) {
      sizeRow.append(lbl, wIn); // kruh: stačí jeden rozměr (průměr)
    } else {
      sizeRow.append(lbl, wIn, Object.assign(document.createElement('span'), { textContent: '×', className: 'muted' }), hIn);
    }
    sizeRow.appendChild(document.createTextNode(' '));
    appendFixtureCount(sizeRow, f, () => showFixturePanel(f));
    panel.appendChild(sizeRow);

    // Kóty ke čtyřem hranám líce — postupně kterákoli (i všechny), míra prvek posune.
    appendFixtureEdgeDims(panel, f, (fe) => showFixturePanel(f, fe), focusEdge);

    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.textContent = 'Táhni prvek pro posun. Kóty k hranám zadáš výše (napsat nebo pípnout metrem), kóty mezi prvky v 📏 Kóta, šlic mezi prvky v ✏️ Trasa.';
    panel.appendChild(hint);
  }

  /** Rozbalovací výběr vrstvy (kategorie); onPick dostane zvolené id. */
  function categorySelect(currentId: string, onPick: (id: string) => void): HTMLSelectElement {
    const sel = document.createElement('select');
    for (const c of project.categories) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      if (c.id === currentId) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => onPick(sel.value);
    return sel;
  }

  /**
   * Wizard bloku nosníků (vrstva nosnik-strop / nosnik-sdk): směr (jen strop),
   * šířka nosníku, osová rozteč, počet → tlačítko vloží celý blok najednou.
   */
  function showBeamWizard(): void {
    const isSdk = areaCategoryId === 'nosnik-sdk';
    if (!isSdk) {
      // Směr skladu — jen stropní nosníky; SDK jsou vždy svislé.
      const dirRow = document.createElement('div');
      dirRow.className = 'row';
      dirRow.style.alignItems = 'center';
      const dl = document.createElement('span'); dl.className = 'muted'; dl.textContent = 'Směr:';
      const mk = (label: string, val: 'u' | 'v'): HTMLButtonElement => {
        const b = document.createElement('button');
        b.textContent = label;
        if (beamDir === val) b.className = 'primary';
        b.onclick = () => { beamDir = val; showAreaPanel(); };
        return b;
      };
      dirRow.append(dl, mk('▏▏ svislé', 'u'), mk('☰ vodorovné', 'v'));
      panel.appendChild(dirRow);
    }
    const field = (label: string, input: HTMLElement): void => {
      const r = document.createElement('div'); r.className = 'row'; r.style.alignItems = 'center';
      const s = document.createElement('span'); s.className = 'muted'; s.textContent = label;
      r.append(s, input); panel.appendChild(r);
    };
    const wIn = lengthInput(beamWidthMm, (mm) => { beamWidthMm = Math.round(mm); });
    wIn.style.width = '90px';
    field('Šířka nosníku (mm):', wIn);
    const sIn = lengthInput(beamSpacingMm, (mm) => { beamSpacingMm = Math.round(mm); });
    sIn.style.width = '90px';
    field('Osová rozteč (mm):', sIn);
    const cIn = document.createElement('input');
    cIn.type = 'number'; cIn.inputMode = 'numeric'; cIn.min = '1'; cIn.value = String(beamCount);
    cIn.style.width = '90px';
    cIn.onchange = () => { const n = Number(cIn.value); if (n >= 1) beamCount = Math.round(n); };
    field('Počet nosníků:', cIn);
    const ins = document.createElement('button');
    ins.className = 'primary';
    ins.textContent = '➕ Vložit blok';
    ins.onclick = () => {
      // Přečti aktuální hodnoty z políček (i bez potvrzení Enterem/změnou).
      const w = Number(wIn.value), s = Number(sIn.value), n = Number(cIn.value);
      if (w > 0) beamWidthMm = Math.round(w);
      if (s > 0) beamSpacingMm = Math.round(s);
      if (n >= 1) beamCount = Math.round(n);
      insertBeamBlock();
    };
    panel.appendChild(ins);
    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.textContent = 'Blok se vloží doprostřed plátna. Táhni ho jako celek; kóta k nosníku ho připne (přebíjí rozteč), šířka zůstává.';
    panel.appendChild(hint);
  }

  /**
   * Panel výdřevy: bez vybrané desky ukáže nápovědu ke kreslení a volbu vrstvy
   * pro novou desku (u vrstvy nosníků wizard bloku); s vybranou deskou dovolí
   * upravit vrstvu, rozměry (i metrem), popisek a smazat.
   */
  function showAreaPanel(): void {
    panel.className = 'card no-print';
    panel.innerHTML = '';
    const a = F.areas.find((x) => x.id === selectedAreaId);
    if (!a) {
      // Volba vrstvy nové desky — přepnutí na vrstvu nosníků aktivuje wizard bloku.
      const row = document.createElement('div');
      row.className = 'row';
      row.style.alignItems = 'center';
      const lbl = document.createElement('span');
      lbl.className = 'muted';
      lbl.textContent = 'Vrstva nové desky:';
      row.append(lbl, categorySelect(areaCategoryId, (id) => { areaCategoryId = id; showAreaPanel(); }));
      panel.appendChild(row);

      if (isBeamLayer(areaCategoryId)) { showBeamWizard(); return; }

      const hint = document.createElement('div');
      hint.className = 'muted';
      hint.textContent = areaFirst
        ? '2. roh: ťukněte na protilehlý roh desky.'
        : 'Táhněte od rohu k protilehlému rohu (nebo ťukněte oba rohy). Hotovou desku ťuknutím vyberete, tažením posunete.';
      panel.appendChild(hint);
      return;
    }

    const row = document.createElement('div');
    row.className = 'row';
    row.append(categorySelect(a.categoryId, (id) => { a.categoryId = id; ensureCategoryVisible(id); saveProject(); redraw(); }));
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = a.beamGroupId ? '🗑 Nosník' : '🗑 Smazat';
    del.onclick = () => { if (confirm(a.beamGroupId ? 'Smazat tento nosník?' : 'Smazat výdřevu?')) deleteArea(a); };
    row.append(del);
    if (a.beamGroupId) {
      const delGroup = document.createElement('button');
      delGroup.className = 'danger';
      delGroup.textContent = '🗑 Celý blok';
      delGroup.onclick = () => { if (confirm('Smazat celý blok nosníků?')) deleteBeamGroup(a.beamGroupId!); };
      row.append(delGroup);
    }
    panel.appendChild(row);

    // rozměry š × v (mm) — pole podporují i vyplnění metrem DISTO
    const sizeRow = document.createElement('div');
    sizeRow.className = 'row';
    sizeRow.style.alignItems = 'center';
    const lbl = document.createElement('span');
    lbl.className = 'muted';
    lbl.textContent = 'rozměr š × v mm:';
    const wIn = lengthInput(a.widthMm, (mm) => { a.widthMm = Math.round(mm); a.uMm = Math.round(clampU(a.uMm)); saveProject(); redraw(); });
    wIn.style.width = '90px';
    const hIn = lengthInput(a.heightMm, (mm) => { a.heightMm = Math.round(mm); a.vMm = Math.round(clampV(a.vMm)); saveProject(); redraw(); });
    hIn.style.width = '90px';
    sizeRow.append(lbl, wIn, Object.assign(document.createElement('span'), { textContent: '×', className: 'muted' }), hIn);
    panel.appendChild(sizeRow);

    const note = document.createElement('input');
    note.placeholder = 'Popisek (např. „pod TV“)';
    note.value = a.note ?? '';
    note.onchange = () => { a.note = note.value.trim() || undefined; saveProject(); redraw(); };
    panel.appendChild(note);

    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.textContent = 'Táhni desku pro posun. Přesné rozměry vyplň metrem (klik do pole) nebo z klávesnice.';
    panel.appendChild(hint);
  }

  function setMode(m: Mode): void {
    const prev = mode;
    mode = m;
    dimFirst = null;
    selectedDimId = null;
    pendingDimId = null;
    lastPlacedId = null;
    selectedFixtureId = null;
    areaFirst = null;
    selectedAreaId = null;
    draggingAreaId = null;
    clearDimHover();
    clearAreaHover();
    root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === m);
    });
    if (m === 'draw') {
      // Znovu-ťuknutí na „Kreslit" (už jsme v režimu kreslení) uzavře rozpracovaný
      // šlic a začne nový; příchod z jiného režimu rozpracovaný šlic zachová.
      if (prev === 'draw') { commitDraft(); newDraft(); }
      else if (!draft) newDraft();
      showDrawSetupPanel();
    } else if (m === 'area') showAreaPanel();
    else if (m === 'select') showSelectPanel();
    else if (m === 'dim') showDimPanel();
    else if (m === 'place') showPlacePanel();
    else showPhotoPanel();
    redraw();
  }

  root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
    b.addEventListener('click', () => setMode(b.dataset.mode as Mode));
  });
  const orthoBtn = root.querySelector('#ortho') as HTMLButtonElement;
  /** Přepínač pravých úhlů — drží v souladu tlačítko v liště i kopii v panelu kreslení. */
  function setOrtho(v: boolean): void {
    ortho = v;
    orthoBtn.classList.toggle('active', ortho);
    if (mode === 'draw' && draft) showDrawPanel();
  }
  orthoBtn.addEventListener('click', () => setOrtho(!ortho));
  const snapBtn = root.querySelector('#snap') as HTMLButtonElement;
  snapBtn.addEventListener('click', async () => {
    if (!snap) {
      if (!activeBg()) {
        alert('Nejdřív napasuj fotku stěny (🖼️ Fotky → Napasovat). Přichytávání pak povede linku po tmavém šlicu.');
        return;
      }
      snapBtn.disabled = true;
      const orig = snapBtn.textContent;
      snapBtn.textContent = '⏳ …';
      try { await ensureCostField(); } finally { snapBtn.disabled = false; snapBtn.textContent = orig; }
      if (!costField) { alert('Podklad se nepodařilo načíst.'); return; }
      snap = true;
    } else {
      snap = false;
    }
    snapBtn.classList.toggle('active', snap);
  });

  // --- panel vrstev (skrývání / zobrazování kategorií) ---
  const layersBtn = root.querySelector('#layers') as HTMLButtonElement;
  const wrapEl = root.querySelector('.viewer-wrap') as HTMLElement;
  let layersEl: HTMLElement | null = null;   // tělo panelu (cíl vykreslení)
  let layersCard: HTMLElement | null = null; // celá karta (vložení/odebrání)
  function closeLayers(): void {
    layersCard?.remove();
    layersCard = null;
    layersEl = null;
    layersBtn.classList.remove('active');
  }
  /** Plovoucí panel se zavíracím křížkem v rohu; vrací kartu (vložit/odebrat) a tělo (obsah). */
  function makeFloatPanel(cssText: string, onClose: () => void): { card: HTMLElement; body: HTMLElement } {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = cssText;
    const close = document.createElement('button');
    close.textContent = '✕';
    close.title = 'Zavřít (Esc)';
    close.style.cssText = 'position:absolute;top:4px;right:4px;padding:2px 8px;line-height:1;z-index:1';
    close.onclick = onClose;
    const body = document.createElement('div');
    body.style.cssText = 'flex:1;min-height:0;overflow:auto';
    card.append(close, body);
    return { card, body };
  }
  /** Přesune vrstvu v seznamu (a tím i v pořadí vykreslení) o `dir` (±1). */
  function moveCategory(i: number, dir: -1 | 1): void {
    const j = i + dir;
    const cats = project.categories;
    if (j < 0 || j >= cats.length) return;
    [cats[i], cats[j]] = [cats[j], cats[i]];
    saveProject();
    redraw();
    renderLayers();
  }
  function renderLayers(): void {
    if (!layersEl) return;
    layersEl.innerHTML = '<div class="muted" style="margin-bottom:6px;padding-right:22px">Vrstvy — pořadí ↑↓ řídí vykreslení (výše = navrchu)</div>';
    // Hromadný přepínač: jsou-li všechny viditelné, skryje vše; jinak vše zobrazí.
    const allVisible = project.categories.every((c) => isCategoryVisible(c));
    const allBtn = document.createElement('button');
    allBtn.style.cssText = 'width:100%;margin:0 0 6px;font-weight:bold';
    allBtn.textContent = allVisible ? '🚫 Skrýt vše' : '👁️ Zobrazit vše';
    allBtn.onclick = () => {
      for (const c of project.categories) c.visible = !allVisible;
      saveProject();
      redraw();
      renderLayers();
    };
    layersEl.appendChild(allBtn);

    project.categories.forEach((c, i) => {
      const vis = isCategoryVisible(c);
      const row = document.createElement('div');
      row.style.cssText = `display:flex;align-items:center;gap:4px;margin:3px 0;opacity:${vis ? 1 : 0.5}`;

      // Řazení ↑↓ (nahoře v seznamu = navrchu při vykreslení)
      const up = document.createElement('button');
      up.textContent = '↑'; up.title = 'Posunout výš (navrch)';
      up.style.cssText = 'padding:2px 6px;line-height:1';
      up.disabled = i === 0;
      up.onclick = () => moveCategory(i, -1);
      const down = document.createElement('button');
      down.textContent = '↓'; down.title = 'Posunout níž (naspod)';
      down.style.cssText = 'padding:2px 6px;line-height:1';
      down.disabled = i === project.categories.length - 1;
      down.onclick = () => moveCategory(i, 1);

      // Barva vrstvy
      const colorIn = document.createElement('input');
      colorIn.type = 'color'; colorIn.value = c.color;
      colorIn.title = 'Barva vrstvy';
      colorIn.style.cssText = 'width:28px;height:24px;padding:1px;flex:none';
      colorIn.onchange = () => { c.color = colorIn.value; saveProject(); redraw(); };

      // Název vrstvy
      const nameIn = document.createElement('input');
      nameIn.value = c.name;
      nameIn.title = 'Název vrstvy';
      nameIn.style.cssText = 'flex:1;min-width:0';
      nameIn.onchange = () => { c.name = nameIn.value; saveProject(); };

      // Viditelnost
      const visBtn = document.createElement('button');
      visBtn.textContent = vis ? '👁️' : '🚫';
      visBtn.title = 'Skrýt / zobrazit vrstvu';
      visBtn.style.cssText = 'padding:2px 6px;line-height:1';
      visBtn.onclick = () => { c.visible = !vis; saveProject(); redraw(); renderLayers(); };

      // Smazání
      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = '✕'; del.title = 'Smazat vrstvu';
      del.style.cssText = 'padding:2px 6px;line-height:1';
      del.onclick = () => {
        if (!confirm(`Smazat vrstvu „${c.name}"? Prvky v ní zůstanou, jen ztratí barvu a řazení vrstvy.`)) return;
        project.categories = project.categories.filter((x) => x.id !== c.id);
        saveProject();
        redraw();
        renderLayers();
      };

      row.append(up, down, colorIn, nameIn, visBtn, del);
      layersEl!.appendChild(row);
    });

    const addBtn = document.createElement('button');
    addBtn.textContent = '➕ Přidat vrstvu';
    addBtn.style.cssText = 'width:100%;margin-top:6px';
    addBtn.onclick = () => {
      project.categories.push({ id: newId(), name: 'Nová vrstva', color: '#22d3ee' });
      saveProject();
      renderLayers();
    };
    layersEl.appendChild(addBtn);
  }
  function toggleLayers(): void {
    if (layersEl) { closeLayers(); return; }
    layersBtn.classList.add('active');
    const { card, body } = makeFloatPanel(
      'position:absolute;top:8px;left:8px;z-index:5;max-height:70%;width:270px;padding:8px;display:flex;flex-direction:column',
      closeLayers);
    wrapEl.appendChild(card);
    layersCard = card;
    layersEl = body;
    renderLayers();
  }
  layersBtn.addEventListener('click', toggleLayers);
  registerCleanup(() => closeLayers());
  /** Kreslí-li/osazuje-li uživatel do skryté vrstvy, zviditelní ji — jinak by výsledek hned zmizel. */
  function ensureCategoryVisible(id: string): void {
    const c = catById(id);
    if (c && c.visible === false) { c.visible = true; saveProject(); renderLayers(); }
  }

  // --- panel řazení prvků v paletě (⚙️ Prvky) ---
  const fixorderBtn = root.querySelector('#fixorder') as HTMLButtonElement;
  let fixorderEl: HTMLElement | null = null;   // tělo panelu
  let fixorderCard: HTMLElement | null = null; // celá karta
  let fixorderFilter = paletteLayerId; // filtr panelu řazení (''=všechny vrstvy)
  function closeFixorder(): void {
    fixorderCard?.remove();
    fixorderCard = null;
    fixorderEl = null;
    fixorderBtn.classList.remove('active');
  }
  /** Aktuální globální pořadí typů prvků (doplněné o chybějící) — základ pro přesuny. */
  function currentFixtureOrder(): FixtureKind[] {
    const ord = project.fixtureOrder ?? [];
    return [...ord.filter((k) => FIXTURE_KINDS.includes(k)),
      ...FIXTURE_KINDS.filter((k) => !ord.includes(k))];
  }
  /** Posune prvek v rámci JEHO vrstvy o krok (dir −1 nahoru / +1 dolů). */
  function moveFixture(kind: FixtureKind, dir: -1 | 1): void {
    const order = currentFixtureOrder();
    const layerKinds = order.filter((k) => FIXTURE_LAYER[k] === FIXTURE_LAYER[kind]);
    const swapWith = layerKinds[layerKinds.indexOf(kind) + dir];
    if (!swapWith) return; // na kraji vrstvy — nic
    const i = order.indexOf(kind), j = order.indexOf(swapWith);
    [order[i], order[j]] = [order[j], order[i]];
    project.fixtureOrder = order;
    saveProject();
    renderFixorder();
    if (mode === 'place') showPlacePanel();
  }
  function renderFixorder(): void {
    if (!fixorderEl) return;
    fixorderEl.innerHTML = '';
    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.style.cssText = 'margin-bottom:6px;padding-right:22px';
    hint.textContent = 'Pořadí prvků v paletě — šipkami ve své vrstvě';
    fixorderEl.appendChild(hint);
    // Filtr podle vrstvy — ať se nehledá v dlouhém seznamu všech prvků.
    const filterRow = document.createElement('label');
    filterRow.className = 'muted';
    filterRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px';
    filterRow.textContent = 'Vrstva:';
    const fsel = document.createElement('select');
    fsel.style.flex = '1';
    const allOpt = document.createElement('option');
    allOpt.value = ''; allOpt.textContent = 'Vše';
    fsel.appendChild(allOpt);
    for (const id of fixtureLayerIds()) {
      const c = catById(id);
      if (!c) continue;
      const o = document.createElement('option');
      o.value = id; o.textContent = c.name;
      fsel.appendChild(o);
    }
    fsel.value = fixorderFilter;
    fsel.onchange = () => { fixorderFilter = fsel.value; renderFixorder(); };
    filterRow.appendChild(fsel);
    fixorderEl.appendChild(filterRow);

    const layerIds = fixorderFilter ? [fixorderFilter] : fixtureLayerIds();
    for (const layerId of layerIds) {
      const cat = catById(layerId);
      if (!cat) continue;
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:8px;margin:8px 0 2px;font-weight:bold';
      head.innerHTML = `<span class="dot" style="background:${cat.color}"></span><span>${cat.name}</span>`;
      fixorderEl.appendChild(head);
      const kinds = fixtureKindsForLayer(layerId, project.fixtureOrder);
      kinds.forEach((kind, idx) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:2px 0';
        const thumb = document.createElement('div');
        thumb.style.cssText = 'flex:0 0 auto;line-height:0';
        thumb.innerHTML = fixtureThumbSvg(kind, 26);
        const name = document.createElement('span');
        name.style.cssText = 'flex:1;text-align:left';
        name.textContent = FIXTURE_DEFS[kind].label;
        const up = document.createElement('button');
        up.textContent = '▲';
        up.title = 'Nahoru';
        up.disabled = idx === 0;
        up.style.cssText = 'padding:2px 10px';
        up.onclick = () => moveFixture(kind, -1);
        const down = document.createElement('button');
        down.textContent = '▼';
        down.title = 'Dolů';
        down.disabled = idx === kinds.length - 1;
        down.style.cssText = 'padding:2px 10px';
        down.onclick = () => moveFixture(kind, 1);
        row.append(thumb, name, up, down);
        fixorderEl!.appendChild(row);
      });
    }
  }
  function toggleFixorder(): void {
    if (fixorderEl) { closeFixorder(); return; }
    fixorderBtn.classList.add('active');
    // Celá volná výška stránky (top→bottom), ne malé okno — ať se prvky rozbalí.
    const { card, body } = makeFloatPanel(
      'position:absolute;top:8px;bottom:8px;left:8px;z-index:5;width:260px;padding:8px;display:flex;flex-direction:column',
      closeFixorder);
    wrapEl.appendChild(card);
    fixorderCard = card;
    fixorderEl = body;
    renderFixorder();
  }
  fixorderBtn.addEventListener('click', toggleFixorder);
  registerCleanup(() => closeFixorder());
  // Zavření plovoucích panelů (Vrstvy / Prvky) klávesou Escape + smazání vybraného
  // prvku / šlicu / výdřevy / kóty klávesou Delete (mimo psaní do políček).
  const onEsc = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && (layersEl || fixorderEl)) { closeLayers(); closeFixorder(); return; }
    if (e.key !== 'Delete') return;
    const t = e.target as HTMLElement | null;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return; // píše se do políčka
    const fx = selectedFixtureId ? F.fixtures.find((x) => x.id === selectedFixtureId) : null;
    const rt = selectedRouteId ? F.routes.find((x) => x.id === selectedRouteId) : null;
    const ar = selectedAreaId ? F.areas.find((x) => x.id === selectedAreaId) : null;
    const dm = selectedDimId ? F.dims.find((x) => x.id === selectedDimId) : null;
    if (fx) { if (confirm('Smazat prvek?')) { deleteFixture(fx); e.preventDefault(); } }
    else if (rt) { if (confirm('Smazat trasu?')) { deleteRoute(rt); e.preventDefault(); } }
    else if (ar) { if (confirm('Smazat výdřevu?')) { deleteArea(ar); e.preventDefault(); } }
    else if (dm) { F.dims = F.dims.filter((x) => x.id !== dm.id); selectedDimId = null; saveProject(); redraw(); showDimPanel(); e.preventDefault(); }
  };
  document.addEventListener('keydown', onEsc);
  registerCleanup(() => document.removeEventListener('keydown', onEsc));

  // --- pointer interakce: tap / pan / pinch ---
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchStart: { dist: number; vb: ViewBox } | null = null;
  let tapStart: { x: number; y: number; t: number } | null = null;

  // Textura líce se kreslí jako <image>, který je nativně tažitelný → při tažení bodu
  // prohlížeč spustí drag&drop obrázku (zákazový kurzor) a naše tažení umře po ~1 mm.
  // Zákaz nativního dragu to spolehlivě vyřeší.
  svg.addEventListener('dragstart', (e) => e.preventDefault());

  svg.addEventListener('pointerdown', (e) => {
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      tapStart = { x: e.clientX, y: e.clientY, t: Date.now() };
      // Pointerdown na objekt zahájí jeho tažení (místo posunu plátna).
      draggingFixtureId = null;
      fixtureMoved = false;
      draggingAreaId = null;
      areaMoved = false;
      draggingRouteVertex = null;
      routeVertexMoved = false;
      // Vkládání uzlu „+" do vybraného šlicu patří do nástroje ✏️ Trasa (dokud nekreslíš
      // nový šlic). Vybrat má šlic jen vybírat + uzly tahat/mazat, ne přidávat body.
      if (mode === 'draw' && (draft?.points.length ?? 0) === 0) {
        const mid = hitRouteMidpoint(selectedRouteId, e.clientX, e.clientY);
        if (mid) {
          const r = F.routes.find((x) => x.id === mid.routeId);
          if (r) { draggingRouteVertex = { routeId: r.id, index: insertRouteVertex(r, mid.seg) }; routeVertexMoved = true; redraw(); }
        }
      }
      if (mode === 'select') {
        // Úchop uzlu vybraného šlicu má přednost — kolečka jsou vidět jen u vybrané
        // trasy, takže tažení uzlu nekoliduje s výběrem prvku/výdřevy/plátna.
        const rv = hitRouteVertex(selectedRouteId, e.clientX, e.clientY);
        if (rv) {
          const now = Date.now();
          const dbl = lastVtap && lastVtap.routeId === rv.routeId && lastVtap.index === rv.index && now - lastVtap.t < 350;
          lastVtap = { ...rv, t: now };
          if (dbl && removeRouteVertex(rv.routeId, rv.index)) {
            // dvojklik na uzel → smazat; žádné tažení, ať pointerup nepřebíjí výběr
            lastVtap = null; tapStart = null;
            saveProject(); redraw(); showSelectPanel();
          } else {
            draggingRouteVertex = rv;
          }
        } else {
          // Priorita výběru: prvek → trasa → výdřeva. Prvek/výdřevu lze rovnou táhnout,
          // trasa se vybere ťuknutím (v pointerdown ji tady jen „necháme být").
          const p = screenToWall(e.clientX, e.clientY);
          const tol = 30 * mmPerPx();
          const f = hitFixture(p, tol);
          if (f) {
            draggingFixtureId = f.id; selectedFixtureId = f.id;
            // Úchop za levý horní roh (stejně jako z palety): prvek visí dolů-vpravo od
            // kurzoru v reálné velikosti, cíl je vidět a prvek zůstane, kam ho dovezeš.
            const sz = fixtureSize(f);
            const pxPerMm = 1 / mmPerPx();
            fixtureGrab = { dx: 6 + sz.w / 2 * pxPerMm, dy: 6 + sz.h / 2 * pxPerMm };
          } else if (!hitRoute(p, tol)) {
            const a = hitArea(p, tol);
            if (a) { draggingAreaId = a.id; selectedAreaId = a.id; areaGrab = { du: p.uMm - a.uMm, dv: p.vMm - a.vMm }; }
          }
        }
      }
      // V režimu Výdřeva: pointerdown na desku (mimo rozkreslení) zahájí její tažení,
      // jinak zapíše počáteční roh nové desky → tažením se kreslí rovnou (bez puštění myši).
      areaDown = null;
      if (mode === 'area' && !areaFirst) {
        const p = screenToWall(e.clientX, e.clientY);
        const a = hitArea(p, 30 * mmPerPx());
        if (a) { draggingAreaId = a.id; selectedAreaId = a.id; areaGrab = { du: p.uMm - a.uMm, dv: p.vMm - a.vMm }; }
        else areaDown = { x: clampU(p.uMm), y: clampV(p.vMm) };
      }
      // V režimu Fotky: rotační úchop → otočení; roh → roztažení; plocha → posun.
      // Dlaždice s volnými rohy (quad): roh → posun rohu; uvnitř → posun celé.
      draggingBgId = null;
      bgResizeCorner = null;
      bgRotating = false;
      bgQuadCorner = null;
      bgMeshVertex = null;
      bgMoved = false;
      if (mode === 'photo') {
        const bg = activeBg();
        if (bg?.mesh && bg.mesh.dst.length >= 3) {
          const d = screenToDisplay(e.clientX, e.clientY);
          const p = screenToWall(e.clientX, e.clientY);
          const tol = Math.max(30 * mmPerPx(), 150);
          let best = -1, bestD = tol;
          bg.mesh.dst.forEach((q, i) => { const c = toDisplay(W, side, q.x, q.y); const dd = Math.hypot(c.x - d.x, c.y - d.y); if (dd < bestD) { bestD = dd; best = i; } });
          if (best >= 0) { draggingBgId = bg.id; bgMeshVertex = best; }
          else if (pointInPoly(d, bg.mesh.dst.map((q) => toDisplay(W, side, q.x, q.y)))) { draggingBgId = bg.id; bgGrab = { du: p.uMm, dv: p.vMm }; }
        } else if (bg?.quad?.length === 4) {
          const d = screenToDisplay(e.clientX, e.clientY);
          const p = screenToWall(e.clientX, e.clientY);
          const tol = Math.max(30 * mmPerPx(), 140);
          let best = -1, bestD = tol;
          bg.quad.forEach((q, i) => { const c = toDisplay(W, side, q.x, q.y); const dd = Math.hypot(c.x - d.x, c.y - d.y); if (dd < bestD) { bestD = dd; best = i; } });
          if (best >= 0) { draggingBgId = bg.id; bgQuadCorner = best; }
          else if (pointInPoly(d, bg.quad.map((q) => toDisplay(W, side, q.x, q.y)))) { draggingBgId = bg.id; bgGrab = { du: p.uMm, dv: p.vMm }; }
        } else if (bg) {
          const d = screenToDisplay(e.clientX, e.clientY);
          const p = screenToWall(e.clientX, e.clientY);
          const rg = bgRegion(bg);
          const info = bgDisp(bg);
          const tol = 30 * mmPerPx();
          const rp = bgRotPos(info);
          if (Math.hypot(rp.x - d.x, rp.y - d.y) < Math.max(tol, 140)) {
            draggingBgId = bg.id; bgRotating = true;
          } else {
            const corner = bgCornerAt(info, d, Math.max(tol, 120));
            if (corner) { draggingBgId = bg.id; bgResizeCorner = corner; }
            else if (bgHit(info, d, tol)) { draggingBgId = bg.id; bgGrab = { du: p.uMm - rg.uMm, dv: p.vMm - rg.vMm }; }
          }
        }
      }
    }
    // Dotyk bez myši nemá hover → ukaž zaměřovací náhled hned při dotyku (kóta / výdřeva).
    if (pointers.size === 1 && (mode === 'dim' || mode === 'area')) {
      if (mode === 'dim') showDimHover(e.clientX, e.clientY); else showAreaPreview(e.clientX, e.clientY);
    }
    if (pointers.size === 2) {
      draggingFixtureId = null;
      areaDown = null; // druhý prst = zoom, ne kreslení → zahoď rozkreslený roh
      const [a, b] = [...pointers.values()];
      pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), vb: { ...vb } };
      tapStart = null;
      clearDimHover(); // dva prsty = zoom, ne kótování → schovej náhled
      clearAreaHover();
    }
  });

  svg.addEventListener('pointermove', (e) => {
    if (pointers.size === 0) { // pouhé najetí kurzorem (žádné tlačítko)
      if (mode === 'dim') showDimHover(e.clientX, e.clientY); else clearDimHover();
      if (mode === 'area') showAreaPreview(e.clientX, e.clientY); else clearAreaHover();
      return;
    }
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    if (pointers.size === 1 && !pinchStart) {
      // Režim zaměřování (kóta / výdřeva): jeden prst NEposouvá plátno, ale MÍŘÍ —
      // živý náhled cíle + „gumička" odkud→kam. Posun/zoom se dělá dvěma prsty.
      if ((mode === 'dim' || mode === 'area')
          && !draggingBgId && !draggingFixtureId && !draggingAreaId && !draggingRouteVertex) {
        if (mode === 'dim') showDimHover(e.clientX, e.clientY); else showAreaPreview(e.clientX, e.clientY);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        return;
      }
      // Pojistka: při tažení si drž capture (redraw ho mohl shodit), ať pohyb pokračuje.
      if ((draggingBgId || draggingFixtureId || draggingAreaId || draggingRouteVertex) && !svg.hasPointerCapture(e.pointerId)) {
        try { svg.setPointerCapture(e.pointerId); } catch { /* ok */ }
      }
      if (draggingRouteVertex) {
        // tažení jednoho uzlu šlicu — bod jde za kurzorem (přichytí se na střed prvku),
        // ořízne se do viditelného líce a přepočet kót/délek řeší redraw automaticky.
        const r = F.routes.find((x) => x.id === draggingRouteVertex!.routeId);
        if (r) {
          const idx = draggingRouteVertex.index;
          r.points[idx] = vertexTarget(r, idx, screenToWall(e.clientX, e.clientY));
          // ručně posunutý bod zneplatní naměřené délky sousedních segmentů (číslo by lhalo)
          if (idx > 0) r.segLengthsMm[idx - 1] = null;
          if (idx < r.segLengthsMm.length) r.segLengthsMm[idx] = null;
          routeVertexMoved = true;
          redraw();
        }
      } else if (draggingFixtureId) {
        // tažení prvku — posune jeho střed, plátno se nehýbe
        const f = F.fixtures.find((x) => x.id === draggingFixtureId);
        // Reposicuj až po skutečném tažení (>6 px) — pouhé ťuknutí (výběr) prvkem nehne.
        const far = !tapStart || Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) >= 6;
        if (f && (fixtureMoved || far)) {
          // Bod = střed prvku (visel dolů-vpravo od kurzoru), aby zůstal tam, kam dovezen.
          const p = screenToWall(e.clientX + fixtureGrab.dx, e.clientY + fixtureGrab.dy);
          f.uMm = Math.round(Math.min(Math.max(p.uMm, U0), U1));
          f.vMm = Math.round(Math.min(Math.max(p.vMm, 0), W.heightMm));
          fixtureMoved = true;
          redraw();
        }
      } else if (draggingAreaId) {
        // tažení výdřevy — posune střed, deska zůstane celá ve stěně
        const a = F.areas.find((x) => x.id === draggingAreaId);
        if (a) {
          const p = screenToWall(e.clientX, e.clientY);
          const halfW = Math.min(a.widthMm / 2, FL / 2);
          const halfH = Math.min(a.heightMm / 2, W.heightMm / 2);
          const newU = Math.round(Math.min(Math.max(p.uMm - areaGrab.du, U0 + halfW), U1 - halfW));
          const newV = Math.round(Math.min(Math.max(p.vMm - areaGrab.dv, halfH), W.heightMm - halfH));
          if (a.beamGroupId) {
            // Nosník bloku se táhne jako CELEK — posuň všechny nosníky o stejný vektor.
            const du = newU - a.uMm, dv = newV - a.vMm;
            for (const b of F.areas) if (b.beamGroupId === a.beamGroupId) {
              b.uMm = Math.round(b.uMm + du); b.vMm = Math.round(b.vMm + dv);
            }
          } else {
            a.uMm = newU; a.vMm = newV;
          }
          areaMoved = true;
          redraw();
        }
      } else if (draggingBgId) {
        // posun / roztažení / otočení dlaždice (fotky)
        const bg = F.backgrounds.find((x) => x.id === draggingBgId);
        if (bg?.mesh && bg.mesh.dst.length >= 3) {
          // síťová dlaždice: tažený vrchol jde za kurzorem; kotva se přichytí na strukturu
          const p = screenToWall(e.clientX, e.clientY);
          if (bgMeshVertex != null) {
            let u = p.uMm, v = p.vMm;
            if (bg.mesh.anchor[bgMeshVertex]) {
              const snapMm = Math.max(30 * mmPerPx(), 200);
              let bd = snapMm, bs: { uMm: number; vMm: number } | null = null;
              for (const s of structurePoints()) { const dd = Math.hypot(s.uMm - u, s.vMm - v); if (dd < bd) { bd = dd; bs = s; } }
              if (bs) { u = bs.uMm; v = bs.vMm; }
            }
            bg.mesh.dst[bgMeshVertex] = { x: Math.round(u), y: Math.round(v) };
          } else {
            const dx = p.uMm - bgGrab.du, dy = p.vMm - bgGrab.dv;
            bg.mesh.dst = bg.mesh.dst.map((q) => ({ x: Math.round(q.x + dx), y: Math.round(q.y + dy) }));
            bgGrab = { du: p.uMm, dv: p.vMm };
          }
          bgMoved = true;
          redraw();
        } else if (bg?.quad?.length === 4) {
          // dlaždice s volnými rohy: tažený roh jde za kurzorem, jinak posun celé
          const p = screenToWall(e.clientX, e.clientY);
          if (bgQuadCorner != null) {
            bg.quad[bgQuadCorner] = { x: Math.round(p.uMm), y: Math.round(p.vMm) };
          } else {
            const dx = p.uMm - bgGrab.du, dy = p.vMm - bgGrab.dv;
            bg.quad = bg.quad.map((q) => ({ x: Math.round(q.x + dx), y: Math.round(q.y + dy) }));
            bgGrab = { du: p.uMm, dv: p.vMm };
          }
          bgMoved = true;
          redraw();
        } else if (bg) {
          const rg = bgRegion(bg);
          const info = bgDisp(bg);
          if (bgRotating) {
            // úhel od středu ke kurzoru; základ = úchop míří nahoru (−90°)
            const d = screenToDisplay(e.clientX, e.clientY);
            let deg = Math.atan2(d.y - info.cy, d.x - info.cx) * 180 / Math.PI + 90;
            deg = ((deg % 360) + 360) % 360;
            for (const snap of [0, 90, 180, 270, 360]) if (Math.abs(deg - snap) <= 3) deg = snap % 360; // lehké přichycení k pravým úhlům
            bg.region = { ...rg, rotDeg: Math.round(deg) };
          } else if (bgResizeCorner) {
            // roztažení v OTOČENÉM rámci: protilehlý roh drží, tažený jde za kurzorem
            const d = screenToDisplay(e.clientX, e.clientY);
            const lc = rot2(d.x - info.cx, d.y - info.cy, -info.rot); // kurzor v lokálním rámci
            const ax = -bgResizeCorner.du * info.w / 2, ay = -bgResizeCorner.dv * info.h / 2; // kotva (protilehlý roh)
            const nw = Math.max(MIN_AREA_MM, Math.abs(lc.x - ax)), nh = Math.max(MIN_AREA_MM, Math.abs(lc.y - ay));
            const lcx = (lc.x + ax) / 2, lcy = (lc.y + ay) / 2; // nový střed v lokálním rámci
            const wc = rot2(lcx, lcy, info.rot); // zpět do zobrazovacích
            const canon = fromDisplay(W, side, info.cx + wc.x, info.cy + wc.y);
            bg.region = { uMm: Math.round(canon.uMm), vMm: Math.round(canon.vMm), widthMm: Math.round(nw), heightMm: Math.round(nh), rotDeg: info.rot || undefined };
          } else {
            const p = screenToWall(e.clientX, e.clientY);
            bg.region = { ...rg, uMm: Math.round(p.uMm - bgGrab.du), vMm: Math.round(p.vMm - bgGrab.dv) };
          }
          bgMoved = true;
          redraw();
        }
      } else {
        const scale = mmPerPx();
        vb.x -= (e.clientX - prev.x) * scale;
        vb.y -= (e.clientY - prev.y) * scale;
        setViewBox();
      }
    } else if (pointers.size === 2 && pinchStart) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      let k = pinchStart.dist / dist;
      // clamp přiblížení do rozsahu lupy
      k = Math.min(Math.max(k, fitVb.w / (ZMAX * pinchStart.vb.w)), fitVb.w / (ZMIN * pinchStart.vb.w));
      const cx = pinchStart.vb.x + pinchStart.vb.w / 2;
      const cy = pinchStart.vb.y + pinchStart.vb.h / 2;
      vb = {
        w: pinchStart.vb.w * k,
        h: pinchStart.vb.h * k,
        x: cx - (pinchStart.vb.w * k) / 2,
        y: cy - (pinchStart.vb.h * k) / 2,
      };
      setViewBox();
      syncZoom();
      return;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });

  svg.addEventListener('pointerleave', () => { clearDimHover(); clearAreaHover(); });

  /**
   * Úklid zrušeného/ztraceného ukazatele. Bez toho by při pointercancel (gesto,
   * ztráta capture, přerušený dotyk) zůstal ID v mapě „navždy" → pointers.size
   * už nikdy neklesne na 0, takže přestane hover-podbarvování kóty i vyhodnocení
   * ťuknutí (další pointerdown spustí pinch a zahodí tapStart).
   */
  function dropPointer(pointerId: number): void {
    pointers.delete(pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (pointers.size === 0) tapStart = null;
  }
  /** Zruší všechna probíhající tažení (prvek/výdřeva/dlaždice) — proti „zaseknutému" stavu. */
  function resetDrags(): void {
    draggingFixtureId = null;
    draggingAreaId = null;
    areaDown = null;
    draggingBgId = null;
    draggingRouteVertex = null;
    bgResizeCorner = null;
    bgRotating = false;
    bgQuadCorner = null;
    bgMeshVertex = null;
  }
  svg.addEventListener('pointercancel', (e) => { resetDrags(); dropPointer(e.pointerId); });
  // redraw() při tažení přepisuje innerHTML SVG a prohlížeč umí shodit pointer‑capture
  // (i když je na <svg>). Při AKTIVNÍM tažení ho hned vrátíme a ukazatel NEzahazujeme,
  // ať tažení plynule pokračuje (jinak drag umřel po prvním pohybu a stav zůstal viset).
  svg.addEventListener('lostpointercapture', (e) => {
    if (draggingBgId || draggingFixtureId || draggingAreaId || draggingRouteVertex) {
      try { svg.setPointerCapture(e.pointerId); } catch { /* ok */ }
      return;
    }
    dropPointer(e.pointerId);
  });

  svg.addEventListener('pointerup', (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    // Konec tažení prvku (i pouhé ťuknutí na prvek): vyber ho a ukaž panel.
    if (draggingFixtureId) {
      const f = F.fixtures.find((x) => x.id === draggingFixtureId);
      draggingFixtureId = null;
      tapStart = null;
      if (fixtureMoved) saveProject();
      selectedRouteId = null;
      selectedAreaId = null;
      redraw();
      if (f) showFixturePanel(f);
      return;
    }
    // Konec tažení výdřevy (i pouhé ťuknutí na desku): vyber ji a ukaž panel.
    if (draggingAreaId) {
      const a = F.areas.find((x) => x.id === draggingAreaId);
      draggingAreaId = null;
      tapStart = null;
      if (areaMoved) saveProject();
      selectedFixtureId = null;
      selectedRouteId = null;
      redraw();
      if (a) showAreaPanel();
      return;
    }
    // Konec posunu / roztažení oblasti dlaždice (fotky).
    if (draggingBgId) {
      draggingBgId = null;
      bgResizeCorner = null;
      bgRotating = false;
      bgQuadCorner = null;
      bgMeshVertex = null;
      tapStart = null;
      if (bgMoved) { saveProject(); invalidateCostField(); }
      redraw();
      void showPhotoPanel();
      return;
    }
    // Konec tažení uzlu šlicu — trasa zůstane vybraná, změnu zapíšeme jednou (čistý undo).
    if (draggingRouteVertex) {
      const r = F.routes.find((x) => x.id === draggingRouteVertex!.routeId);
      draggingRouteVertex = null;
      tapStart = null;
      if (routeVertexMoved) saveProject();
      redraw();
      // V Trase (vložení uzlu) drž panel kreslení, jinak ukaž panel vybrané trasy.
      if (r) { selectedRouteId = r.id; if (mode === 'draw') showDrawSetupPanel(); else showSelectPanel(); }
      return;
    }
    if (!tapStart) return;
    const moved = Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y);
    // V režimech zaměřování (kóta / výdřeva) je jeden prst „míření", takže zvednutí
    // umístí bod i po delším tažení. Jinak vyžadujeme krátké ťuknutí (proti omylu při posunu).
    const aimMode = mode === 'dim' || mode === 'area';
    const isTap = aimMode || (moved < 8 && Date.now() - tapStart.t < 600);
    tapStart = null;
    if (!isTap) return;

    const p = screenToWall(e.clientX, e.clientY);
    const tol = 30 * mmPerPx(); // ~30 px tolerance

    if (mode === 'draw' && draft) {
      const prev = draft.points[draft.points.length - 1] ?? null;
      const fx = hitFixture(p, tol); // šlic se chytne přesně na střed prvku
      if (fx) {
        draft.points.push({ x: fx.uMm, y: fx.vMm });
        if (draft.points.length >= 2) draft.segLengthsMm.push(null);
      } else if (snap && costField && prev) {
        for (const q of snapDraftPath(prev, p)) { draft.points.push(q); draft.segLengthsMm.push(null); }
      } else {
        draft.points.push(snapPoint(p, prev));
        if (draft.points.length >= 2) draft.segLengthsMm.push(null);
      }
      ensureDraftLive(); // od prvního bodu je šlic v F.routes → jde na něj hned kótovat
      pendingDimId = null; // rozepsaná kóta patřila předchozí úsečce
      // Každé ťuknutí = jeden krok historie, aby undo ubralo poslední bod, ne celý
      // šlic. (Trasování po šlicu 🧲 přidá naráz víc bodů — to je pořád jedno gesto,
      // takže i jeden krok.)
      saveProject();
      redraw();
      showDrawPanel();
    } else if (mode === 'place') {
      placeFixtureAt(placeKind, p);
      showPlacePanel();
    } else if (mode === 'area') {
      const up = { x: clampU(p.uMm), y: clampV(p.vMm) };
      const commitArea = (x0: number, y0: number, x1: number, y1: number): void => {
        const b = areaFromCorners(x0, y0, x1, y1);
        if (b.widthMm >= MIN_AREA_MM && b.heightMm >= MIN_AREA_MM) {
          const a: WallArea = { id: newId(), categoryId: areaCategoryId, note: '', ...b };
          F.areas.push(a);
          selectedAreaId = a.id;
          ensureCategoryVisible(areaCategoryId); // ať se deska neschová ve skryté vrstvě
          saveProject();
        }
      };
      clearAreaHover();
      if (areaDown && moved >= 8) {
        // Press–drag–release: nakresli desku v jednom gestu (roh = bod pod stiskem).
        commitArea(areaDown.x, areaDown.y, up.x, up.y);
        areaFirst = null;
      } else if (areaFirst) {
        // 2. ťuknutí (nebo tažení, když je 1. roh už pevný) → dokonči desku.
        commitArea(areaFirst.x, areaFirst.y, up.x, up.y);
        areaFirst = null;
      } else {
        // Krátké ťuknutí bez tažení → záloha: zapiš 1. roh a čekej na druhé ťuknutí.
        areaFirst = up;
      }
      areaDown = null;
      redraw();
      showAreaPanel();
    } else if (mode === 'select') {
      const f = hitFixture(p, tol);
      if (f) {
        selectedRouteId = null;
        selectedAreaId = null;
        selectedDimId = null;
        redraw();
        showFixturePanel(f);
        return;
      }
      selectedFixtureId = null;
      selectedAreaId = null;
      const r = hitRoute(p, tol);
      if (r) {
        selectedRouteId = r.id;
        selectedDimId = null;
        redraw();
        showSelectPanel();
        return;
      }
      selectedRouteId = null;
      // Kóta (klik na její čáru/popisek) — jednotně vybíratelná i nástrojem Vybrat.
      // Až jako poslední (pás kóty leží v odsazení mimo geometrii, konflikty jsou vzácné).
      const dim = hitDim(p, tol * 2);
      if (dim) {
        selectedDimId = dim.id;
        redraw();
        showDimPanel(dim.id);
        return;
      }
      selectedDimId = null;
      redraw();
      showSelectPanel();
    } else if (mode === 'dim') {
      if (!dimFirst) {
        const anchor = dimAnchorAt(p, tol * 2);
        const onTarget = anchor.kind === 'routePoint' || anchor.kind === 'routeSeg' || anchor.kind === 'fixture' || anchor.kind === 'area';
        // Klik na bod trasy / prvek vždy začíná NOVOU kótu (i když už z něj jedna
        // vede), ať jde stejný bod okótovat k víc hranám (podlaha i strop). Editace
        // stávající kóty se dělá klikem na její odsazenou čáru, ne na bod/prvek.
        if (!onTarget) {
          const existing = hitDim(p, tol * 2);
          if (existing) {
            selectedDimId = existing.id;
            redraw();
            showDimPanel(existing.id);
            return;
          }
        }
        dimFirst = anchor;
        showDimPanel();
        showDimHover(e.clientX, e.clientY); // ať počátek (žlutě) svítí i po zvednutí prstu
      } else {
        const dim: Dimension = { id: newId(), from: dimFirst, to: dimAnchorAt(p, tol * 2), valueMm: null };
        F.dims.push(dim);
        dimFirst = null;
        selectedDimId = dim.id;
        clearDimHover();
        saveProject();
        redraw();
        showDimPanel(dim.id);
      }
    }
  });

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const k = e.deltaY > 0 ? 1 / 1.15 : 1.15; // kolečko nahoru = přiblížit
    zoomTo(zoomNow() * k, e.clientX, e.clientY);
  }, { passive: false });

  await loadBackground();
  // Obnovit přiblížení a střed z doby před undo/redo (až teď — SVG má rozměry, takže
  // „vejít se" box jde srovnat na poměr stran plochy).
  const rv = takeResumeView(W.id, side);
  if (rv) {
    fitVb = computeFitVb();
    const w = fitVb.w / rv.zoom, h = fitVb.h / rv.zoom;
    vb = { w, h, x: rv.cx - w / 2, y: rv.cy - h / 2 };
    setViewBox();
  }
  // Po undo/redo se vrátit rovnou do kreslení rozdělaného šlicu (viz resumeDraw).
  // Když krok zpět smazal i jeho první bod, trasa v modelu není → začne se nová.
  const resumeId = takeResumeDraw(W.id, side);
  const resumed = resumeId ? F.routes.find((r) => r.id === resumeId) : undefined;
  if (resumed) {
    setMode('draw');
    draft = resumed;
    selectedRouteId = resumed.id;
    redraw();
    showDrawPanel();
  } else if (resumeId) {
    setMode('draw');
  } else {
    setMode('select');
  }
  syncZoom();
}
