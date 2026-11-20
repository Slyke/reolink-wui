import { z } from 'zod';

const number = z.int().min(1).max(0xffffffff);
export const streamId = z.enum(['main','sub','third']);
export const encoderValues = z.strictObject({
  width:number.optional(), height:number.optional(), fps:number.optional(), bitrate:number.optional(), gop:number.optional()
});
export const encoderChange = z.strictObject({
  stream:streamId, settings:encoderValues.refine(value =>
    Object.keys(value).length > 0 && (value.width === undefined) === (value.height === undefined))
});
const options = z.object({width:number,height:number,fps:z.array(number).max(128),bitrates:z.array(number).max(128)});
export const cameraEncoding = z.object({profiles:z.array(z.object({
  stream:streamId, current:encoderValues, options:z.array(options).max(128), gopRange:z.tuple([number,number]).nullish(),
  bitrateMode:z.enum(['vbr','cbr']).nullish(), encoderProfile:z.enum(['default','baseLine','high','main']).nullish()
})).max(3)});
export type CameraEncoding = z.infer<typeof cameraEncoding>;
export type EncoderValues = z.infer<typeof encoderValues>;
export type StreamId = z.infer<typeof streamId>;
