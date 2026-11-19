<script lang="ts">
  import { onDestroy } from 'svelte';
  import { api, errorText, operationId, outcomeText, t, type Outcome } from './api.js';
  import { cameraStatus, type Camera, type CameraDetail, type CameraEvent } from './models.js';

  import CameraPtz from './CameraPtz.svelte';
  import CameraLiveView from './CameraLiveView.svelte';
  import EventFeed from './EventFeed.svelte';

  let { previewTag, pushConnected, camera, events, historyError, csrf, revision, alertFrameRequest, administer }: {
    previewTag?: string; pushConnected?: boolean; camera: Camera; events: CameraEvent[]; historyError: boolean; csrf: string; revision: number;
    alertFrameRequest: number; administer: boolean
  } = $props();
  let info = $state<CameraDetail>();
  const liveTitle = $props.id();
  let capture = $state('');
  let busy = $state(false);
  let disposed = false;
  let snapshotButton = $state<HTMLButtonElement>();
  let message = $state(''), error = $state('');
  const base = $derived('/api/v1/cameras/' + camera.id);
  const online = $derived(camera.availability.online === true && !camera.availability.stale);
  const result = (value: Outcome) => { message = outcomeText(value); };
  const refresh = async () => {
    try { info = await api<CameraDetail>({ path: base }); } catch { info = undefined; }
  };
  $effect(() => {
    const current = revision;
    if (current > 0) void refresh();
  });
  function closeSnapshot() {
    if (capture) URL.revokeObjectURL(capture);
    capture = '';
  }
  const snapshot = async () => {
    busy = true; error = ''; message = '';
    try {
      const value = await api<Blob | Outcome>({ path: base + '/snapshots', method: 'POST', image: true, csrf, body: { operationId: operationId() } });
      if (disposed) return;
      if (value instanceof Blob) {
        closeSnapshot();
        capture = URL.createObjectURL(value);
        message = t('confirmed');
      } else result(value);
    } catch (err) { error = errorText(err); }
    finally { busy = false; }
  };
  onDestroy(() => { disposed = true; closeSnapshot(); });
</script>

<div class="stack monitor-camera">
  <section class="panel stack">
    <div class="row between panel-title">
      <div><p class="eyebrow">{t('overview')}</p><h2>{camera.name ?? t('camera-noun')}</h2></div>
      <span class="pill" data-status={cameraStatus(camera)}>{t(cameraStatus(camera))}</span>
    </div>
    <div class="row muted">
      <span>{camera.model ?? t('model-unknown')}</span>
      {#if camera.hardware}<span>· {camera.hardware}</span>{/if}
      {#if camera.firmware}<span>· {camera.firmware}</span>{/if}
    </div>
    {#if error}<p role="alert" class="error">{error}</p>{/if}
    {#if message}<p role="status">{message}</p>{/if}
  </section>
  <div class="monitor-columns" class:with-events={camera.capabilities.events}>
    <section class="panel stack" aria-labelledby={liveTitle}>
      <CameraLiveView {previewTag} {pushConnected} headingId={liveTitle} {camera} name={camera.name ?? t('camera-noun')} {csrf} {administer} refreshRequest={alertFrameRequest}>
        {#snippet actions()}
          {#if camera.capabilities.capture}
            <button bind:this={snapshotButton} disabled={!online || busy} onclick={snapshot}>{t(busy ? 'pending' : 'snapshot')}</button>
          {/if}
        {/snippet}
      </CameraLiveView>
      {#if capture}
        <img class="snapshot" src={capture} alt={t('snapshot-alt')} />
        <div class="row">
          <a href={capture} download="snapshot.png">{t('download')}</a>
          <button type="button" aria-label={t('close-snapshot')} onclick={() => { closeSnapshot(); snapshotButton?.focus(); }}>{t('close')}</button>
        </div>
      {/if}
    </section>
    {#if camera.capabilities.events}<EventFeed coordinateStream={info?.coordinateStream} {events} {historyError} />{/if}
  </div>
  {#if info?.detections?.length}
    <section class="panel stack">
      <h2>{t('detections')}</h2>
      <div class="detection-grid">
        {#each info.detections as item (item.type)}
          {@const status = item.active === true ? 'triggered' : item.active === false ? 'cleared' : 'observed'}
          <span class="pill detection-state" data-status={online ? status : 'stale'}>
            <span class="detection-lines"><span class="detection-label" title={t(item.type)}>{t(item.type)}</span><span>{t(item.active === undefined ? 'event-observed' : item.active ? 'event-active' : 'event-clear')}</span></span>
          </span>
        {/each}
      </div>
    </section>
  {/if}
  <CameraPtz {camera} {csrf} reportedPosition={info?.position} />
</div>
