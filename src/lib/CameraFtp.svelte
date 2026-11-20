<script lang="ts">
  import type { FtpChanges, FtpDestination } from '../../shared/ftp.js';
  import type { OptionView } from '../../shared/device-options.js';
  import SettingsDisclosure from './SettingsDisclosure.svelte';
  import { api, errorText, operationId, outcomeText, t, type Outcome } from './api.js';

  let {base,csrf,online,available,access}:{base:string;csrf:string;online:boolean;available:boolean;access:{read:boolean;write:boolean}}=$props();
  let expanded=$state(false), busy=$state(false), supported=$state<boolean>(), view=$state<FtpDestination>();
  let draft=$state<FtpDestination['fields']>({server:'',port:21});
  let password=$state(''), clearPassword=$state(false), enabled=$state<boolean>(), savedEnabled=$state<boolean>();
  let error=$state(''), message=$state(''), taskError=$state(''), taskMessage=$state('');
  const editable=$derived(access.write && online && !busy);
  const needsPassword=$derived(!!view?.passwordStored && (draft.server!==view.fields.server || draft.port!==view.fields.port) && !password && !clearPassword);
  function accept(value:FtpDestination){
    view=value;draft={...value.fields,port:value.fields.port || 21};password='';clearPassword=false;
  }
  function changes():FtpChanges{
    if(!view)return {};
    const changed=Object.fromEntries(Object.entries(draft).filter(([k,v])=>v!==view?.fields[k as keyof typeof draft]));
    if(clearPassword || password)changed.password=clearPassword?'':password;
    return changed;
  }
  export function working(){return busy;}
  export async function refresh(){
    if(!expanded || !access.read || busy)return;
    busy=true;error='';message='';taskError='';taskMessage='';view=undefined;supported=undefined;savedEnabled=undefined;enabled=undefined;
    password='';clearPassword=false;
    try{
      if(available){
        const value=await api<({supported:true}&FtpDestination)|{supported:false}>({path:base+'/ftp'});
        supported=value.supported;
        if(!value.supported)return true;
        accept(value);
      }
      try{
        const task=await api<OptionView>({path:base+'/options/ftp'});
        const value=task.fields.ftpEnabled?.value;
        savedEnabled=enabled=typeof value==='boolean'?value:undefined;
      }catch(err){taskError=errorText(err);}
      return !taskError;
    }catch(err){error=errorText(err);return false;}
    finally{busy=false;}
  }
  function toggle(open:boolean){
    expanded=open;password='';clearPassword=false;
    if(open && !busy)void refresh();
  }
  async function saveDestination(){
    const fields=changes();
    if(!editable || !view || needsPassword || !Object.keys(fields).length)return;
    busy=true;error='';message='';password='';clearPassword=false;
    try{
      const result=await api<Outcome>({path:base+'/ftp',method:'PUT',csrf,body:{operationId:operationId(),fields}});
      if(result.outcome==='confirmed' || (result.outcome==='unverified' && result.data)){
        if(result.data)accept(result.data);
        else accept(await api<FtpDestination>({path:base+'/ftp'}));
        message=outcomeText(result,result.outcome==='unverified'?t('ftp-password-unverified'):undefined);
      }else error=outcomeText(result);
    }catch(err){error=errorText(err);}
    finally{busy=false;}
  }
  async function saveTask(){
    if(!editable || typeof enabled!=='boolean' || enabled===savedEnabled)return;
    busy=true;taskError='';taskMessage='';
    try{
      const result=await api<Outcome>({path:base+'/options/ftp',method:'PUT',csrf,body:{operationId:operationId(),fields:{ftpEnabled:enabled}}});
      if(result.outcome==='confirmed'){enabled=savedEnabled=result.data.fields.ftpEnabled.value;taskMessage=outcomeText(result);}
      else taskError=outcomeText(result);
    }catch(err){taskError=errorText(err);}
    finally{busy=false;}
  }
</script>

<SettingsDisclosure title={t('device-group-ftp')} ontoggle={toggle}>
  {#if expanded}
    {#if !access.read}<p class="muted">{t('device-read-required')}</p>
    {:else}
      {#if busy}<p role="status">{t('loading')}</p>{/if}
      {#if !available}<p class="muted">{t('ftp-bridge-update')}</p>
      {:else if supported===false}<p class="muted">{t('ftp-unsupported')}</p>{/if}
      {#if view}
        <form class="stack" onsubmit={event=>{event.preventDefault();void saveDestination();}}>
          <div class="form-grid">
            <label>{t('ftp-server')}<input bind:value={draft.server} maxlength="253" required disabled={!editable} spellcheck={false}/></label>
            <label>{t('ftp-port')}<input type="number" min="1" max="65535" step="1" required bind:value={draft.port} disabled={!editable}/></label>
            {#if draft.remoteDirectory!==undefined}<label>{t('ftp-directory')}<input bind:value={draft.remoteDirectory} maxlength="255" disabled={!editable} spellcheck={false}/></label>{/if}
            {#if draft.username!==undefined}<label>{t('ftp-username')}<input bind:value={draft.username} maxlength="255" disabled={!editable || draft.anonymous} autocomplete="off" spellcheck={false}/></label>{/if}
            {#if view.passwordStored!==undefined}
              <label>{t('ftp-password')}<input type="password" bind:value={password} maxlength={view.passwordMaxLength} disabled={!editable || clearPassword} autocomplete="new-password"
                placeholder={view.passwordStored?t('ftp-password-keep'):undefined}/></label>
            {/if}
          </div>
          <div class="row">
            {#if draft.anonymous!==undefined}<label class="check"><input type="checkbox" bind:checked={draft.anonymous} disabled={!editable}/>{t('ftp-anonymous')}</label>{/if}
            {#if draft.ftpsOnly!==undefined}<label class="check"><input type="checkbox" bind:checked={draft.ftpsOnly} disabled={!editable}/>{t('ftp-ftps')}</label>{/if}
            {#if view.passwordStored && access.write}<label class="check"><input type="checkbox" bind:checked={clearPassword} disabled={!editable}/>{t('ftp-password-clear')}</label>{/if}
          </div>
          {#if needsPassword}<p class="muted">{t('ftp-password-destination')}</p>{/if}
          {#if access.write}<div class="row"><button class="primary" disabled={!editable || needsPassword || !Object.keys(changes()).length}>{t('ftp-save')}</button></div>{/if}
        </form>
      {/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      {#if message}<p role="status">{message}</p>{/if}
      {#if savedEnabled!==undefined}
        <form class="row" onsubmit={event=>{event.preventDefault();void saveTask();}}>
          <label class="check"><input type="checkbox" bind:checked={enabled} disabled={!editable}/>{t('device-field-ftpEnabled')}</label>
          {#if access.write}<button disabled={!editable || enabled===savedEnabled}>{t('ftp-save-task')}</button>{/if}
        </form>
      {/if}
      {#if taskError}<p class="error" role="alert">{taskError}</p>{/if}
      {#if taskMessage}<p role="status">{taskMessage}</p>{/if}
      <div class="row"><button onclick={refresh} disabled={busy}>{t('ftp-reload')}</button></div>
    {/if}
  {/if}
</SettingsDisclosure>
