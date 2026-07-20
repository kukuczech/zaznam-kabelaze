// Fotostěna: rychlý zákres do obyčejné fotografie, když není čas na 3D sken.
//
// Fotka se založí jako běžná `Wall` (jen líc A, bez tloušťky) ve sběrném podlaží
// „Fotostěny" a fotka se na ni položí jako podklad přes celou plochu. Díky tomu
// s ní beze změny pracuje editor elevace (trasy, prvky, kóty), tisk, PDF i
// export/import ZIPu — nic z toho o fotostěnách nemusí vědět.
//
// Rozměry plochy jsou jen poměr stran fotky (viz PHOTO_WALL_WIDTH_MM); měřítko
// fotka nemá, takže kóty jsou pouhé popisky naměřených hodnot (`Wall.freeScale`).
import { project, saveProject, savePhoto, deletePhoto } from '../db';
import { newId, photoStorey, photoWallSurface, type Wall } from './types';

/** Fotostěny v projektu (prázdné pole, dokud žádná není). */
export function photoWalls(): Wall[] {
  return photoStorey(project)?.walls ?? [];
}

/** Poměr stran obrázku (šířka / výška); u nečitelného souboru padá na 4:3. */
async function imageAspect(file: File): Promise<number> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('Obrázek se nepodařilo načíst'));
      img.src = url;
    });
    return img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 4 / 3;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Založí fotostěnu z vyfocené / nahrané fotky a vrátí ji (už uloženou v projektu).
 * Fotka se ukládá v originále (Blob v IndexedDB), plocha dostane její poměr stran
 * a podklad bez `region` = přes celý líc.
 */
export async function createPhotoWall(file: File, name: string): Promise<Wall> {
  const aspect = await imageAspect(file);
  const photoId = newId();
  await savePhoto(photoId, file);
  const wall = photoWallSurface(name, aspect);
  wall.faces.A.photoIds.push(photoId);
  wall.faces.A.backgrounds.push({ id: newId(), photoId, opacity: 1 });
  photoStorey(project, true)!.walls.push(wall);
  saveProject();
  return wall;
}

/** Smaže fotostěnu i její fotky (originály i narovnané podklady). */
export async function deletePhotoWall(wallId: string): Promise<void> {
  const storey = photoStorey(project);
  const i = storey?.walls.findIndex((w) => w.id === wallId) ?? -1;
  if (!storey || i < 0) return;
  const [wall] = storey.walls.splice(i, 1);
  const ids = new Set<string>();
  for (const face of [wall.faces.A, wall.faces.B]) {
    for (const id of face.photoIds) ids.add(id);
    for (const bg of face.backgrounds) { ids.add(bg.photoId); if (bg.sourcePhotoId) ids.add(bg.sourcePhotoId); }
  }
  await Promise.all([...ids].map((id) => deletePhoto(id)));
  saveProject();
}

/** Návrh jména pro novou fotostěnu — „Fotka 1", „Fotka 2", … (bez kolizí). */
export function nextPhotoWallName(): string {
  const used = new Set(photoWalls().map((w) => w.name));
  for (let i = 1; ; i++) {
    const name = `Fotka ${i}`;
    if (!used.has(name)) return name;
  }
}
