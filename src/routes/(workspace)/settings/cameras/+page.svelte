<script lang="ts">
  import { page } from '$app/state';
  import { onMount, tick } from 'svelte';
  import { api, errorText, t } from '$lib/api.js';
  import { cameraStatus, type Camera } from '$lib/models.js';
  import { useWorkspace } from '$lib/workspace.js';
  import SearchSelect from '$lib/SearchSelect.svelte';
  import type { SettingsGroup } from '../../../../../shared/access.js';
  import SettingsDisclosure from '$lib/SettingsDisclosure.svelte';
  import CameraDetectionZones from '$lib/CameraDetectionZones.svelte';
  import PrivacyMaskEditor from '$lib/PrivacyMaskEditor.svelte';
  import CameraFtp from '$lib/CameraFtp.svelte';
  import CameraOptions from '$lib/CameraOptions.svelte';
  import SettingsPanel from '$lib/SettingsPanel.svelte';
  import MediaRetention from '$lib/MediaRetention.svelte';
  import PlaybackSettings from '$lib/PlaybackSettings.svelte';
  import CameraEncoding from '$lib/CameraEncoding.svelte';
  import CameraClock from '$lib/CameraClock.svelte';
  import CameraDisplay from '$lib/CameraDisplay.svelte';
  import CameraNetwork from '$lib/CameraNetwork.svelte';
  import CameraRecordingSchedule from '$lib/CameraRecordingSchedule.svelte';
  import CameraUsers from '$lib/CameraUsers.svelte';
  import CredentialRotation from '$lib/CredentialRotation.svelte';

  const workspace = useWorkspace();
  let cameras = $state<Camera[]>([]);
  let selected = $state('');
  let busy = $state(true);
  let error = $state('');
  type Panel = { refresh: () => Promise<unknown>; working: () => boolean };
  let lights = $state<Panel>(), orientation = $state<Panel>(), detectionSettings = $state<Panel>(), recordingSettings = $state<Panel>();
  let zones = $state<Panel>();
  let picture = $state<Panel>(), sound = $state<Panel>(), mic = $state<Panel>(), privacy = $state<Panel>();
  let tracking = $state<Panel>(), siren = $state<Panel>(), delivery = $state<Panel>(), ftp = $state<Panel>();
  let refreshed = $state(false);
  const lightGroups = ['spotlight','leds'] as const, detectionGroups = ['motion','ai'] as const;
  let schedule = $state<{ refresh: () => Promise<void>; working: () => boolean }>();
  let retention = $state<{ refresh: () => Promise<void>; working: () => boolean }>();
  let playback = $state<{ refresh: () => Promise<void>; working: () => boolean }>();
  let encoding = $state<{ refresh: () => Promise<void>; working: () => boolean }>();
  let clock = $state<{ refresh: () => Promise<void>; working: () => boolean }>();
  let display = $state<{ refresh: () => Promise<void>; working: () => boolean }>();
  let network = $state<{ refresh: () => Promise<void>; working: () => boolean }>();
  let rotation = $state<{ setStatus: (status: string) => void }>();
  const panels = $derived([lights,orientation,detectionSettings,zones,recordingSettings,picture,sound,mic,privacy,tracking,siren,delivery,ftp,schedule,retention,playback,encoding,clock,display,network]);
  const camera = $derived(cameras.find(item => item.id === selected));
  const admin = $derived(workspace.current().user.admin);
  function visible(groups:readonly SettingsGroup[]) {
    return groups.some(group => { const caps=camera?.capabilities.settings[group];return caps && (caps.read || caps.write || caps.unavailable); });
  }

  const refresh = async ({ manual = false }: { manual?: boolean } = {}) => {
    busy = true; refreshed = false;
    try {
      cameras = (await api<{ cameras: Camera[] }>({ path: '/api/v1/cameras' })).cameras;
      if (!cameras.some(item => item.id === selected)) {
        const requested = page.url.searchParams.get('camera');
        selected = cameras.find(item => item.id === requested)?.id ?? cameras[0]?.id ?? '';
      }
      error = '';
      if (manual) {
        await tick();
        const results = [];
        for (const panel of panels) if (panel) results.push(await panel.refresh());
        refreshed = results.every(value => value !== false);
      }
    } catch (err) {
      cameras = [];
      selected = '';
      error = errorText(err);
    } finally {
      busy = false;
    }
  };
  onMount(() => { void refresh(); });
</script>

<svelte:head><title>{t('camera-settings')} · {t('title')}</title></svelte:head>

<section class="panel stack" aria-labelledby="camera-settings">
  <div class="row between panel-title">
    <h2 id="camera-settings">{t('camera-settings')}</h2>
    <button disabled={busy || panels.some(panel=>panel?.working())}
      onclick={() => refresh({ manual: true })}>{t('refresh-camera-settings')}</button>
  </div>
  {#if refreshed}<p role="status">{t('settings-refreshed')}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if cameras.length}
    <SearchSelect label={t('camera-noun')} bind:value={selected} options={cameras.map((item, index) => ({
      value: item.id,
      label: item.name ?? t('camera-generic', { index: index + 1 }),
      detail: item.model
    }))} />
  {:else if !busy && !error}
    <p class="muted">{t('no-cameras')}</p>
  {:else if busy}
    <p role="status">{t('loading')}</p>
  {/if}
</section>

{#if camera}
  {@const online = cameraStatus(camera) === 'online'}
  {@const base = '/api/v1/cameras/' + camera.id}
  {@const scheduleAccess = camera.capabilities.settings.recording_schedule}
  {@const caps = camera.capabilities}
  {@const csrf = workspace.current().csrf}
  {@const showOrientation = visible(['image']) || !!caps.imageOrientation}
  {@const live = admin || visible(lightGroups) || showOrientation || caps.encoding.read || caps.encoding.write || caps.display.read || caps.options.picture || caps.options.sound || caps.options.privacy}
  {@const detection = caps.detectionZones.types.length || visible(detectionGroups) || caps.alerts.read || caps.alerts.write || caps.options.tracking || caps.options.siren || caps.options.delivery}
  {@const connectivity = caps.network.read || caps.network.write || caps.clock.read || caps.clock.write}
  {@const accounts = caps.cameraUsers || caps.rotate}
  {@const recordings = admin || visible(['recording_schedule','time_lapse']) || caps.options.recordingAudio}
  {#key camera.id}
    {#if live}
      <SettingsDisclosure title={t('settings-live-image')} open>
        <SettingsPanel bind:this={lights} {camera} {base} {csrf} {online} groups={lightGroups}/>
        {#if showOrientation || caps.options.picture}
          <CameraOptions bind:this={picture} {base} {csrf} {online} group="picture" linked={['threshold']} title="device-picture-title" access={caps.options.picture}>
            {#if showOrientation}<SettingsPanel bind:this={orientation} {camera} {base} {csrf} {online} groups={['image']}/>{/if}
          </CameraOptions>
        {/if}
        {#if admin}<PlaybackSettings bind:this={playback} {base} bridgePreview={caps.bridgePreview} {csrf}/>{/if}
        {#if caps.encoding.read || caps.encoding.write}<CameraEncoding bind:this={encoding} {base} {csrf} access={caps.encoding}/>{/if}
        {#if caps.display.read}<CameraDisplay bind:this={display} {base} {csrf} available={caps.display.available}
          writable={caps.display.write && online} onrename={() => void refresh()}/>{/if}
        {#if caps.options.sound}<CameraOptions bind:this={sound} {base} {csrf} {online} group="sound" access={caps.options.sound}/>{/if}
        {#if caps.options.privacy}
          <CameraOptions bind:this={privacy} {base} {csrf} {online} group="privacy" access={caps.options.privacy}>
            {#snippet extra(view,update)}
              {#if view.privacyMasks && caps.options.privacy?.write}
                <PrivacyMaskEditor {base} {csrf} {camera} {online} {view} onupdate={update}/>
              {/if}
            {/snippet}
          </CameraOptions>
        {/if}
      </SettingsDisclosure>
    {/if}
    {#if detection}
      <SettingsDisclosure title={t('settings-detection-alerts')}>
        <SettingsPanel bind:this={detectionSettings} {camera} {base} {csrf} {online} groups={detectionGroups} showAlerts/>
        {#if caps.detectionZones.types.length}<CameraDetectionZones bind:this={zones} {base} {csrf} {camera} {online}/>{/if}
        {#if caps.options.tracking}<CameraOptions bind:this={tracking} {base} {csrf} {online} group="tracking" access={caps.options.tracking}/>{/if}
        {#if caps.options.delivery}<CameraOptions bind:this={delivery} {base} {csrf} {online} group="push" linked={['email']} title="device-delivery-title" access={caps.options.delivery}/>{/if}
        {#if caps.options.delivery}<CameraFtp bind:this={ftp} {base} {csrf} {online} available={caps.ftpDestination} access={caps.options.delivery}/>{/if}
        {#if caps.options.siren}<CameraOptions bind:this={siren} {base} {csrf} {online} group="siren" access={caps.options.siren}/>{/if}
      </SettingsDisclosure>
    {/if}
    {#if connectivity}
      <SettingsDisclosure title={t('settings-network-time')}>
        {#if caps.network.read || caps.network.write}<CameraNetwork bind:this={network} {base} {csrf} access={caps.network}/>{/if}
        {#if caps.clock.read || caps.clock.write}<CameraClock bind:this={clock} {base} {csrf} access={caps.clock}/>{/if}
      </SettingsDisclosure>
    {/if}
    {#if accounts}
      <SettingsDisclosure title={t('camera-users')}>
        {#if caps.cameraUsers}<CameraUsers onrotation={status => rotation?.setStatus(status)} {base} {csrf} {online}/>{/if}
        {#if caps.rotate}<CredentialRotation bind:this={rotation} {base} {csrf} {online}/>{/if}
      </SettingsDisclosure>
    {/if}
    {#if recordings}
      <SettingsDisclosure title={t('settings-recording-storage')}>
        {#if scheduleAccess && (scheduleAccess.read || scheduleAccess.write || scheduleAccess.unavailable)}
          <CameraRecordingSchedule bind:this={schedule} {base} {csrf} access={scheduleAccess} {online} freshSettings={caps.freshSettings}/>
        {/if}
        <SettingsPanel bind:this={recordingSettings} {camera} {base} {csrf} {online} groups={['time_lapse']}/>
        {#if caps.options.recordingAudio}<CameraOptions bind:this={mic} {base} {csrf} {online} group="recordingAudio" access={caps.options.recordingAudio}/>{/if}
        {#if admin}<MediaRetention bind:this={retention} {base} {csrf}/>{/if}
      </SettingsDisclosure>
    {/if}
    {#if !(live || detection || connectivity || accounts || recordings)}<p class="panel muted">{t('settings-empty')}</p>{/if}
  {/key}
{/if}
