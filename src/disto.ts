// Web Bluetooth klient pro Leica DISTO (D2, D2G a příbuzné).
// Služba 3ab10100-…; vzdálenost přichází jako IEEE754 float32 LE (metry) na začátku
// paketu distanční charakteristiky — D2G používá 3ab1010d, klasické D2 3ab10101.
// Koncept „aktivního cíle": tapnuté číselné pole přijme příští naměřenou hodnotu.

const SERVICE = '3ab10100-f831-4395-b29d-570977d5bf94';
// Charakteristiky, na kterých DISTO posílá naměřenou vzdálenost (float32 LE, metry):
//   3ab1010d — D2G (20B paket: [0..3]=vzdálenost, dále náklon/kvalita + čítač)
//   3ab10101 — klasické D2 / D110 / D810
const DISTANCE_CHARS = [
  '3ab1010d-f831-4395-b29d-570977d5bf94',
  '3ab10101-f831-4395-b29d-570977d5bf94',
];

export type DistoStatus = 'disconnected' | 'connecting' | 'connected';

let device: BluetoothDevice | null = null;
let status: DistoStatus = 'disconnected';
const statusListeners = new Set<(s: DistoStatus) => void>();

// --- Nativní most (iOS WKWebView) ---------------------------------------
// Když appka běží UVNITŘ sesterské iOS aplikace (LiDAR skener), Bluetooth
// obsluhuje nativní vrstva (CoreBluetooth) – WKWebView Web Bluetooth neumí.
// Naměřené hodnoty i stav připojení pak proudí sem oknem (viz __lidarDisto);
// logika „aktivního cíle" (které pole měření přijme) zůstává beze změny.
interface NativeBridge { postMessage(msg: unknown): void; }
function distoNativeBridge(): NativeBridge | null {
  return (window as unknown as { webkit?: { messageHandlers?: { distoBridge?: NativeBridge } } })
    .webkit?.messageHandlers?.distoBridge ?? null;
}

/** True, běží-li web uvnitř nativního shellu, který obsluhuje metr za nás. */
export function isNativeDisto(): boolean {
  return distoNativeBridge() !== null;
}

// Rozhraní, které volá nativní vrstva přes evaluateJavaScript:
//   window.__lidarDisto.measurement(mm)  – jedno pípnutí metru (mm)
//   window.__lidarDisto.status('connected' | 'connecting' | 'disconnected')
(window as unknown as { __lidarDisto?: unknown }).__lidarDisto = {
  measurement(mm: number): void { applyMm(Math.round(mm)); },
  status(s: DistoStatus): void { setStatus(s); },
};

interface Target {
  input: HTMLInputElement;
  apply: (mm: number) => void;
}
let target: Target | null = null;

export function distoStatus(): DistoStatus {
  return status;
}

export function onDistoStatus(fn: (s: DistoStatus) => void): () => void {
  statusListeners.add(fn);
  fn(status);
  return () => statusListeners.delete(fn);
}

function setStatus(s: DistoStatus): void {
  status = s;
  statusListeners.forEach((fn) => fn(s));
}

// Alternativa k metru: když je nějaké pole zvýrazněné jako cíl (modře) a
// uživatel začne psát číslici na klávesnici (aniž by měl kurzor v jiném poli),
// přesměrujeme psaní rovnou do zvýrazněného pole. První číslici vložíme ručně
// a nahradíme jí předvyplněnou hodnotu (spoléhat na to, že ji prohlížeč vloží
// sám po focusu, je nespolehlivé — po tapnutí do stěny je focus mimo pole).
// Další číslice pak už píše prohlížeč nativně a Enter potvrdí (handler na poli).
window.addEventListener('keydown', (e) => {
  if (!target) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!/^[0-9]$/.test(e.key)) return;
  const active = document.activeElement as HTMLElement | null;
  if (active === target.input) return; // už se píše přímo do pole → nechá prohlížeč
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
  e.preventDefault();
  const input = target.input;
  input.value = e.key; // první číslice nahradí původní hodnotu
  input.focus();
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

/** Označí pole jako příjemce příštího měření (a zvýrazní ho). */
export function setDistoTarget(input: HTMLInputElement, apply: (mm: number) => void): void {
  target?.input.classList.remove('disto-target');
  target = { input, apply };
  input.classList.add('disto-target');
}

export function clearDistoTarget(input?: HTMLInputElement): void {
  if (input && target?.input !== input) return;
  target?.input.classList.remove('disto-target');
  target = null;
}

function applyMm(mm: number): void {
  if (target && document.contains(target.input)) {
    target.input.value = String(mm);
    target.apply(mm);
    // krátké bliknutí jako potvrzení
    target.input.animate([{ background: '#0ea5e9' }, { background: 'transparent' }], { duration: 400 });
  }
}

/** Vzdálenost je float32 LE (metry) na začátku paketu. */
function parseMeters(dv: DataView): number | null {
  if (dv.byteLength < 4) return null;
  const f = dv.getFloat32(0, true);
  if (!isFinite(f) || f <= 0 || f > 200) return null;
  return f;
}

function onMeasurement(event: Event): void {
  const dv = (event.target as BluetoothRemoteGATTCharacteristic).value;
  if (!dv) return;
  const meters = parseMeters(dv);
  if (meters == null) return;
  applyMm(Math.round(meters * 1000));
}

async function subscribe(): Promise<void> {
  if (!device?.gatt) return;
  setStatus('connecting');
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE);
  // Napojíme se na distanční charakteristiky, které daný model má.
  const chars = await service.getCharacteristics();
  let subscribed = 0;
  for (const ch of chars) {
    if (!DISTANCE_CHARS.includes(ch.uuid)) continue;
    if (!ch.properties.notify && !ch.properties.indicate) continue;
    try {
      await ch.startNotifications();
      ch.addEventListener('characteristicvaluechanged', onMeasurement);
      subscribed++;
    } catch (e) {
      console.warn(`[DISTO] startNotifications selhalo na ${ch.uuid}:`, e);
    }
  }
  if (!subscribed) throw new Error('Metr nemá očekávanou distanční charakteristiku.');
  setStatus('connected');
}

export async function connectDisto(): Promise<void> {
  // V nativním shellu si připojení řídí iOS vrstva – jen jí to řekneme.
  const bridge = distoNativeBridge();
  if (bridge) { setStatus('connecting'); bridge.postMessage({ action: 'connect' }); return; }
  if (!navigator.bluetooth) {
    alert('Tento prohlížeč neumí Web Bluetooth. Na iPhonu použijte prohlížeč Bluefy, na PC Chrome/Edge.');
    return;
  }
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE] }],
      optionalServices: [SERVICE],
    });
    device.addEventListener('gattserverdisconnected', async () => {
      setStatus('disconnected');
      // metr po chvíli nečinnosti usíná — zkusit se potichu připojit znovu
      for (let i = 0; i < 20 && device; i++) {
        try {
          await subscribe();
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    });
    await subscribe();
  } catch (err) {
    setStatus('disconnected');
    if ((err as Error).name !== 'NotFoundError') {
      alert(`Připojení k metru selhalo: ${err}`);
    }
  }
}

export function disconnectDisto(): void {
  const bridge = distoNativeBridge();
  if (bridge) { bridge.postMessage({ action: 'disconnect' }); setStatus('disconnected'); return; }
  const d = device;
  device = null; // zastaví reconnect smyčku
  d?.gatt?.disconnect();
  setStatus('disconnected');
}
