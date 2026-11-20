import { z } from 'zod';

// Camera timestamps are wall-clock readings, including across DST transitions.
export const cameraTime = z.iso.datetime({local:true,precision:0}).length(19);
const offset = z.number().int().min(-720).max(840);
const transition = z.strictObject({
  month:z.number().int().min(1).max(12), week:z.number().int().min(1).max(5),
  weekday:z.number().int().min(0).max(6), hour:z.number().int().min(0).max(23), minute:z.number().int().min(0).max(59)
});
export const clockZone = z.strictObject({
  utcOffsetMinutes:offset,
  daylightSaving:z.strictObject({hours:z.union([z.literal(1),z.literal(2)]),start:transition,end:transition}).nullable()
});
export type ClockZone = z.infer<typeof clockZone>;
export const clockSettings = z.object({utcOffsetMinutes:offset.nullable(),daylightSavingEnabled:z.boolean().nullable(),ntpEnabled:z.boolean().nullable(),daylightSavingSchedule:clockZone.shape.daylightSaving.optional()});
export const clockOptionKeys = ['daylightSavingEnabled','ntpEnabled'] as const;
export type ClockOption = typeof clockOptionKeys[number];
export type ClockOptions = Partial<Record<ClockOption,boolean>>;
export const clockReading = z.object({cameraTime:cameraTime.nullable(),settings:clockSettings.optional(),editableOptions:z.array(z.enum(clockOptionKeys)).optional()});
export type ClockReading = z.infer<typeof clockReading>;
export const clockFields = { cameraTime:cameraTime.optional(), timeZone:clockZone.optional(), daylightSavingEnabled:z.boolean().optional(), ntpEnabled:z.boolean().optional() };
export type ClockChange = ClockOptions & {cameraTime?:string;timeZone?:ClockZone};
export function validClockChange(change:ClockChange) {
  return change.cameraTime!==undefined ? change.daylightSavingEnabled===undefined
    : change.timeZone===undefined && clockOptionKeys.some(key=>change[key]!==undefined);
}
export function clockConfirmed(requested: string, observed: string, elapsedMs: number) {
  const delta = Date.parse(observed + 'Z') - Date.parse(requested + 'Z');
  return delta >= -1000 && delta <= elapsedMs + 1000;
}

export const wallAtOffset = (ms:number, minutes:number) => new Date(ms+minutes*60_000).toISOString().slice(0,19);
export function offsetLabel(minutes:number) {
  const absolute=Math.abs(minutes);
  return (minutes<0?'-':'+')+String(Math.floor(absolute/60)).padStart(2,'0')+':'+String(absolute%60).padStart(2,'0');
}
export function readOffset(label:string) {
  const match=/^([+-])(\d{2}):([0-5]\d)$/.exec(label.trim());
  if (!match) return;
  const minutes=(Number(match[2])*60+Number(match[3]))*(match[1]==='-'?-1:1);
  return offset.safeParse(minutes).data;
}

type Transition = z.infer<typeof transition>;
type ObservedTransition = Transition & {at:number;last:boolean};
function ruleFor(samples:ObservedTransition[]):Transition|undefined {
  if (samples.length<2) return;
  const {month,weekday,hour,minute}=samples[0];
  if (!samples.every(s=>s.month===month && s.weekday===weekday && s.hour===hour && s.minute===minute)) return;
  const allLast=samples.every(s=>s.last), week=allLast ? 5 : samples[0].week;
  if (!allLast && (week===5 || !samples.every(s=>s.week===week))) return;
  return {month,week,weekday,hour,minute};
}

function repeatsAcrossWindow(rule:Transition, samples:ObservedTransition[], beforeOffset:number, start:number, end:number) {
  const observed=new Set(samples.map(sample=>sample.at));
  for(let year=new Date(start).getUTCFullYear()-1;year<=new Date(end).getUTCFullYear()+1;year++) {
    const first=new Date(Date.UTC(year,rule.month-1,1));
    const last=new Date(Date.UTC(year,rule.month,0));
    const day=rule.week===5 ? last.getUTCDate()-(last.getUTCDay()-rule.weekday+7)%7
      : 1+(rule.weekday-first.getUTCDay()+7)%7+(rule.week-1)*7;
    const at=Date.UTC(year,rule.month-1,day,rule.hour,rule.minute)-beforeOffset*60_000;
    if(at>start && at<=end && !observed.delete(at)) return false;
  }
  return observed.size===0;
}

// Reolink stores a standard UTC offset and two recurring local weekday rules.
// Inspect upcoming transitions so a region that abolished DST stays on its new offset.
export function deviceClockZone(now:number, offsetAt=(ms:number)=>-new Date(ms).getTimezoneOffset()):ClockZone|undefined {
  const step=86_400_000, start=Math.floor(now/60_000)*60_000;
  const initial=offsetAt(start), offsets=new Set([initial]);
  const forward:ObservedTransition[]=[], backward:ObservedTransition[]=[];
  let previous=initial;
  for(let day=1;day<=5*366;day++) {
    const end=start+day*step, next=offsetAt(end);
    if (previous===next) continue;
    offsets.add(next);
    if (offsets.size>2) return;
    let lo=(end-step)/60_000, hi=end/60_000;
    while(hi-lo>1) {
      const mid=Math.floor((lo+hi)/2);
      if(offsetAt(mid*60_000)===previous) lo=mid; else hi=mid;
    }
    const before=new Date((hi+previous)*60_000);
    const followingWeek=new Date(before.getTime()+7*step);
    (next>previous?forward:backward).push({at:hi*60_000,month:before.getUTCMonth()+1,week:Math.ceil(before.getUTCDate()/7),
      weekday:before.getUTCDay(),hour:before.getUTCHours(),minute:before.getUTCMinutes(),last:followingWeek.getUTCMonth()!==before.getUTCMonth()});
    previous=next;
  }
  if(offsets.size===1) return {utcOffsetMinutes:initial,daylightSaving:null};
  const standard=Math.min(...offsets), hours=(Math.max(...offsets)-standard)/60;
  const first=ruleFor(forward), last=ruleFor(backward);
  const end=start+5*366*step;
  if((hours===1 || hours===2) && first && last && repeatsAcrossWindow(first,forward,standard,start,end) &&
      repeatsAcrossWindow(last,backward,standard+hours*60,start,end)) {
    return {utcOffsetMinutes:standard,daylightSaving:{hours,start:first,end:last}};
  }
}

export function compareClocks(camera:string, started:number, received:number) {
  const midpoint=(started+received)/2;
  const local=wallAtOffset(midpoint,-new Date(midpoint).getTimezoneOffset());
  const seconds=(Date.parse(camera+'Z')-Date.parse(local+'Z'))/1000;
  const tolerance=Math.max(1,Math.ceil((received-started)/2000));
  const matched=Math.abs(seconds)<=tolerance;
  const display=(stamp:string)=>camera.slice(0,10)===local.slice(0,10)?stamp.slice(11):stamp.replace('T',' ');
  const absolute=Math.abs(seconds);
  const duration=[Math.floor(absolute/3600),Math.floor(absolute/60)%60,absolute%60].map(n=>String(n).padStart(2,'0')).join(':');
  return {matched,seconds,duration,camera:display(camera),local:display(local)};
}
