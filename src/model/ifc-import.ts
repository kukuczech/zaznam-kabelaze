// Import IFC souboru z magicplan → Storey se stěnami. Implementace v M1.
import type { Storey } from './types';

export async function importIfc(_file: File): Promise<Storey> {
  throw new Error('IFC import zatím není implementován (M1)');
}
