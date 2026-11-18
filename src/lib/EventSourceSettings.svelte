<script lang="ts">
  import type { EventSource } from '../../shared/events.js';
  import type { BridgeSummary } from './models.js';
  import SearchSelect from './SearchSelect.svelte';
  import { t } from './api.js';
  import { useAdministration } from './workspace.js';

  let { bridge }: { bridge: BridgeSummary } = $props();
  const admin = useAdministration();
  const initial = () => [...bridge.eventSources];
  let sources = $state<EventSource[]>(initial());
  let add = $state('');
  const choices = $derived(bridge.availableEventSources.filter(source => !sources.includes(source)));
  const changed = $derived(sources.join(',') !== bridge.eventSources.join(','));
  const move = ({ index, offset }: { index: number; offset: number }) => {
    const updated = [...sources];
    const [source] = updated.splice(index, 1);
    updated.splice(index + offset, 0, source);
    sources = updated;
  };
  const save = () => admin.mutate({
    suffix: '/bridges/' + bridge.id + '/event-sources', method: 'PUT', body: { sources }
  });
</script>

<form class="stack" aria-label={t('event-source-form', { bridge: bridge.label })}
  onsubmit={event => { event.preventDefault(); void save(); }}>
  <h3>{t('event-source-form', { bridge: bridge.label })}</h3>
  <p class="muted">{t('event-source-help')}</p>
  <ol class="source-priority" aria-label={t('event-source-priority')}>
    {#each sources as source, index (source)}
      <li>
        <div class="row between">
          <span>{t('event-source-' + source)}
            {#if !bridge.availableEventSources.includes(source)}<small class="muted">{t('event-source-unavailable')}</small>{/if}
          </span>
          <div class="row">
            <button type="button" class="icon-button" aria-label={t('event-source-up', { source: t('event-source-' + source) })}
              disabled={admin.busy() || index === 0} onclick={() => move({ index, offset: -1 })}>↑</button>
            <button type="button" class="icon-button" aria-label={t('event-source-down', { source: t('event-source-' + source) })}
              disabled={admin.busy() || index === sources.length - 1} onclick={() => move({ index, offset: 1 })}>↓</button>
            <button type="button" class="icon-button" aria-label={t('event-source-remove', { source: t('event-source-' + source) })}
              disabled={admin.busy() || sources.length === 1} onclick={() => sources = sources.filter(item => item !== source)}>×</button>
          </div>
        </div>
      </li>
    {/each}
  </ol>
  {#if choices.length}
    <SearchSelect label={t('event-source-add')} bind:value={add} disabled={admin.busy()}
      options={choices.map(source => ({ value: source, label: t('event-source-' + source) }))}
      onchange={({ value }) => { sources = [...sources, value as EventSource]; add = ''; }} />
  {/if}
  <div class="row">
    <button class="primary" disabled={admin.busy() || !changed || sources.some(source => !bridge.availableEventSources.includes(source))}>
      {t('event-source-save')}
    </button>
  </div>
</form>
