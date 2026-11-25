<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { api,t,UiError } from './api.js';
  import type { Camera } from './models.js';
  import { groupRecordings, recordingTime, type RecordingGroup } from '../../shared/recording-groups.js';
  import type { Recording, RecordingList } from '../../shared/recordings.js';
  import { sampleDates,sampleWindows,type Period } from '../../shared/hotspots.js';
  import { zoneView,type DetectionZone } from '../../shared/detection-zones.js';
  import { measureWindows,type HeatMap } from './hotspot-video.js';
  import HotspotMap from './HotspotMap.svelte';
  import InfoTip from './InfoTip.svelte';

  let {camera,date,groups}:{camera:Camera;date:string;groups:RecordingGroup[]}=$props();
  const base=$derived('/api/v1/cameras/'+camera.id);
  const canMask=$derived(camera.capabilities.detectionZones?.available && camera.capabilities.detectionZones.types.some(d=>d.group==='motionZone'));
  const initial=untrack(()=>{
    const day=recordingTime(date+'T00:00:00');
    const end=Math.min(day+86400000,Math.max(day+60000,...groups.map(g=>recordingTime(g.end))));
    const mid=Math.max(day+30000,end-300000);
    const stamp=(ts:number)=>new Date(ts).toISOString().slice(0,19);
    return [{from:stamp(Math.max(day,mid-300000)),to:stamp(mid)},{from:stamp(mid),to:stamp(end)}];
  });
  let ranges=$state(initial);
  let results=$state<(HeatMap|undefined)[]>([]), failures=$state<string[]>([]),ref=$state(''),done=$state(false),busy=$state(false);
  let count=$state(0),planned=$state(0),partial=$state(false),showMask=$state(false),zone=$state<DetectionZone>(),maskError=$state('');
  let work:AbortController|undefined, maskRead:AbortController|undefined;
  const periods=$derived(ranges.map(range=>({from:recordingTime(range.from),to:recordingTime(range.to)})));
  const valid=$derived(periods.every(p=>Number.isFinite(p.from)&&Number.isFinite(p.to)&&p.to-p.from>500));
  const message=(err:unknown)=>err instanceof UiError?t('error-'+err.reason):err instanceof Error?err.message:t('error-INTERNAL');
  const label=(i:number)=>t(i===0?'hotspot-first':'hotspot-second');
  function stop(){work?.abort();work=undefined;busy=false;}
  function edit(){stop();done=false;results=[];failures=[];partial=false;}
  function close(open:boolean){if(!open)stop();}
  async function readMask(){
    maskRead?.abort();maskError='';zone=undefined;
    if(!showMask || !canMask)return;
    const controller=new AbortController();maskRead=controller;
    try{
      const data=await api<{zone?:DetectionZone}>({path:base+'/options/motionZone',signal:controller.signal});
      const saved=zoneView.safeParse(data.zone);
      if(!controller.signal.aborted){if(saved.success)zone=saved.data;else maskError=t('zone-unavailable');}
    }catch(err){if(!controller.signal.aborted)maskError=message(err);}
  }
  async function compare(){
    if(!valid || busy)return;
    edit();const controller=new AbortController();work=controller;busy=true;count=0;planned=0;ref='';
    const signal=controller.signal, selected=periods.map(p=>({...p}));
    const indexes=new Map<string,RecordingGroup[]>([[date,groups]]);
    async function index(day:string){
      if(indexes.has(day))return indexes.get(day)!;
      const rows:Recording[]=[];let ok=0;
      for(const stream of ['sub','main']){
        signal.throwIfAborted();
        try{
          const data=await api<RecordingList>({path:base+'/recordings?date='+day+'&stream='+stream,signal});
          rows.push(...data.recordings);ok++;partial ||= data.truncated;
        }catch(err){signal.throwIfAborted();if(stream==='main' && ok===0)throw err;partial=true;}
      }
      const clips=groupRecordings({recordings:rows});indexes.set(day,clips);return clips;
    }
    try{
      for(const [i,period] of selected.entries()){
        try{
          const all:RecordingGroup[]=[];
          for(const day of sampleDates(period))all.push(...await index(day));
          const windows=sampleWindows(all,period);
          planned+=windows.length;
          const map=await measureWindows(base,windows,signal,()=>{if(!signal.aborted)count++;});
          signal.throwIfAborted();results[i]=map;
          if(!map)failures[i]=t('hotspot-no-frames');
        }catch(err){signal.throwIfAborted();failures[i]=message(err);if(err instanceof UiError)ref=err.correlation??'';}
      }
      done=true;
    }catch(err){if(!signal.aborted){failures=[message(err)];done=true;}}
    finally{if(work===controller){work=undefined;busy=false;}}
  }
  onDestroy(()=>{stop();maskRead?.abort();});
</script>

<details class="panel stack" ontoggle={e=>close(e.currentTarget.open)}>
  <summary>{t('hotspot-title')}</summary>
  <p class="muted">{t('hotspot-help')}</p>
  <div class="periods">
    {#each ranges as range,i}
      <fieldset><legend>{label(i)}</legend><div class="limits">
        <label>{t('hotspot-from')}<input type="datetime-local" step="1" bind:value={range.from} oninput={edit}/></label>
        <label>{t('hotspot-to')}<input type="datetime-local" step="1" bind:value={range.to} oninput={edit}/></label>
      </div></fieldset>
    {/each}
  </div>
  <div class="row">
    <button disabled={!valid || busy} onclick={compare}>{t('hotspot-compare')}</button>
    {#if busy}<button onclick={stop}>{t('hotspot-cancel')}</button>{/if}
    {#if canMask}
      <label class="row"><input type="checkbox" bind:checked={showMask} onchange={readMask}/>{t('hotspot-mask')}</label>
      <a href={'/settings/cameras?camera='+encodeURIComponent(camera.id)+'#detection-zones'}>{t('hotspot-zone-settings')}</a>
    {/if}
  </div>
  {#if busy}<p role="status">{t('hotspot-loading',{count,total:planned})}</p>{/if}
  {#if maskError}<p role="alert" class="error">{maskError}</p>{/if}
  {#if done || results.some(Boolean)}
    <div class="periods">
      {#each ranges as _,i}
        {@const map=results[i]}
        {#if map}<HotspotMap {map} zone={showMask?zone:undefined} label={label(i)}/>
        {:else if failures[i]}<p role="status"><strong>{label(i)}</strong> · {failures[i]}
          {#if ref}<InfoTip label={t('firmware-reference')} text={ref}/>{/if}</p>{/if}
      {/each}
    </div>
    {#if partial}<p class="notice">{t('recording-search-partial')}</p>{/if}
  {/if}
</details>
<style>
  summary{cursor:pointer;font-weight:bold}
  .periods,.limits{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr));gap:var(--space-3,.8rem)}
  .limits{grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr))}
  fieldset,input{min-width:0}input[type=datetime-local]{width:100%}
</style>
