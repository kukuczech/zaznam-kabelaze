// Export do PDF (vektorově, jsPDF) — jedna stěna na stránku A4 na šířku, v měřítku,
// s legendou, poznámkami a rohovým razítkem. Font s českou diakritikou vložen.
import { jsPDF } from 'jspdf';
import robotoUrl from './assets/Roboto-cs.ttf?url';
import { project, getPhoto } from './db';
import { saveBlob } from './save-file';
import { exportableFaces, faceDrawOrder, wallElevation, type Pt, type WallElevation } from './export-geom';
import { resolveBackgrounds, type Storey, type WallBackground, type WallFace } from './model/types';
import { rectDisplayRect } from './ui/wall-svg';

/** Volby PDF exportu (z dialogu na domovské obrazovce). */
export interface PdfOptions {
  /** Vložit fotky-dlaždice jako rastrový podklad pod vektorový výkres. */
  textures: boolean;
  /** Kreslit vektorový overlay (trasy, kóty, prvky, výdřevy, mřížka, legenda). */
  overlay: boolean;
  /** Zahrnout i stěny bez obsahu jako holou elevaci. */
  emptyWalls: boolean;
  /** Přidat závěrečnou stránku se seznamem místností. */
  roomsSummary: boolean;
  /** Fáze fotek pro textury (undefined = aktivní fáze projektu). */
  phaseId?: string;
}

/** Jeden rastrový podklad připravený pro vložení do PDF. */
interface PdfBackground { dataUrl: string; opacity: number; region?: WallBackground['region'] }

/** Blob → data URL (fotka se do PDF vkládá vloženě, base64). */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result as string);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
}

/** Formát pro jsPDF.addImage podle prefixu data URL. */
function imgFormat(dataUrl: string): 'PNG' | 'JPEG' {
  return dataUrl.startsWith('data:image/png') ? 'PNG' : 'JPEG';
}

let fontB64: string | null = null;
async function ensureFont(doc: jsPDF): Promise<void> {
  if (!fontB64) {
    const buf = await (await fetch(robotoUrl)).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    fontB64 = btoa(bin);
  }
  doc.addFileToVFS('Roboto-cs.ttf', fontB64);
  doc.addFont('Roboto-cs.ttf', 'Roboto', 'normal');
  doc.setFont('Roboto');
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// A4 na šířku (mm) a kreslicí plocha
const PAGE = { w: 297, h: 210 };
const DA = { x: 12, y: 18, w: 273, h: 158 }; // pod titulkem stěny, nad razítkem
const DENOMS = [10, 20, 25, 50, 100, 200, 500];

function pickDenom(len: number, H: number): number {
  const fit = Math.max(len / DA.w, H / DA.h);
  return DENOMS.find((d) => d >= fit) ?? Math.ceil(fit / 100) * 100;
}

function setOpacity(doc: jsPDF, o: number): void {
  // GState nemusí být v typech; obalíme.
  const G = (doc as unknown as { GState: new (o: { opacity: number }) => unknown }).GState;
  (doc as unknown as { setGState: (g: unknown) => void }).setGState(new G({ opacity: o }));
}

function drawWall(doc: jsPDF, el: WallElevation, opts: PdfOptions, backgrounds: PdfBackground[]): void {
  const denom = pickDenom(el.len, el.height);
  const s = 1 / denom;
  const cw = el.len * s, ch = el.height * s;
  const ox = DA.x + (DA.w - cw) / 2;
  const oy = DA.y + (DA.h - ch) / 2;
  const P = (p: Pt): [number, number] => [ox + p.x * s, oy + (el.height - p.y) * s];

  doc.setLineCap('round');
  doc.setLineJoin('round');

  // Titulek stěny (+ poznámka stěny šedě za ním)
  doc.setTextColor(20, 20, 20);
  doc.setFontSize(13);
  // Fotostěna má jediný líc a nemá měřítko — označení strany by jen mátlo.
  const title = el.wall.freeScale
    ? `${el.storeyName} — ${el.wall.name}`
    : `${el.storeyName} — ${el.wall.name} · strana ${el.side}`;
  doc.text(title, DA.x, 12);
  if (el.wallNote) {
    const tw = doc.getTextWidth(title);
    doc.setFontSize(9); doc.setTextColor(90);
    doc.text(`· ${el.wallNote}`, DA.x + tw + 3, 12);
    doc.setTextColor(20, 20, 20);
  }

  // Rastrové podklady (fotky-dlaždice) — úplně vespod, pod vektorovým výkresem.
  // Ořezané na kreslicí rámeček stěny, aby přesah dlaždice nevytekl mimo.
  if (opts.textures && backgrounds.length) {
    for (const bg of backgrounds) {
      const box = bg.region ? rectDisplayRect(el.wall, el.side, bg.region) : { x: 0, y: 0, w: el.len, h: el.height };
      const tl = P({ x: box.x, y: el.height - box.y }); // levý horní roh (y ve zobrazovacím dolů → v nahoru)
      setOpacity(doc, bg.opacity);
      doc.addImage(bg.dataUrl, imgFormat(bg.dataUrl), tl[0], tl[1], box.w * s, box.h * s, undefined, 'FAST');
      setOpacity(doc, 1);
    }
  }

  // Mřížka 500 mm (součást vektorového overlaye)
  if (opts.overlay) {
    doc.setDrawColor(210); doc.setLineWidth(0.1);
    for (const u of el.gridU) { const a = P({ x: u, y: 0 }), b = P({ x: u, y: el.height }); doc.line(a[0], a[1], b[0], b[1]); }
    for (const v of el.gridV) { const a = P({ x: 0, y: v }), b = P({ x: el.len, y: v }); doc.line(a[0], a[1], b[0], b[1]); }
  }

  // Obrys stěny (vždy — rám elevace)
  doc.setDrawColor(60); doc.setLineWidth(0.4);
  doc.rect(ox, oy, cw, ch);

  // Otvory (čárkovaně) — vždy, jsou to konstrukční prvky stěny
  doc.setLineWidth(0.25); doc.setDrawColor(90);
  doc.setLineDashPattern([1.2, 0.8], 0);
  doc.setTextColor(110);
  for (const o of el.openings) {
    const tl = P({ x: o.x, y: o.y + o.h });
    doc.rect(tl[0], tl[1], o.w * s, o.h * s);
    const c = P({ x: o.x + o.w / 2, y: o.y + o.h / 2 });
    doc.setFontSize(7); doc.text(o.label, c[0], c[1], { align: 'center', baseline: 'middle' });
  }
  doc.setLineDashPattern([], 0);

  if (opts.overlay) drawOverlay(doc, el, P, s);
  drawBlock(doc, el, denom);
}

/** Vektorový overlay stěny: výdřevy, trasy, kóty, prvky + legenda. Volitelný. */
function drawOverlay(doc: jsPDF, el: WallElevation, P: (p: Pt) => [number, number], s: number): void {

  // Výdřeva (plošná deska) — světlá výplň v barvě vrstvy, obrys a rozměr
  const drawArea = (a: WallElevation['areas'][number]): void => {
    const [r, g, b] = rgb(a.color);
    const tl = P({ x: a.x, y: a.y + a.h });
    const wpx = a.w * s, hpx = a.h * s;
    doc.setDrawColor(r, g, b); doc.setLineWidth(0.3); doc.setFillColor(r, g, b);
    setOpacity(doc, 0.14);
    doc.rect(tl[0], tl[1], wpx, hpx, 'F');
    setOpacity(doc, 1);
    doc.rect(tl[0], tl[1], wpx, hpx, 'S');
    const c = P({ x: a.x + a.w / 2, y: a.y + a.h / 2 });
    doc.setTextColor(r, g, b); doc.setFontSize(7);
    doc.text(a.label, c[0], c[1], { align: 'center', baseline: 'middle' });
  };

  // Trasa (koridor v barvě kategorie, tenká přerušovaná osa)
  const drawRoute = (rt: WallElevation['routes'][number]): void => {
    const [r, g, b] = rgb(rt.color);
    doc.setDrawColor(r, g, b);
    doc.setLineWidth(Math.max(rt.widthMm * s, 0.4));
    setOpacity(doc, 0.65);
    for (let i = 0; i < rt.pts.length - 1; i++) {
      const a = P(rt.pts[i]), c = P(rt.pts[i + 1]);
      doc.line(a[0], a[1], c[0], c[1]);
    }
    setOpacity(doc, 1);
    // osa
    doc.setDrawColor(30); doc.setLineWidth(0.15); doc.setLineDashPattern([0.8, 0.8], 0);
    for (let i = 0; i < rt.pts.length - 1; i++) {
      const a = P(rt.pts[i]), c = P(rt.pts[i + 1]);
      doc.line(a[0], a[1], c[0], c[1]);
    }
    doc.setLineDashPattern([], 0);
    // popisky délek
    doc.setTextColor(r, g, b); doc.setFontSize(7);
    for (const lb of rt.segLabels) { const t = P({ x: lb.x, y: lb.y }); doc.text(lb.text, t[0], t[1] - 1, { align: 'center' }); }
  };

  // Osazený prvek (tvar ve skutečné velikosti v barvě typu + popisek)
  const drawFixture = (f: WallElevation['fixtures'][number]): void => {
    const [r, g, b] = rgb(f.color);
    const c = P({ x: f.x, y: f.y });
    const hw = Math.max((f.w / 2) * s, 0.8), hh = Math.max((f.h / 2) * s, 0.8);
    doc.setDrawColor(r, g, b); doc.setLineWidth(0.3);
    doc.setFillColor(255, 255, 255);
    if (f.shape === 'round') {
      doc.ellipse(c[0], c[1], hw, hh, 'FD');
    } else {
      doc.roundedRect(c[0] - hw, c[1] - hh, hw * 2, hh * 2, Math.min(hw, hh) * 0.25, Math.min(hw, hh) * 0.25, 'FD');
    }
    doc.setTextColor(30, 30, 30); doc.setFontSize(6);
    doc.text(f.label, c[0], c[1] + hh + 2, { align: 'center' });
  };

  // Obsah líce v pořadí vrstev napříč typy (odspodu nahoru); kóty až za tím.
  for (const item of faceDrawOrder(el)) {
    if (item.kind === 'area') drawArea(el.areas[item.index]);
    else if (item.kind === 'route') drawRoute(el.routes[item.index]);
    else drawFixture(el.fixtures[item.index]);
  }

  // Kóty — vždy navrchu
  doc.setDrawColor(30); doc.setTextColor(20, 20, 20);
  for (const d of el.dims) {
    if (d.point) {
      const t = P({ x: d.tx, y: d.ty });
      doc.setFillColor(30, 30, 30); doc.circle(t[0], t[1], 0.5, 'F');
      doc.setFontSize(7); doc.text(d.text, t[0], t[1] - 1.5, { align: 'center' });
      continue;
    }
    doc.setLineWidth(0.15);
    for (const seg of [d.ext1, d.ext2, d.line]) { const a = P(seg[0]), b = P(seg[1]); doc.line(a[0], a[1], b[0], b[1]); }
    // šipky na koncích kótovací čáry
    const a = P(d.line[0]), b = P(d.line[1]);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    arrow(doc, a[0], a[1], ang);
    arrow(doc, b[0], b[1], ang + Math.PI);
    doc.setFontSize(7);
    const t = P({ x: d.tx, y: d.ty });
    doc.text(d.text, t[0], t[1], { align: 'center', baseline: 'middle' });
  }

  drawLegend(doc, el);
}

function arrow(doc: jsPDF, x: number, y: number, ang: number): void {
  const L = 1.6, W = 0.5;
  const bx = x - Math.cos(ang) * L, by = y - Math.sin(ang) * L;
  const nx = -Math.sin(ang), ny = Math.cos(ang);
  doc.setFillColor(30, 30, 30);
  doc.triangle(x, y, bx + nx * W, by + ny * W, bx - nx * W, by - ny * W, 'F');
}

/** Legenda vrstev/prvků (vlevo nahoře) + poznámky tras (vlevo dole). Součást overlaye. */
function drawLegend(doc: jsPDF, el: WallElevation): void {
  // Legenda (vlevo nahoře v ploše) — nejdřív vrstvy, pod nimi typy prvků
  let ly = DA.y + 2;
  doc.setFontSize(7);
  for (const c of el.usedCats) {
    const [r, g, b] = rgb(c.color);
    doc.setFillColor(r, g, b); doc.rect(DA.x, ly - 2.2, 3, 3, 'F');
    doc.setTextColor(40); doc.text(c.name, DA.x + 4.5, ly);
    ly += 4.2;
  }
  if (el.usedFixtures.length) {
    ly += 1.5;
    for (const f of el.usedFixtures) {
      const [r, g, b] = rgb(f.color);
      doc.setDrawColor(r, g, b); doc.setLineWidth(0.25); doc.setFillColor(255, 255, 255);
      if (f.shape === 'round') doc.ellipse(DA.x + 1.5, ly - 0.7, 1.5, 1.5, 'FD');
      else doc.roundedRect(DA.x, ly - 2.2, 3, 3, 0.5, 0.5, 'FD');
      doc.setTextColor(40); doc.text(f.label, DA.x + 4.5, ly);
      ly += 4.2;
    }
  }

  // Poznámky (vlevo dole)
  if (el.notes.length) {
    let ny = PAGE.h - 8 - el.notes.length * 4;
    doc.setFontSize(7);
    for (const n of el.notes) {
      const [r, g, b] = rgb(n.color);
      doc.setFillColor(r, g, b); doc.rect(DA.x, ny - 2.2, 3, 3, 'F');
      doc.setTextColor(40); doc.text(`${n.catName}: ${n.note}`, DA.x + 4.5, ny);
      ny += 4;
    }
  }
}

/** Rohové razítko (vpravo dole) — vždy, i bez overlaye. */
function drawBlock(doc: jsPDF, el: WallElevation, denom: number): void {
  const bw = 96, bh = 20, bx = PAGE.w - 12 - bw, by = PAGE.h - 8 - bh;
  doc.setDrawColor(60); doc.setLineWidth(0.3);
  doc.rect(bx, by, bw, bh);
  doc.line(bx, by + bh / 2, bx + bw, by + bh / 2);
  doc.line(bx + bw * 0.62, by + bh / 2, bx + bw * 0.62, by + bh);
  doc.setTextColor(20, 20, 20);
  doc.setFontSize(9); doc.text(project.name, bx + 3, by + 7);
  doc.setFontSize(8);
  doc.text(el.wall.freeScale ? `${el.storeyName} — ${el.wall.name}` : `${el.storeyName} — ${el.wall.name} (${el.side})`, bx + 3, by + bh - 6.5);
  doc.setFontSize(7);
  doc.text(new Date().toISOString().slice(0, 10), bx + bw * 0.65, by + bh - 6.5);
  // Fotostěna je jen fotka bez měřítka — uvádět „M 1:x" by bylo zavádějící.
  doc.setFontSize(10);
  doc.text(el.wall.freeScale ? 'bez měřítka' : `M 1:${denom}`, bx + bw * 0.65, by + 7);
}

/** Souhrnná stránka místností: název + poznámka, seskupeno po podlažích. */
function drawRoomSummary(doc: jsPDF, storeys: Storey[]): void {
  doc.setFont('Roboto');
  doc.setTextColor(20, 20, 20);
  doc.setFontSize(15);
  doc.text('Místnosti', DA.x, 14);
  let y = 24;
  const nextPage = () => { doc.addPage('a4', 'landscape'); doc.setFont('Roboto'); y = 16; };
  for (const s of storeys) {
    const rooms = s.rooms ?? [];
    if (!rooms.length) continue;
    if (y > PAGE.h - 20) nextPage();
    doc.setTextColor(60); doc.setFontSize(11);
    doc.text(s.name, DA.x, y); y += 6;
    doc.setFontSize(9);
    for (const r of rooms) {
      if (y > PAGE.h - 12) nextPage();
      doc.setTextColor(20, 20, 20);
      doc.text(`• ${r.name}`, DA.x + 4, y);
      const note = r.note?.trim();
      if (note) {
        const nx = DA.x + 4 + doc.getTextWidth(`• ${r.name}`) + 4;
        doc.setTextColor(90);
        doc.text(`— ${note}`, nx, y);
      }
      y += 5;
    }
    y += 3;
  }
}

/** Výchozí volby = původní chování (holé vektorové PDF se vším). */
export const DEFAULT_PDF_OPTIONS: PdfOptions = { textures: true, overlay: true, emptyWalls: true, roomsSummary: true };

/** Načte a připraví rastrové podklady jednoho líce pro zvolenou fázi fotek. */
async function faceBackgrounds(face: WallFace, phaseId?: string): Promise<PdfBackground[]> {
  const out: PdfBackground[] = [];
  for (const bg of resolveBackgrounds(face, phaseId ?? project.activePhaseId, true)) {
    const blob = await getPhoto(bg.photoId);
    if (blob) out.push({ dataUrl: await blobToDataUrl(blob), opacity: bg.opacity, region: bg.region });
  }
  return out;
}

export async function exportPdf(opts: PdfOptions = DEFAULT_PDF_OPTIONS): Promise<void> {
  const faces = exportableFaces(project, opts.emptyWalls);
  const hasRooms = opts.roomsSummary && project.storeys.some((s) => (s.rooms ?? []).length > 0);
  if (!faces.length && !hasRooms) { alert('Projekt je prázdný — není co exportovat (nahrajte model nebo přidejte místnosti).'); return; }

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  await ensureFont(doc);

  let pageAdded = false;
  for (let i = 0; i < faces.length; i++) {
    const { wall, side, storeyName } = faces[i];
    if (i > 0) doc.addPage('a4', 'landscape');
    doc.setFont('Roboto');
    const bgs = opts.textures ? await faceBackgrounds(wall.faces[side], opts.phaseId) : [];
    drawWall(doc, wallElevation(wall, side, storeyName, project.categories), opts, bgs);
    pageAdded = true;
  }

  if (hasRooms) {
    if (pageAdded) doc.addPage('a4', 'landscape');
    drawRoomSummary(doc, project.storeys);
  }

  // POZOR: doc.save() dělá <a download>/window.open — ve WKWebView nefunguje (a blokuje UI).
  // Přes saveBlob se v nativním shellu předá share sheet, v prohlížeči se stáhne.
  await saveBlob(doc.output('blob'), `zaznam-kabelaze-${new Date().toISOString().slice(0, 10)}.pdf`);
}
