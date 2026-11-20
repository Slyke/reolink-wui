<script lang="ts">
  import type { RecordingSchedule } from '../../shared/access.js';
  import { api, errorText, operationId, outcomeText, t, type Outcome } from './api.js';
  import ScheduleEditor from './ScheduleEditor.svelte';
  import SettingsDisclosure from './SettingsDisclosure.svelte';

  let {base,csrf,access,online,freshSettings}:{
    base:string;csrf:string;access:{read?:boolean;write?:boolean;unavailable?:string};online:boolean;freshSettings:boolean
  }=$props();
  let expanded=$state(false), busy=$state(false), saved=$state<RecordingSchedule>();
  let error=$state(''), message=$state('');
  const path=$derived(base+'/settings/recording_schedule');

  async function readSchedule() {
    const result=await api<{values:{recording_schedule?:RecordingSchedule}}>({path:path+(online && freshSettings?'?fresh=true':'')});
    return result.values.recording_schedule;
  }
  export const working=()=>busy;
  export async function refresh() {
    if (!expanded || busy || !access.read || access.unavailable) return;
    busy=true; error=''; message='';
    try {saved=await readSchedule();}
    catch(cause) { error=errorText(cause); }
    finally {busy=false;}
  }
  function toggle(show:boolean) {
    expanded=show;
    if(show && !saved) void refresh();
  }
  async function save(fields:Record<string,unknown>) {
    if (!online || busy || !access.write) return;
    busy=true; error=''; message='';
    try {
      const result=await api<Outcome>({path,method:'PATCH',csrf,body:{operationId:operationId(),change:fields}});
      if(result.outcome==='confirmed') {
        const received=result.data?.recording_schedule as Partial<RecordingSchedule>|undefined;
        saved=saved && received ? {...saved,...received} : await readSchedule();
        message=outcomeText(result);
      } else if(result.outcome==='pending') message=outcomeText(result);
      else error=outcomeText(result);
    } catch(cause) {error=errorText(cause);}
    finally {busy=false;}
  }
</script>

<SettingsDisclosure title={t('recording_schedule')} ontoggle={toggle}>
  {#if access.unavailable}
    <p class="muted">{t('camera-setting-'+access.unavailable)}</p>
  {:else if !access.read}
    <p class="muted">{t('schedule-read-required')}</p>
  {:else if saved}
    <ScheduleEditor value={saved} writable={!!access.write} disabled={!online || busy} {save}/>
  {:else if !error && !busy}
    <p class="muted">{t('settings-not-read')}</p>
  {/if}
  {#if busy}<p role="status">{t('pending')}</p>{:else if message}<p role="status">{message}</p>{/if}
  {#if error}
    <p class="error" role="alert">{error}</p>
    {#if access.read}<div class="row"><button disabled={busy} onclick={refresh}>{t('schedule-reload')}</button></div>{/if}
  {/if}
</SettingsDisclosure>
