<script lang="ts">
  import { t } from '$lib/api.js';
  import { useAppearance } from '$lib/workspace.js';
  import AppearanceFields from '$lib/AppearanceFields.svelte';

  const appearance = useAppearance();
</script>

<svelte:head><title>{t('appearance')} · {t('title')}</title></svelte:head>

<section class="panel stack" aria-labelledby="appearance-title">
  <h2 id="appearance-title" class="panel-title">{t('appearance')}</h2>
  <p class="muted">{t('appearance-personal')}</p>
  <AppearanceFields settings={appearance.current()} choose={appearance.choose} />
  {#if appearance.customized()}
    <div class="row"><button onclick={appearance.reset}>{t('appearance-reset')}</button></div>
  {/if}
</section>
