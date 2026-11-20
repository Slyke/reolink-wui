import { z } from 'zod';

export const dateFormats = ['MDY','DMY','YMD','MDY_CN','DMY_CN','YMD_CN'] as const;
const name = z.string().max(128);
const axis = z.number().int().min(0).max(65536);
export const displayFields = z.strictObject({
  deviceName: name, dateFormat: z.enum(dateFormats), name, nameVisible: z.boolean(),
  nameX: axis, nameY: axis, timeVisible: z.boolean(), timeX: axis, timeY: axis,
  watermark: z.boolean(), background: z.boolean()
}).partial();
export type DisplayFields = z.infer<typeof displayFields>;
export const isDisplayName = (value: string) =>
  value.trim().length > 0 && new TextEncoder().encode(value).length <= 31 && !/\p{Cc}/u.test(value);
export const displayChange = displayFields.refine(fields => {
  const keys = Object.keys(fields);
  const general = keys.filter(key => key === 'deviceName' || key === 'dateFormat');
  return keys.length > 0 && (!general.length || general.length === keys.length)
    && [fields.deviceName,fields.name].every(value => value === undefined || isDisplayName(value));
});
