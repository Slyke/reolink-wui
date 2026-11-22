<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from './api.js';
  import { timelineIndex, timelinePreview, type TimelineCapture } from '../../shared/recording-timeline.js';
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
    if (visibility !== 'visible') return;
    now = Date.now();
    const timer = setInterval(() => { now = Date.now(); }, 30_000);
    return () => clearInterval(timer);
  });
  const futureStart = $derived.by(() => {
    const wallNow = clock?.cameraTime
      ? recordingTime(clock.cameraTime) + now - clock.sampledAt
      : recordingTime(formatLocalTimestamp(now).replace(' ', 'T'));
    if (wallNow >= day && wallNow < rangeEnd) return Math.max(0, wallNow - rangeStart) / span * 100;
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
  function photoRadius(raw:number, nearby:TimelineCapture|undefined, explicit?:RecordingGroup) {
    if (!undatedCount || explicit) return -1;
    if (!nearby) return 86_399;
    if ('item' in nearby && recordingTime(nearby.item.start) <= raw && raw < recordingTime(nearby.item.end)) return -1;
    return Math.min(86_399,Math.ceil(Math.abs(nearby.time-raw)/1000));
  }
  const radius = $derived(hover ? photoRadius(hover.raw,known,hover.explicit) : -1);
  let resolved = $state<{second:number;radius:number;photo:TimelinePhoto|null}>();
  $effect(() => {
    const at = second, distance = radius, cache = previews;
    if (at < 0 || distance < 0 || cache.cachedPhoto(at,distance)!==undefined) return;
    let showing = true;
    void cache.scanPhoto(at,distance,true).then(photo => {
      if (showing) resolved = {second:at,radius:distance,photo};
    }).catch(() => { if (showing) resolved = {second:at,radius:distance,photo:null}; });
    return () => { showing = false; };
  });
  const resolution = $derived.by(()=>{
    const photo=previews.cachedPhoto(second,radius);
    return photo!==undefined?{second,radius,photo}:resolved && second===resolved.second && radius===resolved.radius?resolved:undefined;
  });
  function closestCapture(raw:number, nearby:TimelineCapture|undefined, photo?:TimelinePhoto|null):TimelineCapture|undefined {
    if (!photo) return nearby;
    const time = recordingTime(photo.capturedAt);
    return !nearby || Math.abs(time-raw) < Math.abs(nearby.time-raw) ? {photo,time} : nearby;
  }
  const capture = $derived(hover ? closestCapture(hover.raw,known,resolution?.photo) : undefined);
  const selectedVideo = $derived(capture && 'item' in capture ? capture : undefined);
  $effect(() => {
    const id = selectedVideo?.item.id;
    untrack(() => { if (highlighted !== id) onhover(id); });
  });
  const position = (item: RecordingGroup) => Math.max(0, (recordingTime(item.start) - rangeStart) / span * 100);
  const width = (item: RecordingGroup) => Math.max(0, Math.min(100 - position(item), (recordingTime(item.end) - Math.max(rangeStart,recordingTime(item.start))) / span * 100));
  function scan(raw:number,current:boolean,item?:RecordingGroup) {
    const nearby = item ? {item,time:recordingTime(item.start),offsetMs:0} : index.closest(raw);
    const distance = photoRadius(raw,nearby,item);
    const at = Math.floor((raw-day)/1000);
    const photo = distance < 0 ? null : previews.cachedPhoto(at,distance);
    if (photo === undefined) void previews.scanPhoto(at,distance,current).catch(() => {});
    const capture = closestCapture(raw,nearby,photo);
    if (!capture) return;
    const target = timelinePreview(capture);
    if (target.photo || available) {
      void previews.scanFrame(target.photo ? 'photo/'+target.recording : target.recording,target.offsetMs,current).catch(() => {});
    }
  }
  let previousTime:number|undefined;
  const point = (raw: number, item?: RecordingGroup) => {
    const bounds = rail.getBoundingClientRect();
    if (!bounds.width || !hasMedia) return;
    const cursor = Math.max(0,Math.min(100,(raw-rangeStart)/span*100));
    const half = Math.min(50,Math.min(144,window.innerWidth * .35) / bounds.width * 100);
    hover = { raw, explicit:item, cursor, percent:Math.max(half,Math.min(100-half,cursor)) };
    scan(raw,true,item);
  };
  const clear = () => { previousTime = undefined; pinned = false; hover = undefined; onhover(); };
  const leave = () => { if (!pinned) clear(); };
  const scrub = (event: PointerEvent) => {
    const bounds = rail.getBoundingClientRect();
    if (!bounds.width || !hasMedia) return;
    const timeAt = (x:number) => Math.min(rangeEnd-1,rangeStart + Math.max(0,Math.min(1,(x-bounds.left)/bounds.width))*span);
    const raw = timeAt(event.clientX);
    point(raw);
    const trace = (next:number) => {
      if (previousTime !== undefined && previousTime !== next) {
        for (const time of index.crossed(previousTime,next,rangeStart,span/bounds.width)) scan(time,false);
      }
      if (next !== raw && previousTime !== next) scan(next,false);
      previousTime = next;
    };
    for (const sample of event.getCoalescedEvents?.() ?? []) trace(timeAt(sample.clientX));
    trace(raw);
  };
  const begin = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' || !event.isPrimary || (event.target as Element).closest('.timeline-hover')) return;
    previousTime = undefined;
    pinned = true;
    touchPointer = event.pointerId;
    rail.setPointerCapture(event.pointerId);
    scrub(event);
  };
  const finish = (event: PointerEvent) => {
    if (touchPointer !== event.pointerId) return;
    if (event.type === 'pointerup') scrub(event);
    touchPointer = undefined;
    previousTime = undefined;
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
        {#if capture}
          {@const target = timelinePreview(capture)}
          <RecordingPreview {previews} {...target} available={target.photo || available} eager />
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
