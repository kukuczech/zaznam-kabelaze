// Napasování fotky na líc: uživatel označí body ve fotce a obrázek se perspektivně
// narovná (homografie) do obdélníku čelního pohledu (0,0 → len,H).
//   • Stěna: 4 rohy líce (TL,TR,BR,BL) → přesná homografie.
//   • Podlaha/strop: rohy místnosti v pořadí planOutline; jejich cílové pozice
//     známe z půdorysu, takže stačí naklikat skutečné rohy (i nepravidelný tvar)
//     → least-squares homografie (N≥4 bodů), polygon zároveň slouží jako maska.
// Zdrojovou fotku lze před označením otočit po 90° (⟳) — např. na výšku/na šířku.

type Pt = { x: number; y: number };

/**
 * Homografie mapující zdrojové body na cílové (3×3, h33=1). Pro 4 body přesně,
 * pro N>4 metodou nejmenších čtverců (normální rovnice AᵀA·h = Aᵀb).
 */
function solveHomography(src: Pt[], dst: Pt[]): number[] {
  const rows: number[][] = [];
  const bb: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    rows.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    bb.push(u);
    rows.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    bb.push(v);
  }
  let h: number[];
  if (rows.length === 8) {
    h = gauss(rows, bb);
  } else {
    const n = 8;
    const AtA = Array.from({ length: n }, () => new Array(n).fill(0));
    const Atb = new Array(n).fill(0);
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r], br = bb[r];
      for (let i = 0; i < n; i++) {
        Atb[i] += row[i] * br;
        for (let j = 0; j < n; j++) AtA[i][j] += row[i] * row[j];
      }
    }
    h = gauss(AtA, Atb);
  }
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Gaussova eliminace s částečnou pivotací pro čtvercovou soustavu. */
function gauss(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-9;
    for (let j = c; j <= n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row) => row[n]);
}

function apply(h: number[], x: number, y: number): Pt {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

/**
 * Narovná fotku: `srcPts` (px zdroje) → `dstPts` (px výstupu) na obdélník outW×outH.
 * Vzorkuje inverzně (cíl → zdroj), pro N>4 bodů least-squares.
 */
function warp(srcCanvas: HTMLCanvasElement, srcPts: Pt[], dstPts: Pt[], outW: number, outH: number): HTMLCanvasElement {
  // homografie cíl → zdroj (inverzní vzorkování)
  const h = solveHomography(dstPts, srcPts);
  const sctx = srcCanvas.getContext('2d')!;
  const sImg = sctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const sd = sImg.data;
  const sw = srcCanvas.width, sh = srcCanvas.height;

  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const octx = out.getContext('2d')!;
  const oImg = octx.createImageData(outW, outH);
  const od = oImg.data;

  for (let Y = 0; Y < outH; Y++) {
    for (let X = 0; X < outW; X++) {
      const s = apply(h, X + 0.5, Y + 0.5);
      const sx = s.x | 0, sy = s.y | 0;
      const o = (Y * outW + X) * 4;
      if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) {
        od[o + 3] = 0;
        continue;
      }
      const si = (sy * sw + sx) * 4;
      od[o] = sd[si]; od[o + 1] = sd[si + 1]; od[o + 2] = sd[si + 2]; od[o + 3] = 255;
    }
  }
  octx.putImageData(oImg, 0, 0);
  return out;
}

/**
 * Narovná perspektivu podle 4 rohů referenčního obdélníku (quad = TL,TR,BR,BL v px
 * zdroje), ale ZACHOVÁ CELÝ snímek (ne jen ten obdélník). Homografie srovná quad na
 * pravoúhlý obdélník (poměr = průměr délek hran) a stejná rovina se narovná i kolem.
 * Výstup je čelně rovný obraz s průhledným okolím (mimo zdroj). Vrací i poměr stran.
 */
function warpKeepWhole(srcCanvas: HTMLCanvasElement, quad: Pt[], maxDim: number): { canvas: HTMLCanvasElement; aspect: number } {
  const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
  const tw = Math.max(1, (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2);
  const th = Math.max(1, (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2);
  const dst4: Pt[] = [{ x: 0, y: 0 }, { x: tw, y: 0 }, { x: tw, y: th }, { x: 0, y: th }];
  const sw = srcCanvas.width, sh = srcCanvas.height;
  const Hs2d = solveHomography(quad, dst4); // zdroj → narovnané
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of [{ x: 0, y: 0 }, { x: sw, y: 0 }, { x: sw, y: sh }, { x: 0, y: sh }]) {
    const p = apply(Hs2d, c.x, c.y);
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
  const k = Math.min(1, maxDim / Math.max(spanX, spanY));
  const outW = Math.max(1, Math.round(spanX * k)), outH = Math.max(1, Math.round(spanY * k));
  const Hd2s = solveHomography(dst4, quad); // narovnané → zdroj (inverzní vzorkování)
  const sd = srcCanvas.getContext('2d')!.getImageData(0, 0, sw, sh).data;
  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const octx = out.getContext('2d')!;
  const oImg = octx.createImageData(outW, outH);
  const od = oImg.data;
  for (let Y = 0; Y < outH; Y++) {
    for (let X = 0; X < outW; X++) {
      const s = apply(Hd2s, (X + 0.5) / k + minX, (Y + 0.5) / k + minY);
      const sx = s.x | 0, sy = s.y | 0;
      const o = (Y * outW + X) * 4;
      if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) { od[o + 3] = 0; continue; }
      const si = (sy * sw + sx) * 4;
      od[o] = sd[si]; od[o + 1] = sd[si + 1]; od[o + 2] = sd[si + 2]; od[o + 3] = 255;
    }
  }
  octx.putImageData(oImg, 0, 0);
  return { canvas: out, aspect: outW / outH };
}

/** Otočí canvas o rot·90° po směru hodin (rot 0–3). rot=0 vrací originál. */
function rotateCanvas(src: HTMLCanvasElement, rot: number): HTMLCanvasElement {
  rot = ((rot % 4) + 4) % 4;
  if (rot === 0) return src;
  const w = src.width, h = src.height;
  const out = document.createElement('canvas');
  out.width = rot % 2 ? h : w;
  out.height = rot % 2 ? w : h;
  const c = out.getContext('2d')!;
  c.translate(out.width / 2, out.height / 2);
  c.rotate((rot * Math.PI) / 2);
  c.drawImage(src, -w / 2, -h / 2);
  return out;
}

/** Vodorovně překlopí canvas (zrcadlení vlevo↔vpravo). */
function flipXCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = src.width; out.height = src.height;
  const c = out.getContext('2d')!;
  c.translate(out.width, 0);
  c.scale(-1, 1);
  c.drawImage(src, 0, 0);
  return out;
}

/** Zorientuje zdroj: nejdřív otočení o rot·90°, pak případné vodorovné zrcadlení. */
function orientCanvas(src: HTMLCanvasElement, rot: number, mirror: boolean): HTMLCanvasElement {
  const r = rotateCanvas(src, rot);
  return mirror ? flipXCanvas(r) : r;
}

async function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('Obrázek se nepodařilo načíst.'));
      img.src = url;
    });
    return img;
  } finally {
    // URL uvolníme až po dekódování — necháme na GC, není kritické
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

/** Cílové rohy místnosti pro režim podlaha/strop — v NORMOVANÝCH zobrazovacích souřadnicích [0..1]². */
export interface PlanFit {
  /** Vrcholy planOutline jako {x=displayX/FL, y=displayY/H}, v pořadí polygonu. */
  targets: Pt[];
}

export interface MapResult {
  blob: Blob;
  /** Označené body ve zdrojové fotce (px, po otočení) — stěna 4 rohy, plán N rohů dle planOutline. */
  corners: Pt[];
  /** Otočení zdroje (0/90/180/270°) použité při pasování. */
  rotDeg: number;
  /** Vodorovné zrcadlení zdrojové fotky použité při pasování. */
  mirror: boolean;
  /** Jen režim „podle obdélníku": poměr stran výsledné (narovnané) dlaždice. */
  aspect?: number;
  /**
   * Jen režim cropPoly: síťová data pro dlaždici — `src` = vrcholy v [0,1] normovaně
   * na (orientovaný) zdroj, `anchor[i]` = roh(true)/ořez(false). `blob` je pak CELÝ
   * orientovaný zdroj (ne oříznutý) — ořez i zkosení dělá až mesh v editoru.
   */
  mesh?: { src: Pt[]; anchor: boolean[] };
}

export interface MapOptions {
  /** Znovuotevření — pozice bodů z předchozího pasování (px zdroje, po otočení). */
  initialCorners?: Pt[];
  /** Znovuotevření — otočení zdroje z předchozího pasování. */
  initialRotDeg?: number;
  /** Znovuotevření — vodorovné překlopení z předchozího pasování. */
  initialMirror?: boolean;
  /** Znovuotevření cropPoly — typy bodů (roh/ořez). */
  initialAnchor?: boolean[];
  /** Znovuotevření cropPoly — tvar mnohoúhelníku (body normované [0,1] na zdroj). */
  initialCropSrc?: Pt[];
  /** Přítomné → režim podlaha/strop (naklikat rohy místnosti dle půdorysu). */
  plan?: PlanFit;
  /**
   * Režim „narovnat podle obdélníku": označíš 4 rohy libovolného obdélníku na
   * stěně (okno, panel…), fotka se podle něj perspektivně srovná a ZŮSTANE CELÁ →
   * rovná dlaždice (PNG s průhledným okolím). Pro partial fotky s perspektivou.
   */
  keepWhole?: boolean;
  /**
   * Režim „oříznout mnohoúhelníkem": obtáhneš oblast (libovolný počet bodů, ＋/－),
   * co je uvnitř se nechá, zbytek se ořízne (maska, PNG). BEZ zkreslení perspektivy
   * — tu si pak případně srovnáš volnými rohy dlaždice.
   */
  cropPoly?: boolean;
}

/** Výstupní rozlišení podle poměru stran líce, delší strana = long. */
function outSize(aspect: number, long: number): { w: number; h: number } {
  return aspect >= 1 ? { w: long, h: Math.round(long / aspect) } : { w: Math.round(long * aspect), h: long };
}

/**
 * Znovu narovná fotku na zadaný poměr stran BEZ otevírání editoru — ze zdrojové fotky
 * a už jednou označených rohů (`corners`, px zdroje po otočení). Používá se, když se
 * poměr stran líce změní až dodatečně: u fotostěny se nejdřív ořízne na stěnu a teprve
 * potom se změří skutečná šířka a výška. Přepočítat z originálu je čistší než roztáhnout
 * už narovnaný obraz (jen jedno převzorkování).
 */
export async function rewarpToAspect(
  sourceBlob: Blob,
  corners: Pt[],
  rotDeg: number,
  mirror: boolean,
  aspect: number,
): Promise<Blob | null> {
  if (corners.length < 4) return null;
  const img = await blobToImage(sourceBlob);
  const full = document.createElement('canvas');
  full.width = img.naturalWidth; full.height = img.naturalHeight;
  full.getContext('2d')!.drawImage(img, 0, 0);
  const src = orientCanvas(full, Math.round(rotDeg / 90), mirror);
  const { w, h } = outSize(aspect, 1600);
  // Rohy jsou v pořadí TL, TR, BR, BL → cílem je celý obdélník líce.
  const dst: Pt[] = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const out = warp(src, corners, dst, w, h);
  return new Promise((res) => out.toBlob((b) => res(b), 'image/jpeg', 0.85));
}

/**
 * Otevře celoobrazovkový editor napasování s živým náhledem. Vrátí narovnaný
 * JPEG blob + pozice bodů + otočení, nebo null (uživatel zrušil). aspect = len/H.
 */
export async function mapPhotoToWall(
  sourceBlob: Blob,
  aspect: number,
  opts: MapOptions = {},
): Promise<MapResult | null> {
  const img = await blobToImage(sourceBlob);

  // Plný a zmenšený zdroj v PŮVODNÍ orientaci; otočení se aplikuje odvozeně.
  const origFull = document.createElement('canvas');
  origFull.width = img.naturalWidth; origFull.height = img.naturalHeight;
  origFull.getContext('2d')!.drawImage(img, 0, 0);

  const dispK = Math.min(1, 1400 / Math.max(origFull.width, origFull.height));
  const origDisp = document.createElement('canvas');
  origDisp.width = Math.max(1, Math.round(origFull.width * dispK));
  origDisp.height = Math.max(1, Math.round(origFull.height * dispK));
  origDisp.getContext('2d')!.drawImage(img, 0, 0, origDisp.width, origDisp.height);

  const pvKBase = Math.min(1, 500 / Math.max(origFull.width, origFull.height));
  const origPv = document.createElement('canvas');
  origPv.width = Math.max(1, Math.round(origFull.width * pvKBase));
  origPv.height = Math.max(1, Math.round(origFull.height * pvKBase));
  origPv.getContext('2d')!.drawImage(img, 0, 0, origPv.width, origPv.height);

  const isPlan = !!opts.plan;
  const keepWhole = !!opts.keepWhole; // režim „narovnat podle obdélníku" (zachová celý snímek)
  const cropPoly = !!opts.cropPoly;   // režim „oříznout mnohoúhelníkem" (maska, bez zkreslení)
  const targets: Pt[] = isPlan ? opts.plan!.targets : [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const N = targets.length;
  const pvOut = outSize(aspect, 240);

  // Orientace ZDROJE: otočení (0–3 × 90°) a vodorovné zrcadlení. Transformuje se jen
  // fotka (pracovní plátna + zobrazení); táhla (pts) zůstávají na svých místech.
  let rot = ((opts.initialRotDeg ?? 0) / 90) | 0;
  let mirror = !!opts.initialMirror;
  let nW = 0, nH = 0;
  let srcCanvasFull = origFull; // plné rozlišení po orientaci (pro finální warp)
  let pvSrc = origPv;           // náhledový zdroj po orientaci
  let pvK = pvKBase;            // px zdroje → px náhledu (na aktuální orientaci)

  function buildWork(): void {
    srcCanvasFull = orientCanvas(origFull, rot, mirror);
    pvSrc = orientCanvas(origPv, rot, mirror);
    nW = srcCanvasFull.width; nH = srcCanvasFull.height;
    pvK = pvSrc.width / nW;
  }
  buildWork();

  const clampPt = (p: Pt): Pt => ({ x: Math.min(Math.max(p.x, 0), nW), y: Math.min(Math.max(p.y, 0), nH) });

  // Body v px zdroje (po otočení). Znovuotevření → z uložených, jinak počáteční odhad.
  let pts: Pt[];
  if (cropPoly && opts.initialCropSrc && opts.initialCropSrc.length >= 3) {
    pts = opts.initialCropSrc.map((s) => clampPt({ x: s.x * nW, y: s.y * nH })); // znovuotevření: stejný tvar
  } else if (cropPoly && opts.initialCorners && opts.initialCorners.length >= 3) {
    pts = opts.initialCorners.map(clampPt); // ořezový mnohoúhelník má proměnný počet bodů
  } else if (opts.initialCorners && opts.initialCorners.length === N) {
    pts = opts.initialCorners.map(clampPt);
  } else if (isPlan) {
    // Táhla začnou zhruba tam, kde by roh ležel, kdyby fotka už byla narovnaná.
    pts = targets.map((t) => clampPt({ x: t.x * nW, y: t.y * nH }));
  } else {
    pts = [
      { x: nW * 0.12, y: nH * 0.12 }, { x: nW * 0.88, y: nH * 0.12 },
      { x: nW * 0.88, y: nH * 0.88 }, { x: nW * 0.12, y: nH * 0.88 },
    ];
  }

  // Typ bodů ořezového mnohoúhelníku: true = roh (kotva), false = jen ořez. Výchozí roh.
  let anchor: boolean[] = cropPoly
    ? (opts.initialAnchor && opts.initialAnchor.length === pts.length ? [...opts.initialAnchor] : pts.map(() => true))
    : [];

  return new Promise<MapResult | null>((resolve) => {
    const colors = ['#f87171', '#facc15', '#4ade80', '#60a5fa', '#c084fc', '#f472b6', '#22d3ee', '#a3e635'];
    const col = (i: number): string => colors[i % colors.length];

    const hint = cropPoly
      ? 'Obtáhni oblast: body na <b>skutečných rozích</b> nech jako 🎯 <b>roh</b> (kotva), body kde jen uřezáváš přepni tlačítkem <b>typ</b> na ✂️ ořez. V editoru pak kotvy natáhneš na rohy stěny a obraz se zkosí. („＋/－ bod", ⟳/⇄ orientace)'
      : keepWhole
      ? 'Přetáhni 4 body na rohy <b>obdélníku na stěně</b> (okno, panel, dlaždice, rám zásuvky). Fotka se podle něj perspektivně narovná a zůstane celá — vznikne rovná dlaždice. (⟳/⇄ orientace)'
      : isPlan
        ? 'Přetáhni číslované body na <b>rohy místnosti</b> podle nákresu vpravo (i nepravidelný tvar). Náhled se narovnává.'
        : `Přetáhni 4 body na rohy stěny (náhled se narovnává): <b style="color:#f87171">1 LH</b> · <b style="color:#facc15">2 PH</b> · <b style="color:#4ade80">3 PD</b> · <b style="color:#60a5fa">4 LD</b>`;

    const ov = document.createElement('div');
    ov.className = 'photomap-overlay';
    ov.innerHTML = `
      <div class="photomap-hint">${hint}</div>
      <div class="photomap-stage">
        <img class="photomap-img" draggable="false"/>
        <svg class="photomap-svg"></svg>
        <div class="photomap-preview">
          <span>Náhled</span><canvas></canvas>
          ${isPlan ? '<svg class="photomap-plan"></svg>' : ''}
        </div>
      </div>
      <div class="photomap-actions">
        <button class="btn" data-act="rot" title="Otočit fotku o 90°">⟳ Otočit</button>
        <button class="btn" data-act="mirror" title="Překlopit výsledek zrcadlově (vlevo↔vpravo)">⇄ Zrcadlit</button>
        ${cropPoly ? '<button class="btn" data-act="ptype" title="Vybraný bod: přepnout roh (kotva) ↔ jen ořez">🎯/✂️ typ</button><button class="btn" data-act="addpt" title="Přidat bod (rozdělí nejdelší hranu)">＋ bod</button><button class="btn" data-act="delpt" title="Odebrat vybraný bod">－ bod</button>' : ''}
        <button class="btn" data-act="cancel">✕ Zrušit</button>
        <button class="btn primary" data-act="ok">✓ ${cropPoly ? 'Oříznout' : 'Napasovat'}</button>
      </div>`;
    document.body.appendChild(ov);

    const imgEl = ov.querySelector('.photomap-img') as HTMLImageElement;
    const svg = ov.querySelector('.photomap-svg') as SVGSVGElement;
    const planSvg = ov.querySelector('.photomap-plan') as SVGSVGElement | null;
    const pvCanvas = ov.querySelector('.photomap-preview canvas') as HTMLCanvasElement;
    pvCanvas.width = pvOut.w; pvCanvas.height = pvOut.h;

    let active = 0; // právě tažený/vybraný bod (pro zvýraznění v nákresu)

    function refreshImg(): void { imgEl.src = orientCanvas(origDisp, rot, mirror).toDataURL('image/jpeg', 0.9); }
    refreshImg();

    // Nákres půdorysu místnosti (jen plan režim) — pomáhá určit, který bod je který
    // roh. Šířka viewBoxu = poměr stran, ať nákres odpovídá reálnému tvaru.
    function drawPlan(): void {
      if (!planSvg) return;
      const VW = 100 * aspect, VH = 100;
      planSvg.setAttribute('viewBox', `-8 -8 ${(VW + 16).toFixed(1)} ${VH + 16}`);
      const X = (t: Pt): number => t.x * VW, Y = (t: Pt): number => t.y * VH;
      const poly = targets.map((t) => `${X(t).toFixed(1)},${Y(t).toFixed(1)}`).join(' ');
      planSvg.innerHTML =
        `<polygon points="${poly}" fill="rgba(56,189,248,0.12)" stroke="#38bdf8" stroke-width="1.4"/>` +
        targets.map((t, i) =>
          `<circle cx="${X(t).toFixed(1)}" cy="${Y(t).toFixed(1)}" r="${i === active ? 8 : 6}" fill="${col(i)}" stroke="#0f172a" stroke-width="1.2"/>` +
          `<text x="${X(t).toFixed(1)}" y="${(Y(t) + 2.6).toFixed(1)}" text-anchor="middle" font-size="7" font-weight="bold" fill="#0f172a">${i + 1}</text>`,
        ).join('');
    }

    // Vztah zobrazené <img> ↔ nativní px (po otočení).
    function scale(): { ox: number; oy: number; k: number } {
      const ir = imgEl.getBoundingClientRect();
      const sr = svg.getBoundingClientRect();
      return { ox: ir.left - sr.left, oy: ir.top - sr.top, k: ir.width / nW };
    }

    function updatePreview(): void {
      const sp = pts.map((p) => ({ x: p.x * pvK, y: p.y * pvK }));
      const pctx = pvCanvas.getContext('2d')!;
      if (cropPoly) {
        // Náhled ořezu: bbox mnohoúhelníku, fotka oříznutá na tvar, zmenšeno do rámečku.
        const xs = sp.map((p) => p.x), ys = sp.map((p) => p.y);
        const minX = Math.min(...xs), minY = Math.min(...ys);
        const bw = Math.max(1, Math.max(...xs) - minX), bh = Math.max(1, Math.max(...ys) - minY);
        const s = Math.min(pvCanvas.width / bw, pvCanvas.height / bh);
        const ox = (pvCanvas.width - bw * s) / 2, oy = (pvCanvas.height - bh * s) / 2;
        pctx.clearRect(0, 0, pvCanvas.width, pvCanvas.height);
        pctx.save();
        pctx.beginPath();
        sp.forEach((p, i) => { const x = ox + (p.x - minX) * s, y = oy + (p.y - minY) * s; if (i === 0) pctx.moveTo(x, y); else pctx.lineTo(x, y); });
        pctx.closePath();
        pctx.clip();
        pctx.drawImage(pvSrc, ox - minX * s, oy - minY * s, pvSrc.width * s, pvSrc.height * s);
        pctx.restore();
        return;
      }
      if (keepWhole) {
        // Náhled narovnané CELÉ fotky (perspektiva pryč), zmenšený do rámečku.
        const rw = warpKeepWhole(pvSrc, sp, Math.max(pvOut.w, pvOut.h)).canvas;
        const s = Math.min(pvCanvas.width / rw.width, pvCanvas.height / rw.height);
        const dw = rw.width * s, dh = rw.height * s;
        pctx.clearRect(0, 0, pvCanvas.width, pvCanvas.height);
        pctx.drawImage(rw, (pvCanvas.width - dw) / 2, (pvCanvas.height - dh) / 2, dw, dh);
        return;
      }
      const dp = targets.map((t) => ({ x: t.x * pvOut.w, y: t.y * pvOut.h }));
      const out = warp(pvSrc, sp, dp, pvOut.w, pvOut.h);
      pctx.clearRect(0, 0, pvOut.w, pvOut.h);
      if (isPlan) {
        // Ořez náhledu na tvar místnosti (výsledný podklad se ořízne stejně).
        pctx.save();
        pctx.beginPath();
        targets.forEach((t, i) => {
          const x = t.x * pvOut.w, y = t.y * pvOut.h;
          if (i === 0) pctx.moveTo(x, y); else pctx.lineTo(x, y);
        });
        pctx.closePath();
        pctx.clip();
        pctx.drawImage(out, 0, 0);
        pctx.restore();
      } else {
        pctx.drawImage(out, 0, 0);
      }
    }

    function draw(): void {
      const { ox, oy, k } = scale();
      const sp = pts.map((p) => ({ x: ox + p.x * k, y: oy + p.y * k }));
      const poly = sp.map((p) => `${p.x},${p.y}`).join(' ');
      if (cropPoly) {
        // Duté úchopy (průhledný střed → vidíš na roh pod ním) + přesný bod uprostřed.
        // 🎯 roh = modrý plný prstenec; ✂️ ořez = žlutý čárkovaný. Aktivní = bílý kroužek.
        svg.innerHTML =
          `<polygon points="${poly}" fill="none" stroke="#38bdf8" stroke-width="2" stroke-dasharray="8 6"/>` +
          sp.map((p, i) => {
            const a = anchor[i];
            const c = a ? '#38bdf8' : '#facc15';
            const dash = a ? '' : ' stroke-dasharray="7 5"';
            const sel = i === active ? `<circle cx="${p.x}" cy="${p.y}" r="30" fill="none" stroke="#fff" stroke-width="2"/>` : '';
            return `<circle data-i="${i}" cx="${p.x}" cy="${p.y}" r="26" fill="transparent" pointer-events="all"/>` +
              `<circle cx="${p.x}" cy="${p.y}" r="20" fill="none" stroke="#0f172a" stroke-width="6" pointer-events="none"/>` +
              `<circle cx="${p.x}" cy="${p.y}" r="20" fill="none" stroke="${c}" stroke-width="3"${dash} pointer-events="none"/>` +
              `<circle cx="${p.x}" cy="${p.y}" r="2.5" fill="${c}" stroke="#0f172a" stroke-width="1" pointer-events="none"/>${sel}`;
          }).join('');
        return;
      }
      // Těžiště úchopů → číslo posuneme od bodu dovnitř (nikdy se neořízne u kraje).
      const cx = sp.reduce((a, q) => a + q.x, 0) / sp.length;
      const cy = sp.reduce((a, q) => a + q.y, 0) / sp.length;
      svg.innerHTML =
        `<polygon points="${poly}" fill="rgba(56,189,248,0.15)" stroke="#38bdf8" stroke-width="2"/>` +
        sp.map((p, i) => {
          const c = col(i);
          // Dutý úchop: průhledný střed → vidíš přesně kam táhneš; přesný bod = tečka.
          // Číslo je vedle (posunuté k těžišti), aby nepřekrývalo bod. Aktivní = bílý kroužek.
          const dx = cx - p.x, dy = cy - p.y, L = Math.hypot(dx, dy) || 1;
          const tx = p.x + dx / L * 24, ty = p.y + dy / L * 24 + 5;
          const sel = i === active ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="26" fill="none" stroke="#fff" stroke-width="2"/>` : '';
          return `<circle data-i="${i}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="26" fill="transparent" pointer-events="all"/>` +
            `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="16" fill="none" stroke="#0f172a" stroke-width="6" pointer-events="none"/>` +
            `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="16" fill="none" stroke="${c}" stroke-width="3" pointer-events="none"/>` +
            `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="${c}" stroke="#0f172a" stroke-width="1" pointer-events="none"/>` +
            `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="middle" font-size="15" font-weight="bold" fill="${c}" stroke="#0f172a" stroke-width="3" paint-order="stroke" pointer-events="none">${i + 1}</text>` +
            sel;
        }).join('');
    }

    function redraw(): void { draw(); updatePreview(); drawPlan(); }

    let drag: number | null = null;
    let grab = { dx: 0, dy: 0 }; // odsazení skutečného bodu od kurzoru → značku držíš „za roh"
    svg.addEventListener('pointerdown', (e) => {
      const t = e.target as Element;
      const i = t.getAttribute('data-i');
      if (i == null) return;
      drag = Number(i);
      active = drag;
      // Zapamatuj, kde byl bod vůči kurzoru; při tažení to odsazení zachováme, ať
      // značka na chycení neuskočí na kurzor a přesný bod zůstane vedle prstu vidět.
      const { ox, oy, k } = scale();
      const r = svg.getBoundingClientRect();
      grab = { dx: pts[drag].x - (e.clientX - r.left - ox) / k, dy: pts[drag].y - (e.clientY - r.top - oy) / k };
      drawPlan();
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', (e) => {
      if (drag == null) return;
      const { ox, oy, k } = scale();
      const r = svg.getBoundingClientRect();
      pts[drag] = clampPt({ x: (e.clientX - r.left - ox) / k + grab.dx, y: (e.clientY - r.top - oy) / k + grab.dy });
      redraw();
    });
    svg.addEventListener('pointerup', () => (drag = null));

    const ro = new ResizeObserver(draw);
    ro.observe(imgEl);
    if (imgEl.complete) redraw();
    else imgEl.onload = redraw;

    function close(result: MapResult | null): void {
      ro.disconnect();
      ov.remove();
      resolve(result);
    }

    // Přeorientuje jen ZDROJOVOU fotku (otočení/zrcadlení). Táhla zůstanou na svých
    // MÍSTECH na obrazovce — fotka se otočí/překlopí pod nimi. Pozice si uložíme ve
    // zobrazovacích (svg) souřadnicích a po přebudování je přepočteme na nové px.
    function reorient(apply: () => void): void {
      const s = scale();
      const screen = pts.map((p) => ({ x: s.ox + p.x * s.k, y: s.oy + p.y * s.k }));
      apply();
      buildWork();
      refreshImg();
      const relayout = (): void => {
        const s2 = scale();
        pts = screen.map((p) => clampPt({ x: (p.x - s2.ox) / s2.k, y: (p.y - s2.oy) / s2.k }));
        redraw();
      };
      // Rozměry se mění jen při otočení → počkat na nové rozvržení <img>; u zrcadlení
      // (stejné rozměry) je přepočet identita, ale zavoláme ho taky pro jednotnost.
      imgEl.onload = () => requestAnimationFrame(relayout);
    }

    ov.querySelector('[data-act="rot"]')!.addEventListener('click', () => reorient(() => { rot = (rot + 1) % 4; }));
    const mirBtn = ov.querySelector('[data-act="mirror"]') as HTMLButtonElement;
    const syncMir = (): void => { mirBtn.classList.toggle('active', mirror); };
    syncMir();
    mirBtn.addEventListener('click', () => reorient(() => { mirror = !mirror; syncMir(); }));
    // ＋/－/typ body ořezového mnohoúhelníku (jen cropPoly).
    ov.querySelector('[data-act="ptype"]')?.addEventListener('click', () => {
      if (active < anchor.length) { anchor[active] = !anchor[active]; redraw(); }
    });
    ov.querySelector('[data-act="addpt"]')?.addEventListener('click', () => {
      // vlož bod do středu nejdelší hrany; nový bod je defaultně ořezový (tvaruje mez)
      let bi = 0, bd = -1;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > bd) { bd = d; bi = i; }
      }
      const a = pts[bi], b = pts[(bi + 1) % pts.length];
      pts.splice(bi + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      anchor.splice(bi + 1, 0, false);
      active = bi + 1;
      redraw();
    });
    ov.querySelector('[data-act="delpt"]')?.addEventListener('click', () => {
      if (pts.length <= 3) return; // mnohoúhelník potřebuje aspoň 3 body
      pts.splice(active % pts.length, 1);
      anchor.splice(active % anchor.length, 1);
      active = 0;
      redraw();
    });
    ov.querySelector('[data-act="cancel"]')!.addEventListener('click', () => close(null));
    ov.querySelector('[data-act="ok"]')!.addEventListener('click', () => {
      const corners = pts.map((p) => ({ ...p }));
      if (cropPoly) {
        // Ořez mnohoúhelníkem + kotvy → SÍŤOVÁ dlaždice. Blob = CELÝ orientovaný zdroj
        // (JPEG), ořez i zkosení dělá až mesh v editoru. src = body normované na zdroj.
        const src = pts.map((p) => ({ x: p.x / nW, y: p.y / nH }));
        srcCanvasFull.toBlob((b) => close(b ? { blob: b, corners, rotDeg: rot * 90, mirror, mesh: { src, anchor: [...anchor] } } : null), 'image/jpeg', 0.85);
        return;
      }
      if (keepWhole) {
        // Narovnat podle obdélníku, zachovat celý snímek → PNG (průhledné okolí).
        const { canvas, aspect: outAspect } = warpKeepWhole(srcCanvasFull, pts, 1800);
        canvas.toBlob((b) => close(b ? { blob: b, corners, rotDeg: rot * 90, mirror, aspect: outAspect } : null), 'image/png');
        return;
      }
      const { w, h } = outSize(aspect, 1600);
      const dp = targets.map((t) => ({ x: t.x * w, y: t.y * h }));
      const out = warp(srcCanvasFull, pts, dp, w, h);
      out.toBlob((b) => close(b ? { blob: b, corners, rotDeg: rot * 90, mirror } : null), 'image/jpeg', 0.85);
    });
  });
}
