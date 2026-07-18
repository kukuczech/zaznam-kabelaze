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
  const d = device;
  device = null; // zastaví reconnect smyčku
  d?.gatt?.disconnect();
  setStatus('disconnected');
}
