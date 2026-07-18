// Statické vykreslení elevace stěny do SVG (sdílené editorem i tiskem).
// Zobrazovací souřadnice: x = displayU (mm), y = heightMm − v (osa y dolů).
import { axisLen, displayU, type WallSide } from '../model/geometry';
import type { Anchor, Category, Dimension, Wall } from '../model/types';

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function wallViewBox(wall: Wall, marginMm = 400): ViewBox {
  const len = axisLen(wall);
  return {
    x: -marginMm,
    y: -marginMm,
    w: len + 2 * marginMm,
    h: wall.heightMm + 2 * marginMm,
  };
}

export function toDisplay(wall: Wall, side: WallSide, uMm: number, vMm: number): { x: number; y: number } {
  return { x: displayU(wall, uMm, side), y: wall.heightMm - vMm };
}

export function fromDisplay(wall: Wall, side: WallSide, x: number, y: number): { uMm: number; vMm: number } {
  return { uMm: displayU(wall, x, side), vMm: wall.heightMm - y };
}

export function resolveAnchor(wall: Wall, a: Anchor): { uMm: number; vMm: number } | null {
  if (a.kind === 'point') return { uMm: a.uMm, vMm: a.vMm };
  if (a.kind === 'routePoint') {
    const r = wall.routes.find((x) => x.id === a.routeId);
    const p = r?.points[a.index];
    return p ? { uMm: p.x, vMm: p.y } : null;
  }
  return null; // edge se řeší v páru s druhou kotvou
}

/** Dvojici kotev převede na konkrétní úsečku (edge kotva = kolmý průmět druhé kotvy na hranu). */
export function dimEndpoints(wall: Wall, dim: Dimension): { a: { uMm: number; vMm: number }; b: { uMm: number; vMm: number } } | null {
  const edge = dim.from.kind === 'edge' ? dim.from : dim.to.kind === 'edge' ? dim.to : null;
  const other = dim.from.kind === 'edge' ? dim.to : dim.from;
  const p = resolveAnchor(wall, other);
  if (!p) return null;
  if (!edge) {
    const q = resolveAnchor(wall, dim.to.kind === 'edge' ? dim.from : dim.to);
    const pFrom = resolveAnchor(wall, dim.from);
    return pFrom && q ? { a: pFrom, b: q } : null;
  }
  const e = edge.edge;
  const b =
    e === 'top' ? { uMm: p.uMm, vMm: wall.heightMm }
    : e === 'bottom' ? { uMm: p.uMm, vMm: 0 }
    : e === 'left' ? { uMm: 0, vMm: p.vMm }
    : { uMm: axisLen(wall), vMm: p.vMm };
  return { a: p, b };
}

export function dimGeomLengthMm(wall: Wall, dim: Dimension): number | null {
  const ep = dimEndpoints(wall, dim);
  return ep ? Math.hypot(ep.b.uMm - ep.a.uMm, ep.b.vMm - ep.a.vMm) : null;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

export interface WallSvgOptions {
  side: WallSide;
  categories: Category[];
  selectedRouteId?: string | null;
  /** Rozpracovaná trasa při kreslení (v kanonických souřadnicích). */
  draftPoints?: { x: number; y: number }[];
  draftColor?: string;
  draftWidthMm?: number;
  forPrint?: boolean;
  /** Narovnaná fotka jako podklad (objectURL nebo data URL) vyplňující obdélník stěny. */
  backgroundHref?: string;
  backgroundOpacity?: number;
}

export function wallSvgContent(wall: Wall, opts: WallSvgOptions): string {
  const { side, categories } = opts;
  const len = axisLen(wall);
  const H = wall.heightMm;
  const print = !!opts.forPrint;
  const line = print ? '#333' : '#64748b';
  const parts: string[] = [];

  // Podklad — narovnaná fotka stěny (pod vším ostatním)
  if (opts.backgroundHref) {
    const op = opts.backgroundOpacity ?? 0.6;
    parts.push(
      `<image href="${opts.backgroundHref}" x="0" y="0" width="${len}" height="${H}" opacity="${op}" preserveAspectRatio="none"/>`,
    );
  }

  // Mřížka po 500 mm
  const grid: string[] = [];
  const gridColor = print ? '#ddd' : '#1f2937';
  for (let u = 500; u < len; u += 500) grid.push(`M ${u} 0 V ${H}`);
  for (let v = 500; v < H; v += 500) grid.push(`M 0 ${H - v} H ${len}`);
  parts.push(`<path d="${grid.join(' ')}" stroke="${gridColor}" stroke-width="4" fill="none"/>`);

  // Obrys stěny
  parts.push(`<rect x="0" y="0" width="${len}" height="${H}" fill="none" stroke="${line}" stroke-width="20"/>`);

  // Otvory
  for (const o of wall.openings) {
    const c = toDisplay(wall, side, o.uMm, o.vMm);
    const x = c.x - o.widthMm / 2;
    const y = c.y - o.heightMm / 2;
    parts.push(
      `<rect x="${x}" y="${y}" width="${o.widthMm}" height="${o.heightMm}" fill="${print ? '#f3f4f6' : '#0b1220'}" stroke="${line}" stroke-width="12" stroke-dasharray="60 40"/>`,
      `<text x="${c.x}" y="${c.y}" text-anchor="middle" dominant-baseline="middle" font-size="140" fill="${print ? '#666' : '#475569'}">${o.kind === 'door' ? 'Dveře' : 'Okno'}</text>`,
    );
  }

  // Trasy
  for (const r of wall.routes) {
    const cat = categories.find((c) => c.id === r.categoryId);
    const color = cat?.color ?? '#22d3ee';
    const pts = r.points.map((p) => toDisplay(wall, side, p.x, p.y));
    if (pts.length < 2) continue;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
    const selected = r.id === opts.selectedRouteId;
    parts.push(
      `<path d="${d}" stroke="${color}" stroke-width="${Math.max(r.widthMm, 30)}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${selected ? 0.95 : 0.65}" data-route="${r.id}"/>`,
      `<path d="${d}" stroke="${print ? '#000' : '#fff'}" stroke-width="8" fill="none" stroke-dasharray="80 80" opacity="0.7"/>`,
    );
    if (selected) {
      for (const p of pts) {
        parts.push(`<circle cx="${p.x}" cy="${p.y}" r="60" fill="#fff" stroke="${color}" stroke-width="20"/>`);
      }
    }
    // Popisky délek segmentů
    for (let i = 0; i < pts.length - 1; i++) {
      const meas = r.segLengthsMm[i];
      const label = meas != null ? `${meas}` : '';
      if (!label) continue;
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      parts.push(
        `<text x="${mx}" y="${my - 60}" text-anchor="middle" font-size="150" font-weight="bold" fill="${print ? '#000' : color}" paint-order="stroke" stroke="${print ? '#fff' : '#0f172a'}" stroke-width="40">${label}</text>`,
      );
    }
  }

  // Rozpracovaná trasa
  if (opts.draftPoints && opts.draftPoints.length > 0) {
    const pts = opts.draftPoints.map((p) => toDisplay(wall, side, p.x, p.y));
    const d = pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
    parts.push(
      `<path d="${d}" stroke="${opts.draftColor ?? '#22d3ee'}" stroke-width="${Math.max(opts.draftWidthMm ?? 60, 30)}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"/>`,
    );
    for (const p of pts) parts.push(`<circle cx="${p.x}" cy="${p.y}" r="50" fill="${opts.draftColor ?? '#22d3ee'}"/>`);
  }

  // Kóty — klasické technické kótování: vynášecí čáry, odsazená kótovací čára
  // se šipkami na obou koncích a popiskem vzdálenosti nad ní.
  const dimColor = print ? '#000' : '#fbbf24';
  const cx = len / 2, cy = H / 2;
  const OFF = 300;   // odsazení kótovací čáry od měřeného úseku (mm)
  const OVER = 90;   // přesah vynášecí čáry za kótovací čáru
  const GAP = 40;    // mezera mezi měřeným bodem a začátkem vynášecí čáry
  const arrow = (px: number, py: number, dx: number, dy: number): string => {
    // šipka: hrot v (px,py), míří ven ve směru (dx,dy)
    const AL = 130, AW = 45;
    const bx = px - dx * AL, by = py - dy * AL;
    const nx = -dy, ny = dx;
    return `<path d="M ${px} ${py} L ${bx + nx * AW} ${by + ny * AW} L ${bx - nx * AW} ${by - ny * AW} Z" fill="${dimColor}"/>`;
  };
  for (const dim of wall.dims) {
    const ep = dimEndpoints(wall, dim);
    if (!ep) continue;
    const a = toDisplay(wall, side, ep.a.uMm, ep.a.vMm);
    const b = toDisplay(wall, side, ep.b.uMm, ep.b.vMm);
    const value = dim.valueMm ?? Math.round(Math.hypot(ep.b.uMm - ep.a.uMm, ep.b.vMm - ep.a.vMm));
    const label = `${value}${dim.valueMm == null ? '?' : ''}`;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg < 1) {
      parts.push(
        `<circle cx="${a.x}" cy="${a.y}" r="35" fill="${dimColor}" data-dim="${dim.id}"/>`,
        `<text x="${a.x}" y="${a.y - 60}" text-anchor="middle" font-size="140" fill="${dimColor}" paint-order="stroke" stroke="${print ? '#fff' : '#0f172a'}" stroke-width="40">${label}</text>`,
      );
      continue;
    }
    const dxu = (b.x - a.x) / seg, dyu = (b.y - a.y) / seg; // jednotkový směr a→b
    let nx = -dyu, ny = dxu;                                // kolmice ke kótovací čáře
    // odsadit směrem ven ze středu stěny, ať kóta nekříží geometrii
    if (nx * ((a.x + b.x) / 2 - cx) + ny * ((a.y + b.y) / 2 - cy) < 0) { nx = -nx; ny = -ny; }
    const aX = a.x + nx * OFF, aY = a.y + ny * OFF;         // konce kótovací čáry
    const bX = b.x + nx * OFF, bY = b.y + ny * OFF;
    let ang = Math.atan2(dyu, dxu) * 180 / Math.PI;         // popisek podél čáry, vzhůru nohama otočit
    if (ang > 90) ang -= 180; else if (ang < -90) ang += 180;
    const tX = (aX + bX) / 2 + nx * 95, tY = (aY + bY) / 2 + ny * 95;
    parts.push(
      // vynášecí čáry (od měřených bodů přes kótovací čáru s malým přesahem)
      `<line x1="${a.x + nx * GAP}" y1="${a.y + ny * GAP}" x2="${a.x + nx * (OFF + OVER)}" y2="${a.y + ny * (OFF + OVER)}" stroke="${dimColor}" stroke-width="6"/>`,
      `<line x1="${b.x + nx * GAP}" y1="${b.y + ny * GAP}" x2="${b.x + nx * (OFF + OVER)}" y2="${b.y + ny * (OFF + OVER)}" stroke="${dimColor}" stroke-width="6"/>`,
      // kótovací čára + šipky mířící ven k vynášecím čárám
      `<line x1="${aX}" y1="${aY}" x2="${bX}" y2="${bY}" stroke="${dimColor}" stroke-width="8" data-dim="${dim.id}"/>`,
      arrow(aX, aY, -dxu, -dyu),
      arrow(bX, bY, dxu, dyu),
      // popisek vzdálenosti nad kótovací čárou
      `<text x="${tX}" y="${tY}" text-anchor="middle" dominant-baseline="central" transform="rotate(${ang.toFixed(1)} ${tX} ${tY})" font-size="140" fill="${dimColor}" paint-order="stroke" stroke="${print ? '#fff' : '#0f172a'}" stroke-width="40">${label}</text>`,
    );
  }

  // Popisek rozměrů stěny
  parts.push(
    `<text x="${len / 2}" y="${H + 250}" text-anchor="middle" font-size="160" fill="${print ? '#333' : '#64748b'}">${esc(`${Math.round(len)} × ${Math.round(H)} mm`)}</text>`,
  );

  return parts.join('\n');
}
