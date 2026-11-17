<script lang="ts">
  import { onDestroy, onMount, tick, untrack, type Snippet } from 'svelte';
  import { bridgePreviewPollIntervalMs } from '../../shared/playback.js';
  import { api, errorText, fetchPreview, operationId, outcomeText, t, UiError, url, type Outcome } from './api.js';
  import { dismissOnBackdrop } from './dialog.js';
  import type { Camera } from './models.js';

  let { camera, name, csrf, administer, compact = false, refreshRequest = 0, actions }: {
    camera: Camera; name: string; csrf: string; administer: boolean;
    compact?: boolean; refreshRequest?: number; actions?: Snippet;
  } = $props();
  const id = $props.id();
  const base = $derived('/api/v1/cameras/' + camera.id);
  const enabled = $derived(camera.capabilities.preview);
  const canStream = $derived(camera.capabilities.media.length > 0);
  const mediaOnline = $derived((camera.availability.online === true && !camera.availability.stale) || camera.capabilities.viaProxy);
  let panel: HTMLDivElement;
  let dialog: HTMLDialogElement;
  let expanded = $state(false);
  let image = $state('');
  let failed = $state(false);
  let manualFrameRequest = $state(0);
  let previousRequest: number | undefined;
  let enqueue: (() => void) | undefined;
  let resumePreview: (() => void) | undefined;

  let stream = $state<'main' | 'sub'>('main');
  let playback = $state('');
  let playing = $state(false);
  let liveBusy = $state(false);
  let liveMessage = $state('');
  let playbackTimer: ReturnType<typeof setTimeout> | undefined;
  let playbackSequence = 0;

  const release = ({ path }: { path: string }) => api({ path, method: 'DELETE', csrf, keepalive: true }).catch(() => {});
  const stopLive = () => {
    playbackSequence++;
    clearTimeout(playbackTimer);
    liveBusy = false;
    playing = false;
    const path = playback;
    playback = '';
    if (path) return release({ path });
  };
  const failLive = ({ path }: { path: string }) => {
    if (path !== playback) return;
    void stopLive();
    liveMessage = t('live-display');
  };
  const startLive = async () => {
    if (!expanded || !canStream || !mediaOnline || liveBusy) return;
    const closing = stopLive();
    const sequence = playbackSequence;
    liveBusy = true;
    liveMessage = '';
    try {
      await closing;
      if (sequence !== playbackSequence) return;
      const value = await api<Outcome>({
        path: base + '/media-sessions', method: 'POST', csrf, body: { operationId: operationId(), stream }
      });
      const path = value.data?.url;
      if (sequence !== playbackSequence) {
        if (path) void release({ path });
        return;
      }
      if (path) {
        playback = path;
        const expiresIn = Date.parse(value.data.expiresAt) - Date.now();
        playbackTimer = setTimeout(() => failLive({ path }), Math.max(0, expiresIn));
      } else liveMessage = outcomeText(value);
    } catch (error) {
      if (sequence === playbackSequence) liveMessage = errorText(error);
    } finally {
      if (sequence === playbackSequence) liveBusy = false;
    }
  };
  const show = async ({ play }: { play: boolean }) => {
    expanded = true;
    liveMessage = '';
    await tick();
    if (!dialog.isConnected) return;
    if (!dialog.open) dialog.showModal();
    if (play) await startLive();
  };
  const close = () => {
    expanded = false;
    liveMessage = '';
    void stopLive();
  };

  $effect(() => {
    const next = refreshRequest + manualFrameRequest;
    if (previousRequest !== undefined && previousRequest !== next) untrack(() => enqueue?.());
    previousRequest = next;
  });
  $effect(() => {
    // Resume when the selected surface or playback changes.
    void [enabled, expanded, playback];
    untrack(() => resumePreview?.());
  });
  $effect(() => {
    const supported = camera.capabilities.media;
    const valid = supported.includes(stream);
    if (!mediaOnline || !valid) untrack(() => { if (playback || liveBusy) void stopLive(); });
    if (!valid) stream = supported.includes('sub') ? 'sub' : 'main';
  });

  onDestroy(stopLive);
  onMount(() => {
    let stopped = false;
    let visible = typeof IntersectionObserver === 'undefined';
    let running = false;
    let urgent = false;
    let finishedAt: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    let etag: string | undefined;
    const canFetch = () => enabled && !stopped && (visible || expanded) && !playback && !document.hidden;
    const clear = () => {
      if (image) URL.revokeObjectURL(image);
      image = '';
      etag = undefined;
    };
    const schedule = () => {
      clearTimeout(timer);
      if (canFetch() && !running && finishedAt !== undefined) {
        timer = setTimeout(update, Math.max(0, Math.ceil(finishedAt + bridgePreviewPollIntervalMs - performance.now())));
      }
    };
    const update = async () => {
      if (!canFetch() || running) return;
      clearTimeout(timer);
      const query = urgent ? '?refresh=true' : '';
      urgent = false;
      running = true;
      request = new AbortController();
      try {
        const next = await fetchPreview({ path: base + '/preview' + query, etag, signal: request.signal });
        if (!stopped && enabled) {
          etag = next.etag;
          if (next.image) {
            const previous = image;
            image = URL.createObjectURL(next.image);
            if (previous) URL.revokeObjectURL(previous);
          }
          failed = false;
        }
      } catch (error) {
        if (!stopped && enabled) {
          failed = true;
          if (error instanceof UiError && ['ACCESS_DENIED', 'NOT_AUTHENTICATED', 'CAMERA_UNKNOWN'].includes(error.reason)) clear();
        }
      } finally {
        running = false;
        finishedAt = performance.now();
        if (urgent && canFetch()) void update();
        else schedule();
      }
    };
    resumePreview = () => {
      if (!enabled) {
        request?.abort();
        clear();
        finishedAt = undefined;
      }
      resume();
    };
    enqueue = () => {
      urgent = true;
      void update();
    };
    const resume = () => {
      if (urgent || finishedAt === undefined) {
        clearTimeout(timer);
        void update();
      } else schedule();
    };
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      resume();
    });
    observer?.observe(panel);
    document.addEventListener('visibilitychange', resume);
    resume();
    return () => {
      stopped = true;
      enqueue = undefined;
      resumePreview = undefined;
      observer?.disconnect();
      document.removeEventListener('visibilitychange', resume);
      request?.abort();
      clearTimeout(timer);
      clear();
    };
  });

</script>

{#snippet preview()}
  <div class="viewport preview-viewport">
    {#if image && enabled}
      <img src={image} alt={t('preview-alt', { camera: name })} />
      {#if failed}<small class="preview-notice">{t('preview-stale')}</small>{/if}
    {:else}
      <p>{t(!enabled ? 'preview-unconfigured' : failed ? 'preview-offline' : 'preview-waiting')}</p>
    {/if}
  </div>
{/snippet}

{#snippet guidance()}
  {#if camera.capabilities.mediaAllowed && !playing}
    <div class="row muted">
      <span>{t(canStream ? (camera.capabilities.viaProxy ? 'playback-proxy' : 'playback-direct') : 'live-stream-unavailable')}</span>
      {#if administer}<a href={'/settings/cameras?camera=' + camera.id + '#playback-title'}>{t('live-configure')}</a>{/if}
    </div>
  {/if}
{/snippet}

<div class="stack">
  <div bind:this={panel}>{@render preview()}</div>
  {#if camera.capabilities.mediaAllowed || actions}
    <div class="row">
      {#if camera.capabilities.mediaAllowed}
        <button class="primary" type="button" aria-haspopup="dialog" disabled={!canStream || !mediaOnline}
          onclick={() => show({ play: true })}>{t('live-start')}</button>
        <button type="button" aria-haspopup="dialog" disabled={!enabled && !canStream}
          onclick={() => show({ play: false })}>{t('live-enlarge')}</button>
        {#if !compact}
          <button type="button" disabled={!enabled} onclick={() => { manualFrameRequest++; }}>{t('live-refresh')}</button>
        {/if}
      {/if}
      {@render actions?.()}
    </div>
  {/if}
  {#if !compact && !expanded}{@render guidance()}{/if}
</div>

<dialog class="live-dialog" aria-labelledby={id + '-title'} bind:this={dialog} use:dismissOnBackdrop onclose={close}>
  {#if expanded}
    <div class="stack">
      <div class="row between panel-title">
        <h2 class="wrap" id={id + '-title'}>{t('live-dialog-title', { camera: name })}</h2>
        <form method="dialog"><button>{t('close')}</button></form>
      </div>
      {#if playback}
        {@const path = playback}
        <div class="viewport">
          <img src={url(path)} alt={t('live-alt')}
            onload={() => { if (playback === path) playing = true; }}
            onerror={() => failLive({ path })} />
        </div>
      {:else}
        {@render preview()}
      {/if}
      <div class="row">
        {#if canStream}
          <label class="stream-quality">{t('live-quality')}
            <select bind:value={stream} disabled={liveBusy || camera.capabilities.media.length === 1}
              onchange={() => { if (playback) void startLive(); }}>
              {#if camera.capabilities.media.includes('main')}
                <option value="main">{t(camera.capabilities.viaProxy ? 'live-proxy-quality' : 'primary')}</option>
              {/if}
              {#if camera.capabilities.media.includes('sub')}<option value="sub">{t('secondary')}</option>{/if}
            </select>
          </label>
        {/if}
        {#if playback || liveBusy}
          <button type="button" onclick={() => { void stopLive(); }}>{t('live-stop')}</button>
        {:else}
          <button class="primary" type="button" disabled={!canStream || !mediaOnline} onclick={startLive}>{t('live-start')}</button>
          <button type="button" disabled={!enabled} onclick={() => { manualFrameRequest++; }}>{t('live-refresh')}</button>
        {/if}
      </div>
      {#if liveBusy || (playback && !playing)}<p role="status" class="muted">{t('live-starting')}</p>{/if}
      {#if liveMessage}<p role="status" class="notice">{liveMessage}</p>{/if}
      {@render guidance()}
    </div>
  {/if}
</dialog>
