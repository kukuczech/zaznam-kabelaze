// Domovská obrazovka: podlaží, import IFC, kategorie, exporty.
import { project, saveProject } from '../db';
import { newId } from '../model/types';
import { importIfc } from '../model/ifc-import';

export async function renderHome(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <header class="bar"><h1>🏠 ${project.name}</h1></header>
    <main class="page">
      <div class="card">
        <h2>Podlaží</h2>
        <div id="storeys"></div>
        <label class="btn" style="align-self:flex-start">
          ➕ Importovat IFC podlaží
          <input type="file" accept=".ifc" hidden id="ifc-file" />
        </label>
      </div>
      <div class="card">
        <h2>Kategorie</h2>
        <div id="cats"></div>
      </div>
      <div class="card">
        <h2>Data</h2>
        <div class="row">
          <button id="btn-print">🖨️ Tisk stěn</button>
          <button id="btn-export">💾 Export ZIP</button>
          <label class="btn">📂 Import ZIP<input type="file" accept=".zip" hidden id="zip-file" /></label>
        </div>
      </div>
    </main>`;

  const storeysEl = root.querySelector('#storeys')!;
  if (project.storeys.length === 0) {
    storeysEl.innerHTML = `<div class="muted">Zatím žádné podlaží — importujte IFC soubor z magicplan.</div>`;
  }
  for (const s of project.storeys) {
    const routeCount = s.walls.reduce((n, w) => n + w.routes.length, 0);
    const el = document.createElement('div');
    el.className = 'list-item';
    el.innerHTML = `
      <div class="grow">
        <div>${s.name}</div>
        <div class="sub">${s.walls.length} stěn · ${routeCount} tras</div>
      </div>
      <button class="danger" data-del>✕</button>`;
    el.addEventListener('click', () => (location.hash = `#/storey/${s.id}`));
    el.querySelector('[data-del]')!.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`Smazat podlaží „${s.name}" včetně všech tras?`)) return;
      project.storeys = project.storeys.filter((x) => x.id !== s.id);
      saveProject();
      renderHome(root);
    });
    storeysEl.appendChild(el);
  }

  const catsEl = root.querySelector('#cats')!;
  for (const c of project.categories) {
    const el = document.createElement('div');
    el.className = 'row';
    el.innerHTML = `
      <span class="dot" style="background:${c.color}"></span>
      <input value="${c.name}" style="flex:1" />
      <input type="color" value="${c.color}" style="width:44px;padding:2px" />
      <button class="danger" title="Smazat">✕</button>`;
    const [nameIn, colorIn] = Array.from(el.querySelectorAll('input'));
    nameIn.addEventListener('change', () => { c.name = nameIn.value; saveProject(); });
    colorIn.addEventListener('change', () => {
      c.color = colorIn.value;
      (el.querySelector('.dot') as HTMLElement).style.background = c.color;
      saveProject();
    });
    el.querySelector('button')!.addEventListener('click', () => {
      if (!confirm(`Smazat kategorii „${c.name}"?`)) return;
      project.categories = project.categories.filter((x) => x.id !== c.id);
      saveProject();
      renderHome(root);
    });
    catsEl.appendChild(el);
  }
  const addCat = document.createElement('button');
  addCat.textContent = '➕ Přidat kategorii';
  addCat.addEventListener('click', () => {
    project.categories.push({ id: newId(), name: 'Nová kategorie', color: '#22d3ee' });
    saveProject();
    renderHome(root);
  });
  catsEl.appendChild(addCat);

  root.querySelector<HTMLInputElement>('#ifc-file')!.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const label = root.querySelector('#ifc-file')!.parentElement as HTMLElement;
    const origText = label.textContent;
    label.textContent = '⏳ Importuji…';
    try {
      const storey = await importIfc(file);
      project.storeys.push(storey);
      saveProject();
      // Rovnou otevřít 3D model — ať je jasné, že se import povedl.
      location.hash = `#/storey/${storey.id}`;
    } catch (err) {
      alert(`Import IFC selhal: ${err}`);
      console.error(err);
      label.textContent = origText;
    }
  });

  root.querySelector('#btn-print')!.addEventListener('click', () => (location.hash = '#/print'));
  root.querySelector('#btn-export')!.addEventListener('click', async () => {
    const { exportZip } = await import('../zip');
    await exportZip();
  });
  root.querySelector<HTMLInputElement>('#zip-file')!.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (!confirm('Import přepíše aktuální projekt. Pokračovat?')) return;
    const { importZip } = await import('../zip');
    await importZip(file);
    renderHome(root);
  });
}
