<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from './api.js';
  import { timelineIndex, type TimelineCapture } from '../../shared/recording-timeline.js';
  import { formatLocalTimestamp } from './dates.js';
  import type { TimelinePhoto } from '../../shared/recordings.js';
  import InfoTip from './InfoTip.svelte';
  import RecordingPreview from './RecordingPreview.svelte';
  import type { RecordingPreviews } from './recording-previews.js';
  import { recordingTime, type RecordingGroup } from '../../shared/recording-groups.js';

  let { previews, warming, recordings, photos, undatedCount, date, available, playable, highlighted, onhover, onselect, clockHint, clockWarning, clock, range = $bindable('fit') }: {
    previews: RecordingPreviews; warming: boolean; recordings: RecordingGroup[]; photos: TimelinePhoto[]; undatedCount:number; date: string; available: boolean; playable: boolean;
    clock?: {cameraTime:string;sampledAt:number}; range?: 'fit' | 'day';
    highlighted?: string; clockHint:string; clockWarning:boolean; onhover: (id?: string) => void; onselect: (item: RecordingGroup, offsetMs: number) => void;
  } = $props();
  const day = $derived(recordingTime(date + 'T00:00:00'));
  const index = $derived(timelineIndex(recordings,photos));
  const hasMedia = $derived(Boolean(recordings.length || photos.length || undatedCount));
  const wholeRange = $derived(range === 'day' || Boolean(undatedCount) || !hasMedia);
  const rangeStart = $derived(wholeRange ? day : Math.max(day,Math.floor((Number.isFinite(index.first) ? index.first : day) / 3_600_000) * 3_600_000));
  const rangeEnd = $derived(wholeRange ? day + 86_400_000 : Math.min(day + 86_400_000,Math.max(rangeStart + 3_600_000,Math.ceil(index.last / 3_600_000) * 3_600_000)));
  const span = $derived(rangeEnd - rangeStart);
  let rail: HTMLDivElement;
  let railWidth = $state(0), visibility = $state<DocumentVisibilityState>();
  let now = $state(Date.now());
  $effect(() => {
    if (range !== 'day' || visibility !== 'visible') return;
    now = Date.now();
    const timer = setInterval(() => { now = Date.now(); }, 30_000);
    return () => clearInterval(timer);
  });
  const futureStart = $derived.by(() => {
    if (range !== 'day') return;
    const wallNow = clock?.cameraTime
      ? recordingTime(clock.cameraTime) + now - clock.sampledAt
      : recordingTime(formatLocalTimestamp(now).replace(' ', 'T'));
    if (wallNow >= day && wallNow < day + 86_400_000) return (wallNow - day) / 86_400_000 * 100;
  });
  $effect(() => {
    if (!available || !warming || visibility !== 'visible' || !railWidth) return;
    const controller = new AbortController();
    void previews.warm(recordings, rangeStart, rangeEnd, railWidth, controller.signal);
    return () => controller.abort();
  });
  let hover = $state<{ raw:number; explicit?:RecordingGroup; percent:number; cursor:number }>();
  let pinned = $state(false);
  let touchPointer: number | undefined;
  const known = $derived(hover?.explicit ? {item:hover.explicit,time:recordingTime(hover.explicit.start),offsetMs:0}
    : hover ? index.closest(hover.raw) : undefined);
  const second = $derived(hover ? Math.floor((hover.raw-day)/1000) : -1);
  const radius = $derived.by(() => {
    if (!hover || !undatedCount || hover.explicit) return -1;
    if (!known) return 86_399;
    if ('item' in known && recordingTime(known.item.start) <= hover.raw && hover.raw < recordingTime(known.item.end)) return -1;
    return Math.min(86_399,Math.ceil(Math.abs(known.time-hover.raw)/1000));
  });
  let resolved = $state<{second:number;radius:number;photo:TimelinePhoto|null}>();
  $effect(() => {
    const at = second, distance = radius, cache = previews;
    if (at < 0 || distance < 0) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const photo = await cache.nearestPhoto(at,distance,controller.signal);
        if (!controller.signal.aborted) resolved = {second:at,radius:distance,photo};
      } catch { if (!controller.signal.aborted) resolved = {second:at,radius:distance,photo:null}; }
    },180);
    return () => {clearTimeout(timer);controller.abort();};
  });
  const resolution = $derived(resolved && second === resolved.second && radius === resolved.radius ? resolved : undefined);
  const capture = $derived.by((): TimelineCapture | undefined => {
    const photo = resolution?.photo;
    if (!photo || !hover) return known;
    const time = recordingTime(photo.capturedAt);
    return !known || Math.abs(time-hover.raw) < Math.abs(known.time-hover.raw) ? {photo,time} : known;
  });
  const selectedVideo = $derived(capture && 'item' in capture ? capture : undefined);
  $effect(() => {
    const id = selectedVideo?.item.id;
    untrack(() => { if (highlighted !== id) onhover(id); });
  });
  const position = (item: RecordingGroup) => Math.max(0, (recordingTime(item.start) - rangeStart) / span * 100);
  const width = (item: RecordingGroup) => Math.max(0, Math.min(100 - position(item), (recordingTime(item.end) - Math.max(rangeStart,recordingTime(item.start))) / span * 100));
  const point = (raw: number, item?: RecordingGroup) => {
    const bounds = rail.getBoundingClientRect();
    if (!bounds.width || !hasMedia) return;
    const cursor = Math.max(0,Math.min(100,(raw-rangeStart)/span*100));
    const half = Math.min(50,Math.min(144,window.innerWidth * .35) / bounds.width * 100);
    hover = { raw, explicit:item, cursor, percent:Math.max(half,Math.min(100-half,cursor)) };
  };
  const clear = () => { pinned = false; hover = undefined; onhover(); };
  const leave = () => { if (!pinned) clear(); };
  const scrub = (event: PointerEvent) => {
    const bounds = rail.getBoundingClientRect();
    if (bounds.width) point(Math.min(rangeEnd-1,rangeStart + Math.max(0,Math.min(1,(event.clientX-bounds.left)/bounds.width))*span));
  };
  const begin = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' || !event.isPrimary || (event.target as Element).closest('.timeline-hover')) return;
    pinned = true;
    touchPointer = event.pointerId;
    rail.setPointerCapture(event.pointerId);
    scrub(event);
  };
  const finish = (event: PointerEvent) => {
    if (touchPointer !== event.pointerId) return;
    if (event.type === 'pointerup') scrub(event);
    touchPointer = undefined;
    if (rail.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId);
  };
  const jump = () => {
    if (!playable || !selectedVideo) return;
    const {item,offsetMs} = selectedVideo;
    clear();
    onselect(item,offsetMs);
  };
  const outside = (event: PointerEvent) => {
    if (pinned && event.target instanceof Node && !rail.contains(event.target)) clear();
  };
</script>

<svelte:document bind:visibilityState={visibility} onpointerdown={outside} onkeydown={event => {if (event.key === 'Escape' && pinned) clear();}} />
<div class="recording-timeline stack">
  <div class="row between"><div class="field-heading timeline-title"><h3>{t('recording-timeline')}</h3>
      <InfoTip label={t(clockWarning?'recording-clock-drift-label':'recording-clock-label')} text={clockHint} warning={clockWarning} />
    </div>
    <select class="timeline-range" aria-label={t('recording-timeline-range')} bind:value={range} onchange={clear}>
      <option value="fit">{t('recording-timeline-fit')}</option><option value="day">{t('recording-timeline-day')}</option>
    </select>
    <div class="row timeline-legend"><span class="timeline-key busy"></span>{t('recording-busy')}<span class="timeline-key"></span>{t('recording-still')}
      {#if futureStart !== undefined}<span class="timeline-key future-pattern" aria-hidden="true"></span>{t('timeline-future')}{/if}</div>
  </div>
  <div class="timeline-rail" bind:this={rail} bind:clientWidth={railWidth} onpointerleave={leave} onpointerdown={begin}
    onpointerenter={event => {if (event.pointerType === 'mouse' && !pinned) scrub(event);}}
    onpointermove={event => {if (event.pointerId === touchPointer || (event.pointerType === 'mouse' && !pinned)) scrub(event);}}
    onpointerup={finish} onpointercancel={finish} role="group" aria-label={t('recording-timeline')}>
    {#if futureStart !== undefined}
      <span class="timeline-future future-pattern" style:left={futureStart + '%'} aria-hidden="true"></span>
    {/if}
    <input class="sr-only timeline-scrubber" type="range" disabled={!hasMedia} min={rangeStart} max={rangeEnd-1} step="1000"
      aria-label={t('timeline-scrub')} aria-valuetext={new Date(capture?.time ?? hover?.raw ?? rangeStart).toISOString().slice(11,19)} value={hover ? rangeStart+hover.cursor/100*span : rangeStart}
      onfocus={event => point(event.currentTarget.valueAsNumber)} oninput={event => point(event.currentTarget.valueAsNumber)} onblur={leave} />
    {#each recordings as item, i (item.id)}
      <button type="button" class="timeline-segment" data-id={item.id} data-highlighted={highlighted === item.id}
        style:left={position(item) + '%'} style:width={width(item) + '%'}
        style:min-width={recordings[i+1] ? 'min(3px, '+Math.max(0,position(recordings[i+1])-position(item))+'%)' : '3px'} aria-disabled={!playable}
        aria-label={t('recording-play-at', { time: item.start.replace('T',' ') })}
        title={item.start.slice(11) + '–' + item.end.slice(11)}
        onfocus={() => { if (!pinned) point(recordingTime(item.start),item); }} onblur={leave}
        onclick={event => {
          if (!playable || (pinned && event.detail > 0)) return;
          if (event.detail > 0 && selectedVideo) onselect(selectedVideo.item,selectedVideo.offsetMs);
          else if (!event.detail || !capture || 'item' in capture) onselect(item,0);
        }}></button>
    {/each}
    {#if hover}
      {#if pinned}<span class="timeline-cursor" style:left={hover.cursor + '%'} aria-hidden="true"></span>{/if}
      <div class="timeline-hover stack" class:pinned style:left={hover.percent + '%'} role={pinned ? 'group' : 'tooltip'}
        aria-label={pinned ? t('recording-timeline') : undefined}>
        {#if capture && 'photo' in capture}
          <RecordingPreview {previews} recording={capture.photo.id} available photo eager />
        {:else if selectedVideo}
          {@const video = selectedVideo}
          {@const variant = video.item.variants.find(v => recordingTime(v.start) <= video.time && video.time < recordingTime(v.end)) ?? video.item.variants[0]}
          <RecordingPreview {previews} recording={variant.id} {available} offsetMs={Math.max(0,video.time-recordingTime(variant.start))} eager />
        {:else}
          <div class="recording-preview"><span class="muted">{t(resolution ? 'recording-preview-failed' : 'loading')}</span></div>
        {/if}
        <div class="row between"><time>{new Date(capture?.time ?? hover.raw).toISOString().slice(11,19)}</time>
          {#if capture && 'photo' in capture}<small class="muted">{t('timeline-photo')}</small>{/if}
          {#if pinned && selectedVideo && playable}<button type="button" onclick={jump}>{t('jump-recording')}</button>{/if}
        </div>
      </div>
    {/if}
  </div>
  <div class="timeline-hours" aria-hidden="true">{#each [0,.25,.5,.75,1] as tick}<span>{rangeStart + span * tick === day + 86_400_000 ? '24:00' : new Date(rangeStart + span * tick).toISOString().slice(11,16)}</span>{/each}</div>
</div>
