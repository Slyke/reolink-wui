<script lang="ts">
  import { t } from './api.js';
  import { dismissOnBackdrop } from './dialog.js';
  import type { BridgeSummary } from './models.js';
  import { useAdministration } from './workspace.js';

  let {bridge}:{bridge:BridgeSummary} = $props();
  const admin = useAdministration(), title = $props.id();
  let dialog:HTMLDialogElement;
  let target = $state<{id:string;label:string}>(), exitCode = $state<number|undefined>(0);
  let reason = $state(''), message = $state(''), sending = $state(false);
  const valid = $derived(exitCode !== undefined && Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255);
  function show() {
    target = {id:bridge.id,label:bridge.label};
    exitCode = 0; reason = ''; message = '';
    dialog.showModal();
  }
  function close() { if (!sending) dialog.close(); }
  async function submit() {
    if (!target || !valid || sending || admin.busy()) return;
    const {id,label} = target;
    sending = true;
    try {
      const ok = await admin.mutate({suffix:'/bridges/'+id+'/restart',announce:false,
        body:{confirmBridge:id,exitCode,...(reason.trim() ? {reason} : {})}});
      if (ok) message = t('bridge-restart-accepted',{name:label,id});
    } finally { sending = false; dialog.close(); }
  }
</script>

<button type="button" aria-haspopup="dialog" disabled={!bridge.restart || admin.busy()}
  aria-describedby={!bridge.restart?title+'-availability':undefined} onclick={show}>{t('bridge-restart')}</button>
{#if !bridge.restart}<small id={title+'-availability'} class="muted">{t('bridge-restart-unavailable')}</small>{/if}
{#if message}<span role="status">{message}</span>{/if}
<dialog bind:this={dialog} use:dismissOnBackdrop={close} aria-labelledby={title}
  oncancel={event=>{if(sending)event.preventDefault();}}>
  {#if target}
    <form class="stack" onsubmit={event=>{event.preventDefault();void submit();}}>
      <h2 id={title}>{t('bridge-restart-title',{name:target.label})}</h2>
      <p class="wrap">{t('bridge-restart-target',{id:target.id})}</p>
      <p>{t('bridge-restart-effect')}</p>
      <label>{t('bridge-restart-reason')}<textarea rows="2" maxlength="512" bind:value={reason} disabled={sending}></textarea></label>
      <label>{t('bridge-restart-code')}<input type="number" min="0" max="255" step="1" required bind:value={exitCode} disabled={sending}/></label>
      <div class="row"><button type="button" onclick={close} disabled={sending}>{t('cancel')}</button>
        <button class="danger" disabled={!valid || sending || admin.busy()}>{t('bridge-restart')}</button></div>
    </form>
  {/if}
</dialog>
