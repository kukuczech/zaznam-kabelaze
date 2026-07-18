// Import IFC z magicplan → Storey. Čteme jen to, co potřebujeme:
// IFCWALL: reprezentace 'Axis' (2bodová polyline = střednice) + 'Body' (extruze → výška, tloušťka)
// IFCSLAB: půdorysné polygony podlah (kontext ve 3D)
// IFCOPENINGELEMENT (+IFCRELVOIDSELEMENT/IFCRELFILLSELEMENT): otvory → obdélníky ve stěně
// Souřadnice v mm; magicplan používá identitní placementy, rotace ignorujeme.
import * as WebIFC from 'web-ifc';
import { newId, type Opening, type Storey, type Wall, type XY } from './types';
import { projectToAxis } from './geometry';

let apiPromise: Promise<WebIFC.IfcAPI> | null = null;

function getApi(): Promise<WebIFC.IfcAPI> {
  apiPromise ??= (async () => {
    const api = new WebIFC.IfcAPI();
    api.SetWasmPath('./');
    await api.Init();
    return api;
  })();
  return apiPromise;
}

const val = (x: any): any => (x && typeof x === 'object' && 'value' in x ? x.value : x);

function polylinePoints(polyline: any): XY[] {
  return (polyline?.Points ?? []).map((pt: any) => {
    const c = pt.Coordinates.map(val);
    return { x: c[0], y: c[1] };
  });
}

/** Najde v Representations položku podle RepresentationIdentifier. */
function repItem(product: any, identifier: string): any | undefined {
  for (const rep of product?.Representation?.Representations ?? []) {
    if (val(rep.RepresentationIdentifier) === identifier) return rep.Items?.[0];
  }
  return undefined;
}

/** Absolutní poloha z řetězu IFCLOCALPLACEMENT (rotace magicplan nepoužívá). */
function absolutePlacement(placement: any): { x: number; y: number; z: number } {
  let x = 0, y = 0, z = 0;
  let p = placement;
  while (p) {
    const c = p.RelativePlacement?.Location?.Coordinates?.map(val);
    if (c) {
      x += c[0] ?? 0;
      y += c[1] ?? 0;
      z += c[2] ?? 0;
    }
    p = p.PlacementRelTo;
  }
  return { x, y, z };
}

export async function importIfc(file: File): Promise<Storey> {
  const api = await getApi();
  const data = new Uint8Array(await file.arrayBuffer());
  const modelID = api.OpenModel(data);
  try {
    return parseModel(api, modelID, file.name);
  } finally {
    api.CloseModel(modelID);
  }
}

function parseModel(api: WebIFC.IfcAPI, modelID: number, fileName: string): Storey {
  // Název podlaží
  let storeyName = fileName.replace(/\.ifc$/i, '');
  const storeyIds = api.GetLineIDsWithType(modelID, WebIFC.IFCBUILDINGSTOREY);
  if (storeyIds.size() > 0) {
    const s = api.GetLine(modelID, storeyIds.get(0));
    storeyName = val(s.Name) || storeyName;
  }

  // Stěny
  const walls: Wall[] = [];
  const wallIdByExpressId = new Map<number, string>();
  const wallIds = api.GetLineIDsWithType(modelID, WebIFC.IFCWALL);
  for (let i = 0; i < wallIds.size(); i++) {
    const expressId = wallIds.get(i);
    const w = api.GetLine(modelID, expressId, true);
    const axisPts = polylinePoints(repItem(w, 'Axis'));
    if (axisPts.length < 2) continue;
    const body = repItem(w, 'Body');
    const heightMm = Math.abs(val(body?.Depth) ?? 2600);
    const footprint = polylinePoints(body?.SweptArea?.OuterCurve);

    const wall: Wall = {
      id: newId(),
      ifcGuid: val(w.GlobalId) ?? '',
      name: `Stěna ${walls.length + 1}`,
      axis: [axisPts[0], axisPts[axisPts.length - 1]],
      thicknessMm: 0,
      heightMm,
      openings: [],
      photoIds: [],
      routes: [],
      dims: [],
    };
    // Tloušťka = rozpětí kolmých vzdáleností půdorysného pásu od střednice.
    if (footprint.length >= 3) {
      const dists = footprint.map((p) => projectToAxis(wall, p).dist);
      wall.thicknessMm = Math.round(Math.max(...dists) - Math.min(...dists));
    }
    if (!wall.thicknessMm || wall.thicknessMm > 1000) wall.thicknessMm = 150;
    walls.push(wall);
    wallIdByExpressId.set(expressId, wall.id);
  }

  // Otvory: IFCRELVOIDSELEMENT (stěna ↔ otvor), IFCRELFILLSELEMENT (otvor ↔ dveře/okno)
  try {
    const fillKind = new Map<number, 'door' | 'window'>();
    const fills = api.GetLineIDsWithType(modelID, WebIFC.IFCRELFILLSELEMENT);
    for (let i = 0; i < fills.size(); i++) {
      const rel = api.GetLine(modelID, fills.get(i));
      const openingRef = rel.RelatingOpeningElement?.value;
      const filledRef = rel.RelatedBuildingElement?.value;
      if (!openingRef || !filledRef) continue;
      const filled = api.GetLine(modelID, filledRef);
      const isDoor = api.GetLineType(modelID, filledRef) === WebIFC.IFCDOOR || /door/i.test(val(filled.Name) ?? '');
      fillKind.set(openingRef, isDoor ? 'door' : 'window');
    }

    const voids = api.GetLineIDsWithType(modelID, WebIFC.IFCRELVOIDSELEMENT);
    for (let i = 0; i < voids.size(); i++) {
      const rel = api.GetLine(modelID, voids.get(i));
      const wallRef = rel.RelatingBuildingElement?.value;
      const openingRef = rel.RelatedOpeningElement?.value;
      const wallId = wallIdByExpressId.get(wallRef);
      const wall = walls.find((x) => x.id === wallId);
      if (!wall || !openingRef) continue;

      const op = api.GetLine(modelID, openingRef, true);
      const profile = repItem(op, 'Body')?.SweptArea;
      const widthMm = val(profile?.XDim);
      const heightMm = val(profile?.YDim);
      if (!widthMm || !heightMm) continue;
      const pos = absolutePlacement(op.ObjectPlacement);
      const opening: Opening = {
        kind: fillKind.get(openingRef) ?? 'window',
        uMm: projectToAxis(wall, { x: pos.x, y: pos.y }).u,
        vMm: pos.z, // placement je ve středu otvoru
        widthMm,
        heightMm,
      };
      wall.openings.push(opening);
    }
  } catch (err) {
    console.warn('Otvory se nepodařilo načíst, pokračuji bez nich:', err);
  }

  // Podlahy pro 3D kontext
  const slabs: XY[][] = [];
  try {
    const slabIds = api.GetLineIDsWithType(modelID, WebIFC.IFCSLAB);
    for (let i = 0; i < slabIds.size(); i++) {
      const s = api.GetLine(modelID, slabIds.get(i), true);
      const pts = polylinePoints(repItem(s, 'Body')?.SweptArea?.OuterCurve);
      if (pts.length >= 3) slabs.push(pts);
    }
  } catch { /* podlahy jsou jen kosmetika */ }

  const heights = walls.map((w) => w.heightMm);
  return {
    id: newId(),
    name: storeyName,
    wallHeightMm: heights.length ? Math.max(...heights) : 2600,
    walls,
    slabs,
  };
}
