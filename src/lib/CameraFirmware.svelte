<script lang="ts">
  import { onDestroy } from 'svelte';
  import { firmwareFilename, maxFirmwareBytes, type FirmwareView } from '../../shared/firmware.js';
  import { api, operationId, t, UiError, url, type Outcome } from './api.js';
  import InfoTip from './InfoTip.svelte';
  import SettingsDisclosure from './SettingsDisclosure.svelte';

  let { base, csrf, cameraName, writable }:{base:string;csrf:string;cameraName:string;writable:boolean}=$props();
  let view=$state<FirmwareView>(), file=$state<File>(), busy=$state(false), open=$state(false);
  let failure=$state(''), reference=$state(''), notice=$state(''), checking=$state(false);
  let waiting=$state(''), fileInput=$state<HTMLInputElement>(), offered=$state<boolean|null>();
  const reads=new AbortController();
  let timer:ReturnType<typeof setTimeout>, until=0;
  const settingKey=$derived('firmware-install/'+base);
  export const working=()=>busy;

  function report(err:unknown) {
    failure=t('error-'+(err instanceof UiError?err.reason:'INTERNAL'));
    reference=err instanceof UiError?err.correlation??'':'';
  }
  function schedule() {
    clearTimeout(timer);
    if (open && waiting && Date.now()<until+8000) timer=setTimeout(()=>void refresh(),Math.min(8000,Math.max(750,until-Date.now())));
  }
  export async function refresh(check=false) {
    if (!open || busy) return;
    busy=true; failure=''; checking=check;
    try {
      const previous=view;
      view=await api<FirmwareView>({path:base+'/firmware'+(check?'?check=true':''),signal:reads.signal});
      if(check) offered=view.updateAvailable;
      else if(previous?.source!==view.source) offered=undefined;
      if(waiting && view.installed!==waiting) {
        notice=t('firmware-now-installed',{version:view.installed}); waiting=''; sessionStorage.removeItem(settingKey);
      } else if (waiting && ['stopped','timeout','imgerror'].includes(view.progress?.state??'')) {
        failure=t('firmware-state-'+view.progress!.state); notice=''; waiting=''; sessionStorage.removeItem(settingKey);
      } else if (waiting && Date.now()>=until) {
        notice=t('firmware-unconfirmed'); waiting=''; sessionStorage.removeItem(settingKey);
      }
    } catch(err) {if(!reads.signal.aborted) report(err);return false;}
    finally {busy=false;checking=false;if(!reads.signal.aborted)schedule();}
  }
  function toggle(expanded:boolean) {
    open=expanded;
    clearTimeout(timer);
    if(!open)return;
    const saved=sessionStorage.getItem(settingKey);
    if(saved){try {const previous=JSON.parse(saved); if(typeof previous.installed==='string' && Number(previous.until)>Date.now()){ waiting=previous.installed;until=previous.until; }else sessionStorage.removeItem(settingKey);} catch {sessionStorage.removeItem(settingKey);}}
    void refresh();
  }
  function choose(e:Event) {
    const picked=(e.currentTarget as HTMLInputElement).files?.[0]; file=undefined;failure='';reference='';
    if(!picked)return;
    if(!firmwareFilename.safeParse(picked.name).success || picked.size===0 || picked.size>maxFirmwareBytes) {
      failure=t('firmware-file-invalid');if(fileInput)fileInput.value='';return;
    }
    file=picked;
  }
  async function install(local:boolean) {
    if (!view || busy || waiting || !writable || !view.canInstall || (local?!file:offered!==true)) return;
    const target=local?file!.name:t('firmware-camera-offer');
    if(!confirm(t('firmware-confirm',{file:target,camera:cameraName,hardware:view.hardware,installed:view.installed})))return;
    busy=true; failure=''; notice='';reference='';
    const selected=view, query=new URLSearchParams({source:view.source,confirm:'true',operationId:operationId()});
    if(local)query.set('file',file!.name);
    try {
      const response=await fetch(url(base+'/firmware')+'?'+query,{method:'POST',headers:{'x-csrf-token':csrf,
        ...(local?{'content-type':'application/octet-stream'}:{})},body:local?file:undefined});
      const result=await response.json();
      reference=result.correlationId??'';
      if(!result.id)throw new UiError(result.error??'INTERNAL',reference);
      const outcome=result as Outcome;
      if(outcome.reason!=='FIRMWARE_ACCEPTED' && outcome.outcome!=='unknown')throw new UiError(outcome.reason??'COMMAND_REJECTED',reference);
      if(outcome.outcome==='unknown')failure=t('error-OUTCOME_UNKNOWN');
      else notice=t('error-FIRMWARE_ACCEPTED');
      offered=undefined;file=undefined;if(fileInput)fileInput.value='';
      waiting=selected.installed;until=Date.now()+480000;
      sessionStorage.setItem(settingKey,JSON.stringify({installed:waiting,until}));
    } catch(err){report(err); }
    finally { busy=false;schedule(); }
  }
  onDestroy(()=>{reads.abort();clearTimeout(timer);});
</script>

<SettingsDisclosure title={t('firmware-title')} ontoggle={toggle}>
  {#if view}
    <dl class="facts">
      <dt>{t('firmware-model')}</dt><dd>{view.model}</dd>
      <dt>{t('firmware-hardware')}</dt><dd>{view.hardware}</dd>
      <dt>{t('firmware-installed')}</dt><dd>{view.installed}</dd>
      {#if view.progress && view.progress.state!=='none'}<dt>{t('firmware-progress')}</dt><dd>{t('firmware-state-'+view.progress.state)} {view.progress.percent===null?'':view.progress.percent+'%'}</dd>{/if}
    </dl>
  {/if}
  <div class="row">
    <button disabled={busy} onclick={()=>refresh(true)}>{t('firmware-check')}</button>
    {#if offered===true && writable && view?.canInstall}<button disabled={busy || !!waiting} onclick={()=>install(false)}>{t('firmware-install-offer')}</button>{/if}
    <a href="https://reolink.com/download-center/" target="_blank" rel="noreferrer">{t('firmware-download-center')}</a>
  </div>
  {#if checking}<p role="status">{t('firmware-checking')}</p>
  {:else if offered!==undefined}<p role="status">{t(offered===null?'firmware-check-unsupported':offered?'firmware-available':'firmware-no-offer')}</p>{/if}
  {#if writable && view?.canInstall}
    <div class="row">
      <label>{t('firmware-package')}<input type="file" accept=".pak,.paks" bind:this={fileInput} onchange={choose} disabled={busy}/></label>
      <button class="danger" disabled={!file || busy || !!waiting} onclick={()=>install(true)}>{t('firmware-install-file')}</button>
    </div>
  {:else if writable && view}<p class="muted">{t('firmware-install-unavailable')}</p>{/if}
  {#if notice || failure}<p role={failure?'alert':'status'} class:error={!!failure}>{failure||notice}
    {#if reference}<InfoTip label={t('firmware-reference')} text={reference}/>{/if}</p>{/if}
  {#if waiting}<button disabled={busy} onclick={()=>refresh()}>{t('firmware-refresh-installed')}</button>{/if}
</SettingsDisclosure>
