<script lang="ts">
  import { untrack } from 'svelte';
  import { recordingKinds, type RecordingKind, type RecordingSchedule } from '../../shared/access.js';
  import { t } from './api.js';

  let { value, writable, disabled, save }: { value: RecordingSchedule; writable: boolean; disabled: boolean; save: (fields: Record<string, unknown>) => Promise<void> } = $props();
  const kinds = $derived(recordingKinds.filter(kind => value.schedules[kind]));
  let preferredKind = $state<RecordingKind>();
  const kind = $derived(kinds.find(item => item === preferredKind) ?? kinds[0]);
  let day = $state(1);
  let enabled = $state(untrack(() => value.enabled));
  let edits = $state<Record<number, boolean>>({});
  const table = $derived(kind ? value.schedules[kind] : undefined);
  $effect(() => {
    enabled = value.enabled;
    edits = {};
  });
  const entries = $derived(Object.entries(edits));
  const changed = $derived(entries.length > 0 || enabled !== value.enabled);
  const days = Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(undefined, { weekday: 'long', timeZone: 'UTC' }).format(Date.UTC(2023, 0, index + 1)));
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const selected = (hour: number) => edits[hour] ?? table?.[hour] === '1';
  function setHour(hour: number, active: boolean) {
    if (active === (table?.[hour] === '1')) delete edits[hour];
    else edits[hour] = active;
  }
  function submit() {
    if (!changed || !writable || disabled) return;
    const slots = (active: boolean) => entries.filter(([, state]) => state === active).map(([hour]) => Number(hour));
    void save({ setting: 'recording_schedule', enabled: enabled !== value.enabled ? enabled : undefined,
      schedule: entries.length ? { kind, enable_hours: slots(true), disable_hours: slots(false) } : undefined });
  }
</script>

<form class="stack" onsubmit={event => { event.preventDefault(); submit(); }}>
  <label class="check"><input type="checkbox" bind:checked={enabled} disabled={!writable || disabled} />{t('schedule-enabled')}</label>
  {#if table}
    <div class="form-grid">
      <label>{t('schedule-kind')}
        <select value={kind} onchange={event => { preferredKind = event.currentTarget.value as RecordingKind; }} disabled={disabled || entries.length > 0}>
          {#each kinds as name}<option value={name}>{t(name)}</option>{/each}
        </select>
      </label>
      <label>{t('schedule-day')}
        <select bind:value={day}>{#each days as name, index}<option value={index}>{name}</option>{/each}</select>
      </label>
    </div>
    <fieldset class="stack ai-settings">
      <legend>{t('schedule-hours', { day: days[day] })}</legend>
      <div class="swatch-toggle-grid">
        {#each hours as hour}
          {@const index = day * 24 + hour}
          <button type="button" class="swatch-toggle" aria-pressed={selected(index)} disabled={!writable || disabled}
            onclick={() => setHour(index, !selected(index))}>
            <span class="swatch-label">{String(hour).padStart(2, '0')}:00</span>
          </button>
        {/each}
      </div>
      {#if writable}
        <div class="row">
          <button type="button" {disabled} onclick={() => hours.forEach(hour => setHour(day * 24 + hour, true))}>{t('schedule-day-on')}</button>
          <button type="button" {disabled} onclick={() => hours.forEach(hour => setHour(day * 24 + hour, false))}>{t('schedule-day-off')}</button>
        </div>
      {/if}
    </fieldset>
  {/if}
  {#if writable}<button disabled={disabled || !changed}>{t('save')}</button>{/if}
</form>

<style>
  .swatch-toggle-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 6.5rem), 1fr)); gap: var(--space-3); }
  .swatch-toggle {
    position: relative;
    display: grid;
    place-items: end start;
    min-height: 5rem;
    padding: var(--space-3);
    border-width: 1px 1px .24rem;
    border-radius: var(--radius-md);
    color: var(--color-text-muted);
    background: var(--color-panel-strong);
    box-shadow: var(--shadow-control-rest);
  }
  .swatch-label { font-size: .8rem; font-variant-numeric: tabular-nums; }
  .swatch-toggle::before {
    content: '';
    position: absolute;
    inset: .22rem .55rem auto;
    height: 1px;
    background: var(--color-control-top-glint);
  }
  .swatch-toggle::after {
    content: '';
    position: absolute;
    inset: .7rem .7rem auto auto;
    width: .62rem;
    height: .62rem;
    border: 1px solid var(--color-mid-border);
    border-radius: 50%;
    background: var(--color-mid);
    box-shadow: 0 0 .75rem var(--color-mid-soft);
    opacity: 0;
  }
  .swatch-toggle:not(:disabled):hover {
    border-color: var(--color-start);
    box-shadow: var(--shadow-control-hover), var(--shadow-hover);
    transform: translateY(-.06rem);
  }
  .swatch-toggle[aria-pressed='true'], .swatch-toggle[aria-pressed='true']:not(:disabled):hover {
    border-width: .24rem 1px 1px;
    border-color: var(--color-mid-border);
    color: var(--color-text);
    background: color-mix(in srgb, var(--color-mid) 42%, var(--color-panel));
    box-shadow: inset 0 .2rem 0 var(--color-control-bottom-shade), inset 0 0 0 1px var(--color-mid-border);
    transform: translateY(.12rem);
  }
  .swatch-toggle[aria-pressed='true']::after { opacity: 1; }
  .swatch-toggle:focus-visible { outline: 2px solid var(--color-warning); outline-offset: 2px; }
</style>
