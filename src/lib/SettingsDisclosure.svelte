<script lang="ts">
  import type { Snippet } from 'svelte';

  let { title, open = false, ontoggle, children }: { title: string; open?: boolean; ontoggle?: (expanded: boolean) => void; children: Snippet } = $props();
  const heading = $props.id();
</script>

<details class="panel settings-disclosure" {open} aria-labelledby={heading} ontoggle={event => ontoggle?.(event.currentTarget.open)}>
  <summary class="panel-title"><h2 id={heading}>{title}</h2></summary>
  <div class="stack">{@render children()}</div>
</details>
