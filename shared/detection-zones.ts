import { z } from 'zod';

export const zoneTypes = {
  motionZone:'motion', personZone:'person', vehicleZone:'vehicle', petZone:'pet', faceZone:'face'
} as const;
export type ZoneGroup = keyof typeof zoneTypes;
export const zoneGroups = Object.keys(zoneTypes) as ZoneGroup[];
export const isZoneGroup = (group:string):group is ZoneGroup => Object.hasOwn(zoneTypes,group);

const cells = z.string().min(1).max(15500).regex(/^[01]+$/);
const revision = z.string().regex(/^[0-9a-f]{64}$/);
export const zoneView = z.strictObject({
  width:z.int().min(1).max(155), height:z.int().min(1).max(100), cells, revision
}).refine(view=>view.cells.length===view.width*view.height);
export type DetectionZone = z.infer<typeof zoneView>;
export const zoneChange = z.strictObject({expectedRevision:revision,cells});
