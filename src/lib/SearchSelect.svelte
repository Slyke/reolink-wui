<script lang="ts" module>
  export type SearchOption = { value: string; label: string; detail?: string; group?: string };
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import { t } from './api.js';

  let { label, options, value = $bindable(''), disabled = false, onchange }: {
    label: string;
    options: SearchOption[];
    value?: string;
    disabled?: boolean;
    onchange?: ({ value }: { value: string }) => void;
  } = $props();

  const id = $props.id();
  let container: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let search = $state<HTMLInputElement>();
  let open = $state(false);
  let query = $state('');
  let highlighted = $state('');
  const selected = $derived(options.find(option => option.value === value));
  const matching = $derived(options.filter(option =>
    (option.label + ' ' + (option.detail ?? '')).toLowerCase().includes(query.trim().toLowerCase())
  ));
  const groupLabels = $derived([...new Set(matching.map(option => option.group ?? ''))]);
  const optionId = ({ option }: { option: SearchOption }) => id + '-option-' + matching.indexOf(option);
  const active = $derived(matching.find(option => option.value === highlighted) ?? matching[0]);

  const close = ({ restoreFocus = false }: { restoreFocus?: boolean } = {}) => {
    open = false;
    query = '';
    highlighted = '';
    if (restoreFocus) trigger?.focus();
  };

  const show = async ({ fromEnd = false }: { fromEnd?: boolean } = {}) => {
    if (disabled) return;
    open = true;
    highlighted = selected?.value ?? (fromEnd ? options.at(-1)?.value : options[0]?.value) ?? '';
    await tick();
    if (open) search?.focus();
  };

  const choose = ({ option }: { option: SearchOption }) => {
    value = option.value;
    close({ restoreFocus: true });
    onchange?.({ value });
  };

  const move = ({ event }: { event: KeyboardEvent }) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close({ restoreFocus: true });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (active) choose({ option: active });
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !matching.length) return;
    event.preventDefault();
    const index = active ? matching.indexOf(active) : 0;
    let next = 0;
    if (event.key === 'End') next = matching.length - 1;
    if (event.key === 'ArrowDown') next = (index + 1) % matching.length;
    if (event.key === 'ArrowUp') next = (index + matching.length - 1) % matching.length;
    const option = matching[next];
    highlighted = option.value;
    document.getElementById(optionId({ option }))?.scrollIntoView({ block: 'nearest' });
  };

  const outside = ({ event }: { event: PointerEvent | FocusEvent }) => {
    const target = event instanceof FocusEvent ? event.relatedTarget : event.target;
    if (open && target instanceof Node && !container.contains(target)) close();
  };
  $effect(() => { if (disabled && open) close(); });
</script>

<svelte:window onpointerdown={event => outside({ event })} />

<div class="select-field" bind:this={container} onfocusout={event => outside({ event })}>
  <span id={id + '-label'}>{label}</span>
  <button
    type="button"
    class="search-trigger"
    bind:this={trigger}
    aria-labelledby={id + '-label ' + id + '-value'}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={open ? id + '-list' : undefined}
    {disabled}
    onclick={() => { if (open) close(); else void show(); }}
    onkeydown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        void show({ fromEnd: event.key === 'ArrowUp' });
      }
    }}
  >
    <span id={id + '-value'}>{selected?.label ?? t('choose-option')}</span>
    <span class="chevron" aria-hidden="true">›</span>
  </button>
  {#if open}
    <div class="search-popover">
      <input
        bind:this={search}
        role="combobox"
        aria-label={t('search-options', { label })}
        placeholder={t('search')}
        autocomplete="off"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls={id + '-list'}
        aria-activedescendant={active ? optionId({ option: active }) : undefined}
        value={query}
        oninput={event => { query = event.currentTarget.value; highlighted = ''; }}
        onkeydown={event => move({ event })}
      />
      <div class="search-results" id={id + '-list'} role="listbox" aria-labelledby={id + '-label'}>
        {#each groupLabels as group (group)}
          <div role="group" aria-label={group || label}>
            {#if group}<p class="search-group muted" aria-hidden="true">{group}</p>{/if}
            {#each matching.filter(option => (option.group ?? '') === group) as option (option.value)}
              <button
                type="button"
                role="option"
                class="search-option"
                tabindex="-1"
                id={optionId({ option })}
                aria-selected={value === option.value}
                data-active={option.value === active?.value}
                onpointermove={() => highlighted = option.value}
                onpointerdown={event => event.preventDefault()}
                onclick={() => choose({ option })}
              >
                <strong>{option.label}</strong>
                {#if option.detail}<small>{option.detail}</small>{/if}
              </button>
            {/each}
          </div>
        {/each}
      </div>
      {#if matching.length === 0}<p class="search-empty muted">{t('search-empty')}</p>{/if}
      <span class="sr-only" aria-live="polite">{t(matching.length === 1 ? 'search-result' : 'search-results', { count: matching.length })}</span>
    </div>
  {/if}
</div>
