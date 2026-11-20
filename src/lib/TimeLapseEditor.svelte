<script lang="ts">
  import { untrack } from 'svelte';
  import type { TimeLapse } from '../../shared/access.js';
  import InfoTip from './InfoTip.svelte';
  import { t } from './api.js';
  let { value, writable, disabled, save }: { value: TimeLapse; writable: boolean; disabled: boolean; save: (fields: Record<string, unknown>) => Promise<void> } = $props();
  let enabled = $state(untrack(() => value.enabled));
  let interval = $state(untrack(() => value.interval_seconds ?? 10));
  const initialFormat = $derived(value.configured && value.format ? value.format : 'jpeg');
  let format = $state(untrack(() => initialFormat));
  let stream = $state(untrack(() => value.stream ?? 'main'));
  let overwrite = $state(untrack(() => value.configured ? value.overwrite === true : true));
  const fields = $derived({
    ...(enabled !== value.enabled && { enabled }),
    ...(interval !== (value.interval_seconds ?? 10) && { interval_seconds: interval }),
    ...((format !== initialFormat || (!value.configured && enabled)) && { format }),
    ...(stream !== (value.stream ?? 'main') && { stream }),
    ...(value.overwrite !== undefined && (value.configured ? overwrite !== value.overwrite : enabled) && { overwrite })
  });
  const changed = $derived(Object.keys(fields).length > 0);
  const locked = $derived(!writable || disabled);
</script>

<form class="stack" onsubmit={event => { event.preventDefault(); if (changed && !locked) void save({ setting: 'time_lapse', ...fields }); }}>
  <label class="check"><input type="checkbox" bind:checked={enabled} disabled={locked} />{t('lapse-enabled')}</label>
  <label>{t('lapse-interval')}<input type="number" min="2" max="21600" step="1" bind:value={interval} required disabled={locked} /></label>
  <label>{t('lapse-output')}
    <select bind:value={format} disabled={locked}>
      {#if value.format && !['jpeg','mp4'].includes(value.format)}<option value={value.format}>{value.format}</option>{/if}
      <option value="jpeg">{t('lapse-jpeg')}</option><option value="mp4">{t('lapse-mp4')}</option>
    </select>
  </label>
  <label>{t('live-quality')}
    <select bind:value={stream} disabled={locked}>
      {#if value.stream && !['main','sub'].includes(value.stream)}<option value={value.stream}>{value.stream}</option>{/if}
      <option value="main">{t('primary')}</option><option value="sub">{t('secondary')}</option>
    </select>
  </label>
  {#if value.overwrite !== undefined}
    <div class="field-heading">
      <label class="check"><input type="checkbox" bind:checked={overwrite} disabled={locked} />{t('lapse-overwrite')}</label>
      <InfoTip label={t('lapse-overwrite')} text={t('lapse-overwrite-help')} />
    </div>
  {/if}
  {#if !value.configured}<small class="muted">{t('lapse-new')}</small>{/if}
  {#if writable}<button disabled={disabled || !changed}>{t('save')}</button>{/if}
</form>
