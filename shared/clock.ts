import { z } from 'zod';

// Camera timestamps are wall-clock readings, including across DST transitions.
export const cameraTime = z.iso.datetime({local:true,precision:0}).length(19);
export function clockConfirmed(requested: string, observed: string, elapsedMs: number) {
  const delta = Date.parse(observed + 'Z') - Date.parse(requested + 'Z');
  return delta >= 0 && delta <= elapsedMs + 1000;
}
