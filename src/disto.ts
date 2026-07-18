// Web Bluetooth klient pro Leica DISTO D2.
// Služba 3ab10100-…, měření 3ab10101-… (indicate, IEEE754 float32 LE v metrech).
// Koncept „aktivního cíle": tapnuté číselné pole přijme příští naměřenou hodnotu.

const SERVICE = '3ab10100-f831-4395-b29d-570977d5bf94';

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

/** Zkusí z DataView vytáhnout věrohodnou vzdálenost (metry) různými formáty. */
function parseMeters(dv: DataView): number | null {
  // float32 LE v metrech (standardní DISTO)
  if (dv.byteLength >= 4) {
    const f = dv.getFloat32(0, true);
    if (isFinite(f) && f > 0 && f < 200) return f;
  }
  // float32 LE s offsetem (některé firmwary přidávají 1B hlavičku)
  if (dv.byteLength >= 5) {
    const f = dv.getFloat32(1, true);
    if (isFinite(f) && f > 0 && f < 200) return f;
  }
  // float64 LE
  if (dv.byteLength >= 8) {
    const d = dv.getFloat64(0, true);
    if (isFinite(d) && d > 0 && d < 200) return d;
  }
  return null;
}

function hex(dv: DataView): string {
  return Array.from(new Uint8Array(dv.buffer)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function onMeasurement(event: Event): void {
  const ch = event.target as BluetoothRemoteGATTCharacteristic;
  const dv = ch.value;
  if (!dv) return;
  const meters = parseMeters(dv);
  console.log(`[DISTO] ${ch.uuid} (${dv.byteLength} B): ${hex(dv)} → ${meters != null ? meters.toFixed(3) + ' m' : 'nerozpoznáno'}`);
  if (meters == null) return;
  applyMm(Math.round(meters * 1000));
}

async function subscribe(): Promise<void> {
  if (!device?.gatt) return;
  setStatus('connecting');
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE);
  // Diagnostika: napojíme se na VŠECHNY notify/indicate charakteristiky služby,
  // ať zachytíme měření i kdyby D2G posílal na jiné UUID než D2.
  const chars = await service.getCharacteristics();
  let subscribed = 0;
  for (const ch of chars) {
    const p = ch.properties;
    console.log(`[DISTO] char ${ch.uuid} — notify:${p.notify} indicate:${p.indicate} read:${p.read} write:${p.write}`);
    if (p.notify || p.indicate) {
      try {
        await ch.startNotifications();
        ch.addEventListener('characteristicvaluechanged', onMeasurement);
        subscribed++;
      } catch (e) {
        console.warn(`[DISTO] startNotifications selhalo na ${ch.uuid}:`, e);
      }
    }
  }
  console.log(`[DISTO] napojeno na ${subscribed} charakteristik. Zmáčkni tlačítko na metru.`);
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
