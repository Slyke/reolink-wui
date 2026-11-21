<script lang="ts">
  import { onDestroy } from 'svelte';
  import { api, errorText, fetchPreview, operationId, outcomeText, t, type Outcome } from './api.js';
  import { dismissOnBackdrop } from './dialog.js';
  import { useWorkspace } from './workspace.js';
  import type { Camera } from './models.js';
  import type { OptionView } from '../../shared/device-options.js';
  import { maskWidth,maskHeight,sameAreas,type MaskArea } from '../../shared/privacy-masks.js';

  let {base,csrf,camera,online,view,onupdate}:{base:string;csrf:string;camera:Camera;online:boolean;view:OptionView;onupdate:(v:OptionView)=>void}=$props();
  const workspace=useWorkspace(),title=$props.id();
  let dialog:HTMLDialogElement;
  let stage=$state<HTMLButtonElement>(null!);
  let open=$state(false),busy=$state(false),loading=$state(false),src=$state(''),error=$state(''),imageError=$state(''),status=$state('');
  let drafts=$state<MaskArea[]>([]), selected=$state<number>(),enabled=$state(false),revision=$state(''),limit=$state(0);
  let original:MaskArea[]=[], initialEnabled=false,controller:AbortController|undefined;
  let start=$state<{id:number;x:number;y:number}>(), drawing=$state<MaskArea>();
  const chosen=$derived(drafts.find(a=>a.id===selected));
  const dirty=$derived(!sameAreas(drafts,original) || enabled!==initialEnabled);
  const nextId=()=>Array.from({length:8},(_,i)=>i).find(n=>!drafts.some(r=>r.id===n));
  function clearImage(){if(src)URL.revokeObjectURL(src);src='';}
  async function frame(refresh=false){
    controller?.abort();clearImage();imageError='';loading=false;
    if(!camera.capabilities.mediaAllowed){imageError=t('mask-frame-permission');return;}
    const cached=workspace.lastFrames.get(camera.id);
    if(cached && !refresh){src=URL.createObjectURL(cached);return;}
    const request=new AbortController();controller=request;loading=true;
    try{
      const readFrame=(fresh:boolean)=>fetchPreview({path:base+'/preview'+(fresh?'?refresh=true':''),signal:request.signal});
      const response=await readFrame(refresh).catch(reason=>{
        if(refresh || !camera.capabilities.bridgePreview || request.signal.aborted)throw reason;
        return readFrame(true);
      });
      if(!response.image)throw Error();
      if(request.signal.aborted)return;
      workspace.lastFrames.set(camera.id,response.image);src=URL.createObjectURL(response.image);
    }catch(err){if(!request.signal.aborted){imageError=errorText(err);if(cached)src=URL.createObjectURL(cached);}}
    finally{if(controller===request)loading=false;}
  }
  function reset(v:OptionView){
    const masks=v.privacyMasks;if(!masks)return;
    original=masks.areas.map(a=>({...a}));drafts=original.map(a=>({...a}));limit=masks.maxAreas;
    revision=masks.revision;initialEnabled=enabled=v.fields.maskEnabled.value===true;selected=drafts[0]?.id;
  }
  function show(){reset(view);error='';status='';open=true;dialog.showModal();void frame();}
  function close(){controller?.abort();clearImage();start=undefined;drawing=undefined;open=false;}
  onDestroy(()=>{controller?.abort();clearImage();});
  function add(a:MaskArea){
    if(drafts.length>=limit)return;
    if(!drafts.length)enabled=true;
    drafts=[...drafts,a];selected=a.id;status='';error='';
  }
  function addCentered(){const id=nextId();if(id!==undefined)add({id,x:384,y:288,width:256,height:192});}
  function remove(){
    drafts=drafts.filter(a=>a.id!==selected);selected=drafts[0]?.id;if(!drafts.length)enabled=false;status='';
  }
  function point(e:PointerEvent){
    const rect=stage.getBoundingClientRect();
    return {x:Math.max(0,Math.min(maskWidth,Math.round((e.clientX-rect.left)*maskWidth/rect.width))),
      y:Math.max(0,Math.min(maskHeight,Math.round((e.clientY-rect.top)*maskHeight/rect.height)))};
  }
  function begin(e:PointerEvent){
    if(!e.isPrimary || e.button!==0 || busy || !src)return;
    e.preventDefault();stage.setPointerCapture(e.pointerId);start={id:e.pointerId,...point(e)};drawing=undefined;
  }
  function move(e:PointerEvent){
    if(!start || e.pointerId!==start.id)return;
    const p=point(e),id=nextId();
    if(id!==undefined && drafts.length<limit)drawing={id,x:Math.min(start.x,p.x),y:Math.min(start.y,p.y),width:Math.abs(start.x-p.x),height:Math.abs(start.y-p.y)};
  }
  function finish(e:PointerEvent){
    if(!start || e.pointerId!==start.id)return;
    move(e);
    if(drawing && drawing.width>=2 && drawing.height>=2)add(drawing);
    else {const p=point(e);selected=drafts.findLast(r=>p.x>=r.x && p.x<=r.x+r.width && p.y>=r.y && p.y<=r.y+r.height)?.id;}
    start=undefined;drawing=undefined;
  }
  const dimensions=['x','y','width','height'] as const;
  function adjust(key:typeof dimensions[number],percent:number){
    if(!chosen || !Number.isFinite(percent))return;
    const size=key==='x'||key==='width'?maskWidth:maskHeight;
    const max={x:maskWidth-chosen.width,y:maskHeight-chosen.height,width:maskWidth-chosen.x,height:maskHeight-chosen.y}[key];
    const value=Math.max(key==='width'||key==='height'?1:0,Math.min(max,Math.round(percent*size/100)));
    drafts=drafts.map(a=>a.id===selected?{...a,[key]:value}:a);status='';
  }
  async function reload(){
    busy=true;error='';status='';
    try{const updated=await api<OptionView>({path:base+'/options/privacy'});if(!updated.privacyMasks){error=t('device-options-empty');return;}reset(updated);onupdate(updated);}
    catch(err){error=errorText(err);}finally{busy=false;}
  }
  async function save(){
    if(!dirty || busy || !online)return;
    busy=true;error='';status='';
    try{
      const result=await api<Outcome>({path:base+'/options/privacy',method:'PUT',csrf,body:{operationId:operationId(),fields:{maskAreas:drafts,expectedRevision:revision,maskEnabled:enabled}}});
      if(result.outcome==='confirmed'){
        const updated:OptionView=result.data??await api({path:base+'/options/privacy'});
        reset(updated);onupdate(updated);status=outcomeText(result);
      }else error=outcomeText(result);
    }catch(err){error=errorText(err);}finally{busy=false;}
  }
</script>
<div class="row"><button type="button" aria-haspopup="dialog" disabled={!online} onclick={show}>{t('mask-edit')}</button></div>
<dialog bind:this={dialog} class="media-dialog mask-dialog" use:dismissOnBackdrop aria-labelledby={title} onclose={close}>
  {#if open}
    <div class="stack">
      <div class="row between panel-title"><h2 id={title}>{t('mask-edit')}</h2><form method="dialog"><button>{t('close')}</button></form></div>
      <p class="muted">{t('mask-draw-help')}</p>
      {#if src}
        <div class="mask-stage-wrap"><button bind:this={stage} type="button" class="mask-stage" aria-label={t('mask-draw')}
          onpointerdown={begin} onpointermove={move} onpointerup={finish} onpointercancel={()=>{start=undefined;drawing=undefined;}}
          onlostpointercapture={()=>{start=undefined;drawing=undefined;}}>
          <img {src} alt={t('mask-image')} draggable="false"/>
          <svg viewBox={'0 0 '+maskWidth+' '+maskHeight} preserveAspectRatio="none" aria-hidden="true">
            {#each drafts as r (r.id)}<rect x={r.x} y={r.y} width={r.width} height={r.height} class:chosen={selected===r.id}/>{/each}
            {#if drawing}<rect class="chosen" x={drawing.x} y={drawing.y} width={drawing.width} height={drawing.height}/>{/if}
          </svg>
        </button></div>
      {:else if loading}<p role="status">{t('loading')}</p>{/if}
      {#if imageError}<p class="muted" role="status">{imageError}</p>{/if}
      <div class="row">
        <button type="button" disabled={busy || drafts.length>=limit} onclick={addCentered}>{t('mask-add')}</button>
        {#if drafts.length}
          <select aria-label={t('mask-select')} bind:value={selected}>{#each drafts as r (r.id)}<option value={r.id}>{t('mask-number',{number:r.id+1})}</option>{/each}</select>
          <button type="button" disabled={busy || selected===undefined} onclick={remove}>{t('mask-remove')}</button>
        {/if}
        {#if camera.capabilities.mediaAllowed}<button type="button" onclick={()=>frame(true)} disabled={loading}>{t('mask-refresh-frame')}</button>{/if}
      </div>
      {#if chosen}<div class="form-grid">
        {#each dimensions as key}<label>{t('mask-'+key)}<input type="number" min="0" max="100" step="0.1" disabled={busy}
          value={Number((100*chosen[key]/(key==='x'||key==='width'?maskWidth:maskHeight)).toFixed(1))}
          onchange={e=>adjust(key,e.currentTarget.valueAsNumber)}/></label>{/each}
      </div>{/if}
      <label class="check"><input type="checkbox" bind:checked={enabled} disabled={busy || !drafts.length}/>{t('device-field-maskEnabled')}</label>
      <div class="row"><button class="primary" type="button" onclick={save} disabled={!dirty || busy || !online}>{t('mask-save')}</button>
        <button type="button" onclick={reload} disabled={busy}>{t('mask-reload')}</button></div>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      {#if status}<p role="status">{status}</p>{/if}
    </div>
  {/if}
</dialog>
<style>
  .mask-dialog{width:min(68rem,96vw);max-height:92dvh;overflow:auto;box-sizing:border-box}
  .mask-stage-wrap{display:flex;justify-content:center;min-width:0}
  .mask-stage{display:block;position:relative;max-width:100%;border:0;padding:0;min-width:0;min-height:0;line-height:0;box-shadow:none;background:transparent;cursor:crosshair;touch-action:none;user-select:none}
  .mask-stage img{display:block;max-width:100%;max-height:53dvh;width:auto;height:auto;pointer-events:none}
  .mask-stage svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
  .mask-stage rect{fill:#000;fill-opacity:.78;stroke:#fff;stroke-width:2;vector-effect:non-scaling-stroke}
  .mask-stage rect.chosen{stroke:#ffd34d}
</style>
