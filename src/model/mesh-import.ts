// Import 3D meshe ze skeneru (Polycam / Scaniverse) → parametrický Storey.
// Alternativa k magicplan importu (ifc-import.ts): mesh skener zachytí skutečnou
// geometrii včetně šikmin, my z něj uděláme čistý parametrický model.
//
// Postup (docs/plan-lidar-laser-mereni.md, fáze 4):
//   1) parse OBJ / PLY (typicky v metrech) → vrcholy + trojúhelníky,
//   2) extrakce velkých rovin (greedy region-merge dle normály + kolmého offsetu),
//   3) klasifikace rovin: vodorovná dole = podlaha, nahoře = strop, svislá = stěna,
//      nakloněná = šikmina (SlopePlane z fáze 3),
//   4) z rovin postav graf rohů (fáze 0) + stěny + šikminy; rohy dostanou LiDAR
//      odhad, naměřené délky (measuredLengthMm) zůstávají prázdné → čekají na laser.
//
// Sken je jen počáteční odhad tvaru; laserové přeměření je pak pravda (stejný
// princip jako u IFC importu). Rohy se ukotví jako `lidar`, ať je pak solver
// (resolveStorey) po zadání měřených délek posune na místo.
import { emptyFace, newId, type Corner, type Room, type SlopePlane, type Storey, type Wall, type XY } from './types';
import { computeFaceTrims, computeRoomClearPolygons, rebuildAxes } from './geometry';

// --- Parsování meshe -------------------------------------------------------

type V3 = [number, number, number];
interface Mesh {
  verts: V3[];
  tris: [number, number, number][];
}

/** OBJ: řádky `v x y z` (vrcholy) a `f …` (plochy; polygony trianguluje vějířem). */
function parseObj(text: string): Mesh {
  const verts: V3[] = [];
  const tris: [number, number, number][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length < 2) continue;
    const c0 = line[0];
    if (c0 === 'v' && line[1] === ' ') {
      const p = line.slice(2).trim().split(/\s+/).map(Number);
      if (p.length >= 3 && p.every(Number.isFinite)) verts.push([p[0], p[1], p[2]]);
    } else if (c0 === 'f' && line[1] === ' ') {
      // token může být "i", "i/j", "i/j/k" nebo "i//k"; bereme jen index vrcholu.
      // Index je 1-based, záporný = relativní od konce seznamu vrcholů.
      const idx = line.slice(2).trim().split(/\s+/).map((t) => {
        const n = parseInt(t.split('/')[0], 10);
        return n < 0 ? verts.length + n : n - 1;
      }).filter((n) => n >= 0 && n < verts.length);
      for (let i = 2; i < idx.length; i++) tris.push([idx[0], idx[i - 1], idx[i]]);
    }
  }
  return { verts, tris };
}

const PLY_SIZE: Record<string, number> = {
  char: 1, uchar: 1, int8: 1, uint8: 1,
  short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4,
  double: 8, float64: 8,
};

/** Přečte jednu skalární hodnotu daného PLY typu z DataView; vrátí [hodnota, další offset]. */
function plyRead(dv: DataView, off: number, type: string, le: boolean): [number, number] {
  switch (type) {
    case 'char': case 'int8': return [dv.getInt8(off), off + 1];
    case 'uchar': case 'uint8': return [dv.getUint8(off), off + 1];
    case 'short': case 'int16': return [dv.getInt16(off, le), off + 2];
    case 'ushort': case 'uint16': return [dv.getUint16(off, le), off + 2];
    case 'int': case 'int32': return [dv.getInt32(off, le), off + 4];
    case 'uint': case 'uint32': return [dv.getUint32(off, le), off + 4];
    case 'float': case 'float32': return [dv.getFloat32(off, le), off + 4];
    case 'double': case 'float64': return [dv.getFloat64(off, le), off + 8];
    default: return [0, off + (PLY_SIZE[type] ?? 4)];
  }
}

/** PLY (ASCII i binary_little/big_endian). Čte element `vertex` (x,y,z) a `face` (list indexů). */
function parsePly(buf: ArrayBuffer): Mesh {
  const bytes = new Uint8Array(buf);
  // Hlavička je vždy ASCII, končí řádkem "end_header".
  const headEnd = findEndHeader(bytes);
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, headEnd));
  const lines = header.split(/\r?\n/);

  let format = 'ascii';
  const elements: { name: string; count: number; props: { name: string; type: string; isList?: boolean; countType?: string }[] }[] = [];
  for (const raw of lines) {
    const t = raw.trim().split(/\s+/);
    if (t[0] === 'format') format = t[1];
    else if (t[0] === 'element') elements.push({ name: t[1], count: parseInt(t[2], 10), props: [] });
    else if (t[0] === 'property' && elements.length) {
      const el = elements[elements.length - 1];
      if (t[1] === 'list') el.props.push({ name: t[4], type: t[3], isList: true, countType: t[2] });
      else el.props.push({ name: t[2], type: t[1] });
    }
  }

  const verts: V3[] = [];
  const tris: [number, number, number][] = [];

  if (format === 'ascii') {
    const body = new TextDecoder('ascii').decode(bytes.subarray(headEnd)).split(/\r?\n/).filter((l) => l.trim());
    let li = 0;
    for (const el of elements) {
      for (let i = 0; i < el.count; i++) {
        const nums = (body[li++] ?? '').trim().split(/\s+/).map(Number);
        if (el.name === 'vertex') {
          const ix = el.props.findIndex((p) => p.name === 'x');
          verts.push([nums[ix], nums[ix + 1], nums[ix + 2]]);
        } else if (el.name === 'face') {
          const k = nums[0]; // počet vrcholů plochy
          const poly = nums.slice(1, 1 + k);
          for (let j = 2; j < poly.length; j++) tris.push([poly[0], poly[j - 1], poly[j]]);
        }
      }
    }
  } else {
    const le = format === 'binary_little_endian';
    const dv = new DataView(buf);
    let off = headEnd;
    for (const el of elements) {
      const xi = el.props.findIndex((p) => p.name === 'x');
      for (let i = 0; i < el.count; i++) {
        if (el.name === 'vertex') {
          const v: number[] = [];
          for (const p of el.props) { const [val, no] = plyRead(dv, off, p.type, le); off = no; v.push(val); }
          verts.push([v[xi], v[xi + 1], v[xi + 2]]);
        } else if (el.name === 'face') {
          for (const p of el.props) {
            if (p.isList) {
              const [k, no] = plyRead(dv, off, p.countType!, le); off = no;
              const poly: number[] = [];
              for (let j = 0; j < k; j++) { const [vi, n2] = plyRead(dv, off, p.type, le); off = n2; poly.push(vi); }
              for (let j = 2; j < poly.length; j++) tris.push([poly[0], poly[j - 1], poly[j]]);
            } else { off = plyRead(dv, off, p.type, le)[1]; }
          }
        } else {
          // neznámý element (např. edge) — jen přeskoč jeho bajty
          for (const p of el.props) {
            if (p.isList) { const [k, no] = plyRead(dv, off, p.countType!, le); off = no + k * (PLY_SIZE[p.type] ?? 4); }
            else off += PLY_SIZE[p.type] ?? 4;
          }
        }
      }
    }
  }
  return { verts, tris };
}

/** Najde offset ZA řádkem "end_header" (včetně jeho \n) v bajtech PLY. */
function findEndHeader(bytes: Uint8Array): number {
  const needle = 'end_header';
  for (let i = 0; i + needle.length < bytes.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle.charCodeAt(j)) { ok = false; break; }
    if (ok) {
      let k = i + needle.length;
      while (k < bytes.length && bytes[k] !== 0x0a) k++; // do konce řádku
      return k + 1;
    }
  }
  return 0;
}

// --- Geometrie: normály, plochy, roviny ------------------------------------

interface Tri { n: V3; area: number; c: V3; verts: V3[]; }
interface Plane { n: V3; d: number; area: number; verts: V3[]; }

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): number => Math.hypot(a[0], a[1], a[2]);

/** Auto-detekce jednotek: skenery exportují v metrech; když je bbox „malý", škáluj ×1000 na mm. */
function unitScale(verts: V3[]): number {
  let lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const v of verts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  return diag < 100 ? 1000 : 1; // < 100 j. ⇒ metry (dům ~desítky m) → na mm
}

// Tolerance slučování rovin a klasifikace.
const MERGE_COS = Math.cos((15 * Math.PI) / 180); // shodná normála roviny (do 15°)
const MERGE_DIST = 120;                            // shodný kolmý offset roviny (mm)
const HORIZ_COS = Math.cos((22 * Math.PI) / 180);  // |n·up| ≥ ⇒ vodorovná rovina
const VERT_SIN = Math.sin((22 * Math.PI) / 180);   // |n·up| ≤ ⇒ svislá stěna

/** Trojúhelníky s normálou, plochou a těžištěm (v mm). Degenerované (nulová plocha) vynechá. */
function buildTris(mesh: Mesh, scale: number): Tri[] {
  const out: Tri[] = [];
  for (const [ia, ib, ic] of mesh.tris) {
    const a = mesh.verts[ia], b = mesh.verts[ib], c = mesh.verts[ic];
    if (!a || !b || !c) continue;
    const A: V3 = [a[0] * scale, a[1] * scale, a[2] * scale];
    const B: V3 = [b[0] * scale, b[1] * scale, b[2] * scale];
    const C: V3 = [c[0] * scale, c[1] * scale, c[2] * scale];
    const cr = cross(sub(B, A), sub(C, A));
    const area = norm(cr) / 2;
    if (area < 1) continue; // < 1 mm² → šum
    out.push({
      n: [cr[0] / (2 * area), cr[1] / (2 * area), cr[2] / (2 * area)],
      area,
      c: [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3, (A[2] + B[2] + C[2]) / 3],
      verts: [A, B, C], // rohy pro pozdější rozsah stěny / šikminy
    });
  }
  return out;
}

/**
 * Osa „nahoru" (gravitace): index (0/1/2), podél které leží NEJVĚTŠÍ JEDNOTLIVÁ
 * vodorovná rovina (podlaha bývá největší souvislá plocha v místnosti). Součet
 * ploch nelze — velké štítové stěny (kolmé na vodorovnou osu) by ho přebily; jedna
 * velká podlaha ale porazí každou dílčí stěnu. Skenery navíc exportují gravitačně
 * zarovnaně (Y-up), takže stačí najít nejsilnější vodorovnou rovinu.
 */
function detectUpAxis(planes: Plane[]): number {
  const best = [0, 0, 0];
  for (const p of planes) for (let k = 0; k < 3; k++) if (Math.abs(p.n[k]) > 0.9) best[k] = Math.max(best[k], p.area);
  return best[0] >= best[1] && best[0] >= best[2] ? 0 : best[1] >= best[2] ? 1 : 2;
}

/**
 * Greedy extrakce rovin: trojúhelníky od největšího slučuje do rovin se shodnou
 * normálou (do MERGE_COS) a shodným kolmým offsetem (do MERGE_DIST). Rovina drží
 * plošně váženou normálu/offset a všechny své vrcholy (pro pozdější rozsah).
 */
function extractPlanes(tris: Tri[]): Plane[] {
  const planes: (Plane & { sn: V3; sd: number })[] = [];
  for (const t of [...tris].sort((a, b) => b.area - a.area)) {
    const off = dot(t.n, t.c);
    let best: (Plane & { sn: V3; sd: number }) | null = null;
    for (const p of planes) {
      if (Math.abs(dot(t.n, p.n)) < MERGE_COS) continue;          // jiná orientace
      const sign = dot(t.n, p.n) >= 0 ? 1 : -1;                   // opačně otočený sken téže roviny
      if (Math.abs(sign * off - p.d) > MERGE_DIST) continue;      // jiný kolmý offset
      best = p; break;
    }
    if (best) {
      const sign = dot(t.n, best.n) >= 0 ? 1 : -1;
      best.sn = [best.sn[0] + sign * t.n[0] * t.area, best.sn[1] + sign * t.n[1] * t.area, best.sn[2] + sign * t.n[2] * t.area];
      best.sd += sign * off * t.area;
      best.area += t.area;
      const L = norm(best.sn) || 1;
      best.n = [best.sn[0] / L, best.sn[1] / L, best.sn[2] / L];
      best.d = best.sd / best.area;
      best.verts.push(...t.verts);
    } else {
      planes.push({ n: [...t.n] as V3, d: off, area: t.area, verts: [...t.verts], sn: [t.n[0] * t.area, t.n[1] * t.area, t.n[2] * t.area], sd: off * t.area });
    }
  }
  // ponech jen výrazné roviny (odfiltruj drobný nábytek / šum)
  const maxA = Math.max(...planes.map((p) => p.area), 1);
  return planes.filter((p) => p.area >= maxA * 0.04 || p.area >= 300000).map((p) => ({ n: p.n, d: p.d, area: p.area, verts: p.verts }));
}

// --- Stavba modelu z rovin -------------------------------------------------

/** Průsečík dvou přímek v rovině (bod + směr); null když jsou téměř rovnoběžné. */
function lineX(p0: XY, d0: XY, p1: XY, d1: XY): XY | null {
  const den = d0.x * d1.y - d0.y * d1.x;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((p1.x - p0.x) * d1.y - (p1.y - p0.y) * d1.x) / den;
  return { x: p0.x + t * d0.x, y: p0.y + t * d0.y };
}

interface WallCand { p: XY; dir: XY; a: XY; b: XY; topH: number; }

/**
 * Sestaví Storey z naimportovaného meshe. Osu „nahoru" detekuje, zbylé dvě osy
 * mapuje na půdorys (u, v). Svislé roviny → stěny (obvod z jejich průsečíků),
 * nakloněné → šikminy navázané na kolenní stěnu. Jedna místnost (víc místností =
 * budoucí slícování; celý mesh se bere jako jedna).
 */
function meshToStorey(mesh: Mesh, name: string): Storey {
  const scale = unitScale(mesh.verts);
  const tris = buildTris(mesh, scale);
  if (tris.length < 4) throw new Error('Mesh nemá dost trojúhelníků (prázdný nebo nečitelný soubor).');

  const planes = extractPlanes(tris);
  const up = detectUpAxis(planes);
  const [i1, i2] = [0, 1, 2].filter((k) => k !== up); // půdorysné osy (u, v)
  const planUV = (p: V3): XY => ({ x: p[i1], y: p[i2] });
  const height = (p: V3): number => p[up];

  // Výška podlahy = min výška (podlahové roviny leží nejníž); posuneme ji na 0.
  let floorH = Infinity, ceilH = -Infinity;
  for (const t of tris) for (const v of t.verts ?? []) { floorH = Math.min(floorH, height(v)); ceilH = Math.max(ceilH, height(v)); }
  const H = (p: V3): number => height(p) - floorH; // výška ode dna

  // Klasifikace rovin.
  const wallsP: Plane[] = [], slopesP: Plane[] = [];
  for (const p of planes) {
    const vc = Math.abs(p.n[up]);
    if (vc >= HORIZ_COS) continue;      // podlaha/strop — jen kontext, stěny z nich neděláme
    if (vc <= VERT_SIN) wallsP.push(p); // svislá → stěna
    else slopesP.push(p);               // nakloněná → šikmina
  }

  // Kandidáti stěn: z každé svislé roviny přímka v půdorysu (směr ⊥ vodorovné normály)
  // a rozsah (min/max projekce jejích vrcholů) → úsečka + výška horní hrany.
  const cands: WallCand[] = [];
  for (const p of wallsP) {
    const nh = { x: p.n[i1], y: p.n[i2] };
    const nl = Math.hypot(nh.x, nh.y) || 1;
    const dir = { x: -nh.y / nl, y: nh.x / nl }; // podél stěny
    let sum = { x: 0, y: 0 }, cnt = 0, top = 0;
    for (const v of p.verts) { const q = planUV(v); sum.x += q.x; sum.y += q.y; cnt++; top = Math.max(top, H(v)); }
    const mid = { x: sum.x / cnt, y: sum.y / cnt };
    let tmin = Infinity, tmax = -Infinity;
    for (const v of p.verts) { const q = planUV(v); const t = (q.x - mid.x) * dir.x + (q.y - mid.y) * dir.y; tmin = Math.min(tmin, t); tmax = Math.max(tmax, t); }
    cands.push({ p: mid, dir, a: { x: mid.x + dir.x * tmin, y: mid.y + dir.y * tmin }, b: { x: mid.x + dir.x * tmax, y: mid.y + dir.y * tmax }, topH: Math.round(top) });
  }
  if (cands.length < 3) throw new Error('Ze skenu se nepodařilo rozpoznat aspoň 3 stěny.');

  // Obvod místnosti: stěny seřaď kolem těžiště a rohy najdi jako průsečíky
  // sousedních přímek (jako RoomPlan). Funguje pro konvexní/mírně nekonvexní obrys.
  let cx = 0, cy = 0;
  for (const w of cands) { cx += (w.a.x + w.b.x) / 2; cy += (w.a.y + w.b.y) / 2; }
  cx /= cands.length; cy /= cands.length;
  const ordered = [...cands].sort((wA, wB) => {
    const ma = { x: (wA.a.x + wA.b.x) / 2, y: (wA.a.y + wA.b.y) / 2 };
    const mb = { x: (wB.a.x + wB.b.x) / 2, y: (wB.a.y + wB.b.y) / 2 };
    return Math.atan2(ma.y - cy, ma.x - cx) - Math.atan2(mb.y - cy, mb.x - cx);
  });
  const n = ordered.length;
  // corner[i] = průsečík ordered[i] a ordered[i+1]; ordered[i] jde od corner[i-1] k corner[i].
  const cpts: XY[] = [];
  for (let i = 0; i < n; i++) {
    const w0 = ordered[i], w1 = ordered[(i + 1) % n];
    const hit = lineX(w0.p, w0.dir, w1.p, w1.dir);
    // rovnoběžné (rovná pokračující stěna) → vezmi konec bližší mezi segmenty
    cpts.push(hit ? { x: Math.round(hit.x), y: Math.round(hit.y) } : { x: Math.round((w0.b.x + w1.a.x) / 2), y: Math.round((w0.b.y + w1.a.y) / 2) });
  }

  const corners: Corner[] = cpts.map((p) => ({ id: newId(), x: p.x, y: p.y, lidar: { x: p.x, y: p.y } }));
  const walls: Wall[] = [];
  for (let i = 0; i < n; i++) {
    const ca = corners[(i - 1 + n) % n], cb = corners[i];
    walls.push({
      id: newId(),
      ifcGuid: '',
      name: `Stěna ${i + 1}`,
      axis: [{ x: ca.x, y: ca.y }, { x: cb.x, y: cb.y }],
      a: ca.id, b: cb.id,
      thicknessMm: 150,      // jednostranný sken → tloušťka neznámá, výchozí; doladí měření
      heightMm: Math.max(1, ordered[i].topH),
      openings: [],
      faces: { A: emptyFace(), B: emptyFace() },
    });
  }

  const wallHeightMm = Math.max(1, Math.round(ceilH - floorH));

  // Šikminy: každá nakloněná rovina → SlopePlane navázaná na nejbližší rovnoběžnou
  // kolenní (base) stěnu na její NÍZKÉ straně.
  const slopes: SlopePlane[] = [];
  for (const sp of slopesP) {
    const vc = Math.abs(sp.n[up]);
    const angleDeg = Math.round((Math.acos(Math.min(1, vc)) * 180) / Math.PI); // sklon od vodorovné
    let kneeH = Infinity, ridgeH = -Infinity;
    let loSum = { x: 0, y: 0 }, loCnt = 0;
    for (const v of sp.verts) { const h = H(v); kneeH = Math.min(kneeH, h); ridgeH = Math.max(ridgeH, h); }
    // těžiště nízké hrany (body do 200 mm nad nejnižším bodem šikminy)
    for (const v of sp.verts) if (H(v) <= kneeH + 200) { const q = planUV(v); loSum.x += q.x; loSum.y += q.y; loCnt++; }
    const lo = loCnt ? { x: loSum.x / loCnt, y: loSum.y / loCnt } : planUV(sp.verts[0]);
    const nh = { x: sp.n[i1], y: sp.n[i2] };
    const nhl = Math.hypot(nh.x, nh.y) || 1;
    const edgeDir = { x: -nh.y / nhl, y: nh.x / nhl }; // směr vodorovné hrany šikminy
    // base = stěna nejlépe rovnoběžná s hranou a nejblíž k nízké hraně
    let baseId = '', bestScore = -Infinity;
    for (let i = 0; i < n; i++) {
      const w = ordered[i];
      const par = Math.abs(w.dir.x * edgeDir.x + w.dir.y * edgeDir.y); // 1 = rovnoběžná
      const mx = (w.a.x + w.b.x) / 2, my = (w.a.y + w.b.y) / 2;
      const dist = Math.hypot(mx - lo.x, my - lo.y);
      const score = par * 2 - dist / 1000;
      if (score > bestScore) { bestScore = score; baseId = walls[i].id; }
    }
    if (baseId) slopes.push({ id: newId(), baseWallId: baseId, kneeHeightMm: Math.round(Math.max(0, kneeH)), ridgeHeightMm: Math.round(ridgeH), angleDeg });
  }

  const room: Room = { id: newId(), name: 'Místnost 1', polygon: cpts.map((p) => ({ ...p })) };

  const storey: Storey = {
    id: newId(),
    name,
    wallHeightMm,
    walls,
    rooms: [room],
    corners,
    slopes: slopes.length ? slopes : undefined,
  };

  // Sjednoť pořadí přepočtů jako u ostatních importů: osa z rohů → ořezy → světlé obrysy.
  rebuildAxes(storey);
  computeFaceTrims(storey.walls);
  computeRoomClearPolygons(storey.walls, storey.rooms ?? []);
  return storey;
}

/**
 * Naimportuje OBJ nebo PLY soubor jako jedno podlaží (jedna místnost). Formát se
 * pozná dle přípony, u nejednoznačné se detekuje z obsahu (magic "ply").
 */
export async function importMesh(file: File): Promise<Storey> {
  const buf = await file.arrayBuffer();
  const text = new TextDecoder().decode(buf);
  const head = text.slice(0, 4);

  // Náš vlastní LiDAR export je jen extrudované stěny + šikmina jako plochý plát —
  // BEZ podlahy/stropu. Heuristika níž (detectUpAxis) čeká podlahu jako největší
  // vodorovnou plochu, tady ji nenajde a splete si osu „nahoru" → rozbitý půdorys.
  // Pro tenhle mesh existuje bezztrátový scan.json (viz hlavička „source: scan.json“),
  // proto ho odmítneme s jasnou instrukcí místo tiché rekonstrukce nesmyslu.
  if (/#\s*LiDAR parametric model export|source:\s*parametric scan\.json/i.test(text.slice(0, 400))) {
    throw new Error(
      'Tohle je náš parametrický export (scan.obj) — je to jen doprovodný mesh na 3D náhled. '
      + 'Naimportuj místo něj vedlejší scan.json (nebo celý ZIP skenu); bude přesný včetně otvorů a šikmin.',
    );
  }

  const isPly = /\.ply$/i.test(file.name) || head.startsWith('ply');
  const mesh = isPly ? parsePly(buf) : parseObj(text);
  if (!mesh.verts.length) throw new Error('Soubor neobsahuje žádné vrcholy.');
  return meshToStorey(mesh, file.name.replace(/\.(obj|ply)$/i, ''));
}
