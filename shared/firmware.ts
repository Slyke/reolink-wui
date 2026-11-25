import { z } from 'zod';

export const maxFirmwareBytes = 128 * 1024 * 1024;
export const firmwareSource = z.string().regex(/^[a-f0-9]{64}$/);
export const firmwareFilename = z.string().max(180).regex(/^(?!\.)[A-Z0-9 ._()+-]+\.paks?$/i);
export const firmwareView = z.object({
  model:z.string().min(1).max(160), hardware:z.string().min(1).max(160), installed:z.string().min(1).max(160),
  source:firmwareSource, canInstall:z.boolean(), updateAvailable:z.boolean().nullable(),
  progress:z.object({state:z.enum(['none','downloading','updating','stopped','timeout','finish','imgerror']),
    percent:z.int().min(0).max(100).nullable()}).nullable()
});
export type FirmwareView = z.infer<typeof firmwareView>;
