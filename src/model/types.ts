// Datový model projektu. Všechny délky v milimetrech, souřadnice stěny v (u, v):
// u = vzdálenost podél osy stěny od bodu axis[0], v = výška ode dna podlaží.

export interface XY {
  x: number;
  y: number;
}

export interface Project {
  id: string;
  name: string;
  storeys: Storey[];
  categories: Category[];
}

export interface Storey {
  id: string;
  name: string;
  /** Výchozí výška stěn podlaží (mm) — fallback, každá stěna má vlastní. */
  wallHeightMm: number;
  walls: Wall[];
  /** Půdorysné polygony podlah (IFCSLAB) — jen pro orientaci ve 3D. */
  slabs?: XY[][];
}

export interface Wall {
  id: string;
  ifcGuid: string;
  /** Lidský název, např. „Stěna 12". */
  name: string;
  /** Osa stěny v půdorysu podlaží (mm). Kanonický pohled: osa zleva doprava, díváme se ze strany levotočivé normály. */
  axis: [XY, XY];
  thicknessMm: number;
  heightMm: number;
  openings: Opening[];
  photoIds: string[];
  routes: Route[];
  dims: Dimension[];
}

/** Otvor ve stěně; (uMm, vMm) je STŘED otvoru v souřadnicích stěny. */
export interface Opening {
  kind: 'door' | 'window';
  uMm: number;
  vMm: number;
  widthMm: number;
  heightMm: number;
}

export interface Route {
  id: string;
  categoryId: string;
  /** Šířka šlicu — koridor, kde se nesmí vrtat. */
  widthMm: number;
  note: string;
  points: XY[]; // v souřadnicích (u, v) — XY.x = u, XY.y = v
  /** Naměřená délka segmentu i (points[i] → points[i+1]); null = jen klikaná geometrie. */
  segLengthsMm: (number | null)[];
}

export type Anchor =
  | { kind: 'routePoint'; routeId: string; index: number }
  | { kind: 'edge'; edge: 'top' | 'bottom' | 'left' | 'right' }
  | { kind: 'point'; uMm: number; vMm: number };

export interface Dimension {
  id: string;
  from: Anchor;
  to: Anchor;
  /** Naměřená hodnota; null = zobrazit geometrickou vzdálenost. */
  valueMm: number | null;
}

export interface Category {
  id: string;
  name: string;
  color: string;
}

export const DEFAULT_CATEGORIES: Category[] = [
  { id: 'silnoproud', name: 'Silnoproud', color: '#e11d48' },
  { id: 'slaboproud', name: 'Slaboproud', color: '#f59e0b' },
  { id: 'loxone', name: 'Loxone', color: '#16a34a' },
  { id: 'voda', name: 'Voda', color: '#2563eb' },
  { id: 'odpad', name: 'Odpad', color: '#78716c' },
  { id: 'topeni', name: 'Topení', color: '#9333ea' },
];

export function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function emptyProject(): Project {
  return {
    id: newId(),
    name: 'Můj dům',
    storeys: [],
    categories: structuredClone(DEFAULT_CATEGORIES),
  };
}
