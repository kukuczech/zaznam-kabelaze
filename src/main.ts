// Bootstrap + jednoduchý hash router: #/ | #/storey/:id | #/wall/:id/:strana | #/print
import { loadProject, project, undo, redo } from './db';
import { renderHome } from './ui/home';
import { renderViewer3d } from './ui/viewer3d';
import { renderElevation } from './ui/elevation';
import { renderPrint } from './ui/print';
import { initUpdateCheck } from './ui/update-check';
import { installNativeBridge } from './native';
import type { WallSide } from './model/geometry';
import type { XY } from './model/types';

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
  // Sběrné podlaží fotostěn nemá půdorys ani 3D — otevírají se rovnou jednotlivé elevace.
  if (screen === 'storey' && id && project.storeys.find((s) => s.id === id)?.photoWalls) {
    location.hash = '#/';
    return;
  }
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

loadProject().then(async () => {
  await route();
  // Most do nativní iOS appky (import skenu) aktivujeme až TEĎ – projekt je načtený
  // a home vykreslený, takže import skenu nepředběhne inicializaci. V prohlížeči neškodné.
  installNativeBridge();
});

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

  // Dev-only: import skenu (OBJ/PLY) z URL, např. devImportMesh('./testdata/attic.obj')
  (window as any).devImportMesh = async (url: string) => {
    const { importMesh } = await import('./model/mesh-import');
    const { project, saveProject } = await import('./db');
    const blob = await (await fetch(url)).blob();
    const storey = await importMesh(new File([blob], url.split('/').pop()!));
    project.storeys.push(storey);
    saveProject();
    await route();
    return `${storey.name}: ${storey.walls.length} stěn, ${storey.slopes?.length ?? 0} šikmin`;
  };

  // Dev-only: vytvoř testovací ZKOSENOU místnost (lichoběžník se šikmou stěnou)
  // pro odzkoušení fáze 2. Stěny mají předvyplněnou naměřenou délku ("potvrzeno"),
  // rohy jsou zašuměné kolem pravdy → přidáním jedné úhlopříčky (📐) se tvar
  // zaškvárkuje a rohy zavřou. Zavolej v konzoli: devSkewRoom()
  (window as any).devSkewRoom = async () => {
    const { project, saveProject } = await import('./db');
    const { emptyFace, newId } = await import('./model/types');
    // Pravda: lichoběžník, stěna c1→c2 zkosená ~34° od svislé.
    const truth = [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 2000, y: 3000 }, { x: 0, y: 3000 }];
    // LiDAR šum (deterministický), ať je "před" viditelně nedokonalé.
    const noise = [{ x: -55, y: 40 }, { x: 60, y: -35 }, { x: 45, y: 50 }, { x: -40, y: -48 }];
    const corners = truth.map((p, i) => ({
      id: 'sc' + i, x: p.x + noise[i].x, y: p.y + noise[i].y, lidar: { x: p.x + noise[i].x, y: p.y + noise[i].y },
    }));
    const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    const mkWall = (i: number, ai: number, bi: number) => ({
      id: 'sw' + i, ifcGuid: newId(), name: `Stěna ${i + 1}`,
      axis: [{ x: corners[ai].x, y: corners[ai].y }, { x: corners[bi].x, y: corners[bi].y }] as [XY, XY],
      a: corners[ai].id, b: corners[bi].id,
      measuredLengthMm: Math.round(dist(truth[ai], truth[bi])), // "potvrzeno" (přesná pravda)
      thicknessMm: 150, heightMm: 2600, openings: [],
      faces: { A: emptyFace(), B: emptyFace() },
    });
    const storey = {
      id: newId(), name: 'TEST zkosená místnost', wallHeightMm: 2600,
      corners, diagonals: [] as never[],
      walls: [mkWall(0, 0, 1), mkWall(1, 1, 2), mkWall(2, 2, 3), mkWall(3, 3, 0)],
    };
    project.storeys.push(storey as unknown as (typeof project.storeys)[number]);
    saveProject();
    location.hash = `#/storey/${storey.id}`;
    await route();
    return `Vytvořeno „${storey.name}". Otevři 📐 Úhlopříčka a přidej úhlopříčku sc0–sc2 (pravda ${Math.round(dist(truth[0], truth[2]))} mm).`;
  };

  // Dev-only: testovací PODKROVÍ (fáze 3) — obdélníková místnost 4×3 m se šikmým
  // stropem. Stěna aw0 (y=0) je kolenní (nadezdívka 1100 mm), strop stoupá dovnitř
  // až po hřeben 2600 mm nad protější stěnou. Otevři stěnu aw0 ve 3D a uprav
  // parametry šikminy, nebo otevři elevaci boční stěny — líc je seříznutý šikmo.
  // Zavolej v konzoli: devAtticRoom()
  (window as any).devAtticRoom = async () => {
    const { project, saveProject } = await import('./db');
    const { emptyFace, newId } = await import('./model/types');
    const { resolveStorey } = await import('./model/geometry');
    const truth = [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }];
    const corners = truth.map((p, i) => ({ id: 'ac' + i, x: p.x, y: p.y, lidar: { x: p.x, y: p.y } }));
    const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    const mkWall = (i: number, ai: number, bi: number) => ({
      id: 'aw' + i, ifcGuid: newId(), name: `Stěna ${i + 1}`,
      axis: [{ x: corners[ai].x, y: corners[ai].y }, { x: corners[bi].x, y: corners[bi].y }] as [XY, XY],
      a: corners[ai].id, b: corners[bi].id,
      measuredLengthMm: Math.round(dist(truth[ai], truth[bi])),
      thicknessMm: 150, heightMm: 2600, openings: [],
      faces: { A: emptyFace(), B: emptyFace() },
    });
    const storey = {
      id: newId(), name: 'TEST podkroví', wallHeightMm: 2600,
      corners, diagonals: [] as never[],
      walls: [mkWall(0, 0, 1), mkWall(1, 1, 2), mkWall(2, 2, 3), mkWall(3, 3, 0)],
      rooms: [{ id: newId(), name: 'Podkroví', polygon: truth.map((p) => ({ ...p })) }],
      // Kolenní stěna = aw0; strop stoupá od ní (1100 mm) k hřebeni (2600 mm) na běhu 3 m.
      slopes: [{ id: newId(), baseWallId: 'aw0', kneeHeightMm: 1100, runMm: 3000, ridgeHeightMm: 2600 }],
    };
    resolveStorey(storey as unknown as (typeof project.storeys)[number]);
    project.storeys.push(storey as unknown as (typeof project.storeys)[number]);
    saveProject();
    location.hash = `#/storey/${storey.id}`;
    await route();
    return `Vytvořeno „${storey.name}". Kolenní stěna aw0 (1100 mm), hřeben 2600 mm. Klikni na boční stěnu a otevři elevaci — líc je seříznutý šikmo. Zapni 🔒 Stropy pro šikmou rovinu.`;
  };
}
