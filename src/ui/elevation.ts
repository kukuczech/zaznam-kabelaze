// Elevation editor stěny: kreslení tras, kóty, fotky, DISTO plnění délek.
import { project, saveProject, savePhoto, getPhoto, deletePhoto, undo, redo, canUndo, canRedo, onHistoryChange } from '../db';
import { axisLen, distToSegment, type WallSide } from '../model/geometry';
import { newId, type Anchor, type Dimension, type Route, type Wall, type XY } from '../model/types';
import { connectDisto, onDistoStatus, setDistoTarget } from '../disto';
import { dimGeomLengthMm, fromDisplay, toDisplay, wallSvgContent, wallViewBox, type ViewBox } from './wall-svg';
import { registerCleanup, route } from '../main';
import { mapPhotoToWall } from './photo-map';
import { buildCostField, snapPathPx, simplifyPath, type CostField } from './chase-trace';

type Mode = 'select' | 'draw' | 'dim' | 'photo';

export async function renderElevation(root: HTMLElement, wallId: string, side: WallSide): Promise<void> {
  let storeyId = '';
  let wall: Wall | undefined;
  for (const s of project.storeys) {
    const w = s.walls.find((x) => x.id === wallId);
    if (w) { wall = w; storeyId = s.id; break; }
  }
  if (!wall) { location.hash = '#/'; return; }
  const W = wall;
  const L = axisLen(W);

  root.innerHTML = `
    <header class="bar">
      <button id="back">←</button>
      <h1>${W.name} <span class="muted" style="font-size:13px">(strana ${side})</span></h1>
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
      <button data-mode="dim">📏 Kóta</button>
      <button data-mode="photo">🖼️ Fotky</button>
      <button id="ortho" class="active">⊾ Pravé úhly</button>
      <button id="snap">🧲 Šlic</button>
    </div>`;

  root.querySelector('#back')!.addEventListener('click', () => (location.hash = `#/storey/${storeyId}`));

  // --- undo / redo ---
  const undoBtn = root.querySelector('#undo') as HTMLButtonElement;
  const redoBtn = root.querySelector('#redo') as HTMLButtonElement;
  const syncHistoryBtns = () => { undoBtn.disabled = !canUndo(); redoBtn.disabled = !canRedo(); };
  syncHistoryBtns();
  registerCleanup(onHistoryChange(syncHistoryBtns));
  undoBtn.addEventListener('click', async () => { if (await undo()) await route(); });
  redoBtn.addEventListener('click', async () => { if (await redo()) await route(); });

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
  let fitVb: ViewBox = wallViewBox(W); // referenční „vejít se" = lupa 100 %; srovná se na poměr plochy v refit()
  let vb: ViewBox = { ...fitVb };
  const ZMIN = 0.5, ZMAX = 12; // rozsah lupy (0.5× … 12×)
  let categoryId = project.categories[0]?.id ?? '';
  let brushWidthMm = 60;
  let snap = false; // magnetické přichytávání trasy na tmavý šlic v podkladu
  let costField: CostField | null = null;
  let costFieldPhotoId: string | null = null;

  const catById = (id: string) => project.categories.find((c) => c.id === id);

  // --- magnetické trasování šlicu ---
  async function ensureCostField(): Promise<void> {
    if (!W.background) { costField = null; costFieldPhotoId = null; return; }
    if (costField && costFieldPhotoId === W.background.photoId) return;
    const blob = await getPhoto(W.background.photoId);
    costField = blob ? await buildCostField(blob) : null;
    costFieldPhotoId = W.background.photoId;
  }
  function invalidateCostField(): void { costField = null; costFieldPhotoId = null; }

  /** Bod stěny (u, v mm) → pixel rastru podkladu (přes zobrazovací souřadnice). */
  function wallToPx(uMm: number, vMm: number): { x: number; y: number } {
    const d = toDisplay(W, side, uMm, vMm);
    return { x: (d.x / L) * costField!.w, y: (d.y / W.heightMm) * costField!.h };
  }
  /** Pixel rastru → bod stěny (u, v mm), oříznutý do rozměrů stěny. */
  function pxToWall(x: number, y: number): XY {
    const w = fromDisplay(W, side, (x / costField!.w) * L, (y / costField!.h) * W.heightMm);
    return { x: Math.round(Math.min(Math.max(w.uMm, 0), L)), y: Math.round(Math.min(Math.max(w.vMm, 0), W.heightMm)) };
  }
  /**
   * Magneticky přichycená lomená čára z prev do bodu p (bez počátku prev).
   * Zjednodušení běží v reálných mm (tolerance SNAP_TOL_MM), aby vzniklo jen
   * pár kótovatelných bodů, ne stovky pixelových kroků. Strop MAX_SNAP_PTS.
   */
  function snapDraftPath(prev: XY, p: { uMm: number; vMm: number }): XY[] {
    const SNAP_TOL_MM = 50, MAX_SNAP_PTS = 12;
    const a = wallToPx(prev.x, prev.y);
    const b = wallToPx(Math.min(Math.max(p.uMm, 0), L), Math.min(Math.max(p.vMm, 0), W.heightMm));
    const mm = snapPathPx(costField!, a, b).map((pt) => pxToWall(pt.x, pt.y));
    mm[0] = { x: prev.x, y: prev.y }; // přesně navázat na předchozí bod
    let tol = SNAP_TOL_MM;
    let simp = simplifyPath(mm, tol);
    while (simp.length - 1 > MAX_SNAP_PTS) { tol *= 1.6; simp = simplifyPath(mm, tol); }
    const out = simp.slice(1); // bez počátku (== prev)
    if (out.length === 0) out.push({ x: Math.round(Math.min(Math.max(p.uMm, 0), L)), y: Math.round(Math.min(Math.max(p.vMm, 0), W.heightMm)) });
    return out;
  }

  // --- podklad (narovnaná fotka stěny) ---
  let bgHref: string | null = null;
  async function loadBackground(): Promise<void> {
    if (bgHref) { URL.revokeObjectURL(bgHref); bgHref = null; }
    if (W.background) {
      const blob = await getPhoto(W.background.photoId);
      if (blob) bgHref = URL.createObjectURL(blob);
    }
  }
  registerCleanup(() => { if (bgHref) URL.revokeObjectURL(bgHref); });

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
    const base = wallViewBox(W); // stěna + okraj, vycentrovaná
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
      draftPoints: draft?.points,
      draftColor: catById(draft?.categoryId ?? categoryId)?.color,
      draftWidthMm: draft?.widthMm ?? brushWidthMm,
      backgroundHref: bgHref ?? undefined,
      backgroundOpacity: W.background?.opacity,
    });
    setViewBox();
  }

  // --- geometrie ---
  const mmPerPx = () => vb.w / svg.getBoundingClientRect().width;

  function screenToWall(clientX: number, clientY: number): { uMm: number; vMm: number } {
    const r = svg.getBoundingClientRect();
    const x = vb.x + ((clientX - r.left) / r.width) * vb.w;
    const y = vb.y + ((clientY - r.top) / r.height) * vb.h;
    return fromDisplay(W, side, x, y);
  }

  function snapPoint(p: { uMm: number; vMm: number }, prev: XY | null): XY {
    let u = Math.min(Math.max(p.uMm, 0), L);
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

  /** První kóta trasa↔hrana posune celou trasu tak, aby hodnota seděla. */
  function applyDimValue(dim: Dimension, mm: number): void {
    dim.valueMm = Math.round(mm);
    const rp = dim.from.kind === 'routePoint' ? dim.from : dim.to.kind === 'routePoint' ? dim.to : null;
    const ed = dim.from.kind === 'edge' ? dim.from : dim.to.kind === 'edge' ? dim.to : null;
    if (rp && ed) {
      const route = W.routes.find((r) => r.id === rp.routeId);
      const firstValued = W.dims.find(
        (d) => d.valueMm != null &&
          ((d.from.kind === 'routePoint' && d.from.routeId === rp.routeId) ||
           (d.to.kind === 'routePoint' && d.to.routeId === rp.routeId)),
      );
      if (route && firstValued === dim) {
        const p = route.points[rp.index];
        let du = 0, dv = 0;
        if (ed.edge === 'bottom') dv = mm - p.y;
        else if (ed.edge === 'top') dv = (W.heightMm - mm) - p.y;
        else if (ed.edge === 'left') du = mm - p.x;
        else du = (L - mm) - p.x;
        for (let k = 0; k < route.points.length; k++) {
          route.points[k] = { x: route.points[k].x + du, y: route.points[k].y + dv };
        }
      }
    }
    saveProject();
    redraw();
  }

  function hitRoute(p: { uMm: number; vMm: number }, tolMm: number): Route | null {
    let best: Route | null = null;
    let bestD = tolMm;
    for (const r of W.routes) {
      for (let i = 0; i < r.points.length - 1; i++) {
        const d = distToSegment(p, r.points[i], r.points[i + 1]) - r.widthMm / 2;
        if (d < bestD) { bestD = d; best = r; }
      }
    }
    return best;
  }

  function hitRoutePoint(p: { uMm: number; vMm: number }, tolMm: number): { routeId: string; index: number } | null {
    let best: { routeId: string; index: number } | null = null;
    let bestD = tolMm;
    for (const r of W.routes) {
      r.points.forEach((pt, i) => {
        const d = Math.hypot(pt.x - p.uMm, pt.y - p.vMm);
        if (d < bestD) { bestD = d; best = { routeId: r.id, index: i }; }
      });
    }
    return best;
  }

  function hitEdge(p: { uMm: number; vMm: number }, tolMm: number): Anchor | null {
    // kanonické hrany; left/right v zobrazení převrátit podle strany
    const cands: ['top' | 'bottom' | 'left' | 'right', number][] = [
      ['top', Math.abs(W.heightMm - p.vMm)],
      ['bottom', Math.abs(p.vMm)],
      ['left', Math.abs(side === 'A' ? p.uMm : L - p.uMm)],
      ['right', Math.abs(side === 'A' ? L - p.uMm : p.uMm)],
    ];
    cands.sort((a, b) => a[1] - b[1]);
    if (cands[0][1] > tolMm) return null;
    let edge = cands[0][0];
    if (side === 'B' && (edge === 'left' || edge === 'right')) edge = edge === 'left' ? 'right' : 'left';
    return { kind: 'edge', edge };
  }

  /** Kotva, kterou by ťuknutí v bodě p vybralo — podle fáze kótování (1. vs 2. bod). */
  function dimAnchorAt(p: { uMm: number; vMm: number }, tolMm: number): Anchor {
    const free: Anchor = { kind: 'point', uMm: Math.round(p.uMm), vMm: Math.round(p.vMm) };
    if (!dimFirst) {
      const rp = hitRoutePoint(p, tolMm);
      return rp ? { kind: 'routePoint', ...rp } : free;
    }
    const edge = hitEdge(p, tolMm);
    if (edge) return edge;
    const rp = hitRoutePoint(p, tolMm);
    return rp ? { kind: 'routePoint', ...rp } : free;
  }

  /**
   * SVG zvýraznění kotvy jen pro skutečný cíl přichycení (hrana = pruh,
   * bod trasy = celá trasa + kroužek). Volný bod záměrně nekreslíme — jinak by
   * jeho značka jezdila za kurzorem jako druhá „pomalá myš".
   */
  function anchorHighlightSvg(a: Anchor, color: string): string {
    if (a.kind === 'edge') {
      const e = a.edge;
      const p1 = e === 'top' ? toDisplay(W, side, 0, W.heightMm)
        : e === 'bottom' ? toDisplay(W, side, 0, 0)
        : e === 'left' ? toDisplay(W, side, 0, 0)
        : toDisplay(W, side, L, 0);
      const p2 = e === 'top' ? toDisplay(W, side, L, W.heightMm)
        : e === 'bottom' ? toDisplay(W, side, L, 0)
        : e === 'left' ? toDisplay(W, side, 0, W.heightMm)
        : toDisplay(W, side, L, W.heightMm);
      return `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="${color}" stroke-width="70" stroke-linecap="round" opacity="0.55"/>`;
    }
    if (a.kind === 'routePoint') {
      const r = W.routes.find((x) => x.id === a.routeId);
      if (!r || r.points.length < 2) return '';
      const pts = r.points.map((pt) => toDisplay(W, side, pt.x, pt.y));
      const d = pts.map((pt, i) => `${i ? 'L' : 'M'} ${pt.x} ${pt.y}`).join(' ');
      const c = pts[a.index];
      return `<path d="${d}" stroke="${color}" stroke-width="${Math.max(r.widthMm, 30) + 60}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.3"/>`
        + `<circle cx="${c.x}" cy="${c.y}" r="90" fill="none" stroke="${color}" stroke-width="26"/>`;
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
    if (dimFirst) markup += anchorHighlightSvg(dimFirst, '#fbbf24'); // pevný počáteční bod
    markup += anchorHighlightSvg(target, '#22d3ee');                 // živý cíl pod kurzorem
    g.innerHTML = markup;
    svg.appendChild(g);
    dimHoverLayer = g;
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
    return input;
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
    const undo = document.createElement('button');
    undo.textContent = '↩ Zpět bod';
    undo.onclick = () => { draft!.points.pop(); draft!.segLengthsMm.pop(); redraw(); showDrawPanel(); };
    const done = document.createElement('button');
    done.className = 'primary';
    done.textContent = '✓ Hotovo';
    done.onclick = () => {
      if (draft!.points.length >= 2) {
        W.routes.push(draft!);
        selectedRouteId = draft!.id;
        saveProject();
      }
      draft = null;
      setMode('select');
    };
    const cancel = document.createElement('button');
    cancel.className = 'danger';
    cancel.textContent = '✕ Zrušit';
    cancel.onclick = () => { draft = null; setMode('select'); };
    row.append(undo, done, cancel);
    panel.appendChild(row);
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
    catSel.onchange = () => { categoryId = catSel.value; if (draft) draft.categoryId = categoryId; redraw(); };
    const widthIn = document.createElement('input');
    widthIn.type = 'number';
    widthIn.value = String(brushWidthMm);
    widthIn.style.width = '90px';
    widthIn.title = 'Šířka šlicu (mm)';
    widthIn.onchange = () => { brushWidthMm = Number(widthIn.value) || 60; if (draft) draft.widthMm = brushWidthMm; redraw(); };
    const widthLbl = document.createElement('span');
    widthLbl.className = 'muted';
    widthLbl.textContent = 'šířka mm:';
    row.append(catSel, widthLbl, widthIn);
    panel.appendChild(row);
    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.textContent = 'Ťukněte do stěny — začátek trasy.';
    panel.appendChild(hint);
  }

  function showSelectPanel(): void {
    panel.innerHTML = '';
    const r = W.routes.find((x) => x.id === selectedRouteId);
    if (!r) { panel.className = ''; return; }
    panel.className = 'card no-print';

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
    del.onclick = () => {
      if (!confirm('Smazat trasu?')) return;
      W.routes = W.routes.filter((x) => x.id !== r.id);
      W.dims = W.dims.filter((d) =>
        !(d.from.kind === 'routePoint' && d.from.routeId === r.id) &&
        !(d.to.kind === 'routePoint' && d.to.routeId === r.id));
      selectedRouteId = null;
      saveProject();
      redraw();
      showSelectPanel();
    };
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
        : '1. bod: ťukněte na bod trasy (roh/konec), který chcete kótovat.'
    }</div>`;
    const dims = W.dims;
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
        const apply = (mm: number) => applyDimValue(d, mm);
        const input = lengthInput(d.valueMm ?? (dimGeomLengthMm(W, d) != null ? Math.round(dimGeomLengthMm(W, d)!) : null), apply);
        input.style.width = '90px';
        wrapEl.appendChild(input);
        const del = document.createElement('button');
        del.textContent = '✕';
        del.onclick = () => { W.dims = W.dims.filter((x) => x.id !== d.id); saveProject(); redraw(); showDimPanel(); };
        wrapEl.appendChild(del);
        list.appendChild(wrapEl);
        // čerstvě zanesená kóta rovnou čeká na míru z metru
        if (d.id === focusDimId) setDistoTarget(input, apply);
      });
      panel.appendChild(list);
    }
  }

  /** Otevře editor napasování a uloží narovnaný podklad (+ zdroj a rohy pro doladění). */
  async function mapAsBackground(sourceBlob: Blob, sourcePhotoId?: string, initialCorners?: XY[]): Promise<void> {
    const result = await mapPhotoToWall(sourceBlob, L / W.heightMm, initialCorners);
    if (!result) return;
    if (W.background) await deletePhoto(W.background.photoId);
    const id = newId();
    await savePhoto(id, result.blob);
    W.background = {
      photoId: id,
      opacity: W.background?.opacity ?? 0.6,
      sourcePhotoId: sourcePhotoId ?? W.background?.sourcePhotoId,
      corners: result.corners,
    };
    saveProject();
    invalidateCostField();
    await loadBackground();
    redraw();
    showPhotoPanel();
  }

  async function showPhotoPanel(): Promise<void> {
    panel.className = 'card no-print';
    panel.innerHTML = '';

    // Ovládání podkladu
    if (W.background) {
      const bg = document.createElement('div');
      bg.className = 'row';
      bg.style.cssText = 'align-items:center;gap:10px;margin-bottom:8px';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0'; slider.max = '100';
      slider.value = String(Math.round(W.background.opacity * 100));
      slider.style.flex = '1';
      slider.addEventListener('input', () => {
        if (W.background) W.background.opacity = Number(slider.value) / 100;
        redraw();
      });
      slider.addEventListener('change', () => saveProject());
      const rm = document.createElement('button');
      rm.className = 'danger';
      rm.textContent = '✕ Odebrat podklad';
      rm.onclick = async () => {
        if (W.background) await deletePhoto(W.background.photoId);
        W.background = undefined;
        saveProject();
        invalidateCostField();
        snap = false;
        snapBtn.classList.remove('active');
        await loadBackground();
        redraw();
        showPhotoPanel();
      };
      bg.append(Object.assign(document.createElement('span'), { textContent: '🌫️ Průhlednost podkladu' }), slider);
      // Doladění perspektivy — znovu otevře editor s původní fotkou a rohy.
      if (W.background.sourcePhotoId) {
        const tune = document.createElement('button');
        tune.className = 'primary';
        tune.textContent = '🔧 Doladit perspektivu';
        tune.onclick = async () => {
          const bgn = W.background;
          if (!bgn?.sourcePhotoId) return;
          const src = await getPhoto(bgn.sourcePhotoId);
          if (!src) { alert('Původní fotka už není k dispozici (asi byla smazána).'); return; }
          await mapAsBackground(src, bgn.sourcePhotoId, bgn.corners);
        };
        bg.append(tune);
      }
      bg.append(rm);
      panel.appendChild(bg);
    }

    const row = document.createElement('div');
    row.className = 'row';
    for (const id of W.photoIds) {
      const blob = await getPhoto(id);
      if (!blob) continue;
      const img = document.createElement('img');
      img.src = URL.createObjectURL(blob);
      img.style.cssText = 'width:72px;height:72px;object-fit:cover;border-radius:8px;cursor:pointer';
      img.onclick = () => {
        const ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;background:#000d;z-index:99;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px';
        const big = document.createElement('img');
        big.src = img.src;
        big.style.cssText = 'max-width:100%;max-height:78%';
        const mapBtn = document.createElement('button');
        mapBtn.className = 'primary';
        mapBtn.textContent = '🗺️ Napasovat na stěnu';
        mapBtn.onclick = async (e) => {
          e.stopPropagation();
          ov.remove();
          await mapAsBackground(blob, id);
        };
        const delBtn = document.createElement('button');
        delBtn.className = 'danger';
        delBtn.textContent = '🗑 Smazat fotku';
        delBtn.onclick = async (e) => {
          e.stopPropagation();
          if (!confirm('Smazat fotku?')) return;
          W.photoIds = W.photoIds.filter((x) => x !== id);
          await deletePhoto(id);
          saveProject();
          ov.remove();
          showPhotoPanel();
        };
        ov.onclick = () => ov.remove();
        const btns = document.createElement('div');
        btns.style.cssText = 'display:flex;gap:8px';
        btns.append(mapBtn, delBtn);
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
        W.photoIds.push(id);
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

  function setMode(m: Mode): void {
    mode = m;
    dimFirst = null;
    clearDimHover();
    root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === m);
    });
    if (m === 'draw') {
      draft ??= { id: newId(), categoryId, widthMm: brushWidthMm, note: '', points: [], segLengthsMm: [] };
      showDrawSetupPanel();
    } else if (m === 'select') showSelectPanel();
    else if (m === 'dim') showDimPanel();
    else showPhotoPanel();
    redraw();
  }

  root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
    b.addEventListener('click', () => setMode(b.dataset.mode as Mode));
  });
  const orthoBtn = root.querySelector('#ortho') as HTMLButtonElement;
  orthoBtn.addEventListener('click', () => {
    ortho = !ortho;
    orthoBtn.classList.toggle('active', ortho);
  });
  const snapBtn = root.querySelector('#snap') as HTMLButtonElement;
  snapBtn.addEventListener('click', async () => {
    if (!snap) {
      if (!W.background) {
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

  // --- pointer interakce: tap / pan / pinch ---
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchStart: { dist: number; vb: ViewBox } | null = null;
  let tapStart: { x: number; y: number; t: number } | null = null;

  svg.addEventListener('pointerdown', (e) => {
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) tapStart = { x: e.clientX, y: e.clientY, t: Date.now() };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), vb: { ...vb } };
      tapStart = null;
    }
  });

  svg.addEventListener('pointermove', (e) => {
    if (pointers.size === 0) { // pouhé najetí kurzorem (žádné tlačítko)
      if (mode === 'dim') showDimHover(e.clientX, e.clientY); else clearDimHover();
      return;
    }
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    if (pointers.size === 1 && !pinchStart) {
      const scale = mmPerPx();
      vb.x -= (e.clientX - prev.x) * scale;
      vb.y -= (e.clientY - prev.y) * scale;
      setViewBox();
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

  svg.addEventListener('pointerleave', () => clearDimHover());

  svg.addEventListener('pointerup', (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (!tapStart) return;
    const moved = Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y);
    const isTap = moved < 8 && Date.now() - tapStart.t < 600;
    tapStart = null;
    if (!isTap) return;

    const p = screenToWall(e.clientX, e.clientY);
    const tol = 30 * mmPerPx(); // ~30 px tolerance

    if (mode === 'draw' && draft) {
      const prev = draft.points[draft.points.length - 1] ?? null;
      if (snap && costField && prev) {
        for (const q of snapDraftPath(prev, p)) { draft.points.push(q); draft.segLengthsMm.push(null); }
      } else {
        draft.points.push(snapPoint(p, prev));
        if (draft.points.length >= 2) draft.segLengthsMm.push(null);
      }
      redraw();
      showDrawPanel();
    } else if (mode === 'select') {
      const r = hitRoute(p, tol);
      selectedRouteId = r?.id ?? null;
      redraw();
      showSelectPanel();
    } else if (mode === 'dim') {
      if (!dimFirst) {
        dimFirst = dimAnchorAt(p, tol * 2);
        showDimPanel();
      } else {
        const dim: Dimension = { id: newId(), from: dimFirst, to: dimAnchorAt(p, tol * 2), valueMm: null };
        W.dims.push(dim);
        dimFirst = null;
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
  setMode('select');
  syncZoom();
}
