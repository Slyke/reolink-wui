<script lang="ts">
  import { page } from '$app/state';
  import { onMount, tick } from 'svelte';
  import { api, errorText, t } from '$lib/api.js';
  import { cameraStatus, type Camera } from '$lib/models.js';
  import { useWorkspace } from '$lib/workspace.js';
  import SearchSelect from '$lib/SearchSelect.svelte';
  import SettingsPanel from '$lib/SettingsPanel.svelte';
  import MediaRetention from '$lib/MediaRetention.svelte';
  import PlaybackSettings from '$lib/PlaybackSettings.svelte';
  import CameraEncoding from '$lib/CameraEncoding.svelte';
  import CameraClock from '$lib/CameraClock.svelte';
  import CameraDisplay from '$lib/CameraDisplay.svelte';
  import CameraNetwork from '$lib/CameraNetwork.svelte';
  import CameraUsers from '$lib/CameraUsers.svelte';
  import CredentialRotation from '$lib/CredentialRotation.svelte';

  const workspace = useWorkspace();
  let cameras = $state<Camera[]>([]);
  let selected = $state('');
  let busy = $state(true);
  let error = $state('');
  let settings = $state<{ refresh: () => Promise<void>; working: () => boolean }>();
  let retention = $state<{ refresh: () => Promise<void>; working: () => boolean }>();
  let playback = $state<{ refresh: () => Promise<void>; working: () => boolean }>();
  let encoding = $state<{ refresh: () => Promise<void>; working: () => boolean }>();
  let clock = $state<{ refresh: () => Promise<void>; working: () => boolean }>();
  let display = $state<{ refresh: () => Promise<void>; working: () => boolean }>();
  let network = $state<{ refresh: () => Promise<void>; working: () => boolean }>();
  let rotation = $state<{ setStatus: (status: string) => void }>();
  const camera = $derived(cameras.find(item => item.id === selected));

  const refresh = async ({ manual = false }: { manual?: boolean } = {}) => {
    busy = true;
    try {
      cameras = (await api<{ cameras: Camera[] }>({ path: '/api/v1/cameras' })).cameras;
      if (!cameras.some(item => item.id === selected)) {
        const requested = page.url.searchParams.get('camera');
        selected = cameras.find(item => item.id === requested)?.id ?? cameras[0]?.id ?? '';
      }
      error = '';
      if (manual) {
        await tick();
        await Promise.all([settings?.refresh(), playback?.refresh(), retention?.refresh(), network?.refresh(), display?.refresh(), clock?.refresh(), encoding?.refresh()]);
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
    <button disabled={busy || settings?.working() || playback?.working() || retention?.working() || network?.working() || display?.working() || clock?.working() || encoding?.working()}
      onclick={() => refresh({ manual: true })}>{t('refresh-camera-settings')}</button>
  </div>
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
  {#key camera.id}
    {#if workspace.current().user.admin}
      <PlaybackSettings bind:this={playback} {base} bridgePreview={camera.capabilities.bridgePreview} csrf={workspace.current().csrf} />
    {:else if !Object.keys(camera.capabilities.settings).length && !camera.capabilities.alerts.read && !camera.capabilities.alerts.write && !camera.capabilities.rotate && !camera.capabilities.network.read && !camera.capabilities.network.write && !camera.capabilities.clock.read && !camera.capabilities.clock.write && !camera.capabilities.display.read && !camera.capabilities.encoding.read && !camera.capabilities.encoding.write}
      <p class="panel muted">{t('settings-empty')}</p>
    {/if}
    {#if workspace.current().user.admin}
      <MediaRetention bind:this={retention} {base} csrf={workspace.current().csrf} />
    {/if}
    <SettingsPanel bind:this={settings} {camera} csrf={workspace.current().csrf} {online} {base} />
    {#if camera.capabilities.encoding.read || camera.capabilities.encoding.write}
      <CameraEncoding bind:this={encoding} {base} csrf={workspace.current().csrf} access={camera.capabilities.encoding}/>
    {/if}
    {#if camera.capabilities.clock.read || camera.capabilities.clock.write}
      <CameraClock bind:this={clock} {base} csrf={workspace.current().csrf} access={camera.capabilities.clock} />
    {/if}
    {#if camera.capabilities.display.read}
      <CameraDisplay bind:this={display} {base} csrf={workspace.current().csrf} available={camera.capabilities.display.available}
        writable={camera.capabilities.display.write && online} onrename={() => void refresh()} />
    {/if}
    {#if camera.capabilities.network.read || camera.capabilities.network.write}
      <CameraNetwork bind:this={network} {base} csrf={workspace.current().csrf} access={camera.capabilities.network} />
    {/if}
    {#if camera.capabilities.cameraUsers}<CameraUsers onrotation={status => rotation?.setStatus(status)} {base} csrf={workspace.current().csrf} {online} />{/if}
    {#if camera.capabilities.rotate}<CredentialRotation bind:this={rotation} {base} csrf={workspace.current().csrf} {online} />{/if}
  {/key}
{/if}
