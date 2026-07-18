// Bootstrap + jednoduchý hash router: #/ | #/storey/:id | #/wall/:id/:strana | #/print
import { loadProject } from './db';
import { renderHome } from './ui/home';
import { renderViewer3d } from './ui/viewer3d';
import { renderElevation } from './ui/elevation';
import { renderPrint } from './ui/print';
import type { WallSide } from './model/geometry';

const app = document.getElementById('app')!;

// Obrazovky si registrují úklid (animační smyčky, observery) před přepnutím.
const cleanups: (() => void)[] = [];
export function registerCleanup(fn: () => void): void {
  cleanups.push(fn);
}

async function route(): Promise<void> {
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

loadProject().then(route);

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
