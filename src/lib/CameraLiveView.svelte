<script lang="ts">
  import { onDestroy, onMount, tick, untrack, type Snippet } from 'svelte';
  import { api, errorText, fetchPreview, operationId, outcomeText, t, UiError, url, type Outcome } from './api.js';
  import CameraPtz from './CameraPtz.svelte';
  import { dismissOnBackdrop } from './dialog.js';
  import type { Camera } from './models.js';

  let { previewTag, pushConnected = false, camera, name, csrf, administer, compact = false, refreshRequest = 0, headingId, actions }: {
    previewTag?: string; pushConnected?: boolean; camera: Camera; name: string; csrf: string; administer: boolean;
    compact?: boolean; refreshRequest?: number; headingId?: string; actions?: Snippet;
  } = $props();
  const id = $props.id();
  const base = $derived('/api/v1/cameras/' + camera.id);
  const enabled = $derived(camera.capabilities.preview);
  const canStream = $derived(camera.capabilities.media.length > 0);
  const showPtz = $derived(camera.capabilities.ptz?.supported && (camera.capabilities.ptz.read || camera.capabilities.ptz.write));
  let panel: HTMLDivElement;
  let dialog: HTMLDialogElement;
  let expanded = $state(false);
  let image = $state('');
  let failed = $state(false);
  let previewLoaded = $state(false);
  let manualFrameRequest = $state(0);
  let previousRequest: number | undefined;
  let enqueue: (() => void) | undefined;
  let notifyPreview: ((tag: string) => void) | undefined;
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
    if (!expanded || !canStream || liveBusy) return;
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
    void [enabled, expanded, playback, camera.previewIntervalMs, camera.previewPush, pushConnected];
    untrack(() => resumePreview?.());
  });
  $effect(() => {
    const supported = camera.capabilities.media;
    const valid = supported.includes(stream);
    if (!valid) untrack(() => { if (playback || liveBusy) void stopLive(); });
    if (!valid) stream = supported.includes('sub') ? 'sub' : 'main';
  });

  $effect(() => { const tag = previewTag; if (tag) untrack(() => notifyPreview?.(tag)); });

  onDestroy(stopLive);
  onMount(() => {
    let stopped = false;
    let visible = typeof IntersectionObserver === 'undefined';
    let running = false;
    let urgent = false;
    let pending = false;
    let finishedAt: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    let etag: string | undefined;
    const canFetch = () => enabled && !stopped && (visible || expanded) && !playback && !document.hidden;
    const clear = () => {
      if (image) URL.revokeObjectURL(image);
      image = '';
      previewLoaded = false;
      etag = undefined;
    };
    const schedule = () => {
      clearTimeout(timer);
      if (canFetch() && !running && finishedAt !== undefined && (!camera.previewPush || !pushConnected || pending)) {
        timer = setTimeout(update, Math.max(0, Math.ceil(finishedAt + camera.previewIntervalMs - performance.now())));
      }
    };
    const update = async () => {
      if (!canFetch() || running) return;
      clearTimeout(timer);
      const query = urgent ? '?refresh=true' : '';
      urgent = false;
      pending = false;
      running = true;
      request = new AbortController();
      try {
        const next = await fetchPreview({ path: base + '/preview' + query, etag, signal: request.signal });
        if (!stopped && enabled) {
          if (next.image) {
            const candidate = URL.createObjectURL(next.image);
            try {
              const decoded = new Image(); decoded.src = candidate;
              await decoded.decode();
              if (stopped || !enabled) { URL.revokeObjectURL(candidate); return; }
            } catch (error) { URL.revokeObjectURL(candidate); throw error; }
            const previous = image;
            image = candidate;
            if (previous) URL.revokeObjectURL(previous);
          }
          etag = next.etag;
          if (previewTag === next.etag) pending = false;
          failed = false;
        }
      } catch (error) {
        if (!stopped && enabled) {
          failed = true;
          pending = true;
          if (error instanceof UiError && ['ACCESS_DENIED', 'NOT_AUTHENTICATED', 'CAMERA_UNKNOWN'].includes(error.reason)) clear();
        }
      } finally {
        running = false;
        finishedAt = performance.now();
        if (urgent && canFetch()) void update();
        else schedule();
      }
    };
    notifyPreview = tag => {
      if (tag === etag) return;
      pending = true;
      resume();
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
      notifyPreview = undefined;
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
      <img src={image} alt={t('preview-alt', { camera: name })}
        onload={() => { previewLoaded = true; }}
        onerror={() => { failed = true; previewLoaded = false; }} />
      {#if failed}<small class="preview-notice">{t('preview-stale')}</small>{/if}
    {:else}
      <p>{t(!enabled ? 'preview-unconfigured' : failed ? 'preview-offline' : 'preview-waiting')}</p>
    {/if}
  </div>
{/snippet}

{#snippet guidance()}
  {#if camera.capabilities.mediaAllowed && !playing && (!(image && previewLoaded && !failed) || !!liveMessage)}
    <div class="row muted">
      <span>{t(canStream ? (camera.capabilities.viaProxy ? 'playback-proxy' : 'playback-direct') : 'live-stream-unavailable')}</span>
      {#if administer}<a href={'/settings/cameras?camera=' + camera.id + '#playback-title'}>{t('live-configure')}</a>{/if}
    </div>
  {/if}
{/snippet}

{#snippet toolbar(large: boolean)}
  <div class="row live-toolbar" role="group" aria-label={t('live-actions')}>
    {#if camera.capabilities.recordings}
      <a class="button icon-button" href={'/recordings?camera=' + camera.id} aria-label={t('recordings')} title={t('recordings')}>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
        </svg>
      </a>
    {/if}
    {#if camera.capabilities.rotate || Object.keys(camera.capabilities.settings).length || camera.capabilities.alerts.read || camera.capabilities.alerts.write}
      <a class="button icon-button" href={'/settings/cameras?camera=' + camera.id} aria-label={t('camera-settings')} title={t('camera-settings')}>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="m9 3-1 3-3 1-2 3 2 2-2 2 2 3 3 1 1 3h6l1-3 3-1 2-3-2-2 2-2-2-3-3-1-1-3z" /><circle cx="12" cy="12" r="3" />
        </svg>
      </a>
    {/if}
    {#if camera.capabilities.mediaAllowed}
      {#if !large || (!playback && !liveBusy)}
        <button class="icon-button" type="button" aria-label={t('live-refresh')} title={t('live-refresh')}
          disabled={!enabled} onclick={() => { manualFrameRequest++; }}>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
          </svg>
        </button>
      {/if}
      {#if !large}
        <button class="icon-button" type="button" title={t('live-enlarge')} aria-label={t('live-enlarge')}
          aria-haspopup="dialog" disabled={!enabled && !canStream} onclick={() => show({ play: false })}>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />
          </svg>
        </button>
      {/if}
    {/if}
  </div>
{/snippet}

<div class="stack">
  <div class="row between panel-title">
    <h2 id={headingId ?? id + '-inline'}>{t('live')}</h2>
    {@render toolbar(false)}
  </div>
  <div bind:this={panel}>{@render preview()}</div>
  {#if camera.capabilities.mediaAllowed || actions}
    <div class="row">
      {#if camera.capabilities.mediaAllowed}
        <button class="primary" type="button" aria-haspopup="dialog" disabled={!canStream}
          onclick={() => show({ play: true })}>{t('live-start')}</button>
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
        <div class="row">
          {@render toolbar(true)}
          <form method="dialog"><button>{t('close')}</button></form>
        </div>
      </div>
      <div class="live-dialog-body" class:with-ptz={showPtz}>
        <div class="stack">
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
              <select class="stream-quality" aria-label={t('live-quality')} bind:value={stream} disabled={liveBusy}
                  onchange={() => { if (playback) void startLive(); }}>
                  {#if camera.capabilities.media.includes('main')}
                    <option value="main">{t(camera.capabilities.viaProxy ? 'live-proxy-quality' : 'primary')}</option>
                  {/if}
                  {#if camera.capabilities.media.includes('sub')}<option value="sub">{t('secondary')}</option>{/if}
              </select>
            {/if}
            {#if playback || liveBusy}
              <button type="button" onclick={() => { void stopLive(); }}>{t('live-stop')}</button>
            {:else}
              <button class="primary" type="button" disabled={!canStream} onclick={startLive}>{t('live-start')}</button>
            {/if}
          </div>
          {#if liveBusy || (playback && !playing)}<p role="status" class="muted">{t('live-starting')}</p>{/if}
          {#if liveMessage}<p role="status" class="notice">{liveMessage}</p>{/if}
          {@render guidance()}
        </div>
        {#if showPtz}<CameraPtz {camera} {csrf} />{/if}
      </div>
    </div>
  {/if}
</dialog>
