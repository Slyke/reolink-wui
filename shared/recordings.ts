import { z } from 'zod';

const size = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
export const recordingId = z.string().regex(/^[0-9a-f]{64}$/);
export const recordingDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
export const recordingStream = z.enum(['main', 'sub']);
const wallTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
export const storageResponse = z.object({
  cards: z.array(z.object({
    number: z.number().int().min(0), kind: z.enum(['sd', 'hdd']), mounted: z.boolean(), formatted: z.boolean(),
    totalBytes: size, usedBytes: size, freeBytes: size
  })).max(64),
  cameraTime: wallTime.nullable(), refreshedAt: z.string().datetime(),
  streams: z.array(recordingStream).min(1).max(2)
});
export const recordingsResponse = z.object({
  recordings: z.array(z.object({
    id: recordingId, start: wallTime, end: wallTime, stream: recordingStream, sizeBytes: size,
    kind: z.string().max(120).nullable()
  })).max(4096),
  truncated: z.boolean(), date: recordingDate, stream: recordingStream
});
export type StorageInfo = z.infer<typeof storageResponse>;
export type RecordingList = z.infer<typeof recordingsResponse>;
