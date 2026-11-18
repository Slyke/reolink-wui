<script lang="ts">
  import type { BridgeConnections } from '../../shared/bridges.js';
  import { t } from './api.js';
  import { useAdministration } from './workspace.js';

  let { configuration, onsaved, oncancel }: {
    configuration?: BridgeConnections; onsaved: (id: string) => void; oncancel?: () => void
  } = $props();
  const initial = () => configuration;
  const admin = useAdministration();
  let id = $state(initial()?.id ?? ''), label = $state(initial()?.label ?? '');
  let cameraIds = $state(initial()?.cameraIds.join(', ') ?? '');
  let commands = $state<'http' | 'mqtt' | 'none'>(initial() ? initial()?.commands ?? 'none' : 'http');
  let httpEnabled = $state(initial() ? Boolean(initial()?.http) : true);
  let wsEnabled = $state(Boolean(initial()?.ws)), mqttEnabled = $state(Boolean(initial()?.mqtt));
  let httpUrl = $state(initial()?.http?.url ?? ''), httpToken = $state(''), adminToken = $state('');
  let httpCa = $state(initial()?.http?.ca ?? ''), relay = $state(initial()?.http?.relay ?? true), clearAdmin = $state(false);
  let wsUrl = $state(initial()?.ws?.url ?? ''), wsToken = $state(''), wsCa = $state(initial()?.ws?.ca ?? '');
  let mqttUrl = $state(initial()?.mqtt?.url ?? ''), baseTopic = $state(initial()?.mqtt?.baseTopic ?? 'cameras');
  let mqttIds = $state(initial()?.mqtt?.cameraIds?.join(', ') ?? ''), username = $state(initial()?.mqtt?.username ?? '');
  let password = $state(''), clearPassword = $state(false), mqttCa = $state(initial()?.mqtt?.ca ?? '');
  let partialTrust = $state(initial()?.mqtt?.allowPartialTrustChain ?? false), capture = $state(Boolean(initial()?.capture));
  const initialDestinations = () => Object.entries(initial()?.callbacks ?? {}).map(([name,url]) => ({name,url}));
  let destinations = $state(initialDestinations());
  const duplicateDestinations = $derived(new Set(destinations.map(item => item.name).filter(Boolean)).size < destinations.filter(item => item.name).length);
  const ids = (text: string) => text.split(/[\s,]+/).filter(Boolean);
  $effect(() => {
    if (commands === 'http' && !httpEnabled) commands = mqttEnabled ? 'mqtt' : 'none';
    if (commands === 'mqtt' && !mqttEnabled) commands = httpEnabled ? 'http' : 'none';
  });
  const save = async () => {
    const connection = {
      id, label, cameraIds: ids(cameraIds),
      ...(commands !== 'none' ? { commands } : {}),
      ...(mqttEnabled && capture ? { capture: 'mqtt' } : {}),
      ...(httpEnabled ? { http: {
        url: httpUrl, relay, ...(httpCa.trim() ? { ca: httpCa.trim() } : {}),
        ...(httpToken ? { token: httpToken } : {}),
        ...(clearAdmin || adminToken ? { adminToken: clearAdmin ? '' : adminToken } : {})
      } } : {}),
      ...(wsEnabled ? { ws: {
        url: wsUrl, ...(wsCa.trim() ? { ca: wsCa.trim() } : {}), ...(wsToken ? { token: wsToken } : {})
      } } : {}),
      ...(mqttEnabled ? { mqtt: {
        url: mqttUrl, baseTopic, ...(mqttIds.trim() ? { cameraIds: ids(mqttIds) } : {}),
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(!username.trim() || clearPassword || password ? { password: !username.trim() || clearPassword ? '' : password } : {}),
        ...(mqttCa.trim() ? { ca: mqttCa.trim() } : {}), allowPartialTrustChain: partialTrust
      } } : {}),
      ...(httpEnabled && destinations.length ? { callbacks: Object.fromEntries(destinations.map(item => [item.name,item.url])) } : {})
    };
    if (await admin.mutate({
      suffix: configuration ? '/bridges/' + configuration.id : '/bridges',
      method: configuration ? 'PUT' : 'POST', body: { configuration: connection }
    })) onsaved(id);
  };
</script>

<form class="stack" aria-label={t('bridge-connections-form')} onsubmit={event => { event.preventDefault(); void save(); }}>
  <div class="form-grid">
    <label>{t('bridge-id')}<input bind:value={id} pattern="[A-Za-z0-9_-]+" maxlength="64" required readonly={Boolean(configuration)} disabled={admin.busy()} /></label>
    <label>{t('bridge-label')}<input bind:value={label} maxlength="80" required disabled={admin.busy()} /></label>
  </div>
  <label>{t('bridge-camera-ids')}<input bind:value={cameraIds} disabled={admin.busy()} /></label>
  <p class="muted">{t('bridge-camera-ids-hint')}</p>
  <fieldset class="stack">
    <legend>{t('bridge-http')}</legend>
    <label class="check"><input type="checkbox" bind:checked={httpEnabled} disabled={admin.busy()} />{t('bridge-enable-http')}</label>
    {#if httpEnabled}
      <label>{t('bridge-http-url')}<input type="url" bind:value={httpUrl} required disabled={admin.busy()} /></label>
      <label>{t('bridge-http-token')}<input type="password" bind:value={httpToken} autocomplete="new-password"
        required={!configuration?.http?.tokenConfigured} placeholder={configuration?.http?.tokenConfigured ? t('secret-saved') : ''} disabled={admin.busy()} /></label>
      <label>{t('bridge-admin-token')}<input type="password" bind:value={adminToken} autocomplete="new-password"
        placeholder={configuration?.http?.adminTokenConfigured ? t('secret-saved') : ''} disabled={admin.busy() || clearAdmin} /></label>
      {#if configuration?.http?.adminTokenConfigured}<label class="check"><input type="checkbox" bind:checked={clearAdmin} disabled={admin.busy()} />{t('bridge-clear-admin')}</label>{/if}
      <label class="check"><input type="checkbox" bind:checked={relay} disabled={admin.busy()} />{t('bridge-enable-relay')}</label>
      <details><summary>{t('connection-ca')}</summary><label>{t('connection-ca')}<textarea rows="5" bind:value={httpCa} disabled={admin.busy()}></textarea></label></details>
    {/if}
  </fieldset>
  <fieldset class="stack">
    <legend>{t('event-source-ws')}</legend>
    <label class="check"><input type="checkbox" bind:checked={wsEnabled} disabled={admin.busy()} />{t('bridge-custom-ws')}</label>
    {#if wsEnabled}
      <label>{t('bridge-ws-url')}<input type="url" bind:value={wsUrl} required disabled={admin.busy()} /></label>
      <label>{t('bridge-ws-token')}<input type="password" bind:value={wsToken} autocomplete="new-password"
        required={!configuration?.ws?.tokenConfigured} placeholder={configuration?.ws?.tokenConfigured ? t('secret-saved') : ''} disabled={admin.busy()} /></label>
      <details><summary>{t('connection-ca')}</summary><label>{t('connection-ca')}<textarea rows="5" bind:value={wsCa} disabled={admin.busy()}></textarea></label></details>
    {:else}<p class="muted">{t('bridge-ws-default')}</p>{/if}
  </fieldset>
  <fieldset class="stack">
    <legend>{t('event-source-mqtt')}</legend>
    <label class="check"><input type="checkbox" bind:checked={mqttEnabled} disabled={admin.busy()} />{t('bridge-enable-mqtt')}</label>
    {#if mqttEnabled}
      <div class="form-grid">
        <label>{t('bridge-mqtt-url')}<input type="url" bind:value={mqttUrl} required disabled={admin.busy()} /></label>
        <label>{t('bridge-mqtt-topic')}<input bind:value={baseTopic} required disabled={admin.busy()} /></label>
      </div>
      <label>{t('bridge-mqtt-ids')}<input bind:value={mqttIds} disabled={admin.busy()} /></label>
      <div class="form-grid">
        <label>{t('username')}<input bind:value={username} autocomplete="off" disabled={admin.busy()} /></label>
        <label>{t('password')}<input type="password" bind:value={password} autocomplete="new-password"
          placeholder={configuration?.mqtt?.passwordConfigured ? t('secret-saved') : ''} disabled={admin.busy() || clearPassword} /></label>
      </div>
      {#if configuration?.mqtt?.passwordConfigured}<label class="check"><input type="checkbox" bind:checked={clearPassword} disabled={admin.busy()} />{t('secret-clear-password')}</label>{/if}
      <label class="check"><input type="checkbox" bind:checked={capture} disabled={admin.busy()} />{t('bridge-mqtt-capture')}</label>
      <details>
        <summary>{t('connection-ca')}</summary>
        <label>{t('connection-ca')}<textarea rows="5" bind:value={mqttCa} disabled={admin.busy()}></textarea></label>
        <label class="check"><input type="checkbox" bind:checked={partialTrust} disabled={admin.busy()} />{t('bridge-partial-trust')}</label>
      </details>
    {/if}
  </fieldset>
  <label>{t('bridge-command-transport')}
    <select bind:value={commands} disabled={admin.busy()}>
      <option value="none">{t('disabled')}</option>
      {#if httpEnabled}<option value="http">{t('bridge-http')}</option>{/if}
      {#if mqttEnabled}<option value="mqtt">{t('event-source-mqtt')}</option>{/if}
    </select>
  </label>
  {#if httpEnabled}
    <fieldset class="stack">
      <legend>{t('bridge-callback-destinations')}</legend>
      <p class="muted">{t('bridge-callback-destinations-hint')}</p>
      {#each destinations as destination, index}
        <div class="row">
          <label>{t('bridge-destination-name')}<input bind:value={destination.name} pattern="[A-Za-z0-9_-]+" required disabled={admin.busy()} /></label>
          <label>{t('bridge-destination-url')}<input type="url" bind:value={destination.url} required disabled={admin.busy()} /></label>
          <button type="button" disabled={admin.busy()} onclick={() => destinations = destinations.filter((_,i) => i !== index)}>{t('remove')}</button>
        </div>
      {/each}
      {#if duplicateDestinations}<p class="error">{t('bridge-destination-duplicate')}</p>{/if}
      <div class="row"><button type="button" disabled={admin.busy()} onclick={() => destinations = [...destinations,{name:'',url:''}]}>{t('bridge-add-destination')}</button></div>
    </fieldset>
  {/if}
  <div class="row">
    <button class="primary" disabled={admin.busy() || duplicateDestinations || (!httpEnabled && !wsEnabled && !mqttEnabled)}>{t(configuration ? 'bridge-save-connections' : 'bridge-add')}</button>
    {#if oncancel}<button type="button" disabled={admin.busy()} onclick={oncancel}>{t('cancel')}</button>{/if}
  </div>
</form>
