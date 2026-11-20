import { z } from 'zod';

const text = z.string().max(255).refine(value => [...value].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127));
const port = z.int().min(1).max(65535);
const optionalFields = {
  username:text.optional(), remoteDirectory:text.optional(), anonymous:z.boolean().optional(), ftpsOnly:z.boolean().optional()
};
// Explicitly project the public fields, even if an older or third-party bridge returns more.
export const ftpDestination = z.object({
  fields:z.object({server:text,port:z.int().min(0).max(65535),...optionalFields}),
  passwordStored:z.boolean().optional(), passwordMaxLength:z.int().min(1).max(255).optional()
});
export const ftpChanges = z.strictObject({
  server:text.min(1).optional(), port:port.optional(), ...optionalFields, password:text.optional()
}).refine(fields => Object.keys(fields).length > 0);
export type FtpDestination = z.infer<typeof ftpDestination>;
export type FtpChanges = z.infer<typeof ftpChanges>;
