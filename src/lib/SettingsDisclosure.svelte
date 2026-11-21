<script lang="ts">
  import { getContext, setContext, type Snippet } from 'svelte';

  let { title, open = false, ontoggle, children }: { title: string; open?: boolean; ontoggle?: (expanded: boolean) => void; children: Snippet } = $props();
  const level = getContext<number>('camera-disclosure-level') ?? 2;
  setContext('camera-disclosure-level', level + 1);
  const heading = $props.id();
</script>

<details class="panel settings-disclosure" {open} aria-labelledby={heading} ontoggle={event => ontoggle?.(event.currentTarget.open)}>
  <summary class="panel-title"><svelte:element this={'h'+Math.min(level,6)} id={heading}>{title}</svelte:element></summary>
  <div class="stack">{@render children()}</div>
</details>
