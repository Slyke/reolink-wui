<script lang="ts">
  import { defaultCameraReadRetries, maxCameraReadRetries, type BridgeConnections } from '../../shared/bridges.js';
  import InfoTip from './InfoTip.svelte';
  import ConnectionTls from './ConnectionTls.svelte';
  import type { BridgeTest } from '../../shared/bridges.js';
  import { useWorkspace } from './workspace.js';
  import { api, errorText, t } from './api.js';
  import { useAdministration } from './workspace.js';

  let { configuration, onsaved, oncancel }: {
    configuration?: BridgeConnections; onsaved: (id: string) => void; oncancel?: () => void
  } = $props();
  const fieldId = $props.id();
  const initial = () => configuration;
  const admin = useAdministration();
  const workspace = useWorkspace();
  let testing = $state(false), testError = $state('');
  let testResult = $state<BridgeTest>();
  const busy = $derived(admin.busy() || testing);
  let id = $state(initial()?.id ?? 'bridge-' + crypto.randomUUID().slice(0,8)), label = $state(initial()?.label ?? '');
  let cameraIds = $state(initial()?.cameraIds.join(', ') ?? '');
  let commands = $state<'http' | 'mqtt' | 'none'>(initial() ? initial()?.commands ?? 'none' : 'http');
  const initialRetries = () => initial()?.cameraReadRetries ?? initial()?.effectiveCameraReadRetries ?? defaultCameraReadRetries;
  let readRetries = $state(initialRetries());
  let retriesEdited = $state(false);
  let httpEnabled = $state(initial() ? Boolean(initial()?.http) : true);
  let wsEnabled = $state(Boolean(initial()?.ws)), mqttEnabled = $state(Boolean(initial()?.mqtt));
  let httpUrl = $state(initial()?.http?.url ?? ''), httpToken = $state('');
  let httpCa = $state(initial()?.http?.ca ?? ''), relay = $state(initial()?.http?.relay ?? true);
  let wsUrl = $state(initial()?.ws?.url ?? ''), wsToken = $state(''), wsCa = $state(initial()?.ws?.ca ?? '');
  let mqttUrl = $state(initial()?.mqtt?.url ?? ''), baseTopic = $state(initial()?.mqtt?.baseTopic ?? 'cameras');
  let mqttIds = $state(initial()?.mqtt?.cameraIds?.join(', ') ?? ''), username = $state(initial()?.mqtt?.username ?? '');
  let password = $state(''), clearPassword = $state(false), mqttCa = $state(initial()?.mqtt?.ca ?? '');
  let partialTrust = $state(initial()?.mqtt?.allowPartialTrustChain ?? false), capture = $state(Boolean(initial()?.capture));
  let httpVerify = $state(initial()?.http?.rejectUnauthorized ?? true);
  let wsVerify = $state(initial()?.ws?.rejectUnauthorized ?? true);
  let mqttVerify = $state(initial()?.mqtt?.rejectUnauthorized ?? true);
  const initialDestinations = () => Object.entries(initial()?.callbacks ?? {}).map(([name,url]) => ({name,url}));
  let destinations = $state(initialDestinations());
  const duplicateDestinations = $derived(new Set(destinations.map(item => item.name).filter(Boolean)).size < destinations.filter(item => item.name).length);
  const ids = (text: string) => text.split(/[\s,]+/).filter(Boolean);
  $effect(() => {
    if (commands === 'http' && !httpEnabled) commands = mqttEnabled ? 'mqtt' : 'none';
    if (commands === 'mqtt' && !mqttEnabled) commands = httpEnabled ? 'http' : 'none';
  });
  const connection = () => ({
      id, label, cameraIds: ids(cameraIds),
      ...(httpEnabled && (retriesEdited || configuration?.cameraReadRetries !== undefined) ? {cameraReadRetries:readRetries} : {}),
      ...(commands !== 'none' ? { commands } : {}),
      ...(mqttEnabled && capture ? { capture: 'mqtt' } : {}),
      ...(httpEnabled ? { http: {
        url: httpUrl, relay, rejectUnauthorized: httpVerify, ...(httpCa.trim() ? { ca: httpCa.trim() } : {}),
        ...(httpToken ? { token: httpToken } : {})
      } } : {}),
      ...(wsEnabled ? { ws: {
        url: wsUrl, rejectUnauthorized: wsVerify, ...(wsCa.trim() ? { ca: wsCa.trim() } : {}), ...(!httpEnabled && wsToken ? { token: wsToken } : {})
      } } : {}),
      ...(mqttEnabled ? { mqtt: {
        url: mqttUrl, baseTopic, rejectUnauthorized: mqttVerify, ...(mqttIds.trim() ? { cameraIds: ids(mqttIds) } : {}),
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(!username.trim() || clearPassword || password ? { password: !username.trim() || clearPassword ? '' : password } : {}),
        ...(mqttCa.trim() ? { ca: mqttCa.trim() } : {}), allowPartialTrustChain: mqttUrl.toLowerCase().startsWith('mqtts:') && Boolean(mqttCa.trim()) && mqttVerify && partialTrust
      } } : {}),
      ...(httpEnabled && destinations.length ? { callbacks: Object.fromEntries(destinations.map(item => [item.name,item.url])) } : {})
    });
  const save = async () => {
    if (await admin.mutate({
      suffix: configuration ? '/bridges/' + configuration.id : '/bridges',
      method: configuration ? 'PUT' : 'POST', body: { configuration: connection() }
    })) onsaved(id);
  };
  const test = async () => {
    testing = true; testError = ''; testResult = undefined;
    try {
      testResult = await api<BridgeTest>({
        path: '/api/v1/admin/bridges/test', method: 'POST', csrf: workspace.current().csrf,
        body: { configuration: connection() }
      });
    } catch (error) { testError = errorText(error); }
    finally { testing = false; }
  };
</script>

<form class="stack" aria-label={t('bridge-connections-form')} onsubmit={event => { event.preventDefault(); void save(); }}>
  <div class="form-grid">
    <div class="field"><div class="field-heading"><label for={fieldId + '-id'}>{t('bridge-id')}</label><InfoTip label={t('bridge-id')} text={t('bridge-id-hint')} /></div>
      <input id={fieldId + '-id'} bind:value={id} pattern="[A-Za-z0-9_-]+" maxlength="64" required readonly={Boolean(configuration)} disabled={busy} /></div>
    <label>{t('bridge-label')}<input bind:value={label} maxlength="80" required disabled={busy} /></label>
  </div>
  <details>
    <summary>{t('bridge-camera-filter')}</summary>
    <label>{t('bridge-camera-ids')}<input bind:value={cameraIds} disabled={busy} /></label>
    <p class="muted">{t('bridge-camera-ids-hint')}</p>
  </details>
  <fieldset class="stack">
    <legend>{t('bridge-http')}</legend>
    <label class="check"><input type="checkbox" bind:checked={httpEnabled} disabled={busy} />{t('bridge-enable-http')}</label>
    {#if httpEnabled}
      <label>{t('bridge-http-url')}<input type="url" bind:value={httpUrl} required disabled={busy} /></label>
      <label>{t('bridge-http-token')}<input type="password" bind:value={httpToken} autocomplete="new-password"
        required={!configuration?.http?.tokenConfigured} placeholder={configuration?.http?.tokenConfigured ? t('secret-saved') : ''} disabled={busy} /></label>
      <label class="check"><input type="checkbox" bind:checked={relay} disabled={busy} />{t('bridge-enable-relay')}</label>
      {#if !configuration?.http || configuration.effectiveCameraReadRetries !== undefined || configuration.cameraReadRetries !== undefined}
        <div class="field"><div class="field-heading"><label for={fieldId + '-retries'}>{t('bridge-camera-read-retries')}</label>
          <InfoTip label={t('bridge-camera-read-retries')} text={t('bridge-camera-read-retries-help')} /></div>
          <input id={fieldId + '-retries'} type="number" min="0" max={maxCameraReadRetries} step="1" required bind:value={readRetries}
            oninput={() => retriesEdited = true} disabled={busy} />
        </div>
        {#if configuration?.cameraReadRetries !== undefined && configuration.effectiveCameraReadRetries !== configuration.cameraReadRetries}
          <p class="muted">{t('bridge-camera-read-retries-pending')}</p>
        {/if}
      {/if}
      <ConnectionTls secure={httpUrl.toLowerCase().startsWith('https:')} bind:ca={httpCa} bind:verify={httpVerify} disabled={busy} />
    {/if}
  </fieldset>
  <fieldset class="stack">
    <legend>{t('event-source-ws')}</legend>
    <label class="check"><input type="checkbox" bind:checked={wsEnabled} disabled={busy} />{t('bridge-custom-ws')}</label>
    {#if wsEnabled}
      <label>{t('bridge-ws-url')}<input type="url" bind:value={wsUrl} required disabled={busy} /></label>
      {#if !httpEnabled}
        <label>{t('bridge-ws-token')}<input type="password" bind:value={wsToken} autocomplete="new-password"
        required={!configuration?.ws?.tokenConfigured} placeholder={configuration?.ws?.tokenConfigured ? t('secret-saved') : ''} disabled={busy} /></label>
      {/if}
      <ConnectionTls secure={wsUrl.toLowerCase().startsWith('wss:')} bind:ca={wsCa} bind:verify={wsVerify} disabled={busy} />
    {:else}<p class="muted">{t('bridge-ws-default')}</p>{/if}
  </fieldset>
  <fieldset class="stack">
    <legend>{t('event-source-mqtt')}</legend>
    <label class="check"><input type="checkbox" bind:checked={mqttEnabled} disabled={busy} />{t('bridge-enable-mqtt')}</label>
    {#if mqttEnabled}
      <div class="form-grid">
        <label>{t('bridge-mqtt-url')}<input type="url" bind:value={mqttUrl} required disabled={busy} /></label>
        <label>{t('bridge-mqtt-topic')}<input bind:value={baseTopic} required disabled={busy} /></label>
      </div>
      <label>{t('bridge-mqtt-ids')}<input bind:value={mqttIds} disabled={busy} /></label>
      <div class="form-grid">
        <label>{t('username')}<input bind:value={username} autocomplete="off" disabled={busy} /></label>
        <label>{t('password')}<input type="password" bind:value={password} autocomplete="new-password"
          placeholder={configuration?.mqtt?.passwordConfigured ? t('secret-saved') : ''} disabled={busy || clearPassword} /></label>
      </div>
      {#if configuration?.mqtt?.passwordConfigured}<label class="check"><input type="checkbox" bind:checked={clearPassword} disabled={busy} />{t('secret-clear-password')}</label>{/if}
      <label class="check"><input type="checkbox" bind:checked={capture} disabled={busy} />{t('bridge-mqtt-capture')}</label>
      <ConnectionTls secure={mqttUrl.toLowerCase().startsWith('mqtts:')} bind:ca={mqttCa} bind:verify={mqttVerify} disabled={busy} />
      {#if mqttUrl.toLowerCase().startsWith('mqtts:') && mqttVerify && mqttCa.trim()}
        <label class="check"><input type="checkbox" bind:checked={partialTrust} disabled={busy} />{t('bridge-partial-trust')}</label>
      {/if}
    {/if}
  </fieldset>
  <label>{t('bridge-command-transport')}
    <select bind:value={commands} disabled={busy}>
      <option value="none">{t('disabled')}</option>
      {#if httpEnabled}<option value="http">{t('bridge-http')}</option>{/if}
      {#if mqttEnabled}<option value="mqtt">{t('event-source-mqtt')}</option>{/if}
    </select>
  </label>
  {#if httpEnabled}
    <fieldset class="stack">
      <legend>{t('bridge-callback-destinations')} <InfoTip label={t('bridge-callback-destinations')} text={t('bridge-callback-destinations-hint')} /></legend>
      {#each destinations as destination, index}
        <div class="row">
          <label>{t('bridge-destination-name')}<input bind:value={destination.name} pattern="[A-Za-z0-9_-]+" required disabled={busy} /></label>
          <label>{t('bridge-destination-url')}<input type="url" bind:value={destination.url} required disabled={busy} /></label>
          <button type="button" disabled={busy} onclick={() => destinations = destinations.filter((_,i) => i !== index)}>{t('remove')}</button>
        </div>
      {/each}
      {#if duplicateDestinations}<p class="error">{t('bridge-destination-duplicate')}</p>{/if}
      <div class="row"><button type="button" disabled={busy} onclick={() => destinations = [...destinations,{name:'',url:''}]}>{t('bridge-add-destination')}</button></div>
    </fieldset>
  {/if}
  <div class="row">
    <button class="primary" disabled={busy || duplicateDestinations || (!httpEnabled && !wsEnabled && !mqttEnabled)}>{t('bridge-save-connections')}</button>
    <button type="button" disabled={busy || duplicateDestinations || (!httpEnabled && !wsEnabled && !mqttEnabled)}
      onclick={event => { if (event.currentTarget.form?.reportValidity()) void test(); }}>{t(testing ? 'bridge-testing' : 'bridge-test')}</button>
    {#if oncancel}<button type="button" disabled={busy} onclick={oncancel}>{t('cancel')}</button>{/if}
  </div>
  {#if testError}<p class="error" role="alert">{testError}</p>{/if}
  {#if testResult}
    <div class="table-scroll table-surface" role="status">
      <table class="status-table">
        <thead><tr><th>{t('transport')}</th><th>{t('connection')}</th><th>{t('bridge-test-time')}</th></tr></thead>
        <tbody>{#each testResult.results as result (result.source)}
          <tr><th>{result.transport}</th><td>{t('bridge-test-' + result.status)}{#if result.failure} · {t('bridge-test-failure-' + result.failure)}{/if}</td><td>{result.elapsedMs} ms</td></tr>
        {/each}</tbody>
      </table>
    </div>
    <p class="muted">{t('bridge-test-cameras', { count: testResult.cameraCount })}</p>
  {/if}
</form>
