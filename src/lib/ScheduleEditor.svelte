<script lang="ts">
  import { untrack } from 'svelte';
  import { recordingKinds, type RecordingKind, type RecordingSchedule } from '../../shared/access.js';
  import { t } from './api.js';

  let { value, writable, disabled, save }: { value: RecordingSchedule; writable: boolean; disabled: boolean; save: (fields: Record<string, unknown>) => Promise<void> } = $props();
  const kinds = $derived(recordingKinds.filter(kind => value.schedules[kind]));
  let kind = $state<RecordingKind | undefined>(untrack(() => kinds[0]));
  let day = $state(1);
  let enabled = $state(untrack(() => value.enabled));
  let edits = $state<Record<number, boolean>>({});
  const table = $derived(kind ? value.schedules[kind] : undefined);
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
    <label>{t('schedule-kind')}
      <select bind:value={kind} disabled={disabled || entries.length > 0}>
        {#each kinds as name}<option value={name}>{t(name)}</option>{/each}
      </select>
    </label>
    <label>{t('schedule-day')}
      <select bind:value={day}>{#each days as name, index}<option value={index}>{name}</option>{/each}</select>
    </label>
    <fieldset class="stack ai-settings">
      <legend>{t('schedule-hours')}</legend>
      <div class="schedule-hours">
        {#each hours as hour}
          {@const index = day * 24 + hour}
          <button type="button" aria-pressed={selected(index)} disabled={!writable || disabled}
            onclick={() => setHour(index, !selected(index))}>{String(hour).padStart(2, '0')}:00</button>
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
  .schedule-hours { display: grid; grid-template-columns: repeat(auto-fit, minmax(3.8em, 1fr)); gap: .3rem; }
  .schedule-hours button { min-width: 0; padding-inline: .2em; }
</style>
