// Tisková sestava: elevace všech stěn s trasami, legenda kategorií.
import { project } from '../db';
import { wallSvgContent, wallViewBox } from './wall-svg';

export async function renderPrint(root: HTMLElement): Promise<void> {
  const parts: string[] = [`
    <header class="bar no-print">
      <button onclick="location.hash='#/'">←</button>
      <h1>Tisková sestava</h1>
      <button class="primary" onclick="window.print()">🖨️ Tisk / PDF</button>
    </header>
    <main class="page" style="background:#fff;color:#000">`];

  let any = false;
  for (const storey of project.storeys) {
    for (const wall of storey.walls) {
      if (wall.routes.length === 0 && wall.dims.length === 0) continue;
      any = true;
      const vb = wallViewBox(wall);
      const usedCats = project.categories.filter((c) => wall.routes.some((r) => r.categoryId === c.id));
      const legend = usedCats
        .map((c) => `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px">
          <span style="width:12px;height:12px;border-radius:50%;background:${c.color};display:inline-block"></span>${c.name}</span>`)
        .join('');
      const notes = wall.routes
        .filter((r) => r.note)
        .map((r) => {
          const c = project.categories.find((x) => x.id === r.categoryId);
          return `<div style="font-size:13px">• <b>${c?.name ?? ''}:</b> ${r.note}</div>`;
        })
        .join('');
      parts.push(`
        <div class="print-wall">
          <h3 style="margin-bottom:4px">${storey.name} — ${wall.name}</h3>
          <div style="margin-bottom:6px">${legend}</div>
          <svg viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" xmlns="http://www.w3.org/2000/svg">
            ${wallSvgContent(wall, { side: 'A', categories: project.categories, forPrint: true })}
          </svg>
          ${notes}
        </div>`);
    }
  }
  if (!any) parts.push('<div class="muted">Žádná stěna zatím nemá trasy.</div>');
  parts.push('</main>');
  root.innerHTML = parts.join('\n');
}
