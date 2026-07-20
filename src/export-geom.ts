// Sdílený výpočet geometrie čelní elevace jednoho líce stěny (A/B) pro exporty
// (DXF, PDF). Souřadnice v (u, v) mm, osa v míří NAHORU (v=0 = podlaha); u je už
// v ZOBRAZOVACÍM směru (strana B je zrcadlená jako v editoru). Jednotliví
// exportéři si osu y případně převrátí podle formátu.
import { displayU, faceLenMm } from './model/geometry';
import { FIXTURE_DEFS, FIXTURE_KINDS, fixtureSize, fixtureCaption, isCategoryVisible, type Anchor, type Category, type FixtureKind, type Project, type Wall, type WallSide } from './model/types';
import { dimEndpoints } from './ui/wall-svg';

export interface Pt { x: number; y: number }

export interface ExpRoute {
  color: string;
  catName: string;
  widthMm: number;
  pts: Pt[];
  /** Popisky naměřených délek segmentů (uprostřed segmentu). */
  segLabels: { x: number; y: number; text: string }[];
  /** Index vrstvy v pořadí (menší = výše v seznamu = navrchu). Pro faceDrawOrder. */
  rank: number;
}

export interface ExpOpening {
  /** Levý dolní roh (u, v) a rozměry. */
  x: number; y: number; w: number; h: number;
  label: string;
}

export interface ExpDim {
  ext1: [Pt, Pt];
  ext2: [Pt, Pt];
  line: [Pt, Pt];
  /** Poloha a natočení popisku (stupně, CCW). */
  tx: number; ty: number; angle: number;
  text: string;
  /** true = degenerovaná (bodová) kóta — kreslí jen značku + text. */
  point: boolean;
}

export interface ExpFixture {
  /** Střed prvku (u, v). */
  x: number; y: number;
  /** Rozměry a tvar značky. */
  w: number; h: number;
  shape: 'rect' | 'round';
  color: string;
  label: string;
  /** Index vrstvy v pořadí (menší = výše v seznamu = navrchu). Pro faceDrawOrder. */
  rank: number;
}

export interface ExpArea {
  /** Levý dolní roh (u zobrazovací, v) + rozměry — výdřeva jako obdélník. */
  x: number; y: number; w: number; h: number;
  color: string;
  label: string;
  /** Index vrstvy v pořadí (menší = výše v seznamu = navrchu). Pro faceDrawOrder. */
  rank: number;
}

export interface WallElevation {
  wall: Wall;
  side: WallSide;
  storeyName: string;
  len: number;
  height: number;
  outline: Pt[];       // obrys stěny (4 rohy, y nahoru)
  gridU: number[];     // svislé čáry mřížky (u)
  gridV: number[];     // vodorovné čáry mřížky (v)
  openings: ExpOpening[];
  routes: ExpRoute[];
  dims: ExpDim[];
  fixtures: ExpFixture[];
  /** Výdřevy (plošné desky) na líci — z viditelných vrstev. */
  areas: ExpArea[];
  /** Typy prvků použité na líci (legenda) — z viditelných vrstev. */
  usedFixtures: { label: string; color: string; shape: 'rect' | 'round' }[];
  usedCats: { name: string; color: string }[];
  notes: { catName: string; color: string; note: string }[];
  /** Uživatelská poznámka ke stěně (mimo poznámky tras). */
  wallNote: string;
}

const OFF = 300, OVER = 90, GAP = 40; // odsazení kót — sedí s wall-svg.ts

function catOf(cats: Category[], id: string): Category | undefined {
  return cats.find((c) => c.id === id);
}

/** Spočítá elevaci jednoho líce stěny (A/B) do primitiv nezávislých na formátu. */
export function wallElevation(wall: Wall, side: WallSide, storeyName: string, cats: Category[]): WallElevation {
  const len = faceLenMm(wall, side); // délka viditelného líce (bez zazděných rohů)
  const H = wall.heightMm;
  const face = wall.faces[side];
  // Zobrazovací u: strana A identita, strana B zrcadlí (len − u) — jako editor/tisk.
  const mx = (u: number): number => displayU(wall, u, side);

  // Filtr vrstev: skryté kategorie se do exportu (PDF/DXF) nedostanou.
  const catVisible = (id: string | undefined): boolean => isCategoryVisible(catOf(cats, id ?? ''));
  // Pořadí vrstvy (menší index = výše v seznamu = navrchu) — pro řazení vykreslení.
  const catRank = new Map(cats.map((c, i) => [c.id, i]));
  const rankOf = (id: string): number => catRank.get(id) ?? Number.MAX_SAFE_INTEGER;
  const anchorHidden = (a: Anchor): boolean => {
    if (a.kind === 'routePoint' || a.kind === 'routeSeg') {
      const r = face.routes.find((x) => x.id === a.routeId);
      return !!r && !catVisible(r.categoryId);
    }
    if (a.kind === 'fixture') {
      const f = face.fixtures.find((x) => x.id === a.fixtureId);
      return !!f && !catVisible(f.categoryId);
    }
    if (a.kind === 'area') {
      const ar = face.areas.find((x) => x.id === a.areaId);
      return !!ar && !catVisible(ar.categoryId);
    }
    return false;
  };

  const gridU: number[] = [];
  const gridV: number[] = [];
  for (let u = 500; u < len; u += 500) gridU.push(u);
  for (let v = 500; v < H; v += 500) gridV.push(v);

  const openings: ExpOpening[] = wall.openings.map((o) => ({
    x: mx(o.uMm) - o.widthMm / 2,
    y: o.vMm - o.heightMm / 2,
    w: o.widthMm,
    h: o.heightMm,
    label: o.kind === 'door' ? 'Dveře' : 'Okno',
  }));

  // Pořadí napříč typy řeší faceDrawOrder (dle rank); tady stačí přirozené pořadí.
  const routes: ExpRoute[] = [];
  for (const r of face.routes) {
    if (r.points.length < 2) continue;
    const cat = catOf(cats, r.categoryId);
    if (!isCategoryVisible(cat)) continue; // skrytá vrstva
    const pts = r.points.map((p) => ({ x: mx(p.x), y: p.y }));
    const segLabels: { x: number; y: number; text: string }[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const meas = r.segLengthsMm[i];
      if (meas == null) continue;
      segLabels.push({ x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2, text: `${meas}` });
    }
    routes.push({ color: cat?.color ?? '#22d3ee', catName: cat?.name ?? '', widthMm: r.widthMm, pts, segLabels, rank: rankOf(r.categoryId) });
  }

  const cx = len / 2, cy = H / 2;
  const dims: ExpDim[] = [];
  for (const dim of face.dims) {
    if (anchorHidden(dim.from) || anchorHidden(dim.to)) continue; // kóta na skrytou vrstvu
    const ep = dimEndpoints(wall, side, dim);
    if (!ep) continue;
    const a = { x: mx(ep.a.uMm), y: ep.a.vMm };
    const b = { x: mx(ep.b.uMm), y: ep.b.vMm };
    const value = dim.valueMm ?? Math.round(Math.hypot(b.x - a.x, b.y - a.y));
    const text = `${value}${dim.valueMm == null ? '?' : ''}`;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg < 1) {
      dims.push({ ext1: [a, a], ext2: [b, b], line: [a, b], tx: a.x, ty: a.y, angle: 0, text, point: true });
      continue;
    }
    const dxu = (b.x - a.x) / seg, dyu = (b.y - a.y) / seg;
    let nx = -dyu, ny = dxu;
    if (nx * ((a.x + b.x) / 2 - cx) + ny * ((a.y + b.y) / 2 - cy) < 0) { nx = -nx; ny = -ny; }
    const A = { x: a.x + nx * OFF, y: a.y + ny * OFF };
    const B = { x: b.x + nx * OFF, y: b.y + ny * OFF };
    let ang = Math.atan2(dyu, dxu) * 180 / Math.PI;
    if (ang > 90) ang -= 180; else if (ang < -90) ang += 180;
    dims.push({
      ext1: [{ x: a.x + nx * GAP, y: a.y + ny * GAP }, { x: a.x + nx * (OFF + OVER), y: a.y + ny * (OFF + OVER) }],
      ext2: [{ x: b.x + nx * GAP, y: b.y + ny * GAP }, { x: b.x + nx * (OFF + OVER), y: b.y + ny * (OFF + OVER) }],
      line: [A, B],
      tx: (A.x + B.x) / 2 + nx * 95,
      ty: (A.y + B.y) / 2 + ny * 95,
      angle: ang,
      text,
      point: false,
    });
  }

  // Pořadí napříč typy řeší faceDrawOrder (dle rank); tady stačí přirozené pořadí.
  const fixtures: ExpFixture[] = face.fixtures
    .filter((f) => catVisible(f.categoryId))
    .map((f) => {
      const def = FIXTURE_DEFS[f.kind];
      const sz = fixtureSize(f);
      return {
        x: mx(f.uMm),
        y: f.vMm,
        w: sz.w,
        h: sz.h,
        shape: def.shape,
        color: def.color,
        label: fixtureCaption(f),
        rank: rankOf(f.categoryId),
      };
    });

  const areas: ExpArea[] = face.areas
    .filter((a) => catVisible(a.categoryId))
    .map((a) => ({
      x: mx(a.uMm) - a.widthMm / 2,
      y: a.vMm - a.heightMm / 2,
      w: a.widthMm,
      h: a.heightMm,
      color: catOf(cats, a.categoryId)?.color ?? '#b45309',
      // Nosníky bloku bez per-deskového popisku (bylo by jich moc; míry nesou kóty).
      label: a.beamGroupId
        ? (a.note?.trim() ?? '')
        : (a.note?.trim() ? `${a.widthMm}×${a.heightMm} ${a.note.trim()}` : `${a.widthMm}×${a.heightMm}`),
      rank: rankOf(a.categoryId),
    }));

  const usedFixtures = FIXTURE_KINDS
    .filter((k: FixtureKind) => face.fixtures.some((f) => f.kind === k && catVisible(f.categoryId)))
    .map((k) => ({ label: FIXTURE_DEFS[k].label, color: FIXTURE_DEFS[k].color, shape: FIXTURE_DEFS[k].shape }));

  const usedCats = cats
    .filter((c) => isCategoryVisible(c) && face.routes.some((r) => r.categoryId === c.id))
    .map((c) => ({ name: c.name, color: c.color }));
  const notes = face.routes
    .filter((r) => r.note && catVisible(r.categoryId))
    .map((r) => ({ catName: catOf(cats, r.categoryId)?.name ?? '', color: catOf(cats, r.categoryId)?.color ?? '#000', note: r.note }));

  return {
    wall, side, storeyName, len, height: H,
    outline: [{ x: 0, y: 0 }, { x: len, y: 0 }, { x: len, y: H }, { x: 0, y: H }],
    gridU, gridV, openings, routes, dims, fixtures, areas, usedFixtures, usedCats, notes,
    wallNote: wall.note?.trim() ?? '',
  };
}

/** Jedna položka pořadí kreslení líce — odkaz do el.areas/routes/fixtures dle indexu. */
export type FaceDrawItem =
  | { kind: 'area'; index: number }
  | { kind: 'route'; index: number }
  | { kind: 'fixture'; index: number };

/**
 * Pořadí kreslení obsahu líce NAPŘÍČ typy dle pořadí vrstev (odspodu nahoru):
 * vrstva níž v seznamu (větší rank) se kreslí dřív, vrstva výše překryje i prvky
 * ze spodních vrstev. Při shodné vrstvě je pořadí výdřeva → trasa → prvek (deska
 * pod kabely, prvek navrchu) — stejně jako v editoru (wallSvgContent). Kóty se
 * kreslí zvlášť až za tímto (vždy navrchu).
 */
export function faceDrawOrder(el: WallElevation): FaceDrawItem[] {
  const items: { it: FaceDrawItem; rank: number; type: number }[] = [];
  el.areas.forEach((a, index) => items.push({ it: { kind: 'area', index }, rank: a.rank, type: 0 }));
  el.routes.forEach((r, index) => items.push({ it: { kind: 'route', index }, rank: r.rank, type: 1 }));
  el.fixtures.forEach((f, index) => items.push({ it: { kind: 'fixture', index }, rank: f.rank, type: 2 }));
  items.sort((a, b) => (b.rank - a.rank) || (a.type - b.type));
  return items.map((x) => x.it);
}

/** Těžiště polygonu pro umístění popisku (průměr vrcholů — pro popisek místnosti stačí). */
export function polyCentroid(pts: Pt[]): Pt {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

/** Zda líc stěny nese něco k exportu (trasy / kóty / prvky). */
function faceHasContent(wall: Wall, side: WallSide): boolean {
  const f = wall.faces[side];
  return f.routes.length > 0 || f.dims.length > 0 || f.fixtures.length > 0 || f.areas.length > 0;
}

/**
 * Líce k exportu — za každou stěnu ty strany (A/B), které nesou obsah.
 * `includeEmpty` (výchozí true): stěna bez obsahu na žádném líci se přesto
 * vyexportuje jako holá elevace (strana A), aby fungoval i generátor jen na
 * samotný nahraný model. Při `false` se prázdné stěny vynechají.
 */
export function exportableFaces(
  project: Project,
  includeEmpty = true,
): { wall: Wall; side: WallSide; storeyName: string }[] {
  const out: { wall: Wall; side: WallSide; storeyName: string }[] = [];
  for (const s of project.storeys) {
    for (const w of s.walls) {
      const sides = (['A', 'B'] as WallSide[]).filter((side) => faceHasContent(w, side));
      const use = sides.length ? sides : (includeEmpty ? (['A'] as WallSide[]) : []);
      for (const side of use) out.push({ wall: w, side, storeyName: s.name });
    }
  }
  return out;
}
