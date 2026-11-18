<script lang="ts">
  import { tick } from 'svelte';
  import { t } from './api.js';
  import { dismissOnBackdrop } from './dialog.js';
  import { formatLocalTimestamp } from './dates.js';
  import type { CameraEvent } from './models.js';
  import SearchSelect from './SearchSelect.svelte';

  let { events, historyError }: { events: CameraEvent[]; historyError: boolean } = $props();
  const id = $props.id();
  let dialog: HTMLDialogElement;
  let title = $state<HTMLHeadingElement>();
  let type = $state('*');
  let search = $state('');
  let open = $state(false);
  let expanded = $state(false);
  let selected = $state<CameraEvent>();
  let copyStatus = $state<'copying' | 'copied' | 'blocked'>();

  const eventType = ({ entry }: { entry: CameraEvent }) => entry.event.type || 'event-observed';
  const eventStatus = ({ entry }: { entry: CameraEvent }) => t(entry.event.active === undefined
    ? 'event-observed' : entry.event.active ? 'event-active' : 'event-clear');
  const dateFor = ({ entry }: { entry: CameraEvent }) => entry.event.receivedAt ?? entry.observedAt;
  const types = $derived([...new Set([
    ...events.map(entry => eventType({ entry })), ...(type === '*' ? [] : [type])
  ])].map(value => ({
    value, label: t(value)
  })).sort((a, b) => a.label.localeCompare(b.label)));
  const filterOptions = $derived([{ value: '*', label: t('event-placeholder') }, ...types]);
  const matches = $derived(events.filter(entry => {
    const needle = search.trim().toLowerCase();
    const kind = eventType({ entry });
    if (type !== '*' && kind !== type) return false;
    return !needle || [t(kind), kind, eventStatus({ entry }), entry.event.vendorTopic, entry.event.source,
      entry.event.ruleId, formatLocalTimestamp(dateFor({ entry }))]
      .some(value => value?.toLowerCase().includes(needle));
  }).slice().reverse());

  const show = async ({ entry }: { entry?: CameraEvent } = {}) => {
    if (!open) {
      open = true;
      expanded = !entry;
      dialog.showModal();
    }
    selected = entry;
    copyStatus = undefined;
    await tick();
    title?.focus();
  };
  const close = () => {
    open = false;
    expanded = false;
    selected = undefined;
    copyStatus = undefined;
  };

  const copyJson = async ({ entry }: { entry: CameraEvent }) => {
    copyStatus = 'copying';
    let result: 'copied' | 'blocked';
    try {
      await navigator.clipboard.writeText(JSON.stringify(entry, null, 2));
      result = 'copied';
    } catch {
      result = 'blocked';
    }
    if (selected === entry && copyStatus === 'copying') copyStatus = result;
  };
</script>

{#snippet filters()}
  <div class="event-filters">
    <SearchSelect label={t('event-type')} bind:value={type} options={filterOptions} />
    <label>{t('event-search')}<input type="search" autocomplete="off" bind:value={search} /></label>
  </div>
{/snippet}

{#snippet list()}
  <ul class="event-list">
    {#each matches as entry (entry.id)}
      <li>
        <button class="event-row" type="button" onclick={() => show({ entry })} aria-haspopup="dialog">
          <strong class="wrap">{t(eventType({ entry }))}</strong>
          <time datetime={new Date(dateFor({ entry })).toISOString()}>{formatLocalTimestamp(dateFor({ entry }))}</time>
          <span class="muted wrap">{eventStatus({ entry })}{#if entry.event.source} · {entry.event.source}{/if}</span>
        </button>
      </li>
    {:else}
      <li class="muted event-empty">{t(events.length ? 'event-no-matches' : 'event-empty')}</li>
    {/each}
  </ul>
{/snippet}

<section class="panel event-feed" aria-labelledby={id + '-title'}>
  <div class="row between panel-title">
    <h2 id={id + '-title'}>{t('event-feed')}</h2>
    <button class="icon-button" type="button" title={t('event-expand')} aria-label={t('event-expand')}
      aria-haspopup="dialog" onclick={() => show()}>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />
      </svg>
    </button>
  </div>
  {@render filters()}
  {#if historyError}<p class="notice" role="status">{t('history-unavailable')}</p>{/if}
  {@render list()}
</section>

<dialog class="event-dialog" bind:this={dialog} use:dismissOnBackdrop aria-labelledby={id + '-dialog'} onclose={close}>
  {#if open}
    <div class="stack">
      <div class="row between panel-title">
        <h2 id={id + '-dialog'} bind:this={title} tabindex="-1">{t(selected ? 'event-details' : 'event-feed')}</h2>
        <div class="row">
          {#if selected && expanded}<button type="button" onclick={() => show()}>{t('event-back')}</button>{/if}
          {#if selected}
            {@const entry = selected}
            <button type="button" onclick={() => copyJson({ entry })} disabled={copyStatus === 'copying'}>{t('event-copy-json')}</button>
          {/if}
          <form method="dialog"><button>{t('close')}</button></form>
        </div>
      </div>
      {#if selected}
        {@const entry = selected}
        {@const event = entry.event}
        {#if copyStatus === 'copied'}
          <p class="muted" role="status">{t('event-json-copied')}</p>
        {:else if copyStatus === 'blocked'}
          <p class="notice" role="status">{t('event-json-copy-blocked')}</p>
          <label>{t('event-json')}
            <textarea rows="8" readonly value={JSON.stringify(entry, null, 2)} onfocus={event => event.currentTarget.select()}></textarea>
          </label>
        {/if}
        <h3 class="wrap">{t(eventType({ entry }))}</h3>
        <dl class="event-metadata">
          <dt>{t('event-received')}</dt>
          <dd><time datetime={new Date(dateFor({ entry })).toISOString()}>{formatLocalTimestamp(dateFor({ entry }))}</time></dd>
          <dt>{t('event-state')}</dt><dd>{eventStatus({ entry })}</dd>
          {#if event.source}<dt>{t('event-source')}</dt><dd>{event.source}</dd>{/if}
          {#if event.vendorTopic}<dt>{t('event-vendor-topic')}</dt><dd>{event.vendorTopic}</dd>{/if}
          {#if event.ruleId}<dt>{t('event-rule')}</dt><dd>{event.ruleId}</dd>{/if}
          {#if event.cameraTime}<dt>{t('event-camera-time')}</dt>
            <dd><time datetime={event.cameraTime}>{formatLocalTimestamp(event.cameraTime)}</time></dd>
          {/if}
        </dl>
        {#if event.objects?.length}
          {#if !event.objects.some(({ box }) => [box.left, box.top, box.right, box.bottom].some(Number.isFinite))}
            <p class="muted">{t('event-coordinates-unavailable')}</p>
          {/if}
          <section class="grid" aria-label={t('event-object-details')}>
            {#each event.objects as object}
              {@const coordinates = [
                { label: 'event-left', value: object.box.left }, { label: 'event-top', value: object.box.top },
                { label: 'event-right', value: object.box.right }, { label: 'event-bottom', value: object.box.bottom },
                { label: 'event-space', value: object.box.coordinateSpace },
                { label: 'event-reference-frame', value: object.box.referenceFrame },
                { label: 'event-frame-width', value: object.box.frameWidth }, { label: 'event-frame-height', value: object.box.frameHeight }
              ].filter(field => field.value !== undefined)}
              <article class="panel stack">
                <h3>{object.class ? t(object.class) : t('event-object')}</h3>
                {#if object.confidence !== undefined || object.trackId !== undefined}
                  <dl class="event-metadata">
                    {#if object.confidence !== undefined}<dt>{t('event-confidence')}</dt><dd>{object.confidence}</dd>{/if}
                    {#if object.trackId !== undefined}<dt>{t('event-track')}</dt><dd>{object.trackId}</dd>{/if}
                  </dl>
                {/if}
                {#if coordinates.length}
                  <div>
                    <h4>{t('event-bounds')}</h4>
                    <dl class="event-metadata">
                      {#each coordinates as field (field.label)}<dt>{t(field.label)}</dt><dd>{field.value}</dd>{/each}
                    </dl>
                  </div>
                {/if}
              </article>
            {/each}
          </section>
        {/if}
      {:else}
        {@render filters()}
        {@render list()}
      {/if}
    </div>
  {/if}
</dialog>
