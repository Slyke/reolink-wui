<script lang="ts">
  import type { CameraNetwork, NetworkInterface, RtspSettings } from '../../shared/network.js';
  import { validWifiName, validWifiPassword } from '../../shared/network.js';
  import { api, errorText, operationId, outcomeText, t, type Outcome } from './api.js';
  import SettingsDisclosure from './SettingsDisclosure.svelte';

  let {base, csrf, access}: {base: string; csrf: string; access: {read: boolean; write: boolean; available: boolean; rtsp?: boolean}} = $props();
  const listId = $props.id();
  let network = $state<CameraNetwork>(), busy = $state(false), error = $state(''), message = $state('');
  let ssid = $state(''), password = $state(''), openNetwork = $state(false), expanded = $state(false);
  let rtsp = $state<RtspSettings>(), choice = $state<boolean | undefined>();
  let rtspBusy = $state(false), rtspError = $state(''), rtspMessage = $state('');
  const canEdit = $derived(access.available && access.write && (!access.read || network?.wifi?.configurable === true));
  const valid = $derived(validWifiName(ssid) && validWifiPassword(password,openNetwork));

  async function read() {
    error = '';
    const next = await api<CameraNetwork>({path:base+'/network'});
    network = next;
    ssid = next.wifi?.ssid ?? '';
  }
  export async function refresh() {
    if (!expanded || !access.available || !access.read || busy || rtspBusy) return;
    busy = true; password = ''; openNetwork = false; message = '';
    try { await Promise.all([read().catch(err => { network = undefined; error = errorText(err); }),readRtsp()]); }
    finally { busy = false; }
  }
  async function readRtsp() {
    if (!access.rtsp || !access.read) return;
    rtspError = ''; rtspMessage = '';
    try {
      rtsp = await api<RtspSettings>({path:base+'/network/rtsp'});
      choice = rtsp.supported ? rtsp.enabled : undefined;
    } catch (err) { rtsp = undefined; choice = undefined; rtspError = errorText(err); }
  }
  async function saveRtsp() {
    if (!access.write || choice === undefined || rtspBusy || busy) return;
    rtspBusy = true; rtspError = ''; rtspMessage = '';
    try {
      const value = await api<Outcome>({path:base+'/network/rtsp',method:'PUT',csrf,body:{operationId:operationId(),enabled:choice}});
      if (value.outcome === 'confirmed') {
        rtsp = {supported:true,enabled:value.data.enabled,port:value.data.port};
        rtspMessage = t('network-rtsp-saved');
      } else {
        rtspError = outcomeText(value);
        if (value.outcome === 'unknown') {rtsp=undefined;choice=undefined;}
      }
    } catch (err) {rtspError=errorText(err);rtsp=undefined;choice=undefined;}
    finally {rtspBusy=false;}
  }
  async function switchWifi(enabled:boolean) {
    if (!access.write || !network?.wifiSwitchAvailable || busy || rtspBusy || !confirm(t(enabled?'network-reconnect-confirm':'network-disconnect-confirm'))) return;
    busy=true;error='';message='';
    try {
      const result=await api<Outcome>({path:base+'/network/wifi',method:'PUT',csrf,body:{operationId:operationId(),enabled,confirmation:true}});
      if(result.outcome==='confirmed') message=outcomeText(result); else error=outcomeText(result);
      const fresh=await api<CameraNetwork>({path:base+'/network'});
      network=fresh;
    } catch(err){error=errorText(err);}
    finally{busy=false;}
  }
  export function working() { return busy || rtspBusy; }
  function toggle(show: boolean) {
    expanded = show;
    if (show) void refresh();
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

{#snippet facts(info:NetworkInterface)}
  <dl class="network-facts">
    <dt>{t('network-interface-status')}</dt><dd>{info.active ? t('network-active-link') : info.enabled===false ? t('network-disabled') : info.enabled ? t('network-enabled') : info.active===false ? t('network-standby') : '—'}</dd>
    <dt>{t('network-ip')}</dt><dd>{info.addresses.join(', ') || t('network-ip-unreported')}</dd>
    {#if info.dhcp!==null}<dt>{t('network-addressing')}</dt><dd>{info.dhcp ? 'DHCP' : t('network-static')}</dd>{/if}
    {#if info.active && network?.link?.netmask}<dt>{t('network-netmask')}</dt><dd>{network.link.netmask}</dd>{/if}
    {#if info.active && network?.link?.gateway}<dt>{t('network-gateway')}</dt><dd>{network.link.gateway}</dd>{/if}
  </dl>
{/snippet}

<SettingsDisclosure title={t('camera-network')} ontoggle={toggle}>
  {#if !access.available}
    <p class="muted">{t('network-bridge-update')}</p>
  {:else}
    {#if access.rtsp}
      <fieldset class="stack"><legend>{t('network-rtsp')}</legend>
        {#if rtsp?.supported && rtsp.port}<p>{t('network-rtsp-port',{port:String(rtsp.port)})}</p>{/if}
        {#if rtsp?.supported === false}<p class="muted">{t('network-rtsp-unsupported')}</p>
        {:else if access.write && (rtsp?.supported || !access.read)}
          <form class="row network-rtsp-actions" onsubmit={e=>{e.preventDefault();void saveRtsp();}}>
            <label>{t('network-rtsp-service')}
              <select bind:value={choice} disabled={busy || rtspBusy}>
                {#if choice === undefined}<option value={undefined} disabled>{t('choose-option')}</option>{/if}
                <option value={true}>{t('on')}</option><option value={false}>{t('off')}</option>
              </select>
            </label>
            <button class="primary" disabled={busy || rtspBusy || choice === undefined || (rtsp?.supported && choice === rtsp.enabled)}>{t('network-rtsp-save')}</button>
          </form>
        {:else if rtsp?.supported}<p>{t('network-rtsp-service')} · {t(rtsp.enabled ? 'on' : 'off')}</p>{/if}
        {#if rtspError}<p class="error" role="alert">{rtspError}</p>{/if}
        {#if rtspMessage}<p role="status">{rtspMessage}</p>{/if}
      </fieldset>
    {/if}
    {#if network?.link?.address && !network.interfaces?.wifi?.active && !network.interfaces?.ethernet?.active}
      <dl class="network-facts"><dt>{t('network-camera-ip')}</dt><dd>{network.link.address}</dd></dl>
    {/if}
    {#if network?.interfaces?.ethernet}
      <SettingsDisclosure title={t('network-ethernet')} open>
        {@render facts(network.interfaces.ethernet)}
      </SettingsDisclosure>
    {/if}
    {#if network?.interfaces?.wifi || network?.wifi || !access.read && canEdit}
      <SettingsDisclosure title={t('network-wifi')} open>
      {#if network?.interfaces?.wifi}
        {@render facts(network.interfaces.wifi)}
        {#if network.interfaces.wifi.enabled !== false}
          <dl class="network-facts">
            {#if network.wifiStatus?.associated!=null}
              <dt>{t('network-wifi-association')}</dt><dd>{network.wifiStatus.associated ? network.wifiStatus.ssid || t('network-associated') : t('network-disassociated')}</dd>
            {/if}
            {#if network.wifiSignal!=null}
              <dt>{t('network-signal')}</dt><dd>{network.wifiSignal<0 ? network.wifiSignal+' dBm' : t('network-signal-raw',{value:network.wifiSignal})}</dd>
            {:else if network.wifiStatus?.signal}
              <dt>{t('network-signal')}</dt><dd>{network.wifiStatus.signal}</dd>
            {/if}
          </dl>
        {/if}
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
      {#if access.write && network?.wifiSwitchAvailable && network.interfaces?.wifi?.enabled != null}
        {@const enabled=network.interfaces.wifi.enabled}
        <div class="row"><button type="button" disabled={busy || rtspBusy} onclick={()=>switchWifi(!enabled)}>{t(enabled?'network-disconnect':'network-reconnect')}</button></div>
      {:else if access.write && network?.interfaces?.ethernet && network?.interfaces?.wifi?.enabled!==false}
        <p class="muted">{t(network.interfaces.ethernet.active?'network-no-switch':'network-disconnect-requires-lan')}</p>
      {/if}
      </SettingsDisclosure>
    {/if}
    {#if message}<p role="status">{message}</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if access.read}<div class="row"><button disabled={busy || rtspBusy} onclick={refresh}>{t('network-reload')}</button></div>{/if}
    {#if busy}<p role="status">{t('loading')}</p>{/if}
  {/if}
</SettingsDisclosure>
