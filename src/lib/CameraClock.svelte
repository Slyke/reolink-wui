<script lang="ts">
  import SettingsDisclosure from './SettingsDisclosure.svelte';
  import { api, errorText, operationId, outcomeText, t, type Outcome } from './api.js';
  import { formatLocalTimestamp } from './dates.js';
  import { cameraTime } from '../../shared/clock.js';

  let {base,csrf,access}: {base:string; csrf:string; access:{read:boolean; write:boolean; available:boolean}}=$props();
  let expanded=$state(false), busy=$state(false), saved=$state<string|null>(), day=$state(''), time=$state('');
  let error=$state(''), message=$state('');
  const manual=$derived(day+'T'+time);
  function apply(value:string) {saved=value; [day,time]=value.split('T');}
  export function working(){return busy;}
  export async function refresh() {
    if (!expanded || !access.available || !access.read || busy) return;
    busy=true; error=''; message='';
    try {
      const result=await api<{cameraTime:string|null}>({path:base+'/clock'});
      if (result.cameraTime) apply(result.cameraTime); else saved=null;
    } catch (err) {error=errorText(err);}
    finally {busy=false;}
  }
  async function set(value:string) {
    if (!access.write || !access.available || busy || !cameraTime.safeParse(value).success) return;
    busy=true;error='';message='';
    try {
      const result=await api<Outcome>({path:base+'/clock',method:'PUT',csrf,body:{operationId:operationId(),cameraTime:value}});
      if (result.outcome==='confirmed') {apply(result.data.cameraTime); message=outcomeText(result);}
      else error=outcomeText(result);
    } catch(err){error=errorText(err);}
    finally{busy=false;}
  }
</script>

<SettingsDisclosure title={t('camera-clock')} ontoggle={show=>{expanded=show;if(show)void refresh();}}>
  {#if expanded}
    {#if !access.available}<p class="muted">{t('clock-bridge-required')}</p>
    {:else if saved===null}<p class="muted">{t('clock-unsupported')}</p>
    {:else}
      {#if saved}<p>{t('clock-last-read')} · <time datetime={saved}>{saved.replace('T',' ')}</time></p>{/if}
      {#if access.write && (saved || !access.read)}
        <div class="row"><button disabled={busy} onclick={()=>set(formatLocalTimestamp(Date.now()).replace(' ','T'))}>{t('clock-sync')}</button></div>
        <form class="row network-rtsp-actions" onsubmit={event=>{event.preventDefault();void set(manual);}}>
          <label>{t('clock-date')}<input type="date" bind:value={day} required disabled={busy}/></label>
          <label>{t('clock-time')}<input type="text" placeholder="HH:mm:ss" bind:value={time} maxlength="8" required disabled={busy}/></label>
          <button class="primary" disabled={busy || !cameraTime.safeParse(manual).success}>{t('clock-set')}</button>
        </form>
      {/if}
    {/if}
    {#if access.available && access.read}<div class="row"><button disabled={busy} onclick={refresh}>{t('clock-read')}</button></div>{/if}
    {#if busy}<p role="status">{t('loading')}</p>{:else if message}<p role="status">{message}</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  {/if}
</SettingsDisclosure>
