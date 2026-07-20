// Domovská obrazovka: podlaží, fotostěny, import IFC, kategorie, exporty.
import { getPhoto, project, saveProject } from '../db';
import { isCategoryVisible, newId } from '../model/types';
import { createPhotoWall, deletePhotoWall, nextPhotoWallName, photoWalls } from '../model/photo-wall';
import { importIfc } from '../model/ifc-import';
import { registerCleanup } from '../main';
import type { PdfOptions } from '../pdf';

export async function renderHome(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <header class="bar"><h1>🏠 ${project.name}</h1></header>
    <main class="page">
      <div class="card">
        <h2>Podlaží</h2>
        <div id="storeys"></div>
        <div class="row" style="align-self:flex-start">
          <label class="btn">
            ➕ Importovat IFC podlaží
            <input type="file" accept=".ifc" hidden id="ifc-file" />
          </label>
          <label class="btn">
            📦 Importovat ZIP skenu (LiDAR)
            <input type="file" accept=".zip,.json" hidden id="scan-file" />
          </label>
          <label class="btn">
            🧱 Importovat mesh (OBJ/PLY)
            <input type="file" accept=".obj,.ply" hidden id="mesh-file" />
          </label>
        </div>
      </div>
      <div class="card">
        <h2>Fotostěny</h2>
        <div class="muted" style="margin-bottom:8px">
          Rychlý zákres do fotky — bez 3D modelu. Kóty jsou popisky naměřených hodnot.
        </div>
        <div id="photo-walls"></div>
        <div class="row" style="align-self:flex-start">
          <label class="btn">
            📷 Vyfotit stěnu
            <input type="file" accept="image/*" capture="environment" hidden id="photo-shot" />
          </label>
          <label class="btn">
            🖼️ Nahrát z galerie
            <input type="file" accept="image/*" hidden id="photo-pick" />
          </label>
        </div>
      </div>
      <div class="card">
        <h2>Kategorie</h2>
        <div id="cats"></div>
      </div>
      <div class="card">
        <h2>Fáze fotek</h2>
        <div class="row" style="align-items:center;gap:8px;margin-bottom:10px">
          <span class="muted">Zobrazit ve 3D / vizualizaci:</span>
          <select id="active-phase" style="flex:1"></select>
        </div>
        <div id="phases"></div>
      </div>
      <div class="card">
        <h2>Data</h2>
        <div class="row">
          <button id="btn-print">🖨️ Tisk stěn</button>
          <button id="btn-pdf">📄 Export PDF</button>
          <button id="btn-dxf">📐 Export DXF (CAD)</button>
          <button id="btn-export">💾 Export ZIP</button>
          <label class="btn">📂 Import projektu (ZIP)<input type="file" accept=".zip" hidden id="zip-file" /></label>
        </div>
      </div>
    </main>`;

  const storeysEl = root.querySelector('#storeys')!;
  // Sběrné podlaží fotostěn má vlastní kartu — mezi stavební podlaží nepatří.
  const buildingStoreys = project.storeys.filter((s) => !s.photoWalls);
  if (buildingStoreys.length === 0) {
    storeysEl.innerHTML = `<div class="muted">Zatím žádné podlaží — importujte IFC soubor z magicplan.</div>`;
  }
  for (const s of buildingStoreys) {
    const routeCount = s.walls.reduce((n, w) => n + w.faces.A.routes.length + w.faces.B.routes.length, 0);
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

  await renderPhotoWalls(root);

  const catsEl = root.querySelector('#cats')!;
  project.categories.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'row';
    // Pořadí vrstev řídí i pořadí vykreslení na modelu (výše = navrchu) — viz byLayerOrder.
    el.innerHTML = `
      <button class="up" title="Posunout výš (navrch)" style="padding:2px 6px" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="down" title="Posunout níž (naspod)" style="padding:2px 6px" ${i === project.categories.length - 1 ? 'disabled' : ''}>↓</button>
      <span class="dot" style="background:${c.color}"></span>
      <input value="${c.name}" style="flex:1" />
      <input type="color" value="${c.color}" style="width:44px;padding:2px" />
      <button class="vis" title="Skrýt / zobrazit vrstvu">${isCategoryVisible(c) ? '👁️' : '🚫'}</button>
      <button class="danger" title="Smazat">✕</button>`;
    const move = (dir: -1 | 1): void => {
      const j = i + dir;
      const cats = project.categories;
      if (j < 0 || j >= cats.length) return;
      [cats[i], cats[j]] = [cats[j], cats[i]];
      saveProject();
      renderHome(root);
    };
    el.querySelector('.up')!.addEventListener('click', () => move(-1));
    el.querySelector('.down')!.addEventListener('click', () => move(1));
    const [nameIn, colorIn] = Array.from(el.querySelectorAll('input'));
    nameIn.addEventListener('change', () => { c.name = nameIn.value; saveProject(); });
    colorIn.addEventListener('change', () => {
      c.color = colorIn.value;
      (el.querySelector('.dot') as HTMLElement).style.background = c.color;
      saveProject();
    });
    const visBtn = el.querySelector('.vis') as HTMLButtonElement;
    visBtn.style.opacity = isCategoryVisible(c) ? '1' : '0.5';
    visBtn.addEventListener('click', () => {
      c.visible = !isCategoryVisible(c);
      visBtn.textContent = isCategoryVisible(c) ? '👁️' : '🚫';
      visBtn.style.opacity = isCategoryVisible(c) ? '1' : '0.5';
      saveProject();
    });
    el.querySelector('.danger')!.addEventListener('click', () => {
      if (!confirm(`Smazat kategorii „${c.name}"?`)) return;
      project.categories = project.categories.filter((x) => x.id !== c.id);
      saveProject();
      renderHome(root);
    });
    catsEl.appendChild(el);
  });
  const addCat = document.createElement('button');
  addCat.textContent = '➕ Přidat kategorii';
  addCat.addEventListener('click', () => {
    project.categories.push({ id: newId(), name: 'Nová kategorie', color: '#22d3ee' });
    saveProject();
    renderHome(root);
  });
  catsEl.appendChild(addCat);

  // --- Fáze fotek: globální přepínač + správa číselníku ---
  const phaseSel = root.querySelector('#active-phase') as HTMLSelectElement;
  phaseSel.innerHTML =
    `<option value="">Automaticky (aktivní podklad)</option>` +
    project.photoPhases.map((ph) => `<option value="${ph.id}">${ph.name}</option>`).join('');
  phaseSel.value = project.activePhaseId ?? '';
  phaseSel.addEventListener('change', () => {
    project.activePhaseId = phaseSel.value || undefined;
    saveProject();
  });

  const phasesEl = root.querySelector('#phases')!;
  for (const ph of project.photoPhases) {
    const el = document.createElement('div');
    el.className = 'row';
    el.innerHTML = `
      <span>🖼️</span>
      <input value="${ph.name}" style="flex:1" />
      <button class="danger" title="Smazat">✕</button>`;
    const nameIn = el.querySelector('input') as HTMLInputElement;
    nameIn.addEventListener('change', () => { ph.name = nameIn.value; saveProject(); renderHome(root); });
    el.querySelector('.danger')!.addEventListener('click', () => {
      if (!confirm(`Smazat fázi „${ph.name}"? Fotky zůstanou, jen ztratí zařazení do této fáze.`)) return;
      project.photoPhases = project.photoPhases.filter((x) => x.id !== ph.id);
      // Odpojit smazanou fázi od podkladů (obou líců) i od globálního výběru.
      for (const s of project.storeys) for (const w of s.walls)
        for (const f of [w.faces.A, w.faces.B]) for (const b of f.backgrounds) {
          if (b.phaseId === ph.id) b.phaseId = undefined;
        }
      if (project.activePhaseId === ph.id) project.activePhaseId = undefined;
      saveProject();
      renderHome(root);
    });
    phasesEl.appendChild(el);
  }
  const addPhase = document.createElement('button');
  addPhase.textContent = '➕ Přidat fázi';
  addPhase.addEventListener('click', () => {
    project.photoPhases.push({ id: newId(), name: 'Nová fáze' });
    saveProject();
    renderHome(root);
  });
  phasesEl.appendChild(addPhase);

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

  // Sdílená obsluha importu podlaží (busy stav tlačítka + uložení + otevření 3D).
  const importStorey = async (inputId: string, busyText: string, load: (file: File) => Promise<typeof project.storeys[number]>) => {
    const input = root.querySelector<HTMLInputElement>(inputId)!;
    const file = input.files?.[0];
    if (!file) return;
    const label = input.parentElement as HTMLElement;
    const origText = label.textContent;
    label.textContent = busyText;
    try {
      const storey = await load(file);
      project.storeys.push(storey);
      saveProject();
      location.hash = `#/storey/${storey.id}`; // rovnou otevřít 3D — ať je vidět, že import prošel
    } catch (err) {
      alert(`Import selhal: ${err}`);
      console.error(err);
      label.textContent = origText;
    }
  };

  // ZIP/JSON z LiDAR aplikace = parametrický scan.json (přesný, s otvory i šikminou).
  root.querySelector<HTMLInputElement>('#scan-file')!.addEventListener('change', () =>
    importStorey('#scan-file', '⏳ Zpracovávám sken…', async (file) => (await import('../model/scan-import')).importScan(file)));

  // OBJ/PLY (Polycam / Scaniverse) = surový mesh → heuristická rekonstrukce místnosti.
  root.querySelector<HTMLInputElement>('#mesh-file')!.addEventListener('change', () =>
    importStorey('#mesh-file', '⏳ Zpracovávám mesh…', async (file) => (await import('../model/mesh-import')).importMesh(file)));

  root.querySelector('#btn-print')!.addEventListener('click', () => (location.hash = '#/print'));
  const withBusy = async (id: string, fn: () => Promise<void>) => {
    const btn = root.querySelector(id) as HTMLButtonElement;
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = '⏳ …';
    try { await fn(); } catch (err) { alert(`Export selhal: ${err}`); console.error(err); }
    finally { btn.disabled = false; btn.textContent = orig; }
  };
  root.querySelector('#btn-pdf')!.addEventListener('click', async () => {
    const opts = await openPdfDialog();
    if (!opts) return;
    await withBusy('#btn-pdf', async () => { const { exportPdf } = await import('../pdf'); await exportPdf(opts); });
  });
  root.querySelector('#btn-dxf')!.addEventListener('click', () =>
    withBusy('#btn-dxf', async () => { const { exportDxf } = await import('../dxf'); exportDxf(); }));
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

/**
 * Seznam fotostěn v kartě „Fotostěny" + obsluha focení / nahrání z galerie.
 * Klik na položku otevře rovnou elevaci (líc A) — fotostěna 3D pohled nemá.
 */
async function renderPhotoWalls(root: HTMLElement): Promise<void> {
  const listEl = root.querySelector('#photo-walls')!;
  const walls = photoWalls();
  if (walls.length === 0) {
    listEl.innerHTML = `<div class="muted">Zatím žádná — vyfoť stěnu, zakresli do ní trasy a okótuj.</div>`;
  }
  // Náhledy fotek: objectURL uvolníme při odchodu z obrazovky.
  const urls: string[] = [];
  registerCleanup(() => urls.splice(0).forEach((u) => URL.revokeObjectURL(u)));

  for (const w of walls) {
    const face = w.faces.A;
    const el = document.createElement('div');
    el.className = 'list-item';
    el.innerHTML = `
      <div class="thumb" style="width:44px;height:44px;border-radius:6px;background:#1e293b;flex:none"></div>
      <div class="grow">
        <div>${w.name}</div>
        <div class="sub">${face.routes.length} tras · ${face.dims.length} kót · ${face.fixtures.length} prvků</div>
      </div>
      <button data-rename title="Přejmenovat">✏️</button>
      <button class="danger" data-del>✕</button>`;
    el.addEventListener('click', () => (location.hash = `#/wall/${w.id}/A`));
    el.querySelector('[data-rename]')!.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = prompt('Název fotostěny:', w.name)?.trim();
      if (!name) return;
      w.name = name;
      saveProject();
      renderHome(root);
    });
    el.querySelector('[data-del]')!.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Smazat fotostěnu „${w.name}" včetně fotky a zákresu?`)) return;
      await deletePhotoWall(w.id);
      renderHome(root);
    });
    listEl.appendChild(el);

    // Miniatura z podkladu líce (nebo z originálu, kdyby podklad chyběl).
    const photoId = face.backgrounds[0]?.photoId ?? face.photoIds[0];
    if (photoId) {
      getPhoto(photoId).then((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        const thumb = el.querySelector('.thumb') as HTMLElement;
        thumb.style.backgroundImage = `url(${url})`;
        thumb.style.backgroundSize = 'cover';
        thumb.style.backgroundPosition = 'center';
      });
    }
  }

  // Vyfotit / nahrát: obojí končí stejným založením fotostěny a otevřením elevace.
  const addPhoto = async (inputId: string) => {
    const input = root.querySelector<HTMLInputElement>(inputId)!;
    const file = input.files?.[0];
    if (!file) return;
    const label = input.parentElement as HTMLElement;
    const orig = label.textContent;
    label.textContent = '⏳ Zakládám…';
    try {
      const name = prompt('Název fotostěny:', nextPhotoWallName())?.trim() || nextPhotoWallName();
      const wall = await createPhotoWall(file, name);
      location.hash = `#/wall/${wall.id}/A`; // rovnou do editoru — ať se dá hned kreslit
    } catch (err) {
      alert(`Založení fotostěny selhalo: ${err}`);
      console.error(err);
      label.textContent = orig;
    } finally {
      input.value = ''; // ať jde tutéž fotku vybrat znovu
    }
  };
  root.querySelector('#photo-shot')!.addEventListener('change', () => addPhoto('#photo-shot'));
  root.querySelector('#photo-pick')!.addEventListener('change', () => addPhoto('#photo-pick'));
}

/**
 * Dialog voleb PDF exportu. Vrací zvolené volby, nebo null při zrušení.
 * Textury / overlay / prázdné stěny / souhrn místností jsou přepínatelné,
 * fáze fotek se vybírá ze seznamu (výchozí = aktivní fáze projektu).
 */
function openPdfDialog(): Promise<PdfOptions | null> {
  return new Promise((resolve) => {
    const phases = project.photoPhases ?? [];
    // '' = automaticky (bez filtru fáze) — stejná sémantika jako přepínač na domovské
    // obrazovce a jako tisk; podklady bez přiřazené fáze se tak zobrazí.
    const sel = project.activePhaseId ?? '';
    const phaseOpts = `<option value=""${sel === '' ? ' selected' : ''}>Automaticky (aktivní fáze)</option>`
      + phases.map((p) => `<option value="${p.id}"${p.id === sel ? ' selected' : ''}>${p.name}</option>`).join('');

    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = `
      <div class="modal-card card" role="dialog" aria-modal="true">
        <h2>Export do PDF</h2>
        <label class="opt"><input type="checkbox" id="pdf-textures" checked> 🖼️ Textury (fotky) na pozadí</label>
        <div class="row" id="pdf-phase-row" style="margin:-2px 0 2px 26px">
          <span class="muted">Fáze fotek:</span>
          <select id="pdf-phase" style="flex:1">${phaseOpts}</select>
        </div>
        <label class="opt"><input type="checkbox" id="pdf-overlay" checked> 🔌 Overlay tras, kót a prvků</label>
        <label class="opt"><input type="checkbox" id="pdf-empty" checked> ▭ Prázdné stěny (holá elevace)</label>
        <label class="opt"><input type="checkbox" id="pdf-rooms" checked> 📋 Souhrn místností</label>
        <div class="row" style="justify-content:flex-end;margin-top:6px">
          <button id="pdf-cancel">Zrušit</button>
          <button class="primary" id="pdf-go">📄 Exportovat</button>
        </div>
      </div>`;
    document.body.appendChild(ov);

    const q = <T extends HTMLElement>(sel: string) => ov.querySelector(sel) as T;
    const texCb = q<HTMLInputElement>('#pdf-textures');
    const phaseRow = q<HTMLElement>('#pdf-phase-row');
    const syncPhase = () => { phaseRow.style.opacity = texCb.checked ? '1' : '0.4'; q<HTMLSelectElement>('#pdf-phase').disabled = !texCb.checked; };
    texCb.addEventListener('change', syncPhase);
    syncPhase();

    const close = (result: PdfOptions | null) => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(result); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(null); });
    q('#pdf-cancel').addEventListener('click', () => close(null));
    q('#pdf-go').addEventListener('click', () => close({
      textures: texCb.checked,
      overlay: q<HTMLInputElement>('#pdf-overlay').checked,
      emptyWalls: q<HTMLInputElement>('#pdf-empty').checked,
      roomsSummary: q<HTMLInputElement>('#pdf-rooms').checked,
      phaseId: q<HTMLSelectElement>('#pdf-phase').value || undefined,
    }));
  });
}
