<script lang="ts">
  import { t } from '$lib/api.js';
  import { useAppearance, useAdministration } from '$lib/workspace.js';
  import AppearanceFields from '$lib/AppearanceFields.svelte';
  import type { Appearance } from '../../../../../../shared/appearance.js';

  const admin = useAdministration();
  const appearance = useAppearance();
  const initial = () => ({ ...admin.current().appearanceDefaults });
  let draft = $state<Appearance>(initial());
  const choose = ({ key, value }: { key: keyof Appearance; value: string }) => { draft[key] = value; };
  const save = async () => {
    if (await admin.mutate({ suffix: '/appearance-defaults', method: 'PUT', body: { appearance: { ...draft } } })) {
      draft = initial();
      appearance.replaceDefaults({ appearance: draft });
    }
  };
</script>

<svelte:head><title>{t('appearance-defaults')} · {t('title')}</title></svelte:head>

<section class="panel stack" aria-labelledby="appearance-defaults-title">
  <h2 id="appearance-defaults-title" class="panel-title">{t('appearance-defaults')}</h2>
  <p class="muted">{t('appearance-defaults-help')}</p>
  <form class="stack" onsubmit={event => { event.preventDefault(); void save(); }}>
    <AppearanceFields settings={draft} {choose} disabled={admin.busy()} />
    <div class="row"><button class="primary" disabled={admin.busy()}>{t('appearance-save-defaults')}</button></div>
  </form>
</section>
