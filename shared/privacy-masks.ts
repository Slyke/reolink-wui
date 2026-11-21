import { z } from 'zod';
export const maskWidth=1024, maskHeight=768;
export const areaSchema=z.strictObject({id:z.int().min(0).max(7),x:z.int().nonnegative(),y:z.int().nonnegative(),
  width:z.int().positive(),height:z.int().positive()}).refine(a=>a.x+a.width<=maskWidth && a.y+a.height<=maskHeight);
export type MaskArea=z.infer<typeof areaSchema>;
const areas=z.array(areaSchema).max(8).refine(list=>new Set(list.map(r=>r.id)).size===list.length);
const revision=z.string().regex(/^[0-9a-f]{64}$/);
export const privacyMaskView=z.object({areas,maxAreas:z.int().min(1).max(8),revision}).refine(v=>v.areas.length<=v.maxAreas);
export type MaskView=z.infer<typeof privacyMaskView>;
export const privacyMaskChanges=z.strictObject({maskEnabled:z.boolean(),maskAreas:areas,expectedRevision:revision}).refine(v=>!v.maskEnabled || v.maskAreas.length>0);
export function sameAreas(a:MaskArea[],b:MaskArea[]){
  return a.length===b.length && a.every(r=>b.some(s=>s.id===r.id && s.x===r.x && s.y===r.y && s.width===r.width && s.height===r.height));
}
