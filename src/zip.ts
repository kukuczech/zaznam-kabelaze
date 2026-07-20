// Export/import celého projektu jako ZIP: project.json + photos/<id>.
import JSZip from 'jszip';
import { allPhotoIds, getPhoto, project, replaceProject, savePhoto } from './db';
import { saveBlob } from './save-file';
import type { Project } from './model/types';

export async function exportZip(): Promise<void> {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(project, null, 2));
  const photos = zip.folder('photos')!;
  for (const id of await allPhotoIds()) {
    const blob = await getPhoto(id);
    if (blob) photos.file(id, blob);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  await saveBlob(blob, `zaznam-kabelaze-${new Date().toISOString().slice(0, 10)}.zip`);
}

export async function importZip(file: File): Promise<void> {
  const zip = await JSZip.loadAsync(file);
  const json = await zip.file('project.json')?.async('string');
  if (!json) throw new Error('V ZIPu chybí project.json');
  const p = JSON.parse(json) as Project;
  await replaceProject(p);
  const photoFiles = zip.folder('photos');
  if (photoFiles) {
    const jobs: Promise<void>[] = [];
    photoFiles.forEach((id, f) => {
      jobs.push(f.async('blob').then((b) => savePhoto(id, b)));
    });
    await Promise.all(jobs);
  }
}
