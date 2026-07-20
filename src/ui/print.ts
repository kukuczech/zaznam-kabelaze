// Tisková sestava: elevace všech stěn s trasami, legenda kategorií.
import { project, getPhoto } from '../db';
import { FIXTURE_DEFS, FIXTURE_KINDS, isCategoryVisible, resolveBackgrounds, type FixtureKind, type WallBackground, type WallSide } from '../model/types';
import { faceCeilingPolyline } from '../model/geometry';
import { fixtureThumbSvg, wallSvgContent, wallViewBox } from './wall-svg';

/** Blob → data URL (base64) — do tisku musí jít fotka vloženě, ne přes objectURL. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result as string);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
}

export async function renderPrint(root: HTMLElement): Promise<void> {
  const parts: string[] = [`
    <header class="bar no-print">
      <button onclick="location.hash='#/'">←</button>
      <h1>Tisková sestava</h1>
      <button class="primary" onclick="window.print()">🖨️ Tisk / PDF</button>
    </header>
    <main class="page" style="background:#fff;color:#000">`];

  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
  let any = false;
  for (const storey of project.storeys) {
    for (const wall of storey.walls) {
      // Obě strany stěny (A/B) — každý líc s obsahem má vlastní elevaci.
      for (const side of ['A', 'B'] as WallSide[]) {
        const face = wall.faces[side];
        if (face.routes.length === 0 && face.dims.length === 0 && face.fixtures.length === 0 && (face.areas?.length ?? 0) === 0) continue;
        any = true;
        const vb = wallViewBox(wall, side);
        const catVisible = (id: string) => isCategoryVisible(project.categories.find((c) => c.id === id));
        const usedCats = project.categories.filter((c) => isCategoryVisible(c) && face.routes.some((r) => r.categoryId === c.id));
        const legend = usedCats
          .map((c) => `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px">
            <span style="width:12px;height:12px;border-radius:50%;background:${c.color};display:inline-block"></span>${c.name}</span>`)
          .join('');
        // Legenda použitých prvků (typy osazené na líci, jen z viditelných vrstev)
        const usedKinds = FIXTURE_KINDS.filter((k: FixtureKind) =>
          face.fixtures.some((f) => f.kind === k && catVisible(f.categoryId)));
        const fixtureLegend = usedKinds.length
          ? `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:6px">${usedKinds
              .map((k) => `<span style="display:inline-flex;align-items:center;gap:4px;font-size:12px">${fixtureThumbSvg(k, 22)}${FIXTURE_DEFS[k].label}</span>`)
              .join('')}</div>`
          : '';
        const notes = face.routes
          .filter((r) => r.note && catVisible(r.categoryId))
          .map((r) => {
            const c = project.categories.find((x) => x.id === r.categoryId);
            return `<div style="font-size:13px">• <b>${c?.name ?? ''}:</b> ${r.note}</div>`;
          })
          .join('');
        const wallNote = wall.note?.trim()
          ? `<div style="font-size:13px;margin-bottom:6px"><b>Poznámka:</b> ${esc(wall.note.trim())}</div>` : '';
        // Podklady (fotky-dlaždice) podle zvolené fáze — striktně: jinou fázi nepodkládáme.
        const backgrounds: { href: string; opacity: number; region?: WallBackground['region'] }[] = [];
        const bgs = resolveBackgrounds(face, project.activePhaseId, true);
        for (const bg of bgs) {
          const blob = await getPhoto(bg.photoId);
          if (blob) backgrounds.push({ href: await blobToDataUrl(blob), opacity: bg.opacity, region: bg.region });
        }
        parts.push(`
          <div class="print-wall">
            <h3 style="margin-bottom:4px">${esc(storey.name)} — ${esc(wall.name)}${wall.freeScale ? '' : ` · strana ${side}`}</h3>
            ${wallNote}
            <div style="margin-bottom:6px">${legend}</div>
            ${fixtureLegend}
            <svg viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" xmlns="http://www.w3.org/2000/svg">
              ${wallSvgContent(wall, { side, categories: project.categories, forPrint: true, backgrounds, ceilingTop: faceCeilingPolyline(storey, wall, side) ?? undefined })}
            </svg>
            ${notes}
          </div>`);
      }
    }

    // Seznam místností podlaží (název + poznámka)
    const rooms = storey.rooms ?? [];
    if (rooms.length) {
      any = true;
      const rows = rooms.map((r) => {
        const note = r.note?.trim() ? ` <span style="color:#555">— ${esc(r.note.trim())}</span>` : '';
        return `<div style="font-size:14px;padding:2px 0">• <b>${esc(r.name)}</b>${note}</div>`;
      }).join('');
      parts.push(`
        <div class="print-wall">
          <h3 style="margin-bottom:6px">${esc(storey.name)} — Místnosti</h3>
          ${rows}
        </div>`);
    }
  }
  if (!any) parts.push('<div class="muted">Žádná stěna zatím nemá trasy ani místnosti.</div>');
  parts.push('</main>');
  root.innerHTML = parts.join('\n');
}
