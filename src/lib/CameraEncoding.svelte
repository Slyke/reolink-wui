<script lang="ts">
  import SettingsDisclosure from './SettingsDisclosure.svelte';
  import { api, errorText, operationId, outcomeText, t, type Outcome } from './api.js';
  import type { CameraEncoding, EncoderValues, StreamId } from '../../shared/encoding.js';

  let {base,csrf,access}:{base:string;csrf:string;access:{read:boolean;write:boolean;available:boolean}}=$props();
  let data=$state<CameraEncoding>(), stream=$state<StreamId>('main'), draft=$state<EncoderValues>({});
  let busy=$state(false), expanded=$state(false), error=$state(''), message=$state('');
  const profile=$derived(data?.profiles.find(p=>p.stream===stream));
  const tables=$derived((profile?.options??[]).filter(o=>o.width===draft.width && o.height===draft.height));
  const frameRates=$derived([...new Set(tables.flatMap(o=>o.fps))]);
  function ratesFor(options:CameraEncoding['profiles'][number]['options'],fps:number|undefined){
    return [...new Set(options.filter(o=>fps===undefined || !o.fps.length || o.fps.includes(fps)).flatMap(o=>o.bitrates))];
  }
  const bitrates=$derived(ratesFor(tables,draft.fps));
  const resolutions=$derived.by(()=>{
    const list=new Map<string,string>();
    for (const o of [profile?.current,...(profile?.options??[])]) if(o?.width && o.height) list.set(o.width+'x'+o.height,o.width+' × '+o.height);
    return [...list];
  });
  const delta=$derived.by(()=>{
    const change:EncoderValues={};
    if (!profile) return change;
    if (draft.width!==profile.current.width || draft.height!==profile.current.height) {
      change.width=draft.width;
      change.height=draft.height;
      if(draft.fps!==undefined && frameRates.includes(draft.fps))change.fps=draft.fps;
    }
    for(const key of ['fps','bitrate','gop'] as const) if(draft[key]!==undefined && draft[key]!==profile.current[key]) change[key]=draft[key];
    return change;
  });
  const writable=$derived(access.write && !busy);
  function selectProfile(value:StreamId) {
    stream=value;
    draft={...data?.profiles.find(p=>p.stream===stream)?.current};
    message='';
  }
  function resolution(value:string) {
    const options=(profile?.options??[]).filter(o=>o.width+'x'+o.height===value);
    if(!options.length)return;
    const {width,height}=options[0], fpsValues=options.flatMap(o=>o.fps);
    const fps=fpsValues.length?Math.max(...fpsValues):draft.fps;
    const rates=ratesFor(options,fps);
    draft={...draft,width,height,fps,bitrate:rates.includes(draft.bitrate??0)?draft.bitrate:rates[0]??draft.bitrate};
  }
  function changeRate(key:'fps'|'bitrate',value:number){
    draft[key]=value;
    if(key==='fps'){
      const rates=ratesFor(tables,value);
      if(rates.length && !rates.includes(draft.bitrate??0))draft.bitrate=rates[0];
    }
  }

  function accept(value:CameraEncoding) {
    data=value;
    selectProfile(value.profiles.some(p=>p.stream===stream)?stream:value.profiles[0]?.stream??'main');
  }
  export function working(){return busy;}
  export async function refresh(){
    if (!expanded || !access.available || !access.read || busy) return;
    busy=true;error='';message='';
    try {accept(await api<CameraEncoding>({path:base+'/encoding'}));}
    catch(err){error=errorText(err);} finally{busy=false;}
  }
  async function save(){
    if(!writable || !profile || !Object.keys(delta).length)return;
    busy=true;error='';message='';
    try {
      const result=await api<Outcome>({path:base+'/encoding',method:'PUT',csrf,body:{operationId:operationId(),stream,settings:delta}});
      if(result.outcome==='confirmed'){accept(result.data);message=outcomeText(result);}
      else error=outcomeText(result);
    } catch(err){error=errorText(err);} finally {busy=false;}
  }
</script>
<SettingsDisclosure title={t('encoding-title')} ontoggle={open=>{expanded=open;if(open)void refresh();}}>
  {#if expanded}
    {#if !access.available}<p class="muted">{t('encoding-bridge-required')}</p>
    {:else if !access.read}<p class="muted">{t('encoding-read-required')}</p>
    {:else if profile}
      <label>{t('encoding-stream')}
        <select aria-label={t('encoding-stream')} value={stream} disabled={busy} onchange={e=>selectProfile(e.currentTarget.value as StreamId)}>
          {#each data?.profiles??[] as p}<option value={p.stream}>{t(p.stream==='main'?'primary':p.stream==='sub'?'secondary':'encoding-third')}</option>{/each}
        </select>
      </label>
      <div class="form-grid">
        {#if resolutions.length}
          <label>{t('encoding-resolution')}<select aria-label={t('encoding-resolution')} value={draft.width+'x'+draft.height}
            disabled={!writable || resolutions.length<2} onchange={e=>resolution(e.currentTarget.value)}>
            {#each resolutions as [id,name]}<option value={id}>{name}</option>{/each}
          </select></label>
        {/if}
        {#each ['fps','bitrate'] as key}
          {@const field=key==='fps'?'fps':'bitrate'}
          {@const available=field==='fps'?frameRates:bitrates}
          {#if draft[field]!==undefined}
            <label>{t('encoding-'+field)}<select aria-label={t('encoding-'+field)} value={draft[field]}
               disabled={!writable || !available.some(v=>v!==draft[field])} onchange={e=>{changeRate(field,Number(e.currentTarget.value));}}>
              {#each [...new Set([draft[field],...available])].sort((a,b)=>(b??0)-(a??0)) as n}<option value={n}>{n}</option>{/each}
            </select></label>
          {/if}
        {/each}
        {#if profile.gopRange && draft.gop!==undefined}
          <label>{t('encoding-gop')}<input type="number" step="1" min={profile.gopRange[0]} max={profile.gopRange[1]} bind:value={draft.gop} disabled={!writable || profile.gopRange[0]===profile.gopRange[1]}/></label>
        {/if}
      </div>
      {#if !profile.options.length && !profile.gopRange}
        <p class="muted">{t('encoding-fixed')}</p>
      {/if}
      {#if profile.bitrateMode || profile.encoderProfile}
        <p class="muted">{[profile.bitrateMode?.toUpperCase(),profile.encoderProfile && t('encoding-profile',{profile:profile.encoderProfile})].filter(Boolean).join(' · ')}</p>
      {/if}
      {#if access.write}<div class="row"><button class="primary" disabled={!writable || !Object.keys(delta).length || (profile.gopRange && (draft.gop===undefined || !Number.isInteger(draft.gop) || draft.gop<profile.gopRange[0] || draft.gop>profile.gopRange[1]))} onclick={save}>{t('encoding-save')}</button></div>{/if}
    {:else if data}<p class="muted">{t('encoding-unsupported')}</p>{/if}
    {#if busy}<p role="status">{t('loading')}</p>{:else if message}<p role="status">{message}</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  {/if}
</SettingsDisclosure>
