import { z } from 'zod';
import type { Permission } from './access.js';

const tone = ['auto','manual'] as const;
const pictureLevel = z.int().min(0).max(255), volume=z.int().min(0).max(100);
export const optionTypes = {
  picture: {
    brightness:pictureLevel, contrast:pictureLevel, saturation:pictureLevel, hue:pictureLevel, sharpness:pictureLevel,
    dayNight:z.enum(['auto','color','blackAndWhite']), antiFlicker:z.enum(['off','50hz','60hz','outdoor']),
    exposure:z.enum(['auto','lownoise','anti-smearing','manual']), whiteBalance:z.enum(tone),redGain:pictureLevel,blueGain:pictureLevel,
    hdr:z.enum(['0','1','2']),noiseReduction:z.boolean(),backlightCompensation:z.boolean(),
    dayTone:z.enum(tone),dayHighlight:pictureLevel,dayShadow:pictureLevel,nightTone:z.enum(tone),nightHighlight:pictureLevel,nightShadow:pictureLevel
  },
  threshold:{switchThreshold:z.int().min(0).max(255)},
  sound:{speakerVolume:volume,talkVolume:volume,doorbellVolume:volume},
  recordingAudio:{mainAudio:z.boolean(),subAudio:z.boolean(),thirdAudio:z.boolean()},
  privacy:{maskEnabled:z.boolean()},
  tracking:{autoTracking:z.boolean()},
  siren:{sirenOnEvent:z.boolean()},
  email:{emailEnabled:z.boolean()}, push:{pushEnabled:z.boolean()}, ftp:{ftpEnabled:z.boolean()}
} as const;
export type OptionGroup=keyof typeof optionTypes;
export const isOptionGroup=(key:string):key is OptionGroup=>Object.hasOwn(optionTypes,key);
const section = {picture:'settings.image',threshold:'settings.image',sound:'settings.audio',recordingAudio:'settings.audio',privacy:'settings.privacy',
  tracking:'settings.ai',siren:'alerts',push:'settings.delivery',email:'settings.delivery',ftp:'settings.delivery'} as const;
export function optionPermission(group:OptionGroup,kind:'read'|'write'):Permission {return `${section[group]}.${kind}`;}
export const optionValue=z.union([z.boolean(),z.int(),z.string().max(40)]);
export type OptionValue=z.infer<typeof optionValue>;
const descriptor=z.union([
  z.strictObject({value:z.boolean()}),
  z.strictObject({value:z.int(),min:z.int(),max:z.int()}).refine(o=>o.min<=o.value && o.value<=o.max),
  z.strictObject({value:z.string().max(40),choices:z.array(z.string().max(40)).min(1).max(24)}).refine(o=>o.choices.includes(o.value))
]);
export type OptionDescriptor=z.infer<typeof descriptor>;
export const optionView=z.object({fields:z.record(z.string(),descriptor),privacyZones:z.int().min(0).optional()});
export type OptionView=z.infer<typeof optionView>;
function allowed(group:OptionGroup,key:string,value:OptionValue) {
  const schema=(optionTypes[group] as Record<string,z.ZodType>)[key];
  return Object.hasOwn(optionTypes[group],key) && schema.safeParse(value).success;
}
export const validOptionChange=(group:OptionGroup,fields:Record<string,OptionValue>)=>
  Object.keys(fields).length>0 && Object.entries(fields).every(([key,value])=>allowed(group,key,value));
export function readOptionView(group:OptionGroup,raw:unknown):OptionView|undefined {
  const view=optionView.safeParse(raw).data;
  if(!view)return;
  for(const [key,field] of Object.entries(view.fields)){
    if(!Object.hasOwn(optionTypes[group],key)){delete view.fields[key];continue;}
    if(!allowed(group,key,field.value))return;
    if('choices' in field) {
      field.choices=field.choices.filter(choice=>allowed(group,key,choice));
      if(!field.choices.includes(field.value)) return;
    }
  }
  return view;
}
