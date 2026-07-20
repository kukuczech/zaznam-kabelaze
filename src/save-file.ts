// Uložení vygenerovaného souboru (PDF / ZIP / DXF).
//
// V prohlížeči: klasické stažení přes <a download>.
// Uvnitř sesterské iOS aplikace (WKWebView): stažení přes <a download> NEFUNGUJE
// (prohlížeč ho ignoruje a PDF se navíc snaží otevřít blob přes celou appku).
// Proto blob předáme nativní vrstvě (messageHandlers.saveFile) jako base64 a ta
// ho uloží do dočasného souboru a nabídne share sheet (Uložit do Souborů / poslat dál).

interface SaveFileBridge { postMessage(msg: unknown): void; }
function nativeSaveBridge(): SaveFileBridge | null {
  return (window as unknown as { webkit?: { messageHandlers?: { saveFile?: SaveFileBridge } } })
    .webkit?.messageHandlers?.saveFile ?? null;
}

/** Blob → base64 (bez `data:` prefixu). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => { const s = fr.result as string; res(s.slice(s.indexOf(',') + 1)); };
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
}

/** Uloží/sdílí blob pod daným názvem. V nativním shellu přes share sheet, jinak stažením. */
export async function saveBlob(blob: Blob, filename: string): Promise<void> {
  const bridge = nativeSaveBridge();
  if (bridge) {
    const base64 = await blobToBase64(blob);
    bridge.postMessage({ name: filename, mime: blob.type || 'application/octet-stream', base64 });
    return;
  }
  // Fallback v prohlížeči.
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
