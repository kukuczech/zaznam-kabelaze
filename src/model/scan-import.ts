// Import parametrického skenu ze sesterské iOS aplikace (RoomPlan + DISTO laser)
// → Storey. Vstup je `scan.json` (schéma "zaznam-lidar-scan/N"), buď samostatně,
// nebo zabalený v ZIPu spolu s meshem (scan.obj) a meta.json.
//
// Na rozdíl od mesh-import.ts (heuristická rekonstrukce z trojúhelníků) je scan.json
// UŽ hotový parametrický model: sdílené rohy, stěny s délkou/výškou, otvory a šikminy
// — a nese příznaky ověření (`*Verified` + `*MeasuredBy`), takže laserem přeměřené
// hodnoty (autoritativní) odlišíme od hrubého LiDAR odhadu. Mapujeme ho 1:1 na náš
// model; ověřenou délku stěny propíšeme do `measuredLengthMm` (tvrdá vazba pro solver).
import { emptyFace, newId, type Corner, type Opening, type Room, type SlopePlane, type Storey, type Wall, type XY } from './types';
import { computeFaceTrims, computeRoomClearPolygons, rebuildAxes } from './geometry';

// --- Tvar scan.json (kontrakt "zaznam-lidar-scan/1") -----------------------

interface ScanCorner { id: string; x: number; y: number; }
interface ScanOpening {
  type: string;              // "door" | "window"
  uMm: number;               // STŘED otvoru podél stěny od rohu a
  widthMm: number;
  sillMm: number;            // výška parapetu ode dna (0 pro dveře)
  heightMm: number;
  widthVerified?: boolean;
  heightVerified?: boolean;
}
interface ScanWall {
  id: string;
  a: string;                 // corner id počátku
  b: string;                 // corner id konce
  thicknessMm: number;
  heightMm: number;
  openings: ScanOpening[];
  lengthMm?: number;
  lengthVerified?: boolean;
  heightVerified?: boolean;
}
interface ScanSlope {
  baseWallId: string;
  kneeHeightMm: number;
  ridgeHeightMm: number;
  angleDeg: number;
  kneeVerified?: boolean;
  ridgeVerified?: boolean;
}
interface ScanJSON {
  schema?: string;
  unit?: string;
  capturedWith?: string;
  wallHeightMm: number;
  corners: ScanCorner[];
  walls: ScanWall[];
  slopes?: ScanSlope[];
}

// Dva otvory na téže stěně blíž než tohle (střed i šířka) považujeme za jednu
// věc dvakrát detekovanou RoomPlanem a sloučíme je. RoomPlan občas vyhodí dvoje
// „dveře" pár mm od sebe (viz reálný sken: uMm 4184 vs 4179, šířka 805).
const DUP_OPENING_TOL = 60; // mm

/** Sloučí téměř totožné otvory (RoomPlan duplicity) do jednoho zprůměrovaného. */
function mergeDuplicateOpenings(ops: Opening[]): Opening[] {
  const out: Opening[] = [];
  for (const op of ops) {
    const dup = out.find(
      (o) => o.kind === op.kind
        && Math.abs(o.uMm - op.uMm) <= DUP_OPENING_TOL
        && Math.abs(o.widthMm - op.widthMm) <= DUP_OPENING_TOL,
    );
    if (dup) {
      dup.uMm = Math.round((dup.uMm + op.uMm) / 2);
      dup.vMm = Math.round((dup.vMm + op.vMm) / 2);
      dup.widthMm = Math.round((dup.widthMm + op.widthMm) / 2);
      dup.heightMm = Math.round((dup.heightMm + op.heightMm) / 2);
    } else {
      out.push({ ...op });
    }
  }
  return out;
}

/** Postaví uzavřený cyklus rohů (obvod místnosti) procházením grafu stěn. */
function buildLoop(cornerIds: string[], walls: ScanWall[]): string[] {
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => { (adj.get(a) ?? adj.set(a, []).get(a)!).push(b); };
  for (const w of walls) { link(w.a, w.b); link(w.b, w.a); }
  const start = cornerIds[0];
  if (!start) return [];
  const loop = [start];
  let prev = '', cur = start;
  while (loop.length <= cornerIds.length) {
    const next = (adj.get(cur) ?? []).find((n) => n !== prev);
    if (!next || next === start) break;
    loop.push(next);
    prev = cur; cur = next;
  }
  return loop;
}

/** Zmapuje jeden parsovaný scan.json na Storey (rohy, stěny, otvory, šikminy). */
function scanToStorey(scan: ScanJSON, name: string): Storey {
  if (!scan.corners?.length || !scan.walls?.length) {
    throw new Error('scan.json neobsahuje rohy ani stěny.');
  }

  // Rohy: vlastní id, LiDAR poloha jako kotva pro solver. Mapa scan id → náš roh.
  const cornerIdMap = new Map<string, string>();
  const corners: Corner[] = scan.corners.map((c) => {
    const corner: Corner = { id: newId(), x: Math.round(c.x), y: Math.round(c.y), lidar: { x: Math.round(c.x), y: Math.round(c.y) } };
    cornerIdMap.set(c.id, corner.id);
    return corner;
  });
  const cornerById = new Map(corners.map((c) => [c.id, c] as const));
  const pt = (id: string): XY => { const c = cornerById.get(id)!; return { x: c.x, y: c.y }; };

  // Stěny: osa z rohů; ověřená délka → measuredLengthMm (tvrdá vazba solveru).
  const wallIdMap = new Map<string, string>();
  const walls: Wall[] = scan.walls.map((w, i) => {
    const a = cornerIdMap.get(w.a);
    const b = cornerIdMap.get(w.b);
    if (!a || !b) throw new Error(`Stěna ${w.id} odkazuje na neexistující roh (${w.a}/${w.b}).`);

    const rawOpenings: Opening[] = (w.openings ?? []).map((o) => ({
      kind: o.type === 'door' ? 'door' : 'window',
      uMm: Math.round(o.uMm),                          // střed podél stěny od rohu a = náš axis[0]
      vMm: Math.round((o.sillMm ?? 0) + o.heightMm / 2), // parapet + půlka výšky = STŘED otvoru
      widthMm: Math.round(o.widthMm),
      heightMm: Math.round(o.heightMm),
    }));

    const wall: Wall = {
      id: newId(),
      ifcGuid: '',
      name: `Stěna ${i + 1}`,
      axis: [pt(a), pt(b)],
      a, b,
      thicknessMm: Math.round(w.thicknessMm) || 100,
      heightMm: Math.max(1, Math.round(w.heightMm)),
      openings: mergeDuplicateOpenings(rawOpenings),
      faces: { A: emptyFace(), B: emptyFace() },
    };
    // Jen laserem/ručně potvrzená délka je tvrdá vazba; LiDAR odhad zůstává volný.
    if (w.lengthVerified && w.lengthMm && w.lengthMm > 1) wall.measuredLengthMm = Math.round(w.lengthMm);
    wallIdMap.set(w.id, wall.id);
    return wall;
  });

  // Šikminy: navázané na kolenní stěnu (přemapované id).
  const slopes: SlopePlane[] = (scan.slopes ?? [])
    .map((s): SlopePlane | null => {
      const baseWallId = wallIdMap.get(s.baseWallId);
      if (!baseWallId) return null;
      return {
        id: newId(),
        baseWallId,
        kneeHeightMm: Math.round(s.kneeHeightMm),
        ridgeHeightMm: Math.round(s.ridgeHeightMm),
        angleDeg: Math.round(s.angleDeg),
      };
    })
    .filter((s): s is SlopePlane => s !== null);

  // Místnost: obvod z grafu rohů (podlaha/strop + světlý obrys).
  const loop = buildLoop(scan.corners.map((c) => c.id), scan.walls);
  const polygon: XY[] = loop.map((scanId) => pt(cornerIdMap.get(scanId)!));
  const rooms: Room[] = polygon.length >= 3
    ? [{ id: newId(), name: 'Místnost 1', polygon }]
    : [];

  const storey: Storey = {
    id: newId(),
    name,
    wallHeightMm: Math.max(1, Math.round(scan.wallHeightMm)) || 2600,
    walls,
    rooms,
    corners,
    slopes: slopes.length ? slopes : undefined,
  };

  // Stejné pořadí přepočtů jako ostatní importy: osy z rohů → ořezy líců → světlé obrysy.
  rebuildAxes(storey);
  computeFaceTrims(storey.walls);
  computeRoomClearPolygons(storey.walls, storey.rooms ?? []);
  return storey;
}

/** Vytáhne text `scan.json` ze souboru: buď přímý JSON, nebo z přiloženého ZIPu. */
async function readScanJson(file: File): Promise<string> {
  const isZip = /\.zip$/i.test(file.name)
    || new Uint8Array(await file.slice(0, 2).arrayBuffer()).join(',') === '80,75'; // "PK"
  if (!isZip) return file.text();

  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(file);
  // scan.json bývá ve složce podle názvu skenu, proto hledáme podle jména kdekoliv.
  const entry = Object.values(zip.files).find((f) => !f.dir && /(?:^|\/)scan\.json$/i.test(f.name));
  if (!entry) throw new Error('V ZIPu chybí scan.json (není to sken z LiDAR aplikace?).');
  return entry.async('string');
}

/**
 * Naimportuje sken ze sesterské aplikace (scan.json samostatně nebo v ZIPu) jako
 * jedno podlaží. Schéma musí být "zaznam-lidar-scan/…"; jiná se odmítnou.
 */
export async function importScan(file: File): Promise<Storey> {
  const text = await readScanJson(file);
  let scan: ScanJSON;
  try {
    scan = JSON.parse(text);
  } catch (err) {
    throw new Error(`scan.json nejde přečíst: ${err}`);
  }
  if (scan.schema && !/^zaznam-lidar-scan\//.test(scan.schema)) {
    throw new Error(`Neznámé schéma skenu: ${scan.schema}`);
  }
  const baseName = file.name.replace(/\.(zip|json)$/i, '') || 'Sken';
  return scanToStorey(scan, baseName);
}
