<script lang="ts">
  import { onDestroy } from 'svelte';
  import SettingsDisclosure from './SettingsDisclosure.svelte';
  import { api, errorText, operationId, outcomeText, t, type Outcome } from './api.js';
  import { dismissOnBackdrop } from './dialog.js';
  import { maskFrame } from './mask-frame.js';
  import { useWorkspace } from './workspace.js';
  import type { Camera } from './models.js';
  import type { DetectionZone, ZoneGroup } from '../../shared/detection-zones.js';
  import type { OptionView } from '../../shared/device-options.js';

  let {camera,base,csrf,online}:{camera:Camera;base:string;csrf:string;online:boolean}=$props();
  const workspace=useWorkspace(),title=$props.id(),instructions=title+'-instructions';
  let dialog:HTMLDialogElement;
  let stage=$state<HTMLButtonElement>(null!);
  let choice=$state<ZoneGroup>(),expanded=false;
  const access=$derived(camera.capabilities.detectionZones);
  const detector=$derived(access.types.find(type=>type.group===choice)??access.types[0]);
  let zone=$state<DetectionZone>(),draft=$state(''),loaded=$state(false),busy=$state(false),sending=$state(false);
  let error=$state(''),status=$state(''),imageError=$state(''),src=$state('');
  let reading:AbortController|undefined,preview:AbortController|undefined;
  type Point={x:number;y:number};
  let cursor=$state<Point>({x:0,y:0}),anchor=$state<Point>(),pointer:number|undefined;
  let paint=$state<'0'|'1'>('0');
  const writable=$derived(!!detector?.write && online && !sending);
  const selected=$derived(anchor?{
    x:Math.min(anchor.x,cursor.x),y:Math.min(anchor.y,cursor.y),
    width:Math.abs(cursor.x-anchor.x)+1,height:Math.abs(cursor.y-anchor.y)+1
  }:undefined);
  const shaded=$derived.by(()=>{
    if(!zone)return '';
    const width=zone.width,runs:string[]=[];
    for(let row=0;row<zone.height;row++){
      const line=draft.slice(row*width,(row+1)*width);
      for(const run of line.matchAll(/0+/g))runs.push('M'+run.index+' '+row+'h'+run[0].length+'v1h-'+run[0].length+'z');
    }
    return runs.join(' ');
  });
  const excluded=(cells:string)=>cells.length-cells.replaceAll('0','').length;
  export function working(){return busy || sending;}
  export async function refresh(){
    if(!expanded || !access.available || !detector || sending)return;
    const group=detector.group;
    reading?.abort();
    const request=new AbortController();reading=request;busy=true;loaded=false;zone=undefined;error='';status='';
    try{
      const view=await api<OptionView>({path:base+'/options/'+group,signal:request.signal});
      if(request.signal.aborted)return;
      zone=view.zone;draft=view.zone?.cells??'';loaded=true;
    }catch(err){if(!request.signal.aborted)error=errorText(err);}
    finally{if(reading===request)busy=false;}
  }
  function onToggle(open:boolean){expanded=open;if(open && !loaded && !busy)void refresh();}
  function releaseFrame(){preview?.abort();if(src)URL.revokeObjectURL(src);src='';}
  async function frame(fresh=false){
    preview?.abort();imageError='';
    if(!camera.capabilities.mediaAllowed){imageError=t('mask-frame-permission');return;}
    const request=new AbortController();preview=request;
    try{
      const blob=await maskFrame({base,camera,cache:workspace.lastFrames,fresh,signal:request.signal});
      if(request.signal.aborted)return;
      if(src)URL.revokeObjectURL(src);src=URL.createObjectURL(blob);
    }catch(err){if(!request.signal.aborted)imageError=errorText(err);}
  }
  function show(){
    if(!zone)return;
    draft=zone.cells;anchor=undefined;cursor={x:0,y:0};paint='0';status='';error='';
    dialog.showModal();void frame();
  }
  function close(){if(!sending)dialog.close();}
  function reset(){releaseFrame();anchor=undefined;pointer=undefined;draft=zone?.cells??'';}
  onDestroy(()=>{reading?.abort();releaseFrame();});
  function point(event:PointerEvent):Point{
    const rect=stage.getBoundingClientRect();
    return {x:Math.max(0,Math.min(zone!.width-1,Math.floor((event.clientX-rect.left)*zone!.width/rect.width))),
      y:Math.max(0,Math.min(zone!.height-1,Math.floor((event.clientY-rect.top)*zone!.height/rect.height)))};
  }
  function apply(){
    if(!selected || !zone || !writable)return;
    const rect=selected,cells=draft.split('');
    for(let y=rect.y;y<rect.y+rect.height;y++)cells.fill(paint,y*zone.width+rect.x,y*zone.width+rect.x+rect.width);
    draft=cells.join('');anchor=undefined;status='';error='';
  }
  function down(event:PointerEvent){
    if(!writable || event.button!==0 || pointer!==undefined)return;
    stage.setPointerCapture(event.pointerId);pointer=event.pointerId;
    cursor=point(event);anchor={...cursor};
  }
  function up(event:PointerEvent){
    if(pointer!==event.pointerId)return;
    cursor=point(event);apply();pointer=undefined;
  }
  function key(event:KeyboardEvent){
    if(!zone || !writable || pointer!==undefined)return;
    const {x,y}=cursor;
    switch(event.key){
      case 'ArrowLeft':cursor={x:Math.max(0,x-1),y};break;
      case 'ArrowRight':cursor={x:Math.min(zone.width-1,x+1),y};break;
      case 'ArrowUp':cursor={x,y:Math.max(0,y-1)};break;
      case 'ArrowDown':cursor={x,y:Math.min(zone.height-1,y+1)};break;
      case ' ':case 'Enter':if(!event.repeat){if(anchor)apply();else anchor={...cursor};}break;
      default:return;
    }
    event.preventDefault();
  }
  async function save(){
    if(!zone || !detector || !writable || draft===zone.cells)return;
    sending=true;error='';status='';
    try{
      const result=await api<Outcome>({path:base+'/options/'+detector.group,method:'PUT',csrf,
        body:{operationId:operationId(),fields:{cells:draft,expectedRevision:zone.revision}}});
      if(result.outcome==='confirmed' && result.data?.zone){
        zone=result.data.zone;draft=zone!.cells;status=outcomeText(result);
      }else error=outcomeText(result);
    }catch(err){error=errorText(err);}
    finally{sending=false;}
  }
</script>

<SettingsDisclosure title={t('detection-zones')} ontoggle={onToggle}>
  {#if !access.available}<p class="muted">{t('zone-update')}</p>
  {:else if detector}
    <label>{t('zone-detector')}
      <select value={detector.group} onchange={e=>{choice=e.currentTarget.value as ZoneGroup;void refresh();}}>
        {#each access.types as type (type.group)}<option value={type.group}>{t('zone-'+type.type)}</option>{/each}
      </select>
    </label>
    <p class="muted">{t('zone-help')}</p>
    {#if busy}<p role="status">{t('loading')}</p>
    {:else if zone}<p>{t('zone-count',{count:String(excluded(zone.cells)),total:String(zone.cells.length)})}</p>
      <div class="row"><button onclick={show}>{t(detector.write?'zone-edit':'zone-view')}</button></div>
    {:else if loaded}<p class="muted">{t('zone-unavailable')}</p>{/if}
    <div class="row"><button disabled={working()} onclick={()=>void refresh()}>{t('zone-reload')}</button></div>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</SettingsDisclosure>
<dialog class="zone-dialog" bind:this={dialog} aria-labelledby={title} use:dismissOnBackdrop={close}
  onclose={reset} oncancel={e=>{if(sending)e.preventDefault();}}>
  {#if zone && detector}
    <div class="stack">
      <div class="row between"><h2 id={title}>{t(detector.write?'zone-edit':'zone-view')} · {t('zone-'+detector.type)}</h2>
        <button disabled={sending} onclick={close}>{t('close')}</button></div>
      <p>{t('zone-help')}</p>
      {#if detector.write}
        <div class="row" role="group" aria-label={t('zone-edit')}>
          <button aria-pressed={paint==='0'} disabled={!writable} onclick={()=>paint='0'}>{t('zone-exclude')}</button>
          <button aria-pressed={paint==='1'} disabled={!writable} onclick={()=>paint='1'}>{t('zone-restore')}</button>
        </div>
        <p id={instructions} class="muted">{t('zone-draw')}</p>
      {/if}
      <button type="button" class="zone-stage" bind:this={stage} aria-label={t('zone-stage')} aria-describedby={detector.write?instructions:undefined}
        style:aspect-ratio={src?undefined:zone.width+' / '+zone.height}
        onpointerdown={down} onpointermove={e=>{if(pointer===e.pointerId)cursor=point(e);}} onpointerup={up}
        onlostpointercapture={()=>{pointer=undefined;anchor=undefined;}} onkeydown={key}>
        {#if src}<img {src} alt="" draggable="false"/>{/if}
        <svg viewBox={'0 0 '+zone.width+' '+zone.height} preserveAspectRatio="none" aria-hidden="true">
          <path d={shaded} class="excluded"/>
          {#if selected}<rect {...selected} class="selection"/>{/if}
          <rect x={cursor.x} y={cursor.y} width="1" height="1" class="cell"/>
        </svg>
      </button>
      {#if imageError}<p role="status" class="muted">{imageError}</p>{/if}
      <div class="row between">
        <span>{t('zone-count',{count:String(excluded(draft)),total:String(draft.length)})}</span>
        <span class="muted" aria-live="polite">{t('zone-cell',{x:String(cursor.x+1),y:String(cursor.y+1)})}</span>
      </div>
      <div class="row">
        {#if camera.capabilities.mediaAllowed}<button disabled={sending} onclick={()=>void frame(true)}>{t('mask-refresh-frame')}</button>{/if}
        {#if detector.write}<button class="primary" disabled={!writable || draft===zone.cells || !!anchor} onclick={save}>{t('zone-save')}</button>{/if}
      </div>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      {#if status}<p role="status">{status}</p>{/if}
    </div>
  {/if}
</dialog>
<style>
  .zone-dialog{width:min(58rem,96vw);max-height:94dvh;overflow:auto}
  .zone-stage{position:relative;display:block;width:100%;padding:0;border:1px solid var(--border);background:#16191b;overflow:hidden;touch-action:none;user-select:none;cursor:crosshair}
  .zone-stage img{display:block;width:100%;height:auto;pointer-events:none}
  .zone-stage svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
  .excluded{fill:#fb8639;fill-opacity:.6}
  .selection,.cell{fill:transparent;stroke:white;stroke-width:2;vector-effect:non-scaling-stroke}
  .selection{fill:#ffebad;fill-opacity:.3}
  .cell{display:none}.zone-stage:focus-visible .cell{display:block}
</style>
