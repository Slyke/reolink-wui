<script lang="ts">
  import { t } from '$lib/api.js';
  import { useAdministration, useWorkspace } from '$lib/workspace.js';
  import Callbacks from '$lib/Callbacks.svelte';

  const admin = useAdministration();
  const workspace = useWorkspace();
  const data = $derived(admin.current());
</script>

<svelte:head><title>{t('callbacks')} · {t('title')}</title></svelte:head>

{#if data.bridges.some(bridge => bridge.callbacks)}
  <Callbacks csrf={workspace.current().csrf} bridges={data.bridges} cameras={data.cameras} />
{:else}
  <section class="panel stack">
    <h2 class="panel-title">{t('callbacks')}</h2>
    <p class="muted">{t('callbacks-unavailable')}</p>
  </section>
{/if}
