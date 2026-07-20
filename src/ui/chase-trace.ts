// Asistované „magnetické" trasování šlicu nad narovnaným podkladem stěny.
// Z podkladu se udělá rastr nákladů (tmavé pixely = levné) a mezi dvěma body
// se Dijkstrou najde nejtmavší cesta — uživatel ťuká jen zhruba podél drážky
// a linka se přisaje na vysekaný sek. Souřadnice v PIXELECH rastru; převod
// do (u, v) mm řeší volající (zná stranu i rozměry stěny).

type P = { x: number; y: number };

export interface CostField {
  w: number;
  h: number;
  /** Jas 0..1 na pixel (řádkově y*w+x). Tmavší = nižší = preferované. */
  gray: Float32Array;
}

/**
 * Podklad (blob nebo už složený canvas) zmenší na max. maxDim px delší stranou
 * a spočte šedotón. Canvas umožní složit víc dlaždic do jednoho rastru, aby
 * přichytávání zohledňovalo všechny textury líce dohromady.
 */
export async function buildCostField(source: Blob | HTMLCanvasElement, maxDim = 480): Promise<CostField> {
  let sw: number, sh: number;
  let bmp: ImageBitmap | null = null;
  if (source instanceof Blob) { bmp = await createImageBitmap(source); sw = bmp.width; sh = bmp.height; }
  else { sw = source.width; sh = source.height; }
  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d')!;
  ctx.drawImage(bmp ?? (source as HTMLCanvasElement), 0, 0, w, h);
  bmp?.close?.();
  const d = ctx.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
  }
  return { w, h, gray };
}

const LAMBDA = 0.08; // základní cena kroku — drží cestu krátkou, ať netančí po šumu
const DARK = 1.0;    // váha tmavosti — o kolik je tmavý pixel „levnější" než světlý

/**
 * Najde nejtmavší cestu z bodu a do bodu b (px rastru). Hledá jen v okolí
 * úsečky a–b, takže linka zůstane lokální a výpočet je rychlý. Vrací lomenou
 * čáru VČETNĚ obou krajních bodů, zjednodušenou Douglas–Peuckerem.
 */
export function snapPathPx(f: CostField, a: P, b: P, padPx = 40): P[] {
  const ax = clampI(Math.round(a.x), 0, f.w - 1), ay = clampI(Math.round(a.y), 0, f.h - 1);
  const bx = clampI(Math.round(b.x), 0, f.w - 1), by = clampI(Math.round(b.y), 0, f.h - 1);

  const pad = Math.max(padPx, Math.round(Math.hypot(bx - ax, by - ay) * 0.3));
  const x0 = clampI(Math.min(ax, bx) - pad, 0, f.w - 1);
  const x1 = clampI(Math.max(ax, bx) + pad, 0, f.w - 1);
  const y0 = clampI(Math.min(ay, by) - pad, 0, f.h - 1);
  const y1 = clampI(Math.max(ay, by) + pad, 0, f.h - 1);
  const gw = x1 - x0 + 1, gh = y1 - y0 + 1, n = gw * gh;
  const idx = (x: number, y: number) => (y - y0) * gw + (x - x0);

  const dist = new Float32Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new MinHeap(n);
  const s = idx(ax, ay), t = idx(bx, by);
  dist[s] = 0;
  heap.push(s, 0);

  // 8 sousedů: [dx, dy, délka kroku]
  const nb: [number, number, number][] = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142],
  ];

  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === t) break;
    const ux = x0 + (u % gw), uy = y0 + ((u / gw) | 0);
    for (const [dx, dy, step] of nb) {
      const nx = ux + dx, ny = uy + dy;
      if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
      const vId = idx(nx, ny);
      if (done[vId]) continue;
      const g = f.gray[ny * f.w + nx];
      const nd = dist[u] + step * (g * DARK + LAMBDA);
      if (nd < dist[vId]) { dist[vId] = nd; prev[vId] = u; heap.push(vId, nd); }
    }
  }

  if (prev[t] === -1 && t !== s) return [{ x: ax, y: ay }, { x: bx, y: by }]; // nespojeno → přímá

  const path: P[] = [];
  for (let cur = t; cur !== -1; cur = prev[cur]) {
    path.push({ x: x0 + (cur % gw), y: y0 + ((cur / gw) | 0) });
    if (cur === s) break;
  }
  path.reverse();
  return simplifyPath(path, 2.5);
}

function clampI(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Douglas–Peucker: zredukuje lomenou čáru, krajní body zachová. */
export function simplifyPath(pts: P[], tol: number): P[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let maxD = -1, maxK = -1;
    for (let k = i + 1; k < j; k++) {
      const d = perpDist(pts[k], pts[i], pts[j]);
      if (d > maxD) { maxD = d; maxK = k; }
    }
    if (maxD > tol && maxK !== -1) { keep[maxK] = 1; stack.push([i, maxK], [maxK, j]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function perpDist(p: P, a: P, b: P): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/** Binární minimální halda (node, priorita); decrease-key emulován líným vkládáním. */
class MinHeap {
  private ns: Int32Array;
  private ps: Float32Array;
  size = 0;

  constructor(cap: number) {
    this.ns = new Int32Array(cap + 1);
    this.ps = new Float32Array(cap + 1);
  }

  push(n: number, p: number): void {
    if (this.size + 2 >= this.ns.length) this.grow();
    let i = ++this.size;
    this.ns[i] = n; this.ps[i] = p;
    while (i > 1) {
      const par = i >> 1;
      if (this.ps[par] <= this.ps[i]) break;
      this.swap(par, i); i = par;
    }
  }

  pop(): number {
    const top = this.ns[1];
    this.ns[1] = this.ns[this.size]; this.ps[1] = this.ps[this.size]; this.size--;
    let i = 1;
    while (true) {
      const l = i * 2, r = l + 1;
      let m = i;
      if (l <= this.size && this.ps[l] < this.ps[m]) m = l;
      if (r <= this.size && this.ps[r] < this.ps[m]) m = r;
      if (m === i) break;
      this.swap(m, i); i = m;
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const n = this.ns[a]; this.ns[a] = this.ns[b]; this.ns[b] = n;
    const p = this.ps[a]; this.ps[a] = this.ps[b]; this.ps[b] = p;
  }

  private grow(): void {
    const nn = new Int32Array(this.ns.length * 2); nn.set(this.ns); this.ns = nn;
    const np = new Float32Array(this.ps.length * 2); np.set(this.ps); this.ps = np;
  }
}
