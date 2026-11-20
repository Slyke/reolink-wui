<script lang="ts">
  import SettingsDisclosure from './SettingsDisclosure.svelte';
  import { api, errorText, operationId, outcomeText, t, type Outcome } from './api.js';
  import { cameraTime, clockReading, clockOptionKeys, deviceClockZone, offsetLabel, readOffset, wallAtOffset, type ClockReading, type ClockChange, type ClockOptions, type ClockZone } from '../../shared/clock.js';

  let {base,csrf,access}: {base:string; csrf:string; access:{read:boolean; write:boolean; available:boolean}}=$props();
  let expanded=$state(false), busy=$state(false), reading=$state<ClockReading>();
  let day=$state(''), time=$state(''), error=$state(''), message=$state('');
  let zoneMode=$state('device'), fixedOffset=$state(''), deviceName=$state(''), deviceZone=$state<ClockZone>();
  const fieldId=$props.id();
  let legacyNtp=$state(false), draft=$state<ClockOptions>({});
  const changedOptions=$derived.by(()=>{
    const changes:ClockOptions={};
    for (const key of reading?.editableOptions??[]) {
      if (draft[key]!==undefined && draft[key]!==reading?.settings?.[key]) changes[key]=draft[key];
    }
    return changes;
  });
  const manual=$derived(day+'T'+time);
  const settings=$derived(reading?.settings);
  const canSyncZone=$derived(settings && settings.utcOffsetMinutes!==null && settings.daylightSavingEnabled!==null);
  const fixedMinutes=$derived(readOffset(fixedOffset));
  const selectedZone=$derived(zoneMode==='device' ? deviceZone : fixedMinutes===undefined ? undefined : {utcOffsetMinutes:fixedMinutes,daylightSaving:null});

  function apply(value:ClockReading, clearDraft=true) {
    if(clearDraft) draft={};
    reading=value;
    if (value.cameraTime) [day,time]=value.cameraTime.split('T');
    if (typeof value.settings?.ntpEnabled==='boolean') legacyNtp=value.settings.ntpEnabled;
  }
  function open(show:boolean) {
    expanded=show;
    if (!show) return;
    const now=Date.now(), offset=-new Date(now).getTimezoneOffset();
    deviceZone=deviceClockZone(now);
    deviceName=Intl.DateTimeFormat().resolvedOptions().timeZone+' (UTC'+offsetLabel(offset)+')';
    if (!fixedOffset) fixedOffset=offsetLabel(offset);
    void refresh();
  }
  export function working(){return busy;}
  export async function refresh() {
    if (!expanded || !access.available || !access.read || busy) return;
    busy=true; error=''; message='';
    try {apply(await api<ClockReading>({path:base+'/clock'}));}
    catch (err) {error=errorText(err);}
    finally {busy=false;}
  }
  async function save(change:ClockChange) {
    if (!access.write || !access.available || busy || (change.cameraTime!==undefined && !cameraTime.safeParse(change.cameraTime).success)) return;
    busy=true; error=''; message='';
    try {
      const result=await api<Outcome>({path:base+'/clock',method:'PUT',csrf,body:{operationId:operationId(),...change}});
      if (result.outcome==='confirmed') {
        const observed=clockReading.safeParse(result.data).data;
        if(observed) apply(observed,change.cameraTime===undefined);
        else if(access.read) apply(await api<ClockReading>({path:base+'/clock'}));
        message=outcomeText(result);
      } else error=outcomeText(result);
    } catch(err){error=errorText(err);}
    finally{busy=false;}
  }
  function sync() {
    if (!selectedZone || !canSyncZone) return;
    const now=Date.now(), effective=zoneMode==='device'?-new Date(now).getTimezoneOffset():selectedZone.utcOffsetMinutes;
    void save({cameraTime:wallAtOffset(now,effective),timeZone:selectedZone,ntpEnabled:!reading?.editableOptions && settings?.ntpEnabled!=null?legacyNtp:undefined});
  }
  function transitionText(rule:NonNullable<ClockZone['daylightSaving']>['start']) {
    const month=new Intl.DateTimeFormat(undefined,{month:'long',timeZone:'UTC'}).format(Date.UTC(2023,rule.month-1,1));
    const day=new Intl.DateTimeFormat(undefined,{weekday:'long',timeZone:'UTC'}).format(Date.UTC(2023,0,1+rule.weekday));
    return t('clock-seasonal-rule',{week:t('clock-week-'+rule.week),day,month,time:String(rule.hour).padStart(2,'0')+':'+String(rule.minute).padStart(2,'0')});
  }
  const switchText=(value:boolean|null)=>t(value===null?'clock-not-reported':value?'on':'off');
</script>

<SettingsDisclosure title={t('camera-clock')} ontoggle={open}>
  {#if expanded}
    {#if !access.available}<p class="muted">{t('clock-bridge-required')}</p>
    {:else if reading?.cameraTime===null}<p class="muted">{t('clock-unsupported')}</p>
    {:else}
      {#if reading?.cameraTime}
        <dl class="network-facts clock-facts">
          <dt>{t('clock-last-read')}</dt><dd><time datetime={reading.cameraTime}>{reading.cameraTime.replace('T',' ')}</time></dd>
          {#if settings}
            <dt>{t('clock-standard-offset')}</dt><dd>{settings.utcOffsetMinutes===null?t('clock-not-reported'):'UTC'+offsetLabel(settings.utcOffsetMinutes)}</dd>
            {#each clockOptionKeys as key}
              {@const label=t(key==='daylightSavingEnabled'?'clock-dst':'clock-ntp')}
              {#if access.write && reading.editableOptions?.includes(key) && settings[key]!==null}
                <dt><label for={fieldId+'-'+key}>{label}</label></dt>
                <dd><select id={fieldId+'-'+key} value={(draft[key]??settings[key])?(key==='daylightSavingEnabled'?'auto':'on'):'off'} disabled={busy}
                  onchange={event=>{draft[key]=event.currentTarget.value!=='off';}}>
                  <option value="off">{t('off')}</option><option value={key==='daylightSavingEnabled'?'auto':'on'}>{t(key==='daylightSavingEnabled'?'auto':'on')}</option>
                </select></dd>
              {:else}
                <dt>{label}</dt><dd>{key==='daylightSavingEnabled' && settings[key]===true?t('auto'):switchText(settings[key])}</dd>
              {/if}
            {/each}
          {/if}
        </dl>
        {#if settings && (draft.daylightSavingEnabled ?? settings.daylightSavingEnabled)}
          {#if settings.daylightSavingSchedule}
            {@const rule=settings.daylightSavingSchedule}
            <p class="muted">{t('clock-auto-schedule',{hours:String(rule.hours),start:transitionText(rule.start),end:transitionText(rule.end)})}</p>
          {:else}<p class="muted">{t('clock-auto-explanation')}</p>{/if}
        {/if}
        {#if access.write && reading.editableOptions?.length}
          <div class="row"><button disabled={busy || !Object.keys(changedOptions).length} onclick={()=>save(changedOptions)}>{t('clock-save-options')}</button></div>
        {:else if access.write && settings && !reading.editableOptions}
          <p class="muted">{t('clock-options-upgrade')}</p>
        {/if}
      {/if}
      {#if access.write && reading?.cameraTime && !settings}
        <p class="muted">{t('clock-update-bridge')}</p>
      {/if}
      {#if access.write && canSyncZone}
        <div class="row network-rtsp-actions">
          <label>{t('clock-sync-zone')}
            <select bind:value={zoneMode} disabled={busy}>
              <option value="device">{deviceName}</option>
              <option value="fixed">{t('clock-fixed-zone')}</option>
            </select>
          </label>
          {#if zoneMode==='fixed'}<label>{t('clock-offset')}<input type="text" placeholder="-07:00" maxlength="6" bind:value={fixedOffset} disabled={busy}/></label>{/if}
          <button disabled={busy || !selectedZone} onclick={sync}>{t('clock-sync')}</button>
        </div>
        {#if zoneMode==='device' && !deviceZone}<p class="muted">{t('clock-fixed-required')}</p>{/if}
        {#if !reading?.editableOptions && settings?.ntpEnabled!=null}<label class="check"><input type="checkbox" bind:checked={legacyNtp} disabled={busy}/>{t('clock-sync-ntp')}</label>{/if}
      {/if}
      {#if access.write && ((reading?.cameraTime && settings) || !access.read)}
        {#if settings?.ntpEnabled}<p class="muted">{t('clock-manual-ntp')}</p>{/if}
        <form class="row network-rtsp-actions" onsubmit={event=>{event.preventDefault();void save({cameraTime:manual,ntpEnabled:settings?.ntpEnabled==null?undefined:false});}}>
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

<style>
  .clock-facts { grid-template-columns: fit-content(52%) minmax(0, 1fr); align-items: center; }
  .clock-facts select { width: min(100%, 10rem); }
</style>
