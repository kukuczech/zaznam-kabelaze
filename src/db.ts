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

export async function loadProject(): Promise<Project> {
  const stored = (await (await db()).get('project', 'current')) as Project | undefined;
  if (stored) project = stored;
  return project;
}

let saveTimer: number | undefined;

/** Debounced autosave — volat po každé změně projektu. */
export function saveProject(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    await (await db()).put('project', structuredClone(project), 'current');
  }, 300);
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
  await (await db()).put('project', structuredClone(project), 'current');
}
