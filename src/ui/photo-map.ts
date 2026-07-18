// Napasování fotky na stěnu: uživatel označí 4 rohy stěny ve fotce, obrázek
// se perspektivně narovná (homografie) a vrátí jako narovnaný podklad, který
// přesně vyplní obdélník čelního pohledu (0,0 → len,H).

type Pt = { x: number; y: number };

/** Homografie mapující 4 zdrojové body na 4 cílové (3×3, h33=1). Řeší 8×8 soustavu. */
function solveHomography(src: Pt[], dst: Pt[]): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }
  const h = gauss(A, b); // [h0..h7]
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Gaussova eliminace s částečnou pivotací pro čtvercovou soustavu. */
function gauss(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-9;
    for (let j = c; j <= n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row) => row[n]);
}

function apply(h: number[], x: number, y: number): Pt {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

/** Narovná fotku podle 4 označených rohů (TL,TR,BR,BL v px zdroje) na obdélník outW×outH. */
function warp(srcCanvas: HTMLCanvasElement, corners: Pt[], outW: number, outH: number): HTMLCanvasElement {
  const dst: Pt[] = [
    { x: 0, y: 0 },
    { x: outW, y: 0 },
    { x: outW, y: outH },
    { x: 0, y: outH },
  ];
  // homografie cíl → zdroj (inverzní vzorkování)
  const h = solveHomography(dst, corners);
  const sctx = srcCanvas.getContext('2d')!;
  const sImg = sctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const sd = sImg.data;
  const sw = srcCanvas.width, sh = srcCanvas.height;

  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const octx = out.getContext('2d')!;
  const oImg = octx.createImageData(outW, outH);
  const od = oImg.data;

  for (let Y = 0; Y < outH; Y++) {
    for (let X = 0; X < outW; X++) {
      const s = apply(h, X + 0.5, Y + 0.5);
      const sx = s.x | 0, sy = s.y | 0;
      const o = (Y * outW + X) * 4;
      if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) {
        od[o + 3] = 0;
        continue;
      }
      const si = (sy * sw + sx) * 4;
      od[o] = sd[si]; od[o + 1] = sd[si + 1]; od[o + 2] = sd[si + 2]; od[o + 3] = 255;
    }
  }
  octx.putImageData(oImg, 0, 0);
  return out;
}

async function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('Obrázek se nepodařilo načíst.'));
      img.src = url;
    });
    return img;
  } finally {
    // URL uvolníme až po dekódování — necháme na GC, není kritické
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

/**
 * Otevře celoobrazovkový editor napasování. Vrátí narovnaný JPEG blob nebo null
 * (uživatel zrušil). aspect = len/heightMm určuje poměr stran výstupu.
 */
export async function mapPhotoToWall(sourceBlob: Blob, aspect: number): Promise<Blob | null> {
  const img = await blobToImage(sourceBlob);
  const nW = img.naturalWidth, nH = img.naturalHeight;

  // Zdrojový canvas v plném rozlišení pro vzorkování.
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = nW; srcCanvas.height = nH;
  srcCanvas.getContext('2d')!.drawImage(img, 0, 0);

  return new Promise<Blob | null>((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'photomap-overlay';
    ov.innerHTML = `
      <div class="photomap-hint">Přetáhni 4 body na rohy stěny:
        <b style="color:#f87171">1 levý horní</b> · <b style="color:#facc15">2 pravý horní</b> ·
        <b style="color:#4ade80">3 pravý dolní</b> · <b style="color:#60a5fa">4 levý dolní</b></div>
      <div class="photomap-stage">
        <img class="photomap-img" draggable="false"/>
        <svg class="photomap-svg"></svg>
      </div>
      <div class="photomap-actions">
        <button class="btn" data-act="cancel">✕ Zrušit</button>
        <button class="btn primary" data-act="ok">✓ Napasovat</button>
      </div>`;
    document.body.appendChild(ov);

    const imgEl = ov.querySelector('.photomap-img') as HTMLImageElement;
    const svg = ov.querySelector('.photomap-svg') as SVGSVGElement;
    imgEl.src = img.src;

    const colors = ['#f87171', '#facc15', '#4ade80', '#60a5fa'];
    // Handly v NATIVNÍCH px zdroje; init na 12/88 % okrajích.
    const pts: Pt[] = [
      { x: nW * 0.12, y: nH * 0.12 },
      { x: nW * 0.88, y: nH * 0.12 },
      { x: nW * 0.88, y: nH * 0.88 },
      { x: nW * 0.12, y: nH * 0.88 },
    ];

    // Vztah zobrazené <img> ↔ nativní px.
    function scale(): { ox: number; oy: number; k: number } {
      const ir = imgEl.getBoundingClientRect();
      const sr = svg.getBoundingClientRect();
      return { ox: ir.left - sr.left, oy: ir.top - sr.top, k: ir.width / nW };
    }

    function draw(): void {
      const { ox, oy, k } = scale();
      const sp = pts.map((p) => ({ x: ox + p.x * k, y: oy + p.y * k }));
      const poly = sp.map((p) => `${p.x},${p.y}`).join(' ');
      svg.innerHTML =
        `<polygon points="${poly}" fill="rgba(56,189,248,0.15)" stroke="#38bdf8" stroke-width="2"/>` +
        sp.map((p, i) =>
          `<circle data-i="${i}" cx="${p.x}" cy="${p.y}" r="16" fill="${colors[i]}" stroke="#0f172a" stroke-width="3"/>` +
          `<text x="${p.x}" y="${p.y + 5}" text-anchor="middle" font-size="15" font-weight="bold" fill="#0f172a" pointer-events="none">${i + 1}</text>`,
        ).join('');
    }

    let drag: number | null = null;
    svg.addEventListener('pointerdown', (e) => {
      const t = e.target as Element;
      const i = t.getAttribute('data-i');
      if (i == null) return;
      drag = Number(i);
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', (e) => {
      if (drag == null) return;
      const { ox, oy, k } = scale();
      pts[drag] = {
        x: Math.min(Math.max((e.clientX - svg.getBoundingClientRect().left - ox) / k, 0), nW),
        y: Math.min(Math.max((e.clientY - svg.getBoundingClientRect().top - oy) / k, 0), nH),
      };
      draw();
    });
    svg.addEventListener('pointerup', () => (drag = null));

    const ro = new ResizeObserver(draw);
    ro.observe(imgEl);
    imgEl.complete ? draw() : (imgEl.onload = draw);

    function close(result: Blob | null): void {
      ro.disconnect();
      ov.remove();
      resolve(result);
    }

    ov.querySelector('[data-act="cancel"]')!.addEventListener('click', () => close(null));
    ov.querySelector('[data-act="ok"]')!.addEventListener('click', () => {
      // Výstupní rozlišení podle poměru stran stěny, delší strana ≤ 1600.
      let outW: number, outH: number;
      if (aspect >= 1) { outW = 1600; outH = Math.round(1600 / aspect); }
      else { outH = 1600; outW = Math.round(1600 * aspect); }
      const out = warp(srcCanvas, pts, outW, outH);
      out.toBlob((b) => close(b), 'image/jpeg', 0.85);
    });
  });
}
