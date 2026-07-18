// Perzistence: celý projekt jako jeden JSON dokument v IndexedDB, fotky zvlášť jako Bloby.
import { openDB, type IDBPDatabase } from 'idb';
import { emptyProject, type Project } from './model/types';

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
  if (stored) project = stored;
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
  project = p;
  resetHistory();
  await (await db()).put('project', structuredClone(project), 'current');
}
