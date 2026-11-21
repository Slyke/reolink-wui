import { z } from 'zod';

export const talkFormat = z.object({
  available: z.literal(true),
  sampleRate: z.int().min(8000).max(48000),
  blockSamples: z.int().min(65).max(2049)
});
export type TalkFormat = z.infer<typeof talkFormat>;
export const talkCapability = z.discriminatedUnion('available', [talkFormat, z.object({ available: z.literal(false) })]);
export type TalkCapability = z.infer<typeof talkCapability>;
