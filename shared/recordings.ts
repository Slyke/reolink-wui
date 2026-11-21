import { z } from 'zod';

const size = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
export const recordingId = z.string().regex(/^[0-9a-f]{64}$/);
export const recordingDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
export const recordingStream = z.enum(['main', 'sub']);
const wallTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
export const recordingPhotos = z.object({
  photos:z.array(z.object({id:recordingId, capturedAt:wallTime.nullable()})).max(20_000)
});
export type TimelinePhoto = {id:string; capturedAt:string};
export const storageResponse = z.object({
  cards: z.array(z.object({
    number: z.number().int().min(0), kind: z.enum(['sd', 'hdd']), mounted: z.boolean(), formatted: z.boolean(),
    totalBytes: size, usedBytes: size, freeBytes: size, formatSource: recordingId.optional()
  })).max(64),
  playbackAvailable: z.boolean().optional(),
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

export type Recording = RecordingList['recordings'][number];
export const recordingStages = ['camera-download', 'conversion', 'cache-limit', 'busy', 'timeout', 'temporary-storage', 'preparation'] as const;


export const recordingMetadataResponse = z.object({
  source: z.literal('recording'),
  nextPage: z.number().int().positive().nullable().optional(),
  truncated: z.boolean(),
  frames: z.array(z.object({
    offsetMs: z.number().int().min(0).max(86_400_000),
    objects: z.array(z.object({
      class: z.string().max(120).optional(),
      tracking_id: z.string().max(120).optional(),
      confidence: z.number().min(0).max(1).optional(),
      bounding_box: z.object({
        left: z.number(), top: z.number(), right: z.number(), bottom: z.number(),
        coordinate_space: z.enum(['normalized_top_left','pixels_top_left']),
        reference_frame: z.string().max(200),
        frame_width: z.number().int().positive().optional(),
        frame_height: z.number().int().positive().optional()
      }).optional()
    })).max(32)
  })).max(4096)
});
export type RecordingMetadata = z.infer<typeof recordingMetadataResponse>;
