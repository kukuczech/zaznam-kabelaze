// Perzistence: celý projekt jako jeden JSON dokument v IndexedDB, fotky zvlášť jako Bloby.
import { openDB, type IDBPDatabase } from 'idb';
import { DEFAULT_CATEGORIES, DEFAULT_PHOTO_PHASES, defaultCategoryForFixture, emptyFace, emptyProject, newId, roomSurface, roomSurfaces, type Project, type Room, type WallBackground, type WallFace, type WallSide, type XY } from './model/types';
import { buildCornerGraph, computeFaceTrims, computeRoomClearPolygons } from './model/geometry';

/**
 * Doplní chybějící / přejmenovaná pole u projektů z dřívějších verzí, aby nový
 * kód nespadl na undefined. Nová funkcionalita = přidej sem převod, ať se
 * starší uložené projekty (IndexedDB i importované ZIPy) načtou beze ztráty dat.
 */
export function migrateProject(p: Project): Project {
  // Vrstvy: doplnit stavební kategorie (nosníky, výdřevy) — každou právě JEDNOU.
  // Které už projekt někdy dostal, si pamatujeme v `builtInCatsSeen`, aby se ručně
  // smazaná vrstva nevracela. Zpětná kompatibilita: aktuálně přítomné stavební
  // vrstvy (bez stampu, např. staré `vydreva`) rovnou označíme za viděné — takže se
  // nově zavedené vrstvy (nosnik-*) doplní i projektům, které už `vydreva` měly.
  p.categories ??= [];
  const buildIns = DEFAULT_CATEGORIES.filter((c) => c.id.startsWith('nosnik-') || c.id === 'vydreva');
  const seen = new Set(p.builtInCatsSeen ?? []);
  for (const c of p.categories) if (buildIns.some((b) => b.id === c.id)) seen.add(c.id);
  for (const def of buildIns) {
    if (!seen.has(def.id)) { p.categories.push({ ...def }); seen.add(def.id); }
  }
  p.builtInCatsSeen = [...seen];
  // Fáze fotek (neomítnuté / omítnuté / …) — starším projektům doplnit výchozí číselník.
  if (!Array.isArray(p.photoPhases) || p.photoPhases.length === 0) {
    p.photoPhases = structuredClone(DEFAULT_PHOTO_PHASES);
  }
  for (const s of p.storeys ?? []) {
    // Dřív se ukládaly jen holé polygony podlah `slabs`; teď jsou to místnosti.
    const legacySlabs = (s as { slabs?: XY[][] }).slabs;
    if (!Array.isArray(s.rooms)) s.rooms = [];
    if (legacySlabs && s.rooms.length === 0) {
      s.rooms = legacySlabs.map((polygon, i): Room => ({
        id: newId(),
        name: `Místnost ${i + 1}`,
        polygon,
      }));
    }
    delete (s as { slabs?: XY[][] }).slabs;
    // Topologický graf rohů (zdroj pravdy pro polohu konců stěn) — postavit, chybí-li.
    // Solver zatím = identita: graf se jen přidá jako metadata, `axis` se NEPŘEPISUJE
    // (rebuildAxes se v migraci nevolá), takže chování zůstává beze změny.
    if (!s.corners) {
      buildCornerGraph(s);
    }
    // Viditelný líc (per-líc ořez zazděných/prodloužených konců v rozích) — dopočítat,
    // chybí-li faceTrim (i starší jednoduchý trimStartMm/trimEndMm se tím nahradí).
    if ((s.walls ?? []).some((w) => !w.faceTrim)) {
      computeFaceTrims(s.walls ?? []);
    }
    // Světlý (vnitřní) obrys místností — dopočítat, chybí-li; a přestavět už
    // vytvořené (prázdné) plochy podlahy/stropu, co mají ještě starý vnější bbox.
    if ((s.rooms ?? []).some((r) => !r.clearPolygon)) {
      computeRoomClearPolygons(s.walls ?? [], s.rooms ?? []);
    }
    const faceEmpty = (f?: WallFace): boolean =>
      !f || (f.routes?.length ?? 0) === 0 && (f.dims?.length ?? 0) === 0 && (f.fixtures?.length ?? 0) === 0 && (f.areas?.length ?? 0) === 0;
    for (const r of s.rooms ?? []) {
      for (const kind of ['floor', 'ceiling'] as const) {
        const surf = r[kind];
        if (!surf || !faceEmpty(surf.faces?.A)) continue; // nakreslený obsah nehýbat
        const fresh = roomSurface(r, kind);
        surf.axis = fresh.axis;
        surf.heightMm = fresh.heightMm;
        surf.planOutline = fresh.planOutline;
      }
    }
    for (const w of s.walls ?? []) {
      // Dvě tváře stěny (A/B). Starší stěny měly obsah plochý přímo na stěně —
      // ten patří na stranu A (na ni se dosud kreslilo); strana B začíná prázdná.
      const flat = w as unknown as Partial<WallFace> & { background?: WallBackground };
      if (!w.faces) {
        const faceA: WallFace = {
          photoIds: flat.photoIds ?? [],
          routes: flat.routes ?? [],
          dims: flat.dims ?? [],
          fixtures: flat.fixtures ?? [],
          areas: flat.areas ?? [],
          backgrounds: Array.isArray(flat.backgrounds) ? flat.backgrounds : [],
          activeBackgroundId: flat.activeBackgroundId,
        };
        // Dřív býval jediný podklad `background`; teď jich líc může mít víc.
        const legacy = flat.background;
        if (legacy && faceA.backgrounds.length === 0) {
          const id = legacy.id ?? newId();
          faceA.backgrounds.push({ ...legacy, id });
          faceA.activeBackgroundId = id;
        }
        w.faces = { A: faceA, B: emptyFace() };
      }
      // Odklidit stará plochá pole ze stěny (obsah je teď ve faces).
      for (const k of ['photoIds', 'routes', 'dims', 'fixtures', 'areas', 'backgrounds', 'activeBackgroundId', 'background']) {
        delete (w as unknown as Record<string, unknown>)[k];
      }
      // Normalizace obou tváří: doplnit chybějící pole i id podkladů.
      for (const side of ['A', 'B'] as WallSide[]) {
        const f = (w.faces[side] ??= emptyFace());
        f.photoIds ??= [];
        f.routes ??= [];
        f.dims ??= [];
        f.fixtures ??= [];
        f.areas ??= [];
        if (!Array.isArray(f.backgrounds)) f.backgrounds = [];
        // Prvkům z dřívějška chybí vrstva (categoryId) — doplnit podle typu.
        for (const fx of f.fixtures) fx.categoryId ??= defaultCategoryForFixture(fx.kind);
        // Starším podkladům chybí vlastní id.
        for (const bg of f.backgrounds) bg.id ??= newId();
        if (f.backgrounds.length && !f.backgrounds.some((b) => b.id === f.activeBackgroundId)) {
          f.activeBackgroundId = f.backgrounds[0].id;
        }
      }
    }
  }
  // --- Sloučení vrstev Voda + Odpad a přesun Touch Pure do Loxone ---
  // Projdi všechny líce (stěny i podlahy/stropy místností) a přemapuj vrstvu prvků,
  // tras a desek: 'odpad' → 'voda'; Touch Pure ze slaboproudu → 'loxone'.
  const faces: WallFace[] = [];
  for (const s of p.storeys ?? []) {
    for (const w of s.walls ?? []) {
      if (w.faces) for (const side of ['A', 'B'] as WallSide[]) if (w.faces[side]) faces.push(w.faces[side]);
    }
    for (const r of s.rooms ?? []) {
      for (const surf of roomSurfaces(r)) {
        if (surf.faces) for (const side of ['A', 'B'] as WallSide[]) if (surf.faces[side]) faces.push(surf.faces[side]);
      }
    }
  }
  for (const f of faces) {
    for (const fx of f.fixtures ?? []) {
      if (fx.categoryId === 'odpad') fx.categoryId = 'voda';
      if (fx.kind === 'touch' && fx.categoryId === 'slaboproud') fx.categoryId = 'loxone';
    }
    for (const rt of f.routes ?? []) if (rt.categoryId === 'odpad') rt.categoryId = 'voda';
    for (const ar of f.areas ?? []) if (ar.categoryId === 'odpad') ar.categoryId = 'voda';
  }
  // Číselník vrstev: zajistit Loxone, přejmenovat „Voda" → „Voda a odpad", odstranit „Odpad".
  if (!p.categories.some((c) => c.id === 'loxone')) {
    const loxDef = DEFAULT_CATEGORIES.find((c) => c.id === 'loxone');
    if (loxDef) p.categories.push({ ...loxDef });
  }
  const voda = p.categories.find((c) => c.id === 'voda');
  if (voda && voda.name === 'Voda') voda.name = 'Voda a odpad';
  p.categories = p.categories.filter((c) => c.id !== 'odpad');
  return p;
}

const DB_NAME = 'zaznam-kabelaze';

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, 1, {
    upgrade(d) {
      d.createObjectStore('project');
      d.createObjectStore('photos');
    },
  });
  return dbPromise;
}

export let project: Project = emptyProject();

// --- historie pro undo/redo (snapshoty celého projektu) ---
const HISTORY_LIMIT = 100;
let present: Project = structuredClone(project); // poslední potvrzený stav
let presentJson = JSON.stringify(present);
const undoStack: Project[] = [];
const redoStack: Project[] = [];
let restoring = false;

const historyListeners = new Set<() => void>();
/** Přihlásí posluchače na změnu historie (pro (de)aktivaci tlačítek). Vrací odhlašovač. */
export function onHistoryChange(fn: () => void): () => void {
  historyListeners.add(fn);
  return () => historyListeners.delete(fn);
}
function emitHistory(): void {
  historyListeners.forEach((fn) => fn());
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}
export function canRedo(): boolean {
  return redoStack.length > 0;
}

/** Vynuluje historii (po celkové výměně projektu — import ZIP, load). */
function resetHistory(): void {
  present = structuredClone(project);
  presentJson = JSON.stringify(present);
  undoStack.length = 0;
  redoStack.length = 0;
  emitHistory();
}

export async function loadProject(): Promise<Project> {
  const stored = (await (await db()).get('project', 'current')) as Project | undefined;
  if (stored) project = migrateProject(stored);
  resetHistory();
  return project;
}

let saveTimer: number | undefined;

function scheduleWrite(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    await (await db()).put('project', structuredClone(project), 'current');
  }, 300);
}

/** Debounced autosave — volat po každé změně projektu. Zároveň zapíše krok do historie. */
export function saveProject(): void {
  if (!restoring) {
    const curJson = JSON.stringify(project);
    if (curJson !== presentJson) {
      undoStack.push(present);
      if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
      present = structuredClone(project);
      presentJson = curJson;
      redoStack.length = 0;
      emitHistory();
    }
  }
  scheduleWrite();
}

/** Krok zpět. Vrací true, pokud se něco změnilo. */
export async function undo(): Promise<boolean> {
  const prev = undoStack.pop();
  if (!prev) return false;
  redoStack.push(present);
  present = prev;
  presentJson = JSON.stringify(present);
  project = structuredClone(present);
  restoring = true;
  scheduleWrite();
  restoring = false;
  emitHistory();
  return true;
}

/** Krok vpřed. Vrací true, pokud se něco změnilo. */
export async function redo(): Promise<boolean> {
  const next = redoStack.pop();
  if (!next) return false;
  undoStack.push(present);
  present = next;
  presentJson = JSON.stringify(present);
  project = structuredClone(present);
  restoring = true;
  scheduleWrite();
  restoring = false;
  emitHistory();
  return true;
}

export async function savePhoto(id: string, blob: Blob): Promise<void> {
  await (await db()).put('photos', blob, id);
}

export async function getPhoto(id: string): Promise<Blob | undefined> {
  return (await db()).get('photos', id);
}

export async function deletePhoto(id: string): Promise<void> {
  await (await db()).delete('photos', id);
}

export async function allPhotoIds(): Promise<string[]> {
  return (await (await db()).getAllKeys('photos')) as string[];
}

export async function replaceProject(p: Project): Promise<void> {
  project = migrateProject(p);
  resetHistory();
  await (await db()).put('project', structuredClone(project), 'current');
}
