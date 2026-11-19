<script lang="ts">
  import { onDestroy } from 'svelte';
  import { t } from './api.js';
  import RecordingPreview from './RecordingPreview.svelte';
  import { recordingTime, type RecordingGroup } from '../../shared/recording-groups.js';

  let { camera, recordings, date, available, playable, highlighted, onhover, onselect }: {
    camera: string; recordings: RecordingGroup[]; date: string; available: boolean; playable: boolean;
    highlighted?: string; onhover: (id?: string) => void; onselect: (item: RecordingGroup, offsetMs: number) => void;
  } = $props();
  const day = $derived(recordingTime(date + 'T00:00:00'));
  let range = $state('fit');
  const rangeStart = $derived(range === 'day' ? day : Math.max(day,Math.floor(recordingTime(recordings[0]?.start ?? date + 'T00:00:00') / 3_600_000) * 3_600_000));
  const rangeEnd = $derived(range === 'day' ? day + 86_400_000 : Math.min(day + 86_400_000,Math.max(rangeStart + 3_600_000,Math.ceil(Math.max(...recordings.map(item => recordingTime(item.end))) / 3_600_000) * 3_600_000)));
  const span = $derived(rangeEnd - rangeStart);
  let rail: HTMLDivElement;
  let hover = $state<{ item: RecordingGroup; offsetMs: number; percent: number }>();
  let frame = $state<{ item: RecordingGroup; offsetMs: number }>();
  let timer: ReturnType<typeof setTimeout>;
  const position = (item: RecordingGroup) => Math.max(0, (recordingTime(item.start) - rangeStart) / span * 100);
  const width = (item: RecordingGroup) => Math.min(100 - position(item), (recordingTime(item.end) - Math.max(rangeStart,recordingTime(item.start))) / span * 100);
  const point = (item: RecordingGroup, event?: PointerEvent) => {
    const bounds = rail.getBoundingClientRect();
    const time = event ? rangeStart + (event.clientX - bounds.left) / bounds.width * span : recordingTime(item.start);
    const offsetMs = Math.floor(Math.max(0,Math.min(time - recordingTime(item.start),recordingTime(item.end) - recordingTime(item.start) - 1000)) / 1000) * 1000;
    const half = Math.min(144,window.innerWidth * .35) / bounds.width * 100;
    hover = { item, offsetMs, percent: Math.max(half,Math.min(100 - half,(time - rangeStart) / span * 100)) };
    onhover(item.id);
    clearTimeout(timer);
    if (frame?.item.id !== item.id || frame.offsetMs !== offsetMs) {
      timer = setTimeout(() => { frame = { item, offsetMs }; }, 250);
    }
  };
  const leave = () => { clearTimeout(timer); hover = undefined; frame = undefined; onhover(); };
  onDestroy(() => clearTimeout(timer));
</script>

<div class="recording-timeline stack">
  <div class="row between"><h3>{t('recording-timeline')}</h3>
    <select class="timeline-range" aria-label={t('recording-timeline-range')} bind:value={range}>
      <option value="fit">{t('recording-timeline-fit')}</option><option value="day">{t('recording-timeline-day')}</option>
    </select>
    <div class="row timeline-legend"><span class="timeline-key busy"></span>{t('recording-busy')}<span class="timeline-key"></span>{t('recording-still')}</div>
  </div>
  <div class="timeline-rail" bind:this={rail} onpointerleave={leave} role="group" aria-label={t('recording-timeline')}>
    {#each recordings as item (item.id)}
      <button type="button" class="timeline-segment" data-highlighted={highlighted === item.id}
        style:left={position(item) + '%'} style:width={width(item) + '%'} aria-disabled={!playable}
        aria-label={t('recording-play-at', { time: item.start.replace('T',' ') })}
        title={item.start.slice(11) + '–' + item.end.slice(11)}
        onpointerenter={event => point(item,event)} onpointermove={event => point(item,event)}
        onfocus={() => point(item)} onblur={leave}
        onclick={() => { if (playable) onselect(item,hover?.item.id === item.id ? hover.offsetMs : 0); }}></button>
    {/each}
    {#if hover}
      <div class="timeline-hover stack" style:left={hover.percent + '%'} role="tooltip">
        {#if frame && frame.item.id === hover.item.id && frame.offsetMs === hover.offsetMs}
          <RecordingPreview {camera} recording={frame.item.id} {available} offsetMs={Math.max(0,frame.offsetMs - (recordingTime(frame.item.variants[0].start) - recordingTime(frame.item.start)))} eager />
        {:else}<div class="recording-preview">{t('loading')}</div>{/if}
        <time>{new Date(recordingTime(hover.item.start) + hover.offsetMs).toISOString().slice(11,19)}</time>
      </div>
    {/if}
  </div>
  <div class="timeline-hours" aria-hidden="true">{#each [0,.25,.5,.75,1] as tick}<span>{rangeStart + span * tick === day + 86_400_000 ? '24:00' : new Date(rangeStart + span * tick).toISOString().slice(11,16)}</span>{/each}</div>
</div>
