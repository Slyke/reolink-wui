<script lang="ts">
  import { t } from './api.js';
  import RecordingPreview from './RecordingPreview.svelte';
  import type { RecordingPreviews } from './recording-previews.js';
  import { recordingTime, type RecordingGroup } from '../../shared/recording-groups.js';

  let { previews, warming, recordings, date, available, playable, highlighted, onhover, onselect }: {
    previews: RecordingPreviews; warming: boolean; recordings: RecordingGroup[]; date: string; available: boolean; playable: boolean;
    highlighted?: string; onhover: (id?: string) => void; onselect: (item: RecordingGroup, offsetMs: number) => void;
  } = $props();
  const day = $derived(recordingTime(date + 'T00:00:00'));
  let range = $state('fit');
  const rangeStart = $derived(range === 'day' ? day : Math.max(day,Math.floor(recordingTime(recordings[0]?.start ?? date + 'T00:00:00') / 3_600_000) * 3_600_000));
  const rangeEnd = $derived(range === 'day' ? day + 86_400_000 : Math.min(day + 86_400_000,Math.max(rangeStart + 3_600_000,Math.ceil(Math.max(...recordings.map(item => recordingTime(item.end))) / 3_600_000) * 3_600_000)));
  const span = $derived(rangeEnd - rangeStart);
  let rail: HTMLDivElement;
  let railWidth = $state(0), visibility = $state<DocumentVisibilityState>();
  $effect(() => {
    if (!available || !warming || visibility !== 'visible' || !railWidth) return;
    const controller = new AbortController();
    void previews.warm(recordings, rangeStart, rangeEnd, railWidth, controller.signal);
    return () => controller.abort();
  });
  let hover = $state<{ item?: RecordingGroup; offsetMs: number; time: number; percent: number; cursor: number }>();
  let pinned = $state(false);
  let touchPointer: number | undefined;
  const byId = $derived(new Map(recordings.map(item => [item.id,item])));
  const position = (item: RecordingGroup) => Math.max(0, (recordingTime(item.start) - rangeStart) / span * 100);
  const width = (item: RecordingGroup) => Math.min(100 - position(item), (recordingTime(item.end) - Math.max(rangeStart,recordingTime(item.start))) / span * 100);
  const point = (item?: RecordingGroup, x?: number) => {
    const bounds = rail.getBoundingClientRect();
    if (!bounds.width) return;
    const raw = x === undefined ? recordingTime(item!.start)
      : rangeStart + Math.max(0,Math.min(1,(x - bounds.left) / bounds.width)) * span;
    const start = item ? recordingTime(item.start) : 0;
    const offsetMs = item ? Math.max(0, Math.floor(Math.min(raw-start,recordingTime(item.end)-start-1)/1000)*1000) : 0;
    const time = item ? start + offsetMs : Math.min(rangeEnd-1,raw);
    const cursor = Math.max(0,Math.min(100,(raw-rangeStart)/span*100));
    const half = Math.min(50,Math.min(144,window.innerWidth * .35) / bounds.width * 100);
    hover = { item, offsetMs, time, cursor, percent:Math.max(half,Math.min(100-half,cursor)) };
    onhover(item?.id);
  };
  const clear = () => { pinned = false; hover = undefined; onhover(); };
  const leave = () => { if (!pinned) clear(); };
  const scrub = (event: PointerEvent) => {
    // Captured touch events keep their original target. Hit-test the rail at the
    // finger's current x so narrow, visually enlarged segments remain reachable.
    const bounds = rail.getBoundingClientRect();
    const x = Math.max(bounds.left+1,Math.min(bounds.right-1,event.clientX));
    const segment = document.elementFromPoint(x,bounds.top+bounds.height/2)?.closest<HTMLElement>('.timeline-segment');
    point(segment && rail.contains(segment) ? byId.get(segment.dataset.id!) : undefined,x);
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
    if (!playable || !hover?.item) return;
    const {item,offsetMs} = hover;
    clear();
    onselect(item,offsetMs);
  };
  const outside = (event: PointerEvent) => {
    if (pinned && event.target instanceof Node && !rail.contains(event.target)) clear();
  };
</script>

<svelte:document bind:visibilityState={visibility} onpointerdown={outside} onkeydown={event => {if (event.key === 'Escape' && pinned) clear();}} />
<div class="recording-timeline stack">
  <div class="row between"><h3>{t('recording-timeline')}</h3>
    <select class="timeline-range" aria-label={t('recording-timeline-range')} bind:value={range} onchange={clear}>
      <option value="fit">{t('recording-timeline-fit')}</option><option value="day">{t('recording-timeline-day')}</option>
    </select>
    <div class="row timeline-legend"><span class="timeline-key busy"></span>{t('recording-busy')}<span class="timeline-key"></span>{t('recording-still')}</div>
  </div>
  <div class="timeline-rail" bind:this={rail} bind:clientWidth={railWidth} onpointerleave={leave} onpointerdown={begin}
    onpointermove={event => {if (event.pointerId === touchPointer) scrub(event);}}
    onpointerup={finish} onpointercancel={finish} role="group" aria-label={t('recording-timeline')}>
    {#each recordings as item (item.id)}
      <button type="button" class="timeline-segment" data-id={item.id} data-highlighted={highlighted === item.id}
        style:left={position(item) + '%'} style:width={width(item) + '%'} aria-disabled={!playable}
        aria-label={t('recording-play-at', { time: item.start.replace('T',' ') })}
        title={item.start.slice(11) + '–' + item.end.slice(11)}
        onpointerenter={event => { if (!pinned && event.pointerType === 'mouse') point(item,event.clientX); }}
        onpointermove={event => { if (!pinned && event.pointerType === 'mouse') point(item,event.clientX); }}
        onfocus={() => { if (!pinned) point(item); }} onblur={leave}
        onclick={event => {
          if (!playable || (pinned && event.detail > 0)) return;
          onselect(item,hover?.item?.id === item.id ? hover.offsetMs : 0);
        }}></button>
    {/each}
    {#if hover}
      {#if pinned}<span class="timeline-cursor" style:left={hover.cursor + '%'} aria-hidden="true"></span>{/if}
      <div class="timeline-hover stack" class:pinned style:left={hover.percent + '%'} role={pinned ? 'group' : 'tooltip'}
        aria-label={pinned ? t('recording-timeline') : undefined}>
        {#if hover.item}
          <RecordingPreview {previews} recording={hover.item.id} {available} offsetMs={Math.max(0,hover.offsetMs - (recordingTime(hover.item.variants[0].start) - recordingTime(hover.item.start)))} eager />
        {:else}
          <span class="muted">{t('recording-still')}</span>
        {/if}
        <div class="row between"><time>{new Date(hover.time).toISOString().slice(11,19)}</time>
          {#if pinned && hover.item && playable}<button type="button" onclick={jump}>{t('jump-recording')}</button>{/if}
        </div>
      </div>
    {/if}
  </div>
  <div class="timeline-hours" aria-hidden="true">{#each [0,.25,.5,.75,1] as tick}<span>{rangeStart + span * tick === day + 86_400_000 ? '24:00' : new Date(rangeStart + span * tick).toISOString().slice(11,16)}</span>{/each}</div>
</div>
