// Web Bluetooth klient pro Leica DISTO D2.
// Služba 3ab10100-…, měření 3ab10101-… (indicate, IEEE754 float32 LE v metrech).
// Koncept „aktivního cíle": tapnuté číselné pole přijme příští naměřenou hodnotu.

const SERVICE = '3ab10100-f831-4395-b29d-570977d5bf94';
const CHAR_MEASURE = '3ab10101-f831-4395-b29d-570977d5bf94';

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

function onMeasurement(event: Event): void {
  const dv = (event.target as BluetoothRemoteGATTCharacteristic).value;
  if (!dv || dv.byteLength < 4) return;
  const meters = dv.getFloat32(0, true);
  if (!isFinite(meters) || meters <= 0) return;
  const mm = Math.round(meters * 1000);
  if (target && document.contains(target.input)) {
    target.input.value = String(mm);
    target.apply(mm);
    // krátké bliknutí jako potvrzení
    target.input.animate([{ background: '#0ea5e9' }, { background: 'transparent' }], { duration: 400 });
  }
}

async function subscribe(): Promise<void> {
  if (!device?.gatt) return;
  setStatus('connecting');
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE);
  const ch = await service.getCharacteristic(CHAR_MEASURE);
  await ch.startNotifications();
  ch.addEventListener('characteristicvaluechanged', onMeasurement);
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
