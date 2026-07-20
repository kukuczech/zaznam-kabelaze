// Geometrie stěny: převody mezi půdorysem (mm) a souřadnicemi stěny (u, v).
// Kanonická strana ('A') = díváme se proti normále n = rot90(směr osy) = (-dy, dx).
import { emptyFace, newId, type Corner, type Room, type SlopePlane, type Storey, type Wall, type WallSide, type XY } from './types';

export type { WallSide } from './types';

export function axisDir(wall: Wall): XY {
  const [p0, p1] = wall.axis;
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

export function axisLen(wall: Wall): number {
  const [p0, p1] = wall.axis;
  return Math.hypot(p1.x - p0.x, p1.y - p0.y);
}

/** Ořez viditelného líce na konci osy[0] pro danou stranu (mm; záporný = prodloužení). */
export function faceStartMm(wall: Wall, side: WallSide): number {
  return wall.faceTrim ? wall.faceTrim[side][0] : 0;
}

/** Poloha konce viditelného líce v ose stěny (u od axis[0], mm) = axisLen − ořez u axis[1]. */
export function faceEndMm(wall: Wall, side: WallSide): number {
  return axisLen(wall) - (wall.faceTrim ? wall.faceTrim[side][1] : 0);
}

/** Délka viditelného líce stěny na dané straně (mm) — to, co se fyzicky naměří v místnosti. */
export function faceLenMm(wall: Wall, side: WallSide): number {
  return Math.max(1, faceEndMm(wall, side) - faceStartMm(wall, side));
}

// Tolerance shody koncových bodů os (mm) — sousední stěny se v rohu „potkávají".
const JOINT_TOL = 60;
// Kolineární napojení (stěna pokračuje v přímce) se neořezává: |cos úhlu os| ≥ COLLINEAR.
const COLLINEAR = 0.87; // ~ do 30° od rovnoběžnosti

/**
 * Dopočítá ořez viditelného líce (faceTrim) každé stěny per-líc podle sousedů
 * v rozích. Pro konec osy, který se stýká s koncem jiné (ne kolineární) stěny:
 * soused zabírá ½ své tloušťky; podle toho, zda míří na stranu líce (n) nebo od
 * ní, se líc zkracuje (+) nebo prodlužuje (−). Tím vychází konvexní roh jako
 * ubrání a reflexní (výklenek) jako přidání — a strana A/B se liší (opačné n).
 * Volá se po importu i v migraci; idempotentní. Vyžaduje vyplněné thicknessMm.
 */
export function computeFaceTrims(walls: Wall[]): void {
  // Ořez líce (normála n) na koncovém bodě `end` osy stěny `wall`.
  const trimAtEnd = (wall: Wall, end: XY, n: XY): number => {
    const d = axisDir(wall);
    let contrib = 0, bestPerp = -1;
    for (const other of walls) {
      if (other === wall) continue;
      const od = axisDir(other);
      const perp = 1 - Math.abs(d.x * od.x + d.y * od.y); // 1 = kolmé, 0 = rovnoběžné
      if (perp <= 1 - COLLINEAR) continue; // kolineární napojení → neřezat
      for (let k = 0; k < 2; k++) {
        const p = other.axis[k];
        if (Math.hypot(p.x - end.x, p.y - end.y) > JOINT_TOL) continue;
        const q = other.axis[1 - k]; // druhý konec souseda → směr do jeho těla
        const dl = Math.hypot(q.x - p.x, q.y - p.y) || 1;
        const s = ((q.x - p.x) * n.x + (q.y - p.y) * n.y) / dl; // >0 na stranu líce → zkrátit
        // z víc sousedů v jednom bodě vezmi ten nejvíc kolmý (nejrelevantnější spoj)
        if (perp > bestPerp) { bestPerp = perp; contrib = (s >= 0 ? 1 : -1) * (other.thicknessMm / 2); }
      }
    }
    return Math.round(contrib);
  };
  for (const w of walls) {
    const nA = wallNormal(w);
    const nB = { x: -nA.x, y: -nA.y };
    w.faceTrim = {
      A: [trimAtEnd(w, w.axis[0], nA), trimAtEnd(w, w.axis[1], nA)],
      B: [trimAtEnd(w, w.axis[0], nB), trimAtEnd(w, w.axis[1], nB)],
    };
  }
}

/** Vzdálenost bodu (px,py) k úsečce a–b v půdorysu. */
function ptSegDist(px: number, py: number, a: XY, b: XY): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const apx = px - a.x, apy = py - a.y;
  const len2 = abx * abx + aby * aby;
  const t = len2 ? Math.min(Math.max((apx * abx + apy * aby) / len2, 0), 1) : 0;
  return Math.hypot(apx - t * abx, apy - t * aby);
}

/** Průsečík dvou přímek (bod + směr). null když jsou rovnoběžné. */
function lineIntersect(p0: XY, d0: XY, p1: XY, d1: XY): XY | null {
  const denom = d0.x * d1.y - d0.y * d1.x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((p1.x - p0.x) * d1.y - (p1.y - p0.y) * d1.x) / denom;
  return { x: p0.x + t * d0.x, y: p0.y + t * d0.y };
}

/**
 * Dopočítá světlý (vnitřní) obrys každé místnosti (`room.clearPolygon`): slab
 * polygon (= vnější líce stěn) nasune dovnitř o tloušťku stěny na každé hraně a
 * nové vrcholy najde jako průsečíky odsazených hran. Rozměry pak sedí s naměřenou
 * světlou mírou (i u výklenků). Tloušťku hrany bere z nejbližší rovnoběžné stěny,
 * jinak medián. Volá se po importu i v migraci; idempotentní.
 */
export function computeRoomClearPolygons(walls: Wall[], rooms: Room[]): void {
  const ths = walls.map((w) => w.thicknessMm).filter((t) => t > 0).sort((a, b) => a - b);
  const medT = ths.length ? ths[Math.floor(ths.length / 2)] : 250;
  for (const room of rooms) {
    const src = room.polygon ?? [];
    // sundat případný uzavírací bod (shodný s prvním)
    const pts = src.slice();
    while (pts.length > 1 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y) pts.pop();
    const n = pts.length;
    if (n < 3) { room.clearPolygon = src.slice(); continue; }
    // orientace (interiér vlevo při CCW)
    let area = 0;
    for (let i = 0; i < n; i++) { const q = pts[(i + 1) % n]; area += pts[i].x * q.y - q.x * pts[i].y; }
    const ccw = area > 0;
    // pro každou hranu: odsazená přímka dovnitř o tloušťku odpovídající stěny
    const lines: { p: XY; d: XY }[] = [];
    for (let i = 0; i < n; i++) {
      const A = pts[i], B = pts[(i + 1) % n];
      let dx = B.x - A.x, dy = B.y - A.y;
      const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      const nx = ccw ? -dy : dy, ny = ccw ? dx : -dx; // vnitřní normála
      const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
      let d = medT, best = Infinity;
      for (const w of walls) {
        const wd = axisDir(w);
        if (Math.abs(wd.x * dy - wd.y * dx) > 0.25) continue; // ne rovnoběžná stěna
        const dist = ptSegDist(mx, my, w.axis[0], w.axis[1]);
        if (dist < best && dist < Math.max(300, w.thicknessMm)) { best = dist; d = w.thicknessMm; }
      }
      lines.push({ p: { x: A.x + nx * d, y: A.y + ny * d }, d: { x: dx, y: dy } });
    }
    const clear: XY[] = [];
    for (let i = 0; i < n; i++) {
      const l0 = lines[(i - 1 + n) % n], l1 = lines[i];
      const hit = lineIntersect(l0.p, l0.d, l1.p, l1.d) ?? l1.p; // rovnoběžné → odsazený vrchol
      clear.push({ x: Math.round(hit.x), y: Math.round(hit.y) });
    }
    room.clearPolygon = clear;
  }
}

/** Kanonická normála stěny (strana A) v půdorysu. */
export function wallNormal(wall: Wall): XY {
  const d = axisDir(wall);
  return { x: -d.y, y: d.x };
}

/** Projekce půdorysného bodu na osu → u (mm od axis[0]) a kolmá vzdálenost. */
export function projectToAxis(wall: Wall, p: XY): { u: number; dist: number } {
  const [p0] = wall.axis;
  const d = axisDir(wall);
  const vx = p.x - p0.x;
  const vy = p.y - p0.y;
  return { u: vx * d.x + vy * d.y, dist: vx * -d.y + vy * d.x };
}

/**
 * Osu u (od axis[0]) převede na zobrazovací x líce (0 = levý viditelný okraj,
 * faceLen = pravý). Strana A posune počátek o ořez líce, strana B navíc zrcadlí.
 */
export function displayU(wall: Wall, u: number, side: WallSide): number {
  // Půdorysná plocha (podlaha/strop) = pohled shora, NEzrcadlí se; osa jde 1:1.
  if (wall.planOutline) return u - faceStartMm(wall, side);
  // Stěna — čelní pohled „z místnosti": stojím-li čelem k líci, roste osové u
  // směrem DOLEVA (a0 je vpravo). Zobrazovací x proto běží zrcadlově k ose — jinak
  // by elevace vyšla zprava, tj. jako pohled od souseda skrz zeď. Platí pro oba
  // líce (A i B se dívají z opačných stran), proto se zrcadlí každý po svém.
  return side === 'A' ? faceEndMm(wall, 'A') - u : u - faceStartMm(wall, 'B');
}

/** Inverze displayU: zobrazovací x líce → u v ose stěny (od axis[0]). */
export function displayUInverse(wall: Wall, x: number, side: WallSide): number {
  if (wall.planOutline) return x + faceStartMm(wall, side);
  return side === 'A' ? faceEndMm(wall, 'A') - x : x + faceStartMm(wall, 'B');
}

/** Vzdálenost bodu (uMm, vMm) od úsečky a–b v rovině stěny. */
export function distToSegment(p: { uMm: number; vMm: number }, a: XY, b: XY): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const apx = p.uMm - a.x, apy = p.vMm - a.y;
  const len2 = abx * abx + aby * aby;
  const t = len2 ? Math.min(Math.max((apx * abx + apy * aby) / len2, 0), 1) : 0;
  return Math.hypot(apx - t * abx, apy - t * aby);
}

/**
 * Postaví topologický graf rohů podlaží: koncové body os stěn sváří do sdílených
 * `Corner` podle `JOINT_TOL` a naplní `w.a` / `w.b` jejich id. Formalizuje spoje,
 * které dnes `computeFaceTrims` a viewer3d hádají pokaždé znovu podle blízkosti
 * koncových bodů. Kreslicí plochy podlahy/stropu (`planOutline`) do grafu nepatří.
 *
 * Roh si drží polohu prvního (nejdřív svařeného) koncového bodu a jeho kopii jako
 * `lidar` kotvu. Idempotentní ve smyslu „stav grafu": při opakovaném volání se graf
 * přestaví ze současných os. `axis` NEMĚNÍ — přepis os dělá až rebuildAxes.
 */
export function buildCornerGraph(storey: Storey): void {
  const corners: Corner[] = [];
  const weld = (p: XY): string => {
    const hit = corners.find((c) => Math.hypot(c.x - p.x, c.y - p.y) <= JOINT_TOL);
    if (hit) return hit.id;
    const c: Corner = { id: newId(), x: p.x, y: p.y, lidar: { x: p.x, y: p.y } };
    corners.push(c);
    return c.id;
  };
  for (const w of storey.walls) {
    if (w.planOutline) continue; // podlaha/strop se neřeší
    w.a = weld(w.axis[0]);
    w.b = weld(w.axis[1]);
    // Stěna kratší než JOINT_TOL by se svařila do jednoho rohu (a === b) a při
    // rebuildAxes by zkolabovala na nulu. Dej koncovému bodu vlastní roh, ať osa
    // zůstane zachovaná (rebuildAxes je pak bit-identický s importem).
    if (w.a === w.b) {
      const p = w.axis[1];
      const c: Corner = { id: newId(), x: p.x, y: p.y, lidar: { x: p.x, y: p.y } };
      corners.push(c);
      w.b = c.id;
    }
  }
  storey.corners = corners;
}

/**
 * Dopočítá `axis` každé stěny z poloh jejích rohů (`a` / `b`). Zdroj pravdy je graf
 * rohů; osa je odvozený cache. Volá se po JAKÉKOLI změně poloh rohů (import,
 * naměření, tažení rohu, solve). Kreslicí plochy (`planOutline`) i stěny bez rohů
 * (starý formát) nechává být.
 *
 * Pořadí přepočtu po změně:
 *   solve(storey) → rebuildAxes(storey) → computeFaceTrims(walls) → computeRoomClearPolygons(walls, rooms)
 */
export function rebuildAxes(storey: Storey): void {
  const byId = new Map((storey.corners ?? []).map((c) => [c.id, c] as const));
  for (const w of storey.walls) {
    if (w.planOutline) continue;
    const a = w.a ? byId.get(w.a) : undefined;
    const b = w.b ? byId.get(w.b) : undefined;
    if (a && b) w.axis = [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
  }
}

// --- Ortogonální solver (fáze 1) -------------------------------------------
// Poměr vah: tvrdé vazby (naměřené délky, osnap H/V) vs. měkké LiDAR kotvy.
const W_HARD = 1000; // tvrdá vazba (naměřeno / osnap směru)
const W_ANCHOR = 1;  // měkká kotva na LiDAR odhad
// Do jaké odchylky od nejbližší osy (H/V) se stěna osnapuje a zamyká (dirLocked).
const OSNAP_TOL = (20 * Math.PI) / 180;

/** Vyřeší hustou soustavu M·x = b Gaussovou eliminací s částečným pivotingem. */
function solveLinear(M: number[][], b: number[]): number[] {
  const n = b.length;
  // rozšířená matice (kopie, ať se vstup nemění)
  const A = M.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    // pivot = řádek s největší absolutní hodnotou ve sloupci
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-9) continue; // degenerovaný sloupec → nechá 0
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) A[r][c] -= f * A[col][c];
    }
  }
  // Po Gauss-Jordanově eliminaci je řádek i tvaru [0…0, A[i][i], 0…0 | rhs] → x_i = rhs / A[i][i].
  return A.map((row, i) => (Math.abs(row[i]) < 1e-9 ? row[n] : row[n] / row[i]));
}

/**
 * Ortogonální solver: LiDAR náčrt vyčistí na pravoúhlou místnost a naměřené délky
 * (`measuredLengthMm`) do ní vsadí jako tvrdé rozměry. Přepíše polohy rohů
 * (`storey.corners[i].x/y`); `axis` pak dopočítá rebuildAxes.
 *
 * Postup dle docs/plan-lidar-laser-mereni.md (fáze 1):
 *  1. globální rotace θ z převažujícího směru stěn (kruhová statistika na 4·α),
 *  2. klasifikace stěn na H/V v otočeném rámci, osnap směru → dirLocked,
 *  3. rozpad na dvě nezávislé 1D least-squares úlohy (X, Y): naměřené délky a
 *     osnapované směry = tvrdé vazby (velká váha), LiDAR polohy = měkké kotvy,
 *  4. rotace zpět.
 *
 * Naměřená hodnota je vždy pravda; LiDAR jen počáteční odhad. Solver se pouští
 * po zadání/změně měření, ne v migraci (tam zůstává identita — fáze 0).
 */
export function solveOrthogonal(storey: Storey): void {
  const corners = storey.corners ?? [];
  if (!corners.length) return;
  // stěny zapojené do grafu (mají oba rohy; kreslicí plochy vynecháme)
  const walls = storey.walls.filter((w) => !w.planOutline && w.a && w.b);
  if (!walls.length) return;

  const idx = new Map(corners.map((c, i) => [c.id, i] as const));
  // LiDAR odhad rohu (kotva); fallback na aktuální polohu
  const lx = corners.map((c) => c.lidar?.x ?? c.x);
  const ly = corners.map((c) => c.lidar?.y ?? c.y);

  // 1) globální rotace θ z převažujícího směru stěn (váženo délkou)
  let S = 0, C = 0;
  for (const w of walls) {
    const ia = idx.get(w.a!)!, ib = idx.get(w.b!)!;
    const dx = lx[ib] - lx[ia], dy = ly[ib] - ly[ia];
    const len = Math.hypot(dx, dy);
    if (len < 1) continue;
    const a = Math.atan2(dy, dx);
    S += len * Math.sin(4 * a);
    C += len * Math.cos(4 * a);
  }
  const theta = Math.atan2(S, C) / 4;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  // LiDAR polohy v otočeném rámci (rotace o −θ)
  const fx = corners.map((_, i) => lx[i] * cos + ly[i] * sin);
  const fy = corners.map((_, i) => -lx[i] * sin + ly[i] * cos);

  const N = corners.length;
  const zero = (): number[][] => Array.from({ length: N }, () => new Array(N).fill(0));
  const Mx = zero(), My = zero();
  const bx = new Array(N).fill(0), by = new Array(N).fill(0);
  // měkké kotvy na LiDAR polohu (drží nepřeměřené rohy u odhadu)
  for (let i = 0; i < N; i++) {
    Mx[i][i] += W_ANCHOR; bx[i] += W_ANCHOR * fx[i];
    My[i][i] += W_ANCHOR; by[i] += W_ANCHOR * fy[i];
  }
  // rovnice x_p − x_q = c s váhou w
  const addEq = (M: number[][], b: number[], p: number, q: number, c: number, w: number): void => {
    M[p][p] += w; M[q][q] += w; M[p][q] -= w; M[q][p] -= w;
    b[p] += w * c; b[q] -= w * c;
  };

  for (const w of walls) {
    const ia = idx.get(w.a!)!, ib = idx.get(w.b!)!;
    // směr stěny v otočeném rámci → klasifikace H/V a osnap
    const dx = fx[ib] - fx[ia], dy = fy[ib] - fy[ia];
    const len = Math.hypot(dx, dy);
    if (len < 1) { w.dirLocked = false; continue; }
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    // odchylka od nejbližší osy (H/V)
    const dev = horizontal ? Math.abs(Math.atan2(dy, dx)) : Math.abs(Math.atan2(dx, dy));
    const locked = Math.min(dev, Math.PI - dev) <= OSNAP_TOL;
    w.dirLocked = locked;
    if (!locked) continue; // zkosená stěna (mimo osnap) → řeší až fáze 2
    if (horizontal) {
      // osnap: oba rohy stejné Y
      addEq(My, by, ia, ib, 0, W_HARD);
      // naměřená délka = rozdíl X (znaménko dle LiDAR orientace)
      if (w.measuredLengthMm && w.measuredLengthMm > 0) {
        addEq(Mx, bx, ib, ia, Math.sign(dx) * w.measuredLengthMm, W_HARD);
      }
    } else {
      // svislá stěna: oba rohy stejné X
      addEq(Mx, bx, ia, ib, 0, W_HARD);
      if (w.measuredLengthMm && w.measuredLengthMm > 0) {
        addEq(My, by, ib, ia, Math.sign(dy) * w.measuredLengthMm, W_HARD);
      }
    }
  }

  const sx = solveLinear(Mx, bx), sy = solveLinear(My, by);
  // rotace zpět (o +θ) a zápis do rohů
  for (let i = 0; i < N; i++) {
    corners[i].x = Math.round(sx[i] * cos - sy[i] * sin);
    corners[i].y = Math.round(sx[i] * sin + sy[i] * cos);
  }
}

// --- Obecný solver pro zkosené místnosti (fáze 2) --------------------------
// Váha měkkého směrového prioru zkosené stěny: drží LiDAR úhel, ale změřená
// úhlopříčka (W_HARD) ho přebije. H/V stěny se zamykají tvrdě (W_HARD).
const W_DIR_SOFT = 50;

/** Odchylka směru (dx, dy) od nejbližší osy H/V v otočeném rámci (radiány, 0…π/4). */
function axisDeviation(dx: number, dy: number): number {
  const dev = Math.abs(dx) >= Math.abs(dy) ? Math.abs(Math.atan2(dy, dx)) : Math.abs(Math.atan2(dx, dy));
  return Math.min(dev, Math.PI - dev);
}

/** Kruhová statistika na 4·α (váženo délkou) z vybraných stěn → převažující směr θ. */
function rawTheta(dirs: Array<{ dx: number; dy: number; len: number }>): number {
  let S = 0, C = 0;
  for (const d of dirs) {
    const a = Math.atan2(d.dy, d.dx);
    S += d.len * Math.sin(4 * a);
    C += d.len * Math.cos(4 * a);
  }
  return Math.atan2(S, C) / 4;
}

/**
 * Převažující směr stěn θ, robustní vůči zkoseným stěnám — sdílený základ osnapu.
 * Jediná dlouhá zkosená stěna by 4·α statistiku vychýlila (a „vodorovné" stěny by se
 * pak zamkly nakřivo), proto se θ po prvním odhadu přepočte jen z osnapnutých (H/V)
 * stěn. Počítá se z předaných poloh (typicky LiDAR odhad).
 */
function dominantTheta(
  walls: Wall[], idx: Map<string, number>, xs: number[], ys: number[],
): number {
  const dirs = walls.map((w) => {
    const ia = idx.get(w.a!)!, ib = idx.get(w.b!)!;
    const dx = xs[ib] - xs[ia], dy = ys[ib] - ys[ia];
    return { dx, dy, len: Math.hypot(dx, dy) };
  }).filter((d) => d.len >= 1);
  if (!dirs.length) return 0;
  let theta = rawTheta(dirs);
  // 2 pročišťovací průchody: ponech jen stěny blízké osám v aktuálním rámci a přepočti
  for (let pass = 0; pass < 2; pass++) {
    const cos = Math.cos(theta), sin = Math.sin(theta);
    const kept = dirs.filter((d) => axisDeviation(d.dx * cos + d.dy * sin, -d.dx * sin + d.dy * cos) <= OSNAP_TOL);
    if (!kept.length || kept.length === dirs.length) break;
    theta = rawTheta(kept);
  }
  return theta;
}

/**
 * Má podlaží aspoň jednu zkosenou stěnu (mimo osnap H/V)? Rozhoduje, zda použít
 * `solveGeneral` (existuje zkosená stěna), nebo levnější `solveOrthogonal` (vše H/V).
 * Klasifikuje podle LiDAR směrů (vlastní tvar místnosti), ne podle aktuálních os.
 */
export function hasSkewedWall(storey: Storey): boolean {
  const corners = storey.corners ?? [];
  const walls = storey.walls.filter((w) => !w.planOutline && w.a && w.b);
  if (!walls.length || !corners.length) return false;
  const idx = new Map(corners.map((c, i) => [c.id, i] as const));
  const lx = corners.map((c) => c.lidar?.x ?? c.x);
  const ly = corners.map((c) => c.lidar?.y ?? c.y);
  const theta = dominantTheta(walls, idx, lx, ly);
  const cos = Math.cos(theta), sin = Math.sin(theta);
  for (const w of walls) {
    const ia = idx.get(w.a!)!, ib = idx.get(w.b!)!;
    const dx0 = lx[ib] - lx[ia], dy0 = ly[ib] - ly[ia];
    if (Math.hypot(dx0, dy0) < 1) continue;
    // směr v otočeném rámci (rotace o −θ)
    const rx = dx0 * cos + dy0 * sin, ry = -dx0 * sin + dy0 * cos;
    if (axisDeviation(rx, ry) > OSNAP_TOL) return true;
  }
  return false;
}

/**
 * Obecný (neortogonální) solver: Gauss–Newtonovský least-squares na polohy rohů.
 * Řeší zkosené místnosti (arkýř, podkroví v půdorysu), kde rozpad na 1D neplatí.
 *
 * Rezidua (vše v mm, sčítají se váženě do normálních rovnic):
 *  - naměřené délky stěn        |a−b| = measuredLengthMm   (tvrdá vazba, W_HARD)
 *  - naměřené úhlopříčky         |p−q| = lengthMm           (tvrdá vazba, W_HARD)
 *  - zafixované úhly: H/V stěny drženy přesně na ose        (tvrdá vazba, W_HARD),
 *    zkosené stěny drženy na LiDAR úhlu                     (měkký prior, W_DIR_SOFT)
 *  - měkké kotvy na LiDAR polohu rohů (regularizace, ruší volnost)   (W_ANCHOR)
 *
 * Start z LiDAR poloh; iteruje, dokud se rohy hýbou (>0,5 mm) / max 24 kroků.
 * Přepíše `storey.corners[i].x/y`; `axis` dopočítá rebuildAxes.
 */
export function solveGeneral(storey: Storey): void {
  const corners = storey.corners ?? [];
  if (!corners.length) return;
  const walls = storey.walls.filter((w) => !w.planOutline && w.a && w.b);
  if (!walls.length) return;

  const idx = new Map(corners.map((c, i) => [c.id, i] as const));
  const N = corners.length;
  // start z LiDAR poloh (fallback na aktuální)
  const px = corners.map((c) => c.lidar?.x ?? c.x);
  const py = corners.map((c) => c.lidar?.y ?? c.y);

  // globální rotace + klasifikace stěn na H/V (osnap) vs zkosené → směrové vazby
  const theta = dominantTheta(walls, idx, px, py);
  const cos = Math.cos(theta), sin = Math.sin(theta);
  type DirC = { ia: number; ib: number; nx: number; ny: number; w: number };
  const dirC: DirC[] = [];
  for (const w of walls) {
    const ia = idx.get(w.a!)!, ib = idx.get(w.b!)!;
    const dx0 = px[ib] - px[ia], dy0 = py[ib] - py[ia];
    const len = Math.hypot(dx0, dy0);
    if (len < 1) { w.dirLocked = false; continue; }
    const rx = dx0 * cos + dy0 * sin, ry = -dx0 * sin + dy0 * cos; // otočený rámec
    const horizontal = Math.abs(rx) >= Math.abs(ry);
    const snapped = axisDeviation(rx, ry) <= OSNAP_TOL;
    w.dirLocked = snapped;
    // cílový jednotkový směr u; osnap = přesně H/V otočené zpět o +θ, jinak LiDAR směr
    let ux: number, uy: number;
    if (snapped) {
      if (horizontal) { ux = cos; uy = sin; } else { ux = -sin; uy = cos; }
    } else {
      ux = dx0 / len; uy = dy0 / len;
    }
    // vazba: kolmá složka (p_b−p_a)·n = 0, n = rot90(u)
    dirC.push({ ia, ib, nx: -uy, ny: ux, w: snapped ? W_HARD : W_DIR_SOFT });
  }

  // délkové vazby stěn + úhlopříčky (stejný tvar: |p−q| = L)
  type LenC = { ia: number; ib: number; L: number };
  const lenC: LenC[] = [];
  for (const w of walls) {
    if (w.measuredLengthMm && w.measuredLengthMm > 0) {
      lenC.push({ ia: idx.get(w.a!)!, ib: idx.get(w.b!)!, L: w.measuredLengthMm });
    }
  }
  for (const d of storey.diagonals ?? []) {
    if (d.lengthMm > 0 && d.a !== d.b && idx.has(d.a) && idx.has(d.b)) {
      lenC.push({ ia: idx.get(d.a)!, ib: idx.get(d.b)!, L: d.lengthMm });
    }
  }

  // stavový vektor X = [x0, y0, x1, y1, …], start z LiDAR
  const n2 = 2 * N;
  const X = new Array(n2).fill(0);
  for (let i = 0; i < N; i++) { X[2 * i] = px[i]; X[2 * i + 1] = py[i]; }

  // Vážená cena Σ w·r² v bodu Xv — řídí přijetí LM kroku (délkové vazby jsou
  // nelineární a nekonvexní, plný Gauss-Newton krok při vysoké váze přestřelí do
  // vedlejší kotliny; LM tlumí, dokud krok cenu nesníží).
  const costAt = (Xv: number[]): number => {
    let c = 0;
    for (let i = 0; i < N; i++) {
      c += W_ANCHOR * (Xv[2 * i] - px[i]) ** 2 + W_ANCHOR * (Xv[2 * i + 1] - py[i]) ** 2;
    }
    for (const dc of dirC) {
      const r = dc.nx * (Xv[2 * dc.ib] - Xv[2 * dc.ia]) + dc.ny * (Xv[2 * dc.ib + 1] - Xv[2 * dc.ia + 1]);
      c += dc.w * r * r;
    }
    for (const lc of lenC) {
      const d = Math.hypot(Xv[2 * lc.ib] - Xv[2 * lc.ia], Xv[2 * lc.ib + 1] - Xv[2 * lc.ia + 1]);
      c += W_HARD * (d - lc.L) ** 2;
    }
    return c;
  };

  let lambda = 1e-3; // tlumení LM (roste při zamítnutí kroku, klesá při přijetí)
  let cost = costAt(X);
  for (let iter = 0; iter < 60; iter++) {
    // normální rovnice v aktuálním X: A = Σ w·JᵀJ, g = Σ w·Jᵀr
    const A = Array.from({ length: n2 }, () => new Array(n2).fill(0));
    const g = new Array(n2).fill(0);
    const accum = (terms: Array<[number, number]>, r: number, w: number): void => {
      for (const [p, jp] of terms) {
        g[p] += w * jp * r;
        for (const [q, jq] of terms) A[p][q] += w * jp * jq;
      }
    };
    // měkké kotvy na LiDAR polohu (drží soustavu regulární i bez měření)
    for (let i = 0; i < N; i++) {
      accum([[2 * i, 1]], X[2 * i] - px[i], W_ANCHOR);
      accum([[2 * i + 1, 1]], X[2 * i + 1] - py[i], W_ANCHOR);
    }
    // směrové vazby (lineární): r = n·(p_b − p_a)
    for (const c of dirC) {
      const r = c.nx * (X[2 * c.ib] - X[2 * c.ia]) + c.ny * (X[2 * c.ib + 1] - X[2 * c.ia + 1]);
      accum([[2 * c.ia, -c.nx], [2 * c.ia + 1, -c.ny], [2 * c.ib, c.nx], [2 * c.ib + 1, c.ny]], r, c.w);
    }
    // délkové / úhlopříčkové vazby (nelineární): r = |p_b − p_a| − L
    for (const c of lenC) {
      const dx = X[2 * c.ib] - X[2 * c.ia], dy = X[2 * c.ib + 1] - X[2 * c.ia + 1];
      const d = Math.hypot(dx, dy);
      if (d < 1e-6) continue; // degenerovaná vazba (rohy splynuly) → přeskoč
      const ux = dx / d, uy = dy / d;
      accum([[2 * c.ia, -ux], [2 * c.ia + 1, -uy], [2 * c.ib, ux], [2 * c.ib + 1, uy]], d - c.L, W_HARD);
    }
    const diag = A.map((row, i) => row[i]); // pro LM tlumení (škáluje se s diagonálou)

    // LM: zkoušej krok s rostoucím tlumením, dokud nesníží cenu (nebo se nevzdáme)
    let stepTaken = false;
    for (let tries = 0; tries < 12; tries++) {
      const Ad = A.map((row, i) => row.map((v, j) => (i === j ? v + lambda * diag[i] : v)));
      const delta = solveLinear(Ad, g.map((v) => -v));
      const Xt = X.map((v, k) => v + delta[k]);
      const ct = costAt(Xt);
      if (ct < cost) {
        let maxStep = 0;
        for (let k = 0; k < n2; k++) { maxStep = Math.max(maxStep, Math.abs(delta[k])); X[k] = Xt[k]; }
        const improved = cost - ct;
        cost = ct;
        lambda = Math.max(lambda * 0.3, 1e-9);
        stepTaken = true;
        if (maxStep < 0.5 || improved < 1e-3) { stepTaken = false; } // konvergováno → ukonči vnější
        break;
      }
      lambda *= 4; // krok zhoršil → přitlum a zkus znovu ze stejného X
    }
    if (!stepTaken) break; // přijato malé zlepšení / vyčerpané tlumení → konec
  }

  for (let i = 0; i < N; i++) {
    corners[i].x = Math.round(X[2 * i]);
    corners[i].y = Math.round(X[2 * i + 1]);
  }
}

/**
 * Kompletní přepočet podlaží po změně geometrie (naměření, tažení rohu):
 * solver → dopočet os → ořezy líců → světlé obrysy místností.
 * Jednotné pořadí dle docs/plan-lidar-laser-mereni.md. Volba solveru per-podlaží:
 * zkosená stěna → obecný Gauss–Newton, jinak levnější ortogonální 1D rozpad.
 */
export function resolveStorey(storey: Storey): void {
  if (hasSkewedWall(storey)) solveGeneral(storey);
  else solveOrthogonal(storey);
  rebuildAxes(storey);
  computeFaceTrims(storey.walls);
  computeRoomClearPolygons(storey.walls, storey.rooms ?? []);
}

// --- Šikmina střechy (podkroví, fáze 3) ------------------------------------
// Šikmina není součástí 2D solveru: je to samostatná svislá parametrizace nad
// kolenní stěnou. Elevace i 3D z ní počítají výšku stropu v půdorysném bodě.

/**
 * Stoupání šikminy (bezrozměrné, výška/běh) z jejích parametrů. `angleDeg` má
 * přednost; jinak se odvodí z běhu `runMm` a rozdílu hřeben−nadezdívka. Bez
 * dostatečných dat 0 (rovný strop ve výšce nadezdívky).
 */
export function slopeGradient(sp: SlopePlane): number {
  if (sp.angleDeg != null && Number.isFinite(sp.angleDeg)) return Math.tan((sp.angleDeg * Math.PI) / 180);
  if (sp.runMm && sp.runMm > 0 && sp.ridgeHeightMm != null) return (sp.ridgeHeightMm - sp.kneeHeightMm) / sp.runMm;
  return 0;
}

/**
 * Výška šikmé roviny (mm ode dna) v půdorysném bodě `p`: od osy kolenní stěny
 * stoupá kolmo DOVNITŘ místnosti sklonem `slopeGradient`, zastropená na
 * `ridgeHeightMm`. Vnitřní stranu (kam rovina stoupá) určuje těžiště rohů
 * podlaží. Vrací null, když bod leží na vnější straně base stěny (šikmina ho
 * neovlivňuje) nebo base stěna chybí.
 */
export function slopeHeightAt(storey: Storey, sp: SlopePlane, p: XY): number | null {
  const base = storey.walls.find((w) => w.id === sp.baseWallId);
  if (!base) return null;
  const [b0] = base.axis;
  const n = wallNormal(base);
  // Orientace normály dovnitř místnosti — k těžišti rohů podlaží.
  let cx = 0, cy = 0;
  const cs = storey.corners ?? [];
  for (const c of cs) { cx += c.x; cy += c.y; }
  if (cs.length) { cx /= cs.length; cy /= cs.length; }
  const inward = (cx - b0.x) * n.x + (cy - b0.y) * n.y >= 0 ? 1 : -1;
  const dist = ((p.x - b0.x) * n.x + (p.y - b0.y) * n.y) * inward; // mm od base dovnitř
  if (dist < -JOINT_TOL) return null; // vnější strana base stěny → mimo dosah šikminy
  let h = sp.kneeHeightMm + slopeGradient(sp) * Math.max(0, dist);
  if (sp.ridgeHeightMm != null) h = Math.min(h, sp.ridgeHeightMm);
  return h;
}

/**
 * Výška stropu (mm ode dna) v půdorysném bodě `p` podle všech šikmin podlaží —
 * minimum přes roviny, zastropené `cap` (rovný strop, typicky výška podlaží).
 * Body mimo dosah šikmin vrátí `cap`. Sdílí elevace i 3D viewer.
 */
export function ceilingHeightAt(storey: Storey, p: XY, cap: number): number {
  let h = cap;
  for (const sp of storey.slopes ?? []) {
    const sh = slopeHeightAt(storey, sp, p);
    if (sh != null) h = Math.min(h, sh);
  }
  return h;
}

/**
 * Profil horní hrany líce (výška stropu mm ode dna) podél VIDITELNÉHO líce jako
 * lomená čára v zobrazovacím x (0 … faceLen). Vzorkuje hustě a nechá jen body, kde
 * se mění sklon → zachytí ZLOM, kde rovný strop přejde v šikminu (a naopak). Dvě
 * krajní hodnoty by tenhle zlom zahodily a nakreslily by rovnou diagonálu přes
 * celou stěnu. Vrací null, když strop líc nikde neseřezává (rovný strop v plné
 * výšce) — volající pak kreslí obdélník. Body jsou seřazené vzestupně dle x,
 * první má x = 0, poslední x = faceLen.
 */
export function faceCeilingPolyline(storey: Storey, wall: Wall, side: WallSide): { x: number; h: number }[] | null {
  if (wall.planOutline || !storey.slopes?.length) return null;
  const d = axisDir(wall);
  const [p0] = wall.axis;
  const len = faceLenMm(wall, side);
  const heightAtDisplayX = (x: number): number => {
    const u = displayUInverse(wall, x, side);
    return ceilingHeightAt(storey, { x: p0.x + d.x * u, y: p0.y + d.y * u }, wall.heightMm);
  };
  const N = Math.min(200, Math.max(2, Math.round(len / 50)));
  const raw: { x: number; h: number }[] = [];
  for (let i = 0; i <= N; i++) {
    const x = (len * i) / N;
    raw.push({ x, h: heightAtDisplayX(x) });
  }
  const keep = [raw[0]];
  for (let i = 1; i < raw.length - 1; i++) {
    const a = raw[i - 1], b = raw[i], c = raw[i + 1];
    const gPrev = (b.h - a.h) / (b.x - a.x || 1);
    const gNext = (c.h - b.h) / (c.x - b.x || 1);
    if (Math.abs(gPrev - gNext) > 0.01) keep.push(b); // změna sklonu = zlom
  }
  keep.push(raw[raw.length - 1]);
  if (keep.every((p) => p.h >= wall.heightMm - 1)) return null; // rovný strop v plné výšce → obdélník
  return keep.map((p) => ({ x: p.x, h: Math.max(0, Math.min(wall.heightMm, p.h)) }));
}

/** Vodorovný běh šikminy (mm) v půdorysu od osy kolenní stěny k hřebeni. */
export function slopePlanRun(sp: SlopePlane): number {
  const grad = slopeGradient(sp);
  if (sp.ridgeHeightMm != null && grad > 0) return (sp.ridgeHeightMm - sp.kneeHeightMm) / grad;
  return sp.runMm ?? 0;
}

/** Skutečná délka šikminy po sklonu (mm) — přepona vodorovného běhu a převýšení. */
export function slopeTrueLength(sp: SlopePlane): number {
  const grad = slopeGradient(sp);
  return slopePlanRun(sp) * Math.sqrt(1 + grad * grad);
}

/** Leží osa stěny (přibližně) na hraně polygonu? (rovnoběžná, blízko, aspoň z půlky překrytá). */
function wallOnPolygonEdge(wall: Wall, poly: XY[], tolMm: number): boolean {
  const [a, b] = wall.axis;
  const dir = axisDir(wall);
  const len = axisLen(wall);
  if (len < 1 || poly.length < 2) return false;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const ex = q.x - p.x, ey = q.y - p.y;
    const el = Math.hypot(ex, ey);
    if (el < 1) continue;
    const ux = ex / el, uy = ey / el;
    if (Math.abs(dir.x * uy - dir.y * ux) > 0.09) continue; // ~5° tolerance rovnoběžnosti
    // Kolmá vzdálenost středu osy od přímky hrany.
    if (Math.abs((mx - p.x) * uy - (my - p.y) * ux) > tolMm) continue;
    // Podélný překryv osy s hranou.
    const ta = (a.x - p.x) * ux + (a.y - p.y) * uy;
    const tb = (b.x - p.x) * ux + (b.y - p.y) * uy;
    const overlap = Math.min(el, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb));
    if (overlap > Math.min(len, el) * 0.5) return true;
  }
  return false;
}

/**
 * Šikminy podlaží náležející místnosti — jejich kolenní (base) stěna leží na obrysu
 * místnosti. Vazba je geometrická (Room nemá explicitní seznam stěn). Tolerance
 * pokryje odsazení osy od líce (polovina tloušťky kolenní stěny).
 */
export function slopesForRoom(storey: Storey, room: Room): SlopePlane[] {
  const poly = room.polygon?.length ? room.polygon : (room.clearPolygon ?? []);
  return (storey.slopes ?? []).filter((sp) => {
    const base = storey.walls.find((w) => w.id === sp.baseWallId);
    if (!base) return false;
    return wallOnPolygonEdge(base, poly, base.thicknessMm / 2 + 200);
  });
}

/**
 * Kreslicí plocha jednoho šikmého stropu jako „stěna": obdélník šířka = délka kolenní
 * stěny, výška = skutečná délka šikminy po sklonu (rozměry sedí s realitou). Editor je
 * nad ní generický (planOutline ⇒ půdorysná plocha, ne svislá stěna).
 */
export function slopeCeilingSurface(storey: Storey, room: Room, sp: SlopePlane): Wall {
  const base = storey.walls.find((w) => w.id === sp.baseWallId);
  const w = Math.max(1, Math.round(base ? axisLen(base) : 1000));
  const h = Math.max(1, Math.round(slopeTrueLength(sp) || 1000));
  return {
    id: newId(),
    ifcGuid: '',
    name: `${room.name} — šikmina`,
    axis: [{ x: 0, y: 0 }, { x: w, y: 0 }],
    thicknessMm: 0,
    heightMm: h,
    openings: [],
    planOutline: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }],
    faces: { A: emptyFace(), B: emptyFace() },
  };
}
