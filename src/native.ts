// Most do sesterské iOS aplikace (LiDAR skener), když web běží uvnitř jejího
// WKWebView. Nativní vrstva po dokončení skenu zavolá window.__lidarImportScan()
// s obsahem scan.json (schéma "zaznam-lidar-scan/1") → naimportujeme jako podlaží
// a rovnou otevřeme 3D model. Metr (DISTO) řeší samostatně disto.ts přes svůj most.
import { project, saveProject } from './db';
import { route } from './main';

/** True, běží-li web uvnitř nativního shellu (iOS WKWebView), ne v prohlížeči. */
export function isNativeShell(): boolean {
  return !!(window as unknown as { webkit?: { messageHandlers?: unknown } }).webkit?.messageHandlers;
}

/**
 * Zaregistruje funkce, které volá nativní vrstva přes evaluateJavaScript.
 * Voláno jednou při startu (main.ts). V prohlížeči je neškodné – nikdo je nezavolá.
 */
export function installNativeBridge(): void {
  const w = window as unknown as {
    __lidarImportScan?: (scanJsonText: string, name?: string) => Promise<string>;
    __lidarReopenScan?: (name: string, scanJsonText?: string) => Promise<string>;
    webkit?: { messageHandlers?: { appReady?: { postMessage(m: unknown): void } } };
  };

  // Naimportuje sken jako NOVÉ podlaží. Volá se hned po dokončení skenu.
  w.__lidarImportScan = async (scanJsonText: string, name?: string): Promise<string> => {
    const { importScan } = await import('./model/scan-import');
    const file = new File([scanJsonText], `${name || 'Sken'}.json`, { type: 'application/json' });
    const storey = await importScan(file);
    project.storeys.push(storey);
    saveProject();
    location.hash = `#/storey/${storey.id}`; // rovnou 3D model naskenované místnosti
    await route();
    return storey.id;
  };

  // Znovu OTEVŘE už existující podlaží (z uloženého skenu) – najde ho podle názvu,
  // aby se NEDUPLIKOVALO a zachovala se už zdokumentovaná kabeláž. Když ve webovém
  // projektu ještě není (nová instalace / smazaná data), naimportuje ho z fallbacku.
  w.__lidarReopenScan = async (name: string, scanJsonText?: string): Promise<string> => {
    const existing = project.storeys.find((s) => s.name === name);
    if (existing) {
      location.hash = `#/storey/${existing.id}`;
      await route();
      return existing.id;
    }
    if (scanJsonText) return w.__lidarImportScan!(scanJsonText, name);
    location.hash = '#/';
    await route();
    return '';
  };

  // Dej nativní vrstvě vědět, že web je nabootovaný a most je připravený.
  w.webkit?.messageHandlers?.appReady?.postMessage({ ready: true });
}
