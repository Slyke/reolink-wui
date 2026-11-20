<script lang="ts">
  import { getContext, setContext, type Snippet } from 'svelte';
  import { t } from './api.js';

  let { title, open = false, managed = false, ontoggle, children }: { title: string; open?: boolean; managed?:boolean; ontoggle?: (expanded: boolean) => void; children: Snippet } = $props();
  const level = getContext<number>('camera-disclosure-level') ?? 2;
  setContext('camera-disclosure-level', level + 1);
  const heading = $props.id();
</script>

<details class="panel settings-disclosure" {open} aria-labelledby={heading} ontoggle={event => ontoggle?.(event.currentTarget.open)}>
  <summary class="panel-title"><svelte:element this={'h'+Math.min(level,6)} id={heading}>{title}</svelte:element>
    {#if managed}<span class="managed-setting">{t('managed-by-wui')}</span>{/if}
  </summary>
  <div class="stack">{@render children()}</div>
</details>
