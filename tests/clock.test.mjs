import assert from 'node:assert/strict';
import test from 'node:test';
import {compareClocks,deviceClockZone,offsetLabel,readOffset,wallAtOffset} from '../dist/shared/clock.js';

test('remaining on a fixed offset after the final change does not carry the old DST rule forward',()=>{
  const lastChange=Date.UTC(2026,2,8,10);
  const vancouver=ms=>ms<lastChange?-480:-420;
  const zone=deviceClockZone(Date.UTC(2026,10,20,21),vancouver);
  assert.deepEqual(zone,{utcOffsetMinutes:-420,daylightSaving:null});
  assert.equal(wallAtOffset(Date.UTC(2026,10,20,21),zone.utcOffsetMinutes),'2026-11-20T14:00:00');
  assert.equal(offsetLabel(-420),'-07:00');
  assert.equal(readOffset('+05:45'),345);
  for(const bad of ['+14:01','-13:00','-07:60','7']) assert.equal(readOffset(bad),undefined);
});

test('recurring DST rules encode local transition times in both hemispheres and reject discontinued rules',()=>{
  const now=Date.UTC(2026,10,20);
  function rules(zone) {
    const format=new Intl.DateTimeFormat('en-US',{timeZone:zone,timeZoneName:'longOffset'});
    return ms=>{
      const name=format.formatToParts(ms).find(part=>part.type==='timeZoneName').value;
      return name==='GMT'?0:readOffset(name.slice(3));
    };
  }
  const newYork=rules('America/New_York'), sydney=rules('Australia/Sydney');
  assert.deepEqual(deviceClockZone(now,newYork),{utcOffsetMinutes:-300,daylightSaving:{hours:1,
    start:{month:3,week:2,weekday:0,hour:2,minute:0},end:{month:11,week:1,weekday:0,hour:2,minute:0}}});
  assert.deepEqual(deviceClockZone(now,sydney),{utcOffsetMinutes:600,daylightSaving:{hours:1,
    start:{month:10,week:1,weekday:0,hour:2,minute:0},end:{month:4,week:1,weekday:0,hour:3,minute:0}}});
  assert.equal(deviceClockZone(now,ms=>ms<Date.UTC(2030,0,1)?newYork(ms):-300),undefined);
});

test('timeline uses browser wall time, dates across midnight and uncertainty of the sample',()=>{
  const base=new Date(2026,10,20,0,15,0).getTime(), offset=-new Date(base).getTimezoneOffset();
  const reported=(seconds)=>wallAtOffset(base+seconds*1000,offset);
  assert.equal(compareClocks(reported(-1),base,base+40).matched,true);
  const behind=compareClocks(reported(-3600),base-100,base+100);
  assert.equal(behind.seconds,-3600);assert.equal(behind.duration,'01:00:00');
  assert.equal(behind.camera,'2026-11-19 23:15:00');assert.equal(behind.local,'2026-11-20 00:15:00');
  assert.equal(compareClocks(reported(2),base,base+20).matched,false);
  assert.equal(compareClocks(reported(2),base-2100,base+2100).matched,true);
});
