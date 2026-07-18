// Elevation editor stěny: kreslení tras, kóty, fotky, DISTO plnění délek.
import { project, saveProject, savePhoto, getPhoto, deletePhoto } from '../db';
import { axisLen, distToSegment, type WallSide } from '../model/geometry';
import { newId, type Anchor, type Dimension, type Route, type Wall, type XY } from '../model/types';
import { connectDisto, onDistoStatus, setDistoTarget } from '../disto';
import { dimGeomLengthMm, fromDisplay, wallSvgContent, wallViewBox, type ViewBox } from './wall-svg';
import { registerCleanup } from '../main';

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
      <button id="disto"><span id="disto-dot" class="dot" style="background:#64748b"></span> Metr</button>
    </header>
    <div class="viewer-wrap"><svg class="elevation"></svg></div>
    <div id="panel"></div>
    <div class="toolbar">
      <button data-mode="select">👆 Vybrat</button>
      <button data-mode="draw">✏️ Trasa</button>
      <button data-mode="dim">📏 Kóta</button>
      <button data-mode="photo">🖼️ Fotky</button>
      <button id="ortho" class="active">⊾ Pravé úhly</button>
    </div>`;

  root.querySelector('#back')!.addEventListener('click', () => (location.hash = `#/storey/${storeyId}`));

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
  let vb: ViewBox = wallViewBox(W);
  let categoryId = project.categories[0]?.id ?? '';
  let brushWidthMm = 60;

  const catById = (id: string) => project.categories.find((c) => c.id === id);

  function setViewBox(): void {
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  }

  function redraw(): void {
    svg.innerHTML = wallSvgContent(W, {
      side,
      categories: project.categories,
      selectedRouteId,
      draftPoints: draft?.points,
      draftColor: catById(draft?.categoryId ?? categoryId)?.color,
      draftWidthMm: draft?.widthMm ?? brushWidthMm,
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

  function showDimPanel(): void {
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
        const input = lengthInput(d.valueMm ?? (dimGeomLengthMm(W, d) != null ? Math.round(dimGeomLengthMm(W, d)!) : null), (mm) => applyDimValue(d, mm));
        input.style.width = '90px';
        wrapEl.appendChild(input);
        const del = document.createElement('button');
        del.textContent = '✕';
        del.onclick = () => { W.dims = W.dims.filter((x) => x.id !== d.id); saveProject(); redraw(); showDimPanel(); };
        wrapEl.appendChild(del);
        list.appendChild(wrapEl);
      });
      panel.appendChild(list);
    }
  }

  async function showPhotoPanel(): Promise<void> {
    panel.className = 'card no-print';
    panel.innerHTML = '';
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
        big.style.cssText = 'max-width:100%;max-height:85%';
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
        ov.append(big, delBtn);
        document.body.appendChild(ov);
      };
      row.appendChild(img);
    }
    const add = document.createElement('label');
    add.className = 'btn';
    add.innerHTML = '📷 Přidat<input type="file" accept="image/*" hidden multiple />';
    add.querySelector('input')!.addEventListener('change', async (e) => {
      for (const f of Array.from((e.target as HTMLInputElement).files ?? [])) {
        const id = newId();
        await savePhoto(id, f);
        W.photoIds.push(id);
      }
      saveProject();
      showPhotoPanel();
    });
    row.appendChild(add);
    panel.appendChild(row);
  }

  function setMode(m: Mode): void {
    mode = m;
    dimFirst = null;
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
      const k = pinchStart.dist / dist;
      const cx = pinchStart.vb.x + pinchStart.vb.w / 2;
      const cy = pinchStart.vb.y + pinchStart.vb.h / 2;
      vb = {
        w: pinchStart.vb.w * k,
        h: pinchStart.vb.h * k,
        x: cx - (pinchStart.vb.w * k) / 2,
        y: cy - (pinchStart.vb.h * k) / 2,
      };
      setViewBox();
      return;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });

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
      draft.points.push(snapPoint(p, prev));
      if (draft.points.length >= 2) draft.segLengthsMm.push(null);
      redraw();
      showDrawPanel();
    } else if (mode === 'select') {
      const r = hitRoute(p, tol);
      selectedRouteId = r?.id ?? null;
      redraw();
      showSelectPanel();
    } else if (mode === 'dim') {
      if (!dimFirst) {
        const rp = hitRoutePoint(p, tol * 2);
        dimFirst = rp ? { kind: 'routePoint', ...rp } : { kind: 'point', uMm: Math.round(p.uMm), vMm: Math.round(p.vMm) };
        showDimPanel();
      } else {
        const edge = hitEdge(p, tol * 2);
        const rp = edge ? null : hitRoutePoint(p, tol * 2);
        const to: Anchor = edge ?? (rp ? { kind: 'routePoint', ...rp } : { kind: 'point', uMm: Math.round(p.uMm), vMm: Math.round(p.vMm) });
        const dim: Dimension = { id: newId(), from: dimFirst, to, valueMm: null };
        W.dims.push(dim);
        dimFirst = null;
        saveProject();
        redraw();
        showDimPanel();
      }
    }
  });

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const r = svg.getBoundingClientRect();
    const fx = vb.x + ((e.clientX - r.left) / r.width) * vb.w;
    const fy = vb.y + ((e.clientY - r.top) / r.height) * vb.h;
    vb = { w: vb.w * k, h: vb.h * k, x: fx - (fx - vb.x) * k, y: fy - (fy - vb.y) * k };
    setViewBox();
  }, { passive: false });

  setMode('select');
}
