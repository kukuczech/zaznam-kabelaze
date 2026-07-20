// Export do DXF (AutoCAD R12 ASCII) — 2D čelní elevace všech stěn.
// Každá stěna je vlastní blok pod sebou; kategorie = vrstvy (barvy), trasy =
// polyliny v mm, kóty = čáry + text. Bez knihoven, čistý text.
import { project } from './db';
import { saveBlob } from './save-file';
import { exportableFaces, faceDrawOrder, polyCentroid, wallElevation, type Pt } from './export-geom';

// --- barvy: nejbližší AutoCAD Color Index k hex ---
const ACI: [number, [number, number, number]][] = [
  [1, [255, 0, 0]], [2, [255, 255, 0]], [3, [0, 255, 0]], [4, [0, 255, 255]],
  [5, [0, 0, 255]], [6, [255, 0, 255]], [7, [255, 255, 255]], [8, [128, 128, 128]],
  [9, [192, 192, 192]], [30, [255, 127, 0]], [40, [255, 191, 0]], [140, [0, 127, 255]],
  [210, [127, 0, 255]], [250, [51, 51, 51]],
];
function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function nearestAci(hex: string): number {
  const [r, g, b] = hexRgb(hex);
  let best = 7, bd = Infinity;
  for (const [aci, [cr, cg, cb]] of ACI) {
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bd) { bd = d; best = aci; }
  }
  return best;
}

/** Název vrstvy → jen [A-Z0-9_], diakritika pryč, velká písmena. */
function layerName(s: string): string {
  const map: Record<string, string> = { á: 'a', č: 'c', ď: 'd', é: 'e', ě: 'e', í: 'i', ň: 'n', ó: 'o', ř: 'r', š: 's', ť: 't', ú: 'u', ů: 'u', ý: 'y', ž: 'z' };
  return (s.toLowerCase().replace(/[áčďéěíňóřšťúůýž]/g, (c) => map[c] ?? c)
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()) || 'X';
}

/** Diakritika v TEXT/hodnotách → \U+XXXX (AutoCAD unicode escape). */
function dxfText(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    out += cp < 128 ? ch : `\\U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

class Dxf {
  private e: string[] = [];        // entity
  private layers = new Map<string, number>(); // name → aci
  private p(code: number, val: string | number): void { this.e.push(String(code), String(val)); }

  layer(name: string, aci: number): void { if (!this.layers.has(name)) this.layers.set(name, aci); }

  line(layer: string, a: Pt, b: Pt): void {
    this.p(0, 'LINE'); this.p(8, layer);
    this.p(10, a.x); this.p(20, a.y); this.p(30, 0);
    this.p(11, b.x); this.p(21, b.y); this.p(31, 0);
  }
  polyline(layer: string, pts: Pt[], widthMm = 0, closed = false): void {
    this.p(0, 'POLYLINE'); this.p(8, layer); this.p(66, 1); this.p(70, closed ? 1 : 0);
    if (widthMm > 0) { this.p(40, widthMm); this.p(41, widthMm); }
    for (const pt of pts) {
      this.p(0, 'VERTEX'); this.p(8, layer); this.p(10, pt.x); this.p(20, pt.y); this.p(30, 0);
      if (widthMm > 0) { this.p(40, widthMm); this.p(41, widthMm); }
    }
    this.p(0, 'SEQEND'); this.p(8, layer);
  }
  circle(layer: string, at: Pt, radius: number): void {
    this.p(0, 'CIRCLE'); this.p(8, layer);
    this.p(10, at.x); this.p(20, at.y); this.p(30, 0); this.p(40, radius);
  }
  text(layer: string, at: Pt, height: number, s: string, angle = 0, centerH = false): void {
    this.p(0, 'TEXT'); this.p(8, layer);
    this.p(10, at.x); this.p(20, at.y); this.p(30, 0);
    this.p(40, height); this.p(1, dxfText(s));
    if (angle) this.p(50, angle.toFixed(2));
    if (centerH) { this.p(72, 1); this.p(11, at.x); this.p(21, at.y); this.p(31, 0); }
  }

  build(): string {
    const out: string[] = [];
    const w = (code: number, val: string | number) => out.push(String(code), String(val));
    w(0, 'SECTION'); w(2, 'HEADER'); w(0, 'ENDSEC');
    // TABLES → LAYER
    w(0, 'SECTION'); w(2, 'TABLES');
    w(0, 'TABLE'); w(2, 'LAYER'); w(70, this.layers.size);
    for (const [name, aci] of this.layers) {
      w(0, 'LAYER'); w(2, name); w(70, 0); w(62, aci); w(6, 'CONTINUOUS');
    }
    w(0, 'ENDTAB'); w(0, 'ENDSEC');
    // ENTITIES
    w(0, 'SECTION'); w(2, 'ENTITIES');
    out.push(...this.e);
    w(0, 'ENDSEC'); w(0, 'EOF');
    return out.join('\r\n');
  }
}

export async function exportDxf(): Promise<void> {
  const faces = exportableFaces(project);
  const hasRooms = project.storeys.some((s) => (s.rooms ?? []).length > 0);
  if (!faces.length && !hasRooms) { alert('Projekt je prázdný — není co exportovat (nahrajte model nebo přidejte místnosti).'); return; }

  const dxf = new Dxf();
  dxf.layer('STENA', 7);
  dxf.layer('OTVORY', 8);
  dxf.layer('KOTY', 4);
  dxf.layer('POPIS', 7);
  dxf.layer('MISTNOSTI', 3);

  const GAPY = 1500;           // svislá mezera mezi stěnami (mm)
  const TXT = 150;             // výška textu (mm)
  let baseY = 0;               // horní stěna nahoře, další pod ní

  for (const { wall, side, storeyName } of faces) {
    const el = wallElevation(wall, side, storeyName, project.categories);
    const oy = baseY - el.height; // dolní hrana stěny
    const T = (p: Pt): Pt => ({ x: p.x, y: p.y + oy });

    // titulek nad stěnou (+ poznámka stěny pod titulkem)
    dxf.text('POPIS', { x: 0, y: baseY + TXT * 1.5 }, TXT, `${storeyName} — ${wall.name} · strana ${side}`);
    if (wall.note?.trim()) dxf.text('POPIS', { x: 0, y: baseY + TXT * 0.3 }, TXT * 0.85, `Pozn.: ${wall.note.trim()}`);

    // obrys
    dxf.polyline('STENA', el.outline.map(T), 0, true);
    // mřížka 500 mm (jemná, na vrstvě POPIS)
    for (const u of el.gridU) dxf.line('POPIS', T({ x: u, y: 0 }), T({ x: u, y: el.height }));
    for (const v of el.gridV) dxf.line('POPIS', T({ x: 0, y: v }), T({ x: el.len, y: v }));

    // otvory
    for (const o of el.openings) {
      const r: Pt[] = [{ x: o.x, y: o.y }, { x: o.x + o.w, y: o.y }, { x: o.x + o.w, y: o.y + o.h }, { x: o.x, y: o.y + o.h }];
      dxf.polyline('OTVORY', r.map(T), 0, true);
      dxf.text('OTVORY', T({ x: o.x + o.w / 2, y: o.y + o.h / 2 }), TXT, o.label, 0, true);
    }

    // Výdřeva (plošná deska) — obdélník + rozměr na vrstvě VYDREVY
    const drawArea = (a: typeof el.areas[number]): void => {
      dxf.layer('VYDREVY', nearestAci(a.color));
      const r: Pt[] = [
        { x: a.x, y: a.y }, { x: a.x + a.w, y: a.y },
        { x: a.x + a.w, y: a.y + a.h }, { x: a.x, y: a.y + a.h },
      ];
      dxf.polyline('VYDREVY', r.map(T), 0, true);
      dxf.text('VYDREVY', T({ x: a.x + a.w / 2, y: a.y + a.h / 2 }), TXT, a.label, 0, true);
    };

    // Trasa (na vrstvě své kategorie)
    const drawRoute = (rt: typeof el.routes[number]): void => {
      const ln = layerName(rt.catName || 'TRASA');
      dxf.layer(ln, nearestAci(rt.color));
      dxf.polyline(ln, rt.pts.map(T), Math.max(rt.widthMm, 0));
      for (const s of rt.segLabels) dxf.text(ln, T({ x: s.x, y: s.y + 80 }), TXT, s.text, 0, true);
    };

    // Osazený prvek (tvar ve skutečné velikosti + popisek na vrstvě své barvy)
    const drawFixture = (f: typeof el.fixtures[number]): void => {
      const ln = layerName('PRVEK_' + f.label);
      dxf.layer(ln, nearestAci(f.color));
      const hw = f.w / 2, hh = f.h / 2;
      if (f.shape === 'round') {
        // elipsa přibližně kružnicí o průměrné poloose (DXF R12 nemá spolehlivou ELLIPSE)
        dxf.circle(ln, T({ x: f.x, y: f.y }), (hw + hh) / 2);
      } else {
        dxf.polyline(ln, [
          { x: f.x - hw, y: f.y - hh }, { x: f.x + hw, y: f.y - hh },
          { x: f.x + hw, y: f.y + hh }, { x: f.x - hw, y: f.y + hh },
        ].map(T), 0, true);
      }
      dxf.text(ln, T({ x: f.x, y: f.y - hh - TXT }), TXT, f.label, 0, true);
    };

    // Obsah líce v pořadí vrstev napříč typy (odspodu nahoru); kóty až za tím.
    for (const item of faceDrawOrder(el)) {
      if (item.kind === 'area') drawArea(el.areas[item.index]);
      else if (item.kind === 'route') drawRoute(el.routes[item.index]);
      else drawFixture(el.fixtures[item.index]);
    }

    // kóty
    for (const d of el.dims) {
      if (d.point) {
        dxf.text('KOTY', T({ x: d.tx, y: d.ty + 80 }), TXT, d.text, 0, true);
      } else {
        dxf.line('KOTY', T(d.ext1[0]), T(d.ext1[1]));
        dxf.line('KOTY', T(d.ext2[0]), T(d.ext2[1]));
        dxf.line('KOTY', T(d.line[0]), T(d.line[1]));
        dxf.text('KOTY', T({ x: d.tx, y: d.ty }), TXT, d.text, d.angle, true);
      }
    }

    baseY = oy - GAPY;
  }

  // Půdorysy podlaží s pojmenovanými místnostmi (pod elevacemi).
  const PLAN_GAP = 3000; // mezera mezi půdorysy podlaží (mm)
  for (const s of project.storeys) {
    const rooms = s.rooms ?? [];
    if (!rooms.length) continue;
    let minX = Infinity, minY = Infinity, maxY = -Infinity;
    for (const r of rooms) for (const p of r.polygon) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const planH = maxY - minY;
    const oy = baseY - planH; // horní okraj půdorysu
    // model (x, y dolů) → CAD (x normalizované, y nahoru)
    const T = (p: Pt): Pt => ({ x: p.x - minX, y: (maxY - p.y) + oy });
    dxf.text('POPIS', { x: 0, y: baseY + TXT }, TXT, `${s.name} — půdorys`);
    for (const r of rooms) {
      dxf.polyline('MISTNOSTI', r.polygon.map(T), 0, true);
      const label = r.note?.trim() ? `${r.name} (${r.note.trim()})` : r.name;
      dxf.text('MISTNOSTI', T(polyCentroid(r.polygon)), TXT, label, 0, true);
    }
    baseY = oy - PLAN_GAP;
  }

  const blob = new Blob([dxf.build()], { type: 'application/dxf' });
  await saveBlob(blob, `zaznam-kabelaze-${new Date().toISOString().slice(0, 10)}.dxf`);
}
