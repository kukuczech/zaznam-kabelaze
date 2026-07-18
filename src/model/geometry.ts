// Geometrie stěny: převody mezi půdorysem (mm) a souřadnicemi stěny (u, v).
// Kanonická strana ('A') = díváme se proti normále n = rot90(směr osy) = (-dy, dx).
import type { Wall, XY } from './types';

export type WallSide = 'A' | 'B';

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

/** Zrcadlení u-souřadnice pro pohled ze strany B (v se nemění). */
export function displayU(wall: Wall, u: number, side: WallSide): number {
  return side === 'A' ? u : axisLen(wall) - u;
}

/** Vzdálenost bodu (uMm, vMm) od úsečky a–b v rovině stěny. */
export function distToSegment(p: { uMm: number; vMm: number }, a: XY, b: XY): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const apx = p.uMm - a.x, apy = p.vMm - a.y;
  const len2 = abx * abx + aby * aby;
  const t = len2 ? Math.min(Math.max((apx * abx + apy * aby) / len2, 0), 1) : 0;
  return Math.hypot(apx - t * abx, apy - t * aby);
}
