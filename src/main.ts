// Bootstrap + jednoduchý hash router: #/ | #/storey/:id | #/wall/:id/:strana | #/print
import { loadProject, undo, redo } from './db';
import { renderHome } from './ui/home';
import { renderViewer3d } from './ui/viewer3d';
import { renderElevation } from './ui/elevation';
import { renderPrint } from './ui/print';
import { initUpdateCheck } from './ui/update-check';
import type { WallSide } from './model/geometry';

const app = document.getElementById('app')!;

// Obrazovky si registrují úklid (animační smyčky, observery) před přepnutím.
const cleanups: (() => void)[] = [];
export function registerCleanup(fn: () => void): void {
  cleanups.push(fn);
}

export async function route(): Promise<void> {
  cleanups.splice(0).forEach((fn) => fn());
  const hash = location.hash || '#/';
  const [, screen, id, arg] = hash.split('/');
  app.innerHTML = '';
  if (screen === 'storey' && id) await renderViewer3d(app, id);
  else if (screen === 'wall' && id) await renderElevation(app, id, (arg as WallSide) || 'A');
  else if (screen === 'print') await renderPrint(app);
  else await renderHome(app);
}

window.addEventListener('hashchange', route);

// Globální undo/redo: Ctrl/Cmd+Z zpět, Ctrl/Cmd+Shift+Z nebo Ctrl+Y vpřed.
// Uvnitř textových polí necháme nativní undo prohlížeči.
function isEditable(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

window.addEventListener('keydown', async (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const key = e.key.toLowerCase();
  const isUndo = key === 'z' && !e.shiftKey;
  const isRedo = (key === 'z' && e.shiftKey) || key === 'y';
  if (!isUndo && !isRedo) return;
  if (isEditable(e.target)) return;
  e.preventDefault();
  if (await (isUndo ? undo() : redo())) await route();
});

loadProject().then(route);

// Sleduj, jestli není venku nová verze, a nabídni obnovení.
initUpdateCheck();

// Dev-only: import IFC z URL (testování bez souborového dialogu), např.
// devImportIfc('./testdata/gf.ifc')
if (import.meta.env.DEV) {
  (window as any).devImportIfc = async (url: string) => {
    const { importIfc } = await import('./model/ifc-import');
    const { project, saveProject } = await import('./db');
    const blob = await (await fetch(url)).blob();
    const storey = await importIfc(new File([blob], url.split('/').pop()!));
    project.storeys.push(storey);
    saveProject();
    await route();
    return `${storey.name}: ${storey.walls.length} stěn`;
  };
}
