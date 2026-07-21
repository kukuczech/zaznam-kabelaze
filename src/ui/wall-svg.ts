// Statické vykreslení elevace stěny do SVG (sdílené editorem i tiskem).
// Zobrazovací souřadnice: x = displayU (mm), y = heightMm − v (osa y dolů).
import { displayU, displayUInverse, faceEndMm, faceLenMm, faceStartMm, type WallSide } from '../model/geometry';
import { FIXTURE_DEFS, FIXTURE_LAYER, fixtureSize, fixtureCaption, fixtureCount, fixtureSlots, fixtureAlwaysVisible, isCategoryVisible, type Anchor, type Category, type Dimension, type Fixture, type FixtureKind, type Wall, type WallArea, type XY } from '../model/types';

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function wallViewBox(wall: Wall, side: WallSide, marginMm = 400): ViewBox {
  const len = faceLenMm(wall, side);
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
  return { uMm: displayUInverse(wall, x, side), vMm: wall.heightMm - y };
}

export function resolveAnchor(wall: Wall, side: WallSide, a: Anchor): { uMm: number; vMm: number } | null {
  const face = wall.faces[side];
  if (a.kind === 'point') return { uMm: a.uMm, vMm: a.vMm };
  if (a.kind === 'routePoint') {
    const r = face.routes.find((x) => x.id === a.routeId);
    const p = r?.points[a.index];
    return p ? { uMm: p.x, vMm: p.y } : null;
  }
  if (a.kind === 'routeSeg') {
    const r = face.routes.find((x) => x.id === a.routeId);
    const p0 = r?.points[a.index], p1 = r?.points[a.index + 1];
    return p0 && p1 ? { uMm: p0.x + (p1.x - p0.x) * a.t, vMm: p0.y + (p1.y - p0.y) * a.t } : null;
  }
  if (a.kind === 'fixture') {
    const f = face.fixtures.find((x) => x.id === a.fixtureId);
    return f ? { uMm: f.uMm, vMm: f.vMm } : null;
  }
  if (a.kind === 'area') {
    const ar = face.areas.find((x) => x.id === a.areaId);
    return ar ? { uMm: ar.uMm + a.du * ar.widthMm / 2, vMm: ar.vMm + a.dv * ar.heightMm / 2 } : null;
  }
  return null; // edge se řeší v páru s druhou kotvou
}

/** Dvojici kotev převede na konkrétní úsečku (edge kotva = kolmý průmět druhé kotvy na hranu). */
export function dimEndpoints(wall: Wall, side: WallSide, dim: Dimension): { a: { uMm: number; vMm: number }; b: { uMm: number; vMm: number } } | null {
  const edge = dim.from.kind === 'edge' ? dim.from : dim.to.kind === 'edge' ? dim.to : null;
  const other = dim.from.kind === 'edge' ? dim.to : dim.from;
  const p = resolveAnchor(wall, side, other);
  if (!p) return null;
  if (!edge) {
    const q = resolveAnchor(wall, side, dim.to.kind === 'edge' ? dim.from : dim.to);
    const pFrom = resolveAnchor(wall, side, dim.from);
    return pFrom && q ? { a: pFrom, b: q } : null;
  }
  const e = edge.edge;
  // left/right = viditelné okraje líce (ne konce střednice) → faceStart/faceEnd.
  const b =
    e === 'top' ? { uMm: p.uMm, vMm: wall.heightMm }
    : e === 'bottom' ? { uMm: p.uMm, vMm: 0 }
    : e === 'left' ? { uMm: faceStartMm(wall, side), vMm: p.vMm }
    : { uMm: faceEndMm(wall, side), vMm: p.vMm };
  return { a: p, b };
}

export function dimGeomLengthMm(wall: Wall, side: WallSide, dim: Dimension): number | null {
  const ep = dimEndpoints(wall, side, dim);
  return ep ? Math.hypot(ep.b.uMm - ep.a.uMm, ep.b.vMm - ep.a.vMm) : null;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/** Vnitřní schematický symbol prvku, vycentrovaný na (0,0), v poloměru ~s (mm). */
function fixtureGlyph(kind: FixtureKind, s: number, color: string): string {
  const sw = Math.max(s * 0.16, 10);
  const ln = (x1: number, y1: number, x2: number, y2: number) =>
    `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>`;
  const dot = (cx: number, cy: number, r: number) =>
    `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}"/>`;
  const rect = (x: number, y: number, w: number, h: number, r = 0, fill = 'none') =>
    `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${r.toFixed(1)}" fill="${fill}" stroke="${color}" stroke-width="${sw}"/>`;
  switch (kind) {
    case 'socket': // dva kolíky
      return dot(-s * 0.42, 0, s * 0.26) + dot(s * 0.42, 0, s * 0.26) + ln(-s * 0.42, s * 0.55, s * 0.42, s * 0.55);
    case 'switch': // tlačítko: prstenec + bod
      return `<circle cx="0" cy="0" r="${(s * 0.62).toFixed(1)}" fill="none" stroke="${color}" stroke-width="${sw}"/>` + dot(0, 0, s * 0.2);
    case 'touch': // dotykový panel Jablotron
      return rect(-s * 0.62, -s * 0.88, s * 1.24, s * 1.76, s * 0.3) + ln(-s * 0.28, -s * 0.12, s * 0.28, -s * 0.12) + dot(0, s * 0.42, s * 0.17);
    case 'lightswitch': // vypínač — rámeček s páčkou (pivot + lever)
      return rect(-s * 0.55, -s * 0.82, s * 1.1, s * 1.64, s * 0.18) +
        dot(-s * 0.05, s * 0.32, s * 0.12) + ln(-s * 0.05, s * 0.32, s * 0.4, -s * 0.5);
    case 'light': // vývod na světlo ⊗
      return ln(-s * 0.55, -s * 0.55, s * 0.55, s * 0.55) + ln(-s * 0.55, s * 0.55, s * 0.55, -s * 0.55);
    case 'panel': // rozvaděč
      return rect(-s * 0.58, -s * 0.82, s * 1.16, s * 1.64, s * 0.08) + ln(-s * 0.35, -s * 0.3, s * 0.35, -s * 0.3) + ln(-s * 0.35, s * 0.1, s * 0.35, s * 0.1);
    case 'speaker': // repro
      return rect(-s * 0.62, -s * 0.4, s * 0.42, s * 0.8) +
        `<path d="M ${(-s * 0.2).toFixed(1)} ${(-s * 0.4).toFixed(1)} L ${(s * 0.6).toFixed(1)} ${(-s * 0.72).toFixed(1)} L ${(s * 0.6).toFixed(1)} ${(s * 0.72).toFixed(1)} L ${(-s * 0.2).toFixed(1)} ${(s * 0.4).toFixed(1)} Z" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round"/>`;
    case 'spkmaster': // aktivní repro (master) — skříňka s woofrem a písmenem M
    case 'spkslave': { // aktivní repro (slave) — totéž s písmenem S
      const letter = kind === 'spkmaster' ? 'M' : 'S';
      return rect(-s * 0.5, -s * 0.82, s * 1.0, s * 1.64, s * 0.1) +
        `<circle cx="0" cy="${(s * 0.34).toFixed(1)}" r="${(s * 0.34).toFixed(1)}" fill="none" stroke="${color}" stroke-width="${sw}"/>` +
        dot(0, s * 0.34, s * 0.08) +
        `<text x="0" y="${(-s * 0.38).toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-size="${(s * 0.66).toFixed(1)}" font-weight="bold" fill="${color}">${letter}</text>`;
    }
    case 'data': // datová zásuvka RJ45
      return rect(-s * 0.62, -s * 0.58, s * 1.24, s * 1.16, s * 0.14) + dot(0, 0, s * 0.24);
    case 'flood': // čidlo zaplavení — kapka
      return `<path d="M 0 ${(-s * 0.78).toFixed(1)} C ${(s * 0.6).toFixed(1)} ${(-s * 0.02).toFixed(1)}, ${(s * 0.42).toFixed(1)} ${(s * 0.72).toFixed(1)}, 0 ${(s * 0.72).toFixed(1)} C ${(-s * 0.42).toFixed(1)} ${(s * 0.72).toFixed(1)}, ${(-s * 0.6).toFixed(1)} ${(-s * 0.02).toFixed(1)}, 0 ${(-s * 0.78).toFixed(1)} Z" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round"/>`;
    case 'magnet': // magnetický kontakt — dva jazýčky
      return rect(-s * 0.58, -s * 0.6, s * 0.4, s * 1.2, s * 0.06) + rect(s * 0.18, -s * 0.6, s * 0.4, s * 1.2, s * 0.06);
    case 'doorbell': // domácí vrátný / video zvonek — rámeček s kamerou a tlačítkem
      return rect(-s * 0.5, -s * 0.85, s * 1.0, s * 1.7, s * 0.16) +
        `<circle cx="0" cy="${(-s * 0.42).toFixed(1)}" r="${(s * 0.22).toFixed(1)}" fill="none" stroke="${color}" stroke-width="${sw}"/>` +
        dot(0, -s * 0.42, s * 0.08) +
        dot(0, s * 0.45, s * 0.16);
    case 'ac': // klimatizace — vnitřní jednotka s lamelami
      return rect(-s * 0.78, -s * 0.42, s * 1.56, s * 0.84, s * 0.18) + ln(-s * 0.6, s * 0.12, s * 0.6, s * 0.12) + ln(-s * 0.4, s * 0.3, s * 0.4, s * 0.3);
    case 'shutter': // vývod roleta — instalační krabička s vývodem ven
      return dot(0, 0, s * 0.28) + ln(s * 0.2, -s * 0.2, s * 0.62, -s * 0.62);
    case 'presence': // Loxone Presence Sensor — stropní čidlo: čočka + radarové oblouky
      return dot(0, 0, s * 0.2) +
        `<path d="M ${(-s * 0.45).toFixed(1)} ${(s * 0.45).toFixed(1)} A ${(s * 0.64).toFixed(1)} ${(s * 0.64).toFixed(1)} 0 0 1 ${(s * 0.45).toFixed(1)} ${(s * 0.45).toFixed(1)}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>` +
        `<path d="M ${(-s * 0.72).toFixed(1)} ${(s * 0.62).toFixed(1)} A ${(s * 0.95).toFixed(1)} ${(s * 0.95).toFixed(1)} 0 0 1 ${(s * 0.72).toFixed(1)} ${(s * 0.62).toFixed(1)}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>`;
    case 'nfc': // Loxone NFC Code Touch — čtečka: rámeček, tečka klávesnice a signální vlnky
      return rect(-s * 0.6, -s * 0.82, s * 1.2, s * 1.64, s * 0.16) + dot(0, s * 0.44, s * 0.16) +
        `<path d="M ${(-s * 0.18).toFixed(1)} ${(-s * 0.5).toFixed(1)} A ${(s * 0.34).toFixed(1)} ${(s * 0.34).toFixed(1)} 0 0 1 ${(-s * 0.18).toFixed(1)} ${(s * 0.06).toFixed(1)}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>` +
        `<path d="M ${(s * 0.12).toFixed(1)} ${(-s * 0.5).toFixed(1)} A ${(s * 0.62).toFixed(1)} ${(s * 0.62).toFixed(1)} 0 0 1 ${(s * 0.12).toFixed(1)} ${(s * 0.06).toFixed(1)}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>`;
    case 'tablet': // nástěnný tablet (iPad) — rámeček na šířku, displej a home tečka
      return rect(-s * 0.92, -s * 0.62, s * 1.84, s * 1.24, s * 0.14) +
        rect(-s * 0.66, -s * 0.44, s * 1.16, s * 0.88, s * 0.04) + dot(s * 0.78, 0, s * 0.09);
    case 'valve': // roháček — rohový ventil s kohoutem
      return `<circle cx="0" cy="0" r="${(s * 0.45).toFixed(1)}" fill="none" stroke="${color}" stroke-width="${sw}"/>` +
        ln(0, -s * 0.45, 0, -s * 0.92) + ln(-s * 0.28, -s * 0.92, s * 0.28, -s * 0.92);
    case 'faucet': // vodovodní baterie — tělo + výtok + páka + dva přívody
      return ln(0, s * 0.55, 0, -s * 0.45) + ln(0, -s * 0.45, s * 0.55, -s * 0.45) + ln(s * 0.55, -s * 0.45, s * 0.55, -s * 0.05) +
        ln(0, -s * 0.15, -s * 0.42, -s * 0.15) + dot(-s * 0.42, s * 0.72, s * 0.14) + dot(s * 0.42, s * 0.72, s * 0.14);
    case 'bidet': // bidetová baterie — baterie nad miskou
      return ln(0, s * 0.15, 0, -s * 0.5) + ln(0, -s * 0.5, s * 0.5, -s * 0.5) + ln(s * 0.5, -s * 0.5, s * 0.5, -s * 0.15) +
        ln(0, -s * 0.2, -s * 0.4, -s * 0.2) +
        `<path d="M ${(-s * 0.6).toFixed(1)} ${(s * 0.35).toFixed(1)} A ${(s * 0.6).toFixed(1)} ${(s * 0.55).toFixed(1)} 0 0 0 ${(s * 0.6).toFixed(1)} ${(s * 0.35).toFixed(1)}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>`;
    case 'geberit': // závěsný systém Geberit — nádržka, tlačítko a mísa v rámu
      return rect(-s * 0.5, -s * 0.9, s * 1.0, s * 0.5, s * 0.06) + dot(0, -s * 0.65, s * 0.1) +
        ln(-s * 0.42, -s * 0.4, -s * 0.42, s * 0.3) + ln(s * 0.42, -s * 0.4, s * 0.42, s * 0.3) +
        `<ellipse cx="0" cy="${(s * 0.5).toFixed(1)}" rx="${(s * 0.45).toFixed(1)}" ry="${(s * 0.28).toFixed(1)}" fill="none" stroke="${color}" stroke-width="${sw}"/>`;
    case 'drain': // kanálek / podlahový žlab — podlouhlý rámeček s příčnou mřížkou
      return rect(-s * 0.9, -s * 0.28, s * 1.8, s * 0.56, s * 0.06) +
        ln(-s * 0.5, -s * 0.28, -s * 0.5, s * 0.28) + ln(-s * 0.15, -s * 0.28, -s * 0.15, s * 0.28) +
        ln(s * 0.2, -s * 0.28, s * 0.2, s * 0.28) + ln(s * 0.55, -s * 0.28, s * 0.55, s * 0.28);
    case 'drainsq': // podlahová vpust čtvercová — rámeček s mřížkou (rošt)
      return rect(-s * 0.6, -s * 0.6, s * 1.2, s * 1.2, s * 0.1) +
        ln(-s * 0.2, -s * 0.6, -s * 0.2, s * 0.6) + ln(s * 0.2, -s * 0.6, s * 0.2, s * 0.6) +
        ln(-s * 0.6, -s * 0.2, s * 0.6, -s * 0.2) + ln(-s * 0.6, s * 0.2, s * 0.6, s * 0.2);
    case 'drainround': // podlahová vpust kulatá — kruh se štěrbinami roštu
      return `<circle cx="0" cy="0" r="${(s * 0.6).toFixed(1)}" fill="none" stroke="${color}" stroke-width="${sw}"/>` +
        ln(-s * 0.28, -s * 0.53, -s * 0.28, s * 0.53) + ln(0, -s * 0.6, 0, s * 0.6) + ln(s * 0.28, -s * 0.53, s * 0.28, s * 0.53);
    case 'washsiphon': // sifon pračkový — krabice s vývodem a „U" sifonem
      return rect(-s * 0.62, -s * 0.62, s * 1.24, s * 1.24, s * 0.12) +
        ln(0, -s * 0.62, 0, -s * 0.9) +
        `<path d="M ${(-s * 0.28).toFixed(1)} ${(-s * 0.1).toFixed(1)} L ${(-s * 0.28).toFixed(1)} ${(s * 0.2).toFixed(1)} A ${(s * 0.28).toFixed(1)} ${(s * 0.28).toFixed(1)} 0 0 0 ${(s * 0.28).toFixed(1)} ${(s * 0.2).toFixed(1)} L ${(s * 0.28).toFixed(1)} ${(-s * 0.1).toFixed(1)}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 'sinkoutlet': // vývod na dřez — půlkruh mísy dřezu se svislým odpadem
      return `<path d="M ${(-s * 0.6).toFixed(1)} ${(-s * 0.35).toFixed(1)} A ${(s * 0.6).toFixed(1)} ${(s * 0.6).toFixed(1)} 0 0 0 ${(s * 0.6).toFixed(1)} ${(-s * 0.35).toFixed(1)} Z" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round"/>` +
        ln(0, s * 0.25, 0, s * 0.85) + dot(0, -s * 0.05, s * 0.12);
    case 'multibox': // vícekrabice — tři pozice v jednom rámečku
      return rect(-s * 0.95, -s * 0.45, s * 1.9, s * 0.9, s * 0.1) +
        ln(-s * 0.32, -s * 0.45, -s * 0.32, s * 0.45) + ln(s * 0.32, -s * 0.45, s * 0.32, s * 0.45);
  }
}

/** Obrys značky prvku (rect/elipsa) ve skutečné velikosti — sdílený vykreslením i zvýrazněním. */
function fixtureOutline(
  shape: 'rect' | 'round', cx: number, cy: number, w: number, h: number,
  fill: string, stroke: string, strokeWidth: number, opacity = 1, pad = 0,
): string {
  const W = w + pad * 2, H = h + pad * 2;
  if (shape === 'round') {
    return `<ellipse cx="${cx}" cy="${cy}" rx="${(W / 2).toFixed(1)}" ry="${(H / 2).toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"/>`;
  }
  const r = Math.min(W, H) * 0.14;
  return `<rect x="${(cx - W / 2).toFixed(1)}" y="${(cy - H / 2).toFixed(1)}" width="${W.toFixed(1)}" height="${H.toFixed(1)}" rx="${r.toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"/>`;
}

/** Barva ztlumené (nezobrazované) pozice vícekrabice — jen obrys, ať nekřičí. */
const DIM_COLOR = '#64748b';

/**
 * Značka osazeného prvku (tvar ve skutečné velikosti + symbol + popisek).
 * @param visible zda je vrstva zobrazená — u vícekrabice řídí, které pozice se
 *   kreslí barevně a které jen šedě (krabice sama je vidět vždy).
 */
export function fixtureMarkerSvg(
  wall: Wall, side: WallSide, f: Fixture, print: boolean, highlighted = false,
  visible: (catId: string) => boolean = () => true,
): string {
  const def = FIXTURE_DEFS[f.kind];
  const c = toDisplay(wall, side, f.uMm, f.vMm);
  const { w, h } = fixtureSize(f);
  const bg = print ? '#ffffff' : '#0b1220';
  const label = fixtureCaption(f);
  // symbol zmenšíme, aby se vešel do menšího rozměru s okrajem; strop kvůli čitelnosti
  // (u bloku se počítá z JEDNOHO kusu, ne z celé šířky bloku)
  const n = fixtureCount(f);
  const glyphS = Math.max(Math.min(Math.min(w / n, h) * 0.3, 90), 22);
  const ring = highlighted
    ? fixtureOutline(def.shape, c.x, c.y, w, h, 'none', '#22d3ee', 30, 0.75, 80)
    : '';
  // Blok víc kusů vedle sebe (dvoj-/trojzásuvka…, vícekrabice): jeden prvek, ale
  // n značek v řadě symetricky kolem středu — kótuje se od středu bloku.
  const unit = w / n;
  const cells = Array.from({ length: n }, (_, i) => c.x - w / 2 + unit * (i + 0.5));
  // Vícekrabice: každá pozice může být jiný typ z jiné vrstvy. Pozice ve skryté
  // vrstvě (i prázdná pozice) se kreslí jen šedě — zvýrazněné zůstane to, co
  // patří do právě zobrazených vrstev.
  const slots = f.kind === 'multibox' ? fixtureSlots(f) : null;
  const cellKind = (i: number): FixtureKind | null => (slots ? slots[i] : f.kind);
  const cellActive = (i: number): boolean => {
    const k = cellKind(i);
    return k != null && (!slots || visible(FIXTURE_LAYER[k]));
  };
  const cellColor = (i: number): string => {
    const k = cellKind(i);
    return cellActive(i) && k ? FIXTURE_DEFS[k].color : DIM_COLOR;
  };
  const bodies = cells.map((x, i) => {
    const k = cellKind(i);
    const col = cellColor(i);
    const empty = slots && !k;
    const shape = k ? FIXTURE_DEFS[k].shape : 'rect';
    const box = fixtureOutline(shape, x, c.y, unit, h, bg, col, 18, print ? 1 : cellActive(i) ? 0.95 : 0.5);
    // Prázdná pozice: jen čárkovaný obrys (obsah se doplní později).
    const dashed = empty ? box.replace('/>', ' stroke-dasharray="40 30"/>') : box;
    const glyph = k
      ? `<g transform="translate(${x} ${c.y})" opacity="${cellActive(i) ? 1 : 0.5}">${fixtureGlyph(k, glyphS, col)}</g>`
      : '';
    return dashed + glyph;
  }).join('');
  // Vícekrabici navíc olemuj společným rámečkem — je to jedna sdílená krabice.
  const frame = slots
    ? fixtureOutline('rect', c.x, c.y, w, h, 'none', print ? '#111' : '#e2e8f0', 12, 0.8, 26)
    : '';
  return (
    `<g data-fixture="${f.id}">` +
    ring +
    frame +
    bodies +
    `<text x="${c.x}" y="${(c.y + h / 2 + 170).toFixed(1)}" text-anchor="middle" font-size="130" font-weight="bold" fill="${print ? '#111' : def.color}" paint-order="stroke" stroke="${print ? '#fff' : '#0f172a'}" stroke-width="36">${esc(label)}</text>` +
    `</g>`
  );
}

/**
 * Bounding box výdřevy v zobrazovacích souřadnicích. Obdélník je zarovnaný s
 * osami stěny, takže po převodu čtyř rohů stačí jejich min/max (u strany B se
 * osa u zrcadlí, ale krajní hodnoty se jen prohodí).
 */
export function rectDisplayRect(
  wall: Wall, side: WallSide, r: { uMm: number; vMm: number; widthMm: number; heightMm: number },
): { x: number; y: number; w: number; h: number } {
  const uMin = r.uMm - r.widthMm / 2, uMax = r.uMm + r.widthMm / 2;
  const vMin = r.vMm - r.heightMm / 2, vMax = r.vMm + r.heightMm / 2;
  const cs = [
    toDisplay(wall, side, uMin, vMin), toDisplay(wall, side, uMax, vMin),
    toDisplay(wall, side, uMax, vMax), toDisplay(wall, side, uMin, vMax),
  ];
  const xs = cs.map((c) => c.x), ys = cs.map((c) => c.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Bounding box výdřevy v zobrazovacích souřadnicích (obdélník = rectDisplayRect). */
export function areaDisplayRect(wall: Wall, side: WallSide, a: WallArea): { x: number; y: number; w: number; h: number } {
  return rectDisplayRect(wall, side, a);
}

/** Afinní matice [a,b,c,d,e,f] mapující 3 body src → 3 body dst (pro SVG matrix() / canvas setTransform). */
export function affine3(s0: XY, s1: XY, s2: XY, d0: XY, d1: XY, d2: XY): number[] {
  const det = (s1.x - s0.x) * (s2.y - s0.y) - (s1.y - s0.y) * (s2.x - s0.x) || 1e-9;
  const a = ((d1.x - d0.x) * (s2.y - s0.y) - (s1.y - s0.y) * (d2.x - d0.x)) / det;
  const c = ((s1.x - s0.x) * (d2.x - d0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / det;
  const b = ((d1.y - d0.y) * (s2.y - s0.y) - (s1.y - s0.y) * (d2.y - d0.y)) / det;
  const d = ((s1.x - s0.x) * (d2.y - d0.y) - (d1.y - d0.y) * (s2.x - s0.x)) / det;
  return [a, b, c, d, d0.x - a * s0.x - c * s0.y, d0.y - b * s0.x - d * s0.y];
}

/**
 * Nejlepší afinní matice [a,b,c,d,e,f] mapující src → dst (x'=ax+cy+e, y'=bx+dy+f).
 * 2 body → PODOBNOST (posun+otočení+stejnoměrné měřítko, BEZ zkosení); 3+ → afinní
 * metodou nejmenších čtverců. Používá se pro umístění dlaždice podle KOTEV.
 */
export function fitTransform(src: XY[], dst: XY[]): number[] {
  const n = Math.min(src.length, dst.length);
  if (n === 2) {
    const dsx = src[1].x - src[0].x, dsy = src[1].y - src[0].y;
    const den = dsx * dsx + dsy * dsy || 1e-9;
    const ddx = dst[1].x - dst[0].x, ddy = dst[1].y - dst[0].y;
    const a = (ddx * dsx + ddy * dsy) / den, bb = (ddy * dsx - ddx * dsy) / den;
    return [a, bb, -bb, a, dst[0].x - (a * src[0].x - bb * src[0].y), dst[0].y - (bb * src[0].x + a * src[0].y)];
  }
  let Sxx = 0, Sxy = 0, Sx = 0, Syy = 0, Sy = 0, S1 = 0, Sxu = 0, Syu = 0, Su = 0, Sxv = 0, Syv = 0, Sv = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i].x, y = src[i].y, u = dst[i].x, v = dst[i].y;
    Sxx += x * x; Sxy += x * y; Sx += x; Syy += y * y; Sy += y; S1 += 1;
    Sxu += x * u; Syu += y * u; Su += u; Sxv += x * v; Syv += y * v; Sv += v;
  }
  const solve3 = (m: number[][], r: number[]): number[] => {
    const M = m.map((row, i) => [...row, r[i]]);
    for (let c = 0; c < 3; c++) {
      let piv = c; for (let k = c + 1; k < 3; k++) if (Math.abs(M[k][c]) > Math.abs(M[piv][c])) piv = k;
      [M[c], M[piv]] = [M[piv], M[c]];
      const dv = M[c][c] || 1e-9; for (let j = c; j <= 3; j++) M[c][j] /= dv;
      for (let k = 0; k < 3; k++) { if (k === c) continue; const f = M[k][c]; for (let j = c; j <= 3; j++) M[k][j] -= f * M[c][j]; }
    }
    return [M[0][3], M[1][3], M[2][3]];
  };
  const N = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, S1]];
  const [a, cc, e] = solve3(N, [Sxu, Syu, Su]);
  const [bb, d, f] = solve3(N, [Sxv, Syv, Sv]);
  return [a, bb, cc, d, e, f];
}

/** Gaussova eliminace (n×n). */
function gaussN(A: number[][], b: number[]): number[] {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-9; for (let j = c; j <= n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c]; for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j]; }
  }
  return M.map((row) => row[n]);
}

/** Homografie (3×3, h33=1) mapující src → dst; 4 body přesně, >4 least‑squares. Pro perspektivu. */
export function solveHomography(src: XY[], dst: XY[]): number[] {
  const rows: number[][] = [], bb: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    rows.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); bb.push(u);
    rows.push([0, 0, 0, x, y, 1, -x * v, -y * v]); bb.push(v);
  }
  let h: number[];
  if (rows.length === 8) h = gaussN(rows, bb);
  else {
    const n = 8, AtA = Array.from({ length: n }, () => new Array(n).fill(0)), Atb = new Array(n).fill(0);
    for (let r = 0; r < rows.length; r++) { const row = rows[r], br = bb[r]; for (let i = 0; i < n; i++) { Atb[i] += row[i] * br; for (let j = 0; j < n; j++) AtA[i][j] += row[i] * row[j]; } }
    h = gaussN(AtA, Atb);
  }
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Aplikuje homografii na bod. */
export function applyH(h: number[], x: number, y: number): XY {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

/**
 * Trojúhelníky pro síťové vykreslení dlaždice: umístění řídí VŠECHNY body (homografie
 * ≥4 bodů = perspektiva; jinak afinní/podobnost). Vrací pole {sTri,dTri} v [0,1]×display,
 * jemná mřížka G×G přes bbox mnohoúhelníku → hladká perspektiva (bez zlomu). Sdílené
 * SVG i canvasem; volající je jen vykreslí a ořízne celým mnohoúhelníkem (dst).
 *
 * `G` = počet dělení mřížky. Když se nezadá, dopočítá se ADAPTIVNĚ podle míry zakřivení
 * perspektivy: rovný záběr (afinní) → 1 buňka, ostrá perspektiva → jemnější síť. Bez
 * toho by nízké G zlomilo přímky (futra, spáry) na hranách buněk — piecewise‑afinní
 * aproximace homografie. Práh je podíl úhlopříčky dst → nezávislý na měřítku (mm i px).
 */
export function meshTriangles(src: XY[], dst: XY[], G?: number): { s: [XY, XY, XY]; d: [XY, XY, XY] }[] {
  const useH = src.length >= 4;
  const H = useH ? solveHomography(src, dst) : null;
  const T = useH ? null : fitTransform(src, dst);
  const map = (x: number, y: number): XY => H ? applyH(H, x, y) : { x: T![0] * x + T![2] * y + T![4], y: T![1] * x + T![3] * y + T![5] };
  const xs = src.map((p) => p.x), ys = src.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (G == null) {
    if (!H) G = 1; // afinní/podobnost je přesná všude → stačí 1 buňka (2 troj.)
    else {
      // Odhad zakřivení: max odchylka homografie od NEJLEPŠÍ afinní mapy přes mřížku
      // vzorků. Aproximace G buňkami sníží tuto odchylku ~1/G² → G ≈ √(dev/práh).
      const Ta = fitTransform(src, dst);
      const af = (x: number, y: number): XY => ({ x: Ta[0] * x + Ta[2] * y + Ta[4], y: Ta[1] * x + Ta[3] * y + Ta[5] });
      const dxs = dst.map((p) => p.x), dys = dst.map((p) => p.y);
      const diag = Math.hypot(Math.max(...dxs) - Math.min(...dxs), Math.max(...dys) - Math.min(...dys)) || 1;
      let dev = 0;
      const S = 4;
      for (let i = 0; i <= S; i++) for (let j = 0; j <= S; j++) {
        const x = x0 + (x1 - x0) * i / S, y = y0 + (y1 - y0) * j / S;
        const a = applyH(H, x, y), b = af(x, y);
        dev = Math.max(dev, Math.hypot(a.x - b.x, a.y - b.y));
      }
      const tol = diag * 0.004; // cílová zbytková odchylka ~0,4 % úhlopříčky dlaždice
      G = Math.max(3, Math.min(16, Math.round(Math.sqrt(dev / Math.max(tol, 1e-6)))));
    }
  }
  const out: { s: [XY, XY, XY]; d: [XY, XY, XY] }[] = [];
  for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
    const ax = x0 + (x1 - x0) * gx / G, bx = x0 + (x1 - x0) * (gx + 1) / G;
    const ay = y0 + (y1 - y0) * gy / G, by = y0 + (y1 - y0) * (gy + 1) / G;
    const s00 = { x: ax, y: ay }, s10 = { x: bx, y: ay }, s11 = { x: bx, y: by }, s01 = { x: ax, y: by };
    const d00 = map(ax, ay), d10 = map(bx, ay), d11 = map(bx, by), d01 = map(ax, by);
    out.push({ s: [s00, s10, s11], d: [d00, d10, d11] }, { s: [s00, s11, s01], d: [d00, d11, d01] });
  }
  return out;
}

/** Triangulace jednoduchého mnohoúhelníku (ear‑clipping) → trojice PŮVODNÍCH indexů. */
export function triangulatePoly(poly: XY[]): [number, number, number][] {
  const n = poly.length;
  if (n < 3) return [];
  const idx = [...Array(n).keys()];
  let area = 0;
  for (let i = 0; i < n; i++) { const a = poly[i], b = poly[(i + 1) % n]; area += a.x * b.y - b.x * a.y; }
  if (area < 0) idx.reverse(); // zajisti CCW
  const cross = (o: XY, a: XY, b: XY): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const inTri = (p: XY, a: XY, b: XY, c: XY): boolean => {
    const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  const tris: [number, number, number][] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 2000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length], i1 = idx[i], i2 = idx[(i + 1) % idx.length];
      const a = poly[i0], b = poly[i1], c = poly[i2];
      if (cross(a, b, c) <= 0) continue; // ne konvexní vrchol (v CCW)
      let ear = true;
      for (const j of idx) { if (j === i0 || j === i1 || j === i2) continue; if (inTri(poly[j], a, b, c)) { ear = false; break; } }
      if (!ear) continue;
      tris.push([i0, i1, i2]); idx.splice(i, 1); clipped = true; break;
    }
    if (!clipped) break; // degenerovaný tvar — přestaň
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

/** Výdřeva / plošná deska: šrafovaný obdélník s popiskem rozměru (sdílené editorem i tiskem). */
export function wallAreaSvg(wall: Wall, side: WallSide, a: WallArea, color: string, print: boolean, selected = false): string {
  const { x, y, w, h } = areaDisplayRect(wall, side, a);
  const pid = `wd-${a.id}`; // id je unikátní i mezi víc SVG na tiskové stránce
  // Nosníky bloku (wizard) kreslíme bez per-deskového popisku — bylo by jich moc;
  // rozměry nese vlastní popisek jen s poznámkou, míry řeší kóty.
  const label = a.beamGroupId
    ? (a.note?.trim() ? esc(a.note.trim()) : '')
    : (a.note?.trim() ? `${a.widthMm}×${a.heightMm} · ${esc(a.note.trim())}` : `${a.widthMm}×${a.heightMm}`);
  const handles = selected && !print
    ? [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
      .map(([hx, hy]) => `<circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="70" fill="#fff" stroke="${color}" stroke-width="20"/>`)
      .join('')
    : '';
  return (
    `<g data-area="${a.id}">` +
    `<defs><pattern id="${pid}" patternUnits="userSpaceOnUse" width="140" height="140" patternTransform="rotate(45)">` +
    `<line x1="0" y1="0" x2="0" y2="140" stroke="${color}" stroke-width="20" opacity="0.55"/></pattern></defs>` +
    `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" opacity="${print ? 0.12 : 0.16}"/>` +
    `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="url(#${pid})"/>` +
    `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="none" stroke="${color}" stroke-width="${selected ? 26 : 16}" opacity="${selected ? 1 : 0.85}"/>` +
    `<text x="${(x + w / 2).toFixed(1)}" y="${(y + h / 2).toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-size="150" font-weight="bold" fill="${print ? '#000' : color}" paint-order="stroke" stroke="${print ? '#fff' : '#0f172a'}" stroke-width="40">${label}</text>` +
    handles +
    `</g>`
  );
}

/** Miniatura typu prvku (tvar + symbol v barvě typu) jako samostatné SVG — pro paletu a „ducha" při tažení. */
export function fixtureThumbSvg(kind: FixtureKind, px = 42): string {
  const def = FIXTURE_DEFS[kind];
  const VB = 300, c = VB / 2, maxDim = VB * 0.78;
  const asp = def.wMm / def.hMm;
  let w = maxDim, h = maxDim;
  if (asp >= 1) h = maxDim / asp; else w = maxDim * asp;
  const outline = fixtureOutline(def.shape, c, c, w, h, 'none', def.color, 16, 1);
  const glyph = `<g transform="translate(${c} ${c})">${fixtureGlyph(kind, Math.max(Math.min(w, h) * 0.3, 24), def.color)}</g>`;
  return `<svg width="${px}" height="${px}" viewBox="0 0 ${VB} ${VB}" xmlns="http://www.w3.org/2000/svg" style="display:block">${outline}${glyph}</svg>`;
}

export interface WallSvgOptions {
  side: WallSide;
  categories: Category[];
  selectedRouteId?: string | null;
  /** Ukázat úchopy „+" pro vkládání uzlů do vybraného šlicu (jen v režimu ✏️ Trasa). */
  showInsertHandles?: boolean;
  /** Zvýrazněná kóta (režim úprav kóty). */
  selectedDimId?: string | null;
  /** Zvýrazněný prvek (vybraný / tažený). */
  selectedFixtureId?: string | null;
  /** Zvýrazněná výdřeva (vybraná / tažená). */
  selectedAreaId?: string | null;
  /** Rozpracovaná trasa při kreslení (v kanonických souřadnicích). */
  draftPoints?: { x: number; y: number }[];
  draftColor?: string;
  draftWidthMm?: number;
  /**
   * ID rozkreslené trasy, která už je „živým" členem wall.routes (aby na ni šlo
   * průběžně kótovat). V normálním výčtu tras ji přeskočíme — kreslí se zvlášť
   * přes draftPoints jako poloprůhledný náčrt.
   */
  draftRouteId?: string;
  forPrint?: boolean;
  /**
   * Narovnané fotky jako podklad čelního pohledu (dlaždice). Kreslí se v pořadí
   * odspodu nahoru; `region` (u,v mm, střed+rozměr) omezí fotku na výřez líce,
   * chybí-li → přes celou zeď. U podlahy/stropu (planOutline) se ořízne na tvar.
   */
  backgrounds?: {
    href: string;
    opacity: number;
    region?: { uMm: number; vMm: number; widthMm: number; heightMm: number; rotDeg?: number };
    /** Volné rohy (corner‑pin) v (u,v) mm, pořadí TL,TR,BR,BL — perspektiva. */
    quad?: XY[];
    /** Síťová dlaždice: src [0,1] × dst (u,v) mm + anchor (roh/ořez). Umístění dle kotev, ořez polygonem. */
    mesh?: { src: XY[]; dst: XY[]; anchor: boolean[] };
  }[];
  /**
   * Holý overlay pro 3D texturu: vynechá mřížku, obrys, otvory, kóty a popisek
   * rozměru — zůstanou jen výdřevy, trasy a osazené prvky (nad podkladem/průhledné).
   */
  bare?: boolean;
  /**
   * Kontrolní kóty celkového rozměru líce (šířka = světlá míra místnosti, výška)
   * — automaticky, jen pro vizuální kontrolu proti naměřenému. Zapíná editor.
   */
  refDims?: boolean;
  /**
   * Šikmý strop (podkroví, fáze 3): profil horní hrany líce jako lomená čára —
   * body { x = zobrazovací x (0…faceLen), h = výška stropu mm ode dna }, seřazené
   * dle x (první x=0, poslední x=faceLen). Zachytí i ZLOM rovný strop → šikmina.
   * Když je zadán, líc se místo obdélníku ukončí touto hranou a obsah (podklad/
   * trasy/prvky) se ořízne pod ni. Počítá geometry.faceCeilingPolyline; chybí =
   * rovný strop do heightMm.
   */
  ceilingTop?: { x: number; h: number }[];
}

/**
 * Kontrolní (referenční) kóty celkového rozměru viditelného líce: šířka dole
 * (= světlá míra místnosti podél stěny), výška vlevo. Tlumená barva a přerušovaná
 * kótovací čára je odlišuje od uživatelských kót. Zobrazovací souřadnice.
 */
function refDimsSvg(len: number, H: number, print: boolean): string {
  const col = print ? '#94a3b8' : '#94a3b8';
  const OFF = 280, GAP = 40, OVER = 70;
  const arrow = (px: number, py: number, dx: number, dy: number): string => {
    const AL = 120, AW = 40;
    const bx = px - dx * AL, by = py - dy * AL, nx = -dy, ny = dx;
    return `<path d="M ${px.toFixed(1)} ${py.toFixed(1)} L ${(bx + nx * AW).toFixed(1)} ${(by + ny * AW).toFixed(1)} L ${(bx - nx * AW).toFixed(1)} ${(by - ny * AW).toFixed(1)} Z" fill="${col}"/>`;
  };
  const p: string[] = [];
  // Šířka — kótovací čára pod stěnou (display y roste dolů; dno stěny je y=H).
  const wy = H + OFF;
  p.push(
    `<line x1="0" y1="${(H + GAP).toFixed(1)}" x2="0" y2="${(wy + OVER).toFixed(1)}" stroke="${col}" stroke-width="6"/>`,
    `<line x1="${len.toFixed(1)}" y1="${(H + GAP).toFixed(1)}" x2="${len.toFixed(1)}" y2="${(wy + OVER).toFixed(1)}" stroke="${col}" stroke-width="6"/>`,
    `<line x1="0" y1="${wy.toFixed(1)}" x2="${len.toFixed(1)}" y2="${wy.toFixed(1)}" stroke="${col}" stroke-width="8" stroke-dasharray="60 40"/>`,
    arrow(0, wy, -1, 0), arrow(len, wy, 1, 0),
    `<text x="${(len / 2).toFixed(1)}" y="${(wy - 55).toFixed(1)}" text-anchor="middle" font-size="150" font-weight="bold" fill="${col}" paint-order="stroke" stroke="${print ? '#fff' : '#0f172a'}" stroke-width="40">${Math.round(len)}</text>`,
  );
  // Výška — kótovací čára vlevo od stěny.
  const hx = -OFF;
  p.push(
    `<line x1="${(-GAP).toFixed(1)}" y1="0" x2="${(hx - OVER).toFixed(1)}" y2="0" stroke="${col}" stroke-width="6"/>`,
    `<line x1="${(-GAP).toFixed(1)}" y1="${H.toFixed(1)}" x2="${(hx - OVER).toFixed(1)}" y2="${H.toFixed(1)}" stroke="${col}" stroke-width="6"/>`,
    `<line x1="${hx.toFixed(1)}" y1="0" x2="${hx.toFixed(1)}" y2="${H.toFixed(1)}" stroke="${col}" stroke-width="8" stroke-dasharray="60 40"/>`,
    arrow(hx, 0, 0, -1), arrow(hx, H, 0, 1),
    `<text x="${(hx - 55).toFixed(1)}" y="${(H / 2).toFixed(1)}" text-anchor="middle" font-size="150" font-weight="bold" fill="${col}" paint-order="stroke" stroke="${print ? '#fff' : '#0f172a'}" stroke-width="40" transform="rotate(-90 ${(hx - 55).toFixed(1)} ${(H / 2).toFixed(1)})">${Math.round(H)}</text>`,
  );
  return p.join('\n');
}

export function wallSvgContent(wall: Wall, opts: WallSvgOptions): string {
  const { side, categories } = opts;
  const face = wall.faces[side]; // obsah líce; otvory zůstávají sdílené na wall
  const len = faceLenMm(wall, side); // délka viditelného líce (bez zazděných rohů)
  const H = wall.heightMm;
  const print = !!opts.forPrint;
  const line = print ? '#333' : '#64748b';
  const parts: string[] = [];

  // Šikmý strop (podkroví): horní hrana líce jako lomená čára v zobrazovacích
  // souřadnicích (display y = H − výška ode dna). Zachytí i zlom rovný strop →
  // šikmina. Když je zadán, líc se ukončí touto hranou místo obdélníku.
  const slope = opts.ceilingTop && opts.ceilingTop.length >= 2 ? opts.ceilingTop : undefined;
  const topPts = slope ? slope.map((p) => ({ x: p.x, y: H - p.h })) : null; // display body horní hrany (L→R)
  const topStr = topPts ? topPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') : '';
  const topRev = topPts ? [...topPts].reverse().map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') : '';
  const topLineD = topPts ? topPts.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') : '';

  // Filtr vrstev: skrytá kategorie schová trasy/prvky i kóty na ně navázané.
  const catVisible = (id: string | undefined): boolean =>
    isCategoryVisible(categories.find((c) => c.id === id));
  const anchorHidden = (a: Anchor): boolean => {
    if (a.kind === 'routePoint' || a.kind === 'routeSeg') {
      const r = face.routes.find((x) => x.id === a.routeId);
      return !!r && !catVisible(r.categoryId);
    }
    if (a.kind === 'fixture') {
      const f = face.fixtures.find((x) => x.id === a.fixtureId);
      // Vícekrabice se kreslí ve všech vrstvách → její kóty taky.
      return !!f && !catVisible(f.categoryId) && !fixtureAlwaysVisible(f);
    }
    if (a.kind === 'area') {
      const ar = face.areas.find((x) => x.id === a.areaId);
      return !!ar && !catVisible(ar.categoryId);
    }
    return false;
  };

  // Podklad — narovnané fotky stěny (dlaždice, pod vším ostatním). Každá buď přes
  // celou zeď, nebo na svůj výřez (region). U podlahy/stropu ořez na tvar místnosti.
  if (opts.backgrounds?.length) {
    const imgs = opts.backgrounds.map((b, i) => {
      const op = b.opacity ?? 0.6;
      if (b.mesh && b.mesh.src.length >= 3) {
        // Umístění řídí VŠECHNY body (homografie = perspektiva); jemná síť → hladké.
        // Oříznuto na celý mnohoúhelník (dst). Tažením kteréhokoli bodu se perspektiva mění.
        const dst = b.mesh.dst.map((p) => toDisplay(wall, side, p.x, p.y));
        const id = `bgm-${wall.id}-${side}-${i}`;
        const poly = dst.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
        const clips: string[] = [`<clipPath id="${id}m"><polygon points="${poly}"/></clipPath>`];
        const tris = meshTriangles(b.mesh.src, dst).map((t, ti) => {
          const m = affine3(t.s[0], t.s[1], t.s[2], t.d[0], t.d[1], t.d[2]);
          const tp = t.d.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
          clips.push(`<clipPath id="${id}t${ti}"><polygon points="${tp}"/></clipPath>`);
          return `<g clip-path="url(#${id}t${ti})"><image href="${b.href}" x="0" y="0" width="1" height="1" preserveAspectRatio="none" opacity="${op}" transform="matrix(${m.map((v) => v.toFixed(5)).join(' ')})"/></g>`;
        });
        return clips.join('') + `<g clip-path="url(#${id}m)">${tris.join('')}</g>`;
      }
      if (b.quad?.length === 4) {
        // Perspektivní dlaždice (corner‑pin): celá fotka do čtyřúhelníku — HLADKÁ
        // homografie přes jemnou síť (stejně jako mesh; dřív 2 troj. dělaly zlom).
        const P = b.quad.map((p) => toDisplay(wall, side, p.x, p.y)); // TL,TR,BR,BL
        const srcQ: XY[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
        const id = `bgq-${wall.id}-${side}-${i}`;
        const clips: string[] = [];
        const tris = meshTriangles(srcQ, P).map((t, ti) => {
          const m = affine3(t.s[0], t.s[1], t.s[2], t.d[0], t.d[1], t.d[2]);
          const tp = t.d.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
          clips.push(`<clipPath id="${id}t${ti}"><polygon points="${tp}"/></clipPath>`);
          return `<g clip-path="url(#${id}t${ti})"><image href="${b.href}" x="0" y="0" width="1" height="1" preserveAspectRatio="none" opacity="${op}" transform="matrix(${m.map((v) => v.toFixed(5)).join(' ')})"/></g>`;
        });
        return clips.join('') + tris.join('');
      }
      if (b.region) {
        const r = rectDisplayRect(wall, side, b.region);
        const img = `<image href="${b.href}" x="${r.x.toFixed(1)}" y="${r.y.toFixed(1)}" width="${r.w.toFixed(1)}" height="${r.h.toFixed(1)}" opacity="${op}" preserveAspectRatio="none"/>`;
        const rd = b.region.rotDeg;
        if (rd) { // otočení dlaždice kolem jejího středu (zobrazovací souřadnice)
          const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
          return `<g transform="rotate(${rd.toFixed(2)} ${cx.toFixed(1)} ${cy.toFixed(1)})">${img}</g>`;
        }
        return img;
      }
      return `<image href="${b.href}" x="0" y="0" width="${len}" height="${H}" opacity="${op}" preserveAspectRatio="none"/>`;
    }).join('');
    // Podlaha/strop: ořez fotek na reálný půdorysný obrys místnosti (planOutline
    // je už v zobrazovacích u,v). Běžná stěna clip nemá → fotky přes celý obdélník.
    if (wall.planOutline?.length) {
      const pts = wall.planOutline.map((p) => toDisplay(wall, side, p.x, p.y));
      const poly = pts.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ');
      const cid = `bgclip-${wall.id}-${side}`;
      parts.push(
        `<clipPath id="${cid}"><polygon points="${poly}"/></clipPath>`,
        `<g clip-path="url(#${cid})">${imgs}</g>`,
      );
    } else {
      parts.push(imgs);
    }
  }

  // Mřížka po 500 mm (v holém overlay pro 3D vynecháno; u fotostěny by předstírala
  // měřítko, které fotka nemá — tam jen překáží přes fotku)
  if (!opts.bare) {
    if (!wall.freeScale) {
      const grid: string[] = [];
      const gridColor = print ? '#ddd' : '#1f2937';
      for (let u = 500; u < len; u += 500) grid.push(`M ${u} 0 V ${H}`);
      for (let v = 500; v < H; v += 500) grid.push(`M 0 ${H - v} H ${len}`);
      parts.push(`<path d="${grid.join(' ')}" stroke="${gridColor}" stroke-width="4" fill="none"/>`);
    }

    // Obrys stěny — u šikminy sleduje lomenou horní hranu místo obdélníku.
    if (topPts) {
      parts.push(`<path d="M 0 ${H} ${topLineD.replace(/^M/, 'L')} L ${len} ${H} Z" fill="none" stroke="${line}" stroke-width="20"/>`);
    } else {
      parts.push(`<rect x="0" y="0" width="${len}" height="${H}" fill="none" stroke="${line}" stroke-width="20"/>`);
    }

    // Otvory. Je-li pod nimi podklad (fotka), výplň poloprůhledná — ať je vidět textura,
    // kterou umisťuješ (jinak by dveře byly černý flek přes fotku). Bez podkladu plná.
    const hasBg = !!opts.backgrounds?.length;
    const openFill = print ? 0.85 : (hasBg ? 0.22 : 1);
    for (const o of wall.openings) {
      const c = toDisplay(wall, side, o.uMm, o.vMm);
      const x = c.x - o.widthMm / 2;
      const y = c.y - o.heightMm / 2;
      parts.push(
        `<rect x="${x}" y="${y}" width="${o.widthMm}" height="${o.heightMm}" fill="${print ? '#f3f4f6' : '#0b1220'}" fill-opacity="${openFill}" stroke="${line}" stroke-width="12" stroke-dasharray="60 40"/>`,
        `<text x="${c.x}" y="${c.y}" text-anchor="middle" dominant-baseline="middle" font-size="140" fill="${print ? '#666' : '#475569'}">${o.kind === 'door' ? 'Dveře' : 'Okno'}</text>`,
      );
    }
  }

  // Obsah líce (výdřevy, trasy, osazené prvky) v JEDNOM průchodu seřazeném podle
  // pořadí vrstev: vrstva výše v seznamu (menší index) se kreslí navrchu — a to
  // NAPŘÍČ typy, takže výdřeva ve vrchní vrstvě překryje i prvek ze spodní vrstvy.
  // Uvnitř jedné vrstvy zůstává výdřeva → trasa → prvek (deska pod kabely, prvek
  // navrchu). Odspodu nahoru = větší rank (níž v seznamu) se emituje dřív.
  const layerRank = new Map(categories.map((c, i) => [c.id, i]));
  const li = (id: string): number => layerRank.get(id) ?? Number.MAX_SAFE_INTEGER;
  const layered: { rank: number; type: 0 | 1 | 2; svg: string }[] = [];

  // Výdřevy (plošné desky) — v rámci vrstvy naspod, ať přes ně kabely vedou viditelně.
  for (const a of face.areas ?? []) {
    const cat = categories.find((c) => c.id === a.categoryId);
    if (!isCategoryVisible(cat)) continue; // skrytá vrstva
    layered.push({ rank: li(a.categoryId), type: 0,
      svg: wallAreaSvg(wall, side, a, cat?.color ?? '#b45309', print, !print && a.id === opts.selectedAreaId) });
  }

  // Trasy
  for (const r of face.routes) {
    if (opts.draftRouteId && r.id === opts.draftRouteId) continue; // kreslí se jako náčrt níž
    const cat = categories.find((c) => c.id === r.categoryId);
    if (!isCategoryVisible(cat)) continue; // skrytá vrstva
    const color = cat?.color ?? '#22d3ee';
    const pts = r.points.map((p) => toDisplay(wall, side, p.x, p.y));
    if (pts.length < 2) continue;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
    const selected = r.id === opts.selectedRouteId;
    const seg: string[] = [
      `<path d="${d}" stroke="${color}" stroke-width="${Math.max(r.widthMm, 5)}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${selected ? 0.95 : 0.65}" data-route="${r.id}"/>`,
      `<path d="${d}" stroke="${print ? '#000' : '#fff'}" stroke-width="8" fill="none" stroke-dasharray="80 80" opacity="0.7"/>`,
    ];
    if (selected) {
      // Úchopy uzlů (tažení = posun, dvojklik = smazání) — plný bílý puntík.
      for (const p of pts) seg.push(`<circle cx="${p.x}" cy="${p.y}" r="60" fill="#fff" stroke="${color}" stroke-width="20"/>`);
      // Úchop pro VLOŽENÍ uzlu v půli segmentu — menší puntík s „+". Jen v režimu
      // Trasa; nástroj Vybrat má šlic pouze vybírat (uzly tahat/mazat), ne přidávat.
      if (opts.showInsertHandles) for (let i = 0; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
        seg.push(
          `<circle cx="${mx}" cy="${my}" r="42" fill="#fff" stroke="${color}" stroke-width="12" opacity="0.9"/>`,
          `<path d="M ${mx - 22} ${my} H ${mx + 22} M ${mx} ${my - 22} V ${my + 22}" stroke="${color}" stroke-width="12" stroke-linecap="round"/>`,
        );
      }
    }
    // Popisky délek segmentů
    for (let i = 0; i < pts.length - 1; i++) {
      const meas = r.segLengthsMm[i];
      const label = meas != null ? `${meas}` : '';
      if (!label) continue;
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      seg.push(`<text x="${mx}" y="${my - 60}" text-anchor="middle" font-size="150" font-weight="bold" fill="${print ? '#000' : color}" paint-order="stroke" stroke="${print ? '#fff' : '#0f172a'}" stroke-width="40">${label}</text>`);
    }
    layered.push({ rank: li(r.categoryId), type: 1, svg: seg.join('') });
  }

  // Osazené prvky (paleta) — v rámci vrstvy navrchu, pod kótami
  for (const f of face.fixtures) {
    // Vícekrabice je sdílená napříč profesemi → kreslí se i ve skryté vrstvě
    // (pozice mimo zobrazené vrstvy jen zešednou).
    if (!catVisible(f.categoryId) && !fixtureAlwaysVisible(f)) continue;
    layered.push({ rank: li(f.categoryId), type: 2,
      svg: fixtureMarkerSvg(wall, side, f, print, !print && f.id === opts.selectedFixtureId, catVisible) });
  }

  // Emise odspodu nahoru: vrstva níž v seznamu (větší rank) dřív; při shodě vrstvy
  // výdřeva (0) → trasa (1) → prvek (2). Řazení stabilní → pořadí vložení v rámci
  // stejné vrstvy i typu zůstává.
  layered.sort((a, b) => (b.rank - a.rank) || (a.type - b.type));
  for (const it of layered) parts.push(it.svg);

  // Rozpracovaná trasa — náčrt nad hotovým obsahem
  if (opts.draftPoints && opts.draftPoints.length > 0) {
    const pts = opts.draftPoints.map((p) => toDisplay(wall, side, p.x, p.y));
    const d = pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
    parts.push(
      `<path d="${d}" stroke="${opts.draftColor ?? '#22d3ee'}" stroke-width="${Math.max(opts.draftWidthMm ?? 50, 5)}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"/>`,
    );
    for (const p of pts) parts.push(`<circle cx="${p.x}" cy="${p.y}" r="50" fill="${opts.draftColor ?? '#22d3ee'}"/>`);
  }

  // Šikmý strop: obsah líce (podklad, mřížka, obrys, výdřevy, trasy, prvky) ořízni
  // pod skloněnou hranu; nad ní vykresli „střechu" (šrafuru). Kóty a popisek
  // rozměru přijdou až za tím — nekřížou se a nesmí se oříznout (kreslí se i vně líce).
  if (topPts) {
    const clipId = `slopeclip-${wall.id}-${side}`;
    // Plocha místnosti = pod lomenou horní hranou; „střecha" = nad ní.
    const roomPoly = `0,${H} ${topStr} ${len},${H}`;
    const roofPoly = `0,0 ${len},0 ${topRev}`;
    const body = parts.splice(0, parts.length);
    parts.push(
      `<clipPath id="${clipId}"><polygon points="${roomPoly}"/></clipPath>`,
      `<g clip-path="url(#${clipId})">${body.join('\n')}</g>`,
    );
    if (!opts.bare) {
      const hatch = print ? '#d1d5db' : '#334155';
      parts.push(
        `<polygon points="${roofPoly}" fill="${hatch}" fill-opacity="0.14"/>`,
        `<path d="${topLineD}" fill="none" stroke="${line}" stroke-width="24"/>`,
      );
    }
  }

  // Kóty — klasické technické kótování: vynášecí čáry, odsazená kótovací čára
  // se šipkami na obou koncích a popiskem vzdálenosti nad ní. (v holém overlay vynecháno)
  if (!opts.bare) {
  const dimColor = print ? '#000' : '#fbbf24';
  const cx = len / 2, cy = H / 2;
  const OFF = 300;   // odsazení kótovací čáry od měřeného úseku (mm)
  const OVER = 90;   // přesah vynášecí čáry za kótovací čáru
  const GAP = 40;    // mezera mezi měřeným bodem a začátkem vynášecí čáry
  const arrow = (px: number, py: number, dx: number, dy: number, color: string): string => {
    // šipka: hrot v (px,py), míří ven ve směru (dx,dy)
    const AL = 130, AW = 45;
    const bx = px - dx * AL, by = py - dy * AL;
    const nx = -dy, ny = dx;
    return `<path d="M ${px} ${py} L ${bx + nx * AW} ${by + ny * AW} L ${bx - nx * AW} ${by - ny * AW} Z" fill="${color}"/>`;
  };
  for (const dim of face.dims) {
    if (anchorHidden(dim.from) || anchorHidden(dim.to)) continue; // kóta na skrytou vrstvu
    const ep = dimEndpoints(wall, side, dim);
    if (!ep) continue;
    const a = toDisplay(wall, side, ep.a.uMm, ep.a.vMm);
    const b = toDisplay(wall, side, ep.b.uMm, ep.b.vMm);
    const geom = Math.round(Math.hypot(ep.b.uMm - ep.a.uMm, ep.b.vMm - ep.a.vMm));
    // Kóta má přednost, ale geometrie ji nedokázala splnit (drží ji naměřené segmenty)
    // → naměřená hodnota nesedí se skutečností. Ukázat červeně a s „≠ skutečnost",
    // ať je jasné, že kóta NEPLATÍ (a o kolik se míjí).
    // Fotostěna měřítko nemá — zapsaná míra je popisek, s geometrií se neporovnává.
    const conflict = !wall.freeScale && dim.valueMm != null && Math.abs(dim.valueMm - geom) > 1;
    const sel = !print && dim.id === opts.selectedDimId;
    const dc = conflict ? (print ? '#cc0000' : '#f87171') : sel ? '#38bdf8' : dimColor;
    const label = conflict ? `${dim.valueMm} ≠ ${geom}` : `${dim.valueMm ?? geom}${dim.valueMm == null ? '?' : ''}`;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg < 1) {
      parts.push(
        `<circle cx="${a.x}" cy="${a.y}" r="${sel ? 55 : 35}" fill="${dc}" data-dim="${dim.id}"/>`,
        `<text x="${a.x}" y="${a.y - 60}" text-anchor="middle" font-size="140" fill="${dc}" paint-order="stroke" stroke="${print ? '#fff' : '#0f172a'}" stroke-width="40">${label}</text>`,
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
      `<line x1="${a.x + nx * GAP}" y1="${a.y + ny * GAP}" x2="${a.x + nx * (OFF + OVER)}" y2="${a.y + ny * (OFF + OVER)}" stroke="${dc}" stroke-width="6"/>`,
      `<line x1="${b.x + nx * GAP}" y1="${b.y + ny * GAP}" x2="${b.x + nx * (OFF + OVER)}" y2="${b.y + ny * (OFF + OVER)}" stroke="${dc}" stroke-width="6"/>`,
      // kótovací čára + šipky mířící ven k vynášecím čárám
      `<line x1="${aX}" y1="${aY}" x2="${bX}" y2="${bY}" stroke="${dc}" stroke-width="${sel ? 16 : 8}" data-dim="${dim.id}"/>`,
      arrow(aX, aY, -dxu, -dyu, dc),
      arrow(bX, bY, dxu, dyu, dc),
      // popisek vzdálenosti nad kótovací čárou
      `<text x="${tX}" y="${tY}" text-anchor="middle" dominant-baseline="central" transform="rotate(${ang.toFixed(1)} ${tX} ${tY})" font-size="140" fill="${dc}" paint-order="stroke" stroke="${print ? '#fff' : '#0f172a'}" stroke-width="40">${label}</text>`,
    );
  }
  }

  // Rozměr stěny: v editoru kontrolní kóty (světlá míra pro porovnání s naměřeným),
  // jinak jen kompaktní popisek. V holém overlay (3D) vynecháno.
  if (opts.refDims) {
    parts.push(refDimsSvg(len, H, print));
  } else if (!opts.bare && !wall.freeScale) { // fotostěna měřítko nemá — rozměr neuvádět
    parts.push(
      `<text x="${len / 2}" y="${H + 250}" text-anchor="middle" font-size="160" fill="${print ? '#333' : '#64748b'}">${esc(`${Math.round(len)} × ${Math.round(H)} mm`)}</text>`,
    );
  }

  return parts.join('\n');
}
