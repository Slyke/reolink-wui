<script lang="ts">
  import type { Snippet } from 'svelte';

  let { title, open = false, children }: { title: string; open?: boolean; children: Snippet } = $props();
</script>

<details class="panel settings-disclosure" {open}>
  <summary class="panel-title"><h2>{title}</h2></summary>
  <div class="stack">{@render children()}</div>
</details>
