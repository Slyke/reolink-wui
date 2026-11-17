<script lang="ts">
  import { onDestroy } from 'svelte';
  import { api, errorText, operationId, outcomeText, t, url, type Outcome } from './api.js';
  import { cameraStatus, type Camera, type CameraDetail, type CameraEvent } from './models.js';

  import CameraPreview from './CameraPreview.svelte';
  import EventFeed from './EventFeed.svelte';

  let { camera, events, historyError, csrf, revision, alertFrameRequest, administer }: {
    camera: Camera; events: CameraEvent[]; historyError: boolean; csrf: string; revision: number;
    alertFrameRequest: number; administer: boolean
  } = $props();
  let info = $state<CameraDetail>();
  const liveTitle = $props.id();
  let stream = $state<'main' | 'sub'>('main');
  let playback = $state('');
  let manualFrameRequest = $state(0);
  let playbackTimer: ReturnType<typeof setTimeout> | undefined;
  let playbackSequence = 0;
  let capture = $state('');
  let busy = $state(false), moving = $state(false), liveBusy = $state(false);
  let duration = $state(400), speed = $state<number>();
  let zoom = $state<number>(), preset = $state(0);
  let position = $state<CameraDetail['position']>();
  let presets = $state<{ id: number; name?: string }[]>([]);
  let message = $state(''), error = $state('');
  let pointer: number | undefined;
  let movement: string | undefined;
  const base = $derived('/api/v1/cameras/' + camera.id);
  const online = $derived(camera.availability.online === true && !camera.availability.stale);
  const mediaOnline = $derived(online || camera.capabilities.viaProxy);
  const canStream = $derived(camera.capabilities.media.length > 0);
  const settingsLink = $derived('/settings/cameras?camera=' + camera.id);
  const ptz = $derived(camera.capabilities.ptz);
  const result = (value: Outcome) => { message = outcomeText(value); };
  const refresh = async () => {
    try { info = await api<CameraDetail>({ path: base }); } catch { info = undefined; }
  };
  $effect(() => {
    const current = revision;
    if (current > 0) void refresh();
  });
  $effect(() => {
    if ((!mediaOnline || !camera.capabilities.media.length) && playback) closeLive();
    if (!camera.capabilities.media.includes(stream)) stream = camera.capabilities.media.includes('sub') ? 'sub' : 'main';
  });

  const releaseStream = ({ path }: { path: string }) => api({ path, method: 'DELETE', csrf, keepalive: true }).catch(() => {});
  const closeLive = () => {
    playbackSequence++;
    clearTimeout(playbackTimer);
    if (!playback) return;
    const path = playback;
    playback = '';
    return releaseStream({ path });
  };
  const startLive = async () => {
    if (!canStream || !mediaOnline || liveBusy) return;
    liveBusy = true; message = ''; error = '';
    const closing = closeLive();
    const generation = playbackSequence;
    try {
      await closing;
      if (generation !== playbackSequence) return;
      const value = await api<Outcome>({ path: base + '/media-sessions', method: 'POST', csrf, body: { operationId: operationId(), stream } });
      if (generation !== playbackSequence) {
        if (value.data?.url) void releaseStream({ path: value.data.url });
        return;
      }
      if (value.data?.url) {
        playback = value.data.url;
        playbackTimer = setTimeout(() => { closeLive(); message = t('live-display'); }, Math.max(0, Date.parse(value.data.expiresAt) - Date.now()));
      } else result(value);
    } catch (err) { error = errorText(err); }
    finally { liveBusy = false; }
  };
  const refreshLive = () => { manualFrameRequest++; };

  const snapshot = async () => {
    busy = true; error = ''; message = '';
    try {
      const value = await api<Blob | Outcome>({ path: base + '/snapshots', method: 'POST', image: true, csrf, body: { operationId: operationId() } });
      if (value instanceof Blob) {
        if (capture) URL.revokeObjectURL(capture);
        capture = URL.createObjectURL(value);
        message = t('confirmed');
      } else result(value);
    } catch (err) { error = errorText(err); }
    finally { busy = false; }
  };
  const ptzAction = async (action: Record<string, unknown>, quiet = false, id: string = operationId(), interrupts?: string) => {
    if (!quiet) { message = ''; error = ''; }
    try {
      const value = await api<Outcome>({ path: base + '/ptz', method: 'POST', csrf, keepalive: action.op === 'stop', body: { operationId: id, action, interrupts } });
      if (value.data?.presets) presets = value.data.presets;
      if (value.data?.position?.pan !== undefined || value.data?.position?.tilt !== undefined || value.data?.position?.zoom?.position !== undefined) {
        position = value.data;
      }
      if (!quiet || value.outcome === 'unknown' || value.outcome === 'rejected') result(value);
    } catch (err) { error = errorText(err); }
  };
  const move = async (direction: string) => {
    if (moving || !online) return;
    moving = true;
    movement = operationId();
    await ptzAction({ op: 'move', direction, duration_ms: duration, speed: ptz?.speed ? speed : undefined }, false, movement);
    moving = false;
    if (pointer === undefined) movement = undefined;
  };
  const stop = () => {
    const shouldStop = moving || pointer !== undefined;
    pointer = undefined;
    if (shouldStop) void ptzAction({ op: 'stop' }, true, operationId(), movement);
    if (!moving) movement = undefined;
  };
  onDestroy(() => {
    stop();
    closeLive();
    if (capture) URL.revokeObjectURL(capture);
  });
  const directions = $derived([
    ...(ptz?.pan ? ['left', 'right'] : []), ...(ptz?.tilt ? ['up', 'down'] : []),
    ...(ptz?.diagonal ? ['left_up', 'right_up', 'left_down', 'right_down'] : []),
    ...(ptz?.directionalZoom ? ['zoom_in', 'zoom_out'] : [])
  ]);
</script>

<svelte:window onblur={stop} onpagehide={stop} />
<svelte:document onvisibilitychange={() => { if (document.hidden) stop(); }} />

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
      <h2 id={liveTitle} class="panel-title">{t('live')}</h2>
      {#if playback}
        <div class="viewport">
          <img src={url(playback)} alt={t('live-alt')} onerror={() => { closeLive(); message = t('live-display'); }} />
        </div>
      {:else}
        {#key camera.capabilities.preview}
          <CameraPreview camera={camera.id} name={camera.name ?? t('camera-noun')} enabled={camera.capabilities.preview}
            refreshRequest={manualFrameRequest + alertFrameRequest} />
        {/key}
      {/if}
      <div class="row">
        {#if camera.capabilities.media.length > 1}
          <select class="stream-quality" aria-label={t('live-quality')} bind:value={stream} disabled={liveBusy}
            onchange={() => { if (playback) void startLive(); }}>
            <option value="main">{t('primary')}</option>
            <option value="sub">{t('secondary')}</option>
          </select>
        {/if}
        {#if camera.capabilities.mediaAllowed}
          {#if playback}
            <button onclick={closeLive}>{t('live-stop')}</button>
          {:else}
            <button class="primary" disabled={!canStream || !mediaOnline || liveBusy} onclick={startLive}>{t(liveBusy ? 'pending' : 'live-start')}</button>
          {/if}
          {#if !playback}
            <button disabled={!camera.capabilities.preview} onclick={refreshLive}>{t('live-refresh')}</button>
          {/if}
        {/if}
        {#if camera.capabilities.capture}
          <button disabled={!online || busy} onclick={snapshot}>{t(busy ? 'pending' : 'snapshot')}</button>
        {/if}
      </div>
      {#if camera.capabilities.mediaAllowed}
        <div class="row muted">
          {#if canStream}
            <span>{t(camera.capabilities.viaProxy ? 'playback-proxy' : 'playback-direct')}</span>
          {:else}
            <span>{t('live-stream-unavailable')}</span>
          {/if}
          {#if administer}<a href={settingsLink + '#playback-title'}>{t('live-configure')}</a>{/if}
        </div>
      {/if}
      {#if capture}
        <img class="snapshot" src={capture} alt={t('snapshot-alt')} />
        <a href={capture} download="snapshot.png">{t('download')}</a>
      {/if}
    </section>
    {#if camera.capabilities.events}<EventFeed {events} {historyError} />{/if}
  </div>
  {#if info?.detections?.length}
    <section class="panel stack">
      <h2>{t('detections')}</h2>
      <div class="row">
        {#each info.detections as item (item.type)}
          {@const status = item.active === true ? 'triggered' : item.active === false ? 'cleared' : 'observed'}
          <span class="pill detection-state" data-status={online ? status : 'stale'}>
            {t(item.type)} · {t(item.active === undefined ? 'event-observed' : item.active ? 'event-active' : 'event-clear')}
          </span>
        {/each}
      </div>
    </section>
  {/if}
  {#if ptz}
    <section class="panel stack">
      <h2 class="panel-title">{t('ptz')}</h2>
      {#if !ptz.supported}
        <p class="muted">{t(ptz.discovery === 'pending' ? 'waiting' : 'not-supported')}</p>
      {:else}
        {#if ptz.write}
          <div class="form-grid">
            <label>{t('duration')}<input type="number" min={ptz.duration?.min} max={ptz.duration?.max} bind:value={duration} /></label>
            {#if ptz.speed}<label>{t('speed')}<input type="number" placeholder={t('default-speed')} min={ptz.speed.min} max={ptz.speed.max} bind:value={speed} /></label>{/if}
          </div>
          <div class="row">
            {#each directions as direction}
              <button disabled={!online} onpointerdown={event => {
                if (event.button !== 0 || !event.isPrimary || moving) return;
                pointer = event.pointerId;
                event.currentTarget.setPointerCapture(event.pointerId);
                void move(direction);
              }} onpointerup={stop} onpointercancel={stop} onlostpointercapture={() => { if (pointer !== undefined) stop(); }}
              onclick={event => { if (event.detail === 0) void move(direction); }}>{t('move-' + direction)}</button>
            {/each}
            <button class="danger" onclick={() => ptzAction({ op: 'stop' }, false, operationId(), movement)}>{t('stop')}</button>
          </div>
        {/if}
        <div class="row">
          {#if ptz.read}<button disabled={!online} onclick={() => ptzAction({ op: 'status' })}>{t('read-position')}</button>{/if}
          {#if ptz.read && ptz.presets}<button disabled={!online} onclick={() => ptzAction({ op: 'list_presets' })}>{t('load-presets')}</button>{/if}
          {#if ptz.write && presets.length}
            <select aria-label={t('presets')} bind:value={preset}>
              <option value={0}>{t('select-preset')}</option>
              {#each presets as item}<option value={item.id}>{item.name ?? item.id}</option>{/each}
            </select>
            <button disabled={!online || !preset} onclick={() => ptzAction({ op: 'goto_preset', preset_id: preset })}>{t('recall')}</button>
          {/if}
        </div>
        {#if ptz.write && ptz.zoom}
          <div class="row">
            <label>{t('zoom')}<input type="number" bind:value={zoom} min={ptz.zoom.min} max={ptz.zoom.max} /></label>
            <button disabled={!online || zoom === undefined} onclick={() => ptzAction({ op: 'set_zoom', position: zoom })}>{t('set-zoom')}</button>
          </div>
        {/if}
        {@const pos = position ?? info?.position}
        {#if ptz.read && pos}
          <p class="muted">{t('position')}: {pos.position.pan ?? t('empty-value')} / {pos.position.tilt ?? t('empty-value')} / {pos.position.zoom.position ?? t('empty-value')}
            {#if pos.receivedAt} · {new Date(pos.receivedAt).toLocaleTimeString()}{/if}
          </p>
        {/if}
      {/if}
    </section>
  {/if}
  {#if camera.capabilities.rotate || Object.keys(camera.capabilities.settings).length || camera.capabilities.alerts.read || camera.capabilities.alerts.write}
    <div class="row"><a class="button" href={'/settings/cameras?camera=' + camera.id}>{t('camera-settings')}</a></div>
  {/if}
</div>
