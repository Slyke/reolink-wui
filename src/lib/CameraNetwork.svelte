<script lang="ts">
  import type { CameraNetwork } from '../../shared/network.js';
  import { validWifiName, validWifiPassword } from '../../shared/network.js';
  import { api, errorText, operationId, outcomeText, t, type Outcome } from './api.js';
  import SettingsDisclosure from './SettingsDisclosure.svelte';

  let {base, csrf, access}: {base: string; csrf: string; access: {read: boolean; write: boolean; available: boolean}} = $props();
  const listId = $props.id();
  let network = $state<CameraNetwork>(), busy = $state(false), error = $state(''), message = $state('');
  let ssid = $state(''), password = $state(''), openNetwork = $state(false), expanded = $state(false);
  const canEdit = $derived(access.available && access.write && (!access.read || network?.wifi?.configurable === true));
  const valid = $derived(validWifiName(ssid) && validWifiPassword(password,openNetwork));

  async function read() {
    error = '';
    const next = await api<CameraNetwork>({path:base+'/network'});
    network = next;
    ssid = next.wifi?.ssid ?? '';
  }
  export async function refresh() {
    if (!expanded || !access.available || !access.read || busy) return;
    busy = true; password = ''; openNetwork = false; message = '';
    try { await read(); } catch (err) { network = undefined; error = errorText(err); } finally { busy = false; }
  }
  export function working() { return busy; }
  function toggle(show: boolean) {
    expanded = show;
    if (show && !network) void refresh();
    if (!show) password = '';
  }
  async function save() {
    if (!canEdit || busy || !valid || !confirm(t('network-confirm', {name:ssid}))) return;
    busy=true; error=''; message='';
    try {
      const result=await api<Outcome>({path:base+'/network',method:'PUT',csrf,body:{operationId:operationId(),ssid,password,open:openNetwork,confirmation:true}});
      message = result.outcome === 'confirmed' ? t('network-saved') : result.outcome === 'unverified' ? t(result.data?.ssidVerified ? 'network-ssid-saved' : 'network-unverified') : '';
      if (!message) error = outcomeText(result);
      if ((result.outcome === 'confirmed' || result.data?.ssidVerified) && network?.wifi) network = {...network, wifi: {...network.wifi, ssid}};
    } catch (err) { error=errorText(err); }
    finally {password='';busy=false;}
  }
</script>

<SettingsDisclosure title={t('camera-network')} ontoggle={toggle}>
  {#if !access.available}
    <p class="muted">{t('network-bridge-update')}</p>
  {:else}
    {#if network?.link}
      <dl class="network-facts">
        {#if network.link.address}<dt>{t('network-wired-address')}</dt><dd>{network.link.address}</dd>{/if}
        {#if network.link.netmask}<dt>{t('network-netmask')}</dt><dd>{network.link.netmask}</dd>{/if}
        {#if network.link.gateway}<dt>{t('network-gateway')}</dt><dd>{network.link.gateway}</dd>{/if}
        {#if network.link.dhcp != null}<dt>{t('network-addressing')}</dt><dd>{network.link.dhcp ? 'DHCP' : t('network-static')}</dd>{/if}
      </dl>
    {/if}
    {#if network?.wifi?.ssid}<p>{t('network-current-ssid', {name:network.wifi.ssid})}</p>{/if}
    {#if canEdit}
      <form class="stack" onsubmit={event=>{event.preventDefault();void save();}}>
        <p class="muted">{t('network-wired-help')}</p>
        <div class="form-grid">
          <label>{t('wifi-ssid')}<input list={listId} disabled={busy} autocomplete="off" bind:value={ssid} required /></label>
          {#if !openNetwork}<label>{t('wifi-password')}<input type="password" autocomplete="new-password" disabled={busy} bind:value={password} required /></label>{/if}
        </div>
        <datalist id={listId}>{#each network?.wifi?.nearby ?? [] as name}<option value={name}></option>{/each}</datalist>
        <label class="row"><input type="checkbox" disabled={busy} bind:checked={openNetwork} onchange={()=>password=''} />{t('network-open')}</label>
        <div class="row"><button class="primary" disabled={busy || !valid}>{t('network-save')}</button></div>
      </form>
    {:else if network && !network.wifi?.configurable}
      <p class="muted">{t('network-no-wifi')}</p>
    {/if}
    {#if access.read}<div class="row"><button disabled={busy} onclick={refresh}>{t('network-reload')}</button></div>{/if}
    {#if busy}<p role="status">{t('loading')}</p>{/if}
    {#if message}<p role="status">{message}</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  {/if}
</SettingsDisclosure>
