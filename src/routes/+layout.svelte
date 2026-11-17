<script lang="ts">
  import { browser } from '$app/environment';
  import { onMount, setContext } from 'svelte';
  import { api } from '$lib/api.js';
  import { appearanceStorageKey, readPersonalAppearance, savePersonalAppearance } from '$lib/appearance.js';
  import { appearanceKey, type AppearanceContext } from '$lib/workspace.js';
  import { appearanceOverrides, defaultAppearance, type Appearance } from '../../shared/appearance.js';
  import '../theme.css';
  import '../style.css';

  let { data, children } = $props();
  let defaults = $state<Appearance>({ ...defaultAppearance });
  let choices = $state<Partial<Appearance>>({});
  let account: string | undefined;
  let latestDefaults = 0;
  const appearance = $derived({ ...defaults, ...choices });

  const setAccount: AppearanceContext['setAccount'] = ({ id }) => {
    if (!browser || account === id) return;
    account = id;
    choices = id ? readPersonalAppearance({ account: id }) : {};
  };
  const choose: AppearanceContext['choose'] = ({ key, value }) => {
    if (!account) return;
    const selected = appearanceOverrides({ [key]: value });
    if (selected[key] === undefined) return;
    choices = { ...choices, ...selected };
    savePersonalAppearance({ account, choices });
  };
  const reset = () => {
    if (!account) return;
    choices = {};
    savePersonalAppearance({ account, choices });
  };
  const replaceDefaults: AppearanceContext['replaceDefaults'] = ({ appearance }) => {
    latestDefaults++;
    defaults = { ...defaultAppearance, ...appearanceOverrides(appearance) };
  };
  setContext<AppearanceContext>(appearanceKey, {
    current: () => appearance,
    customized: () => Object.keys(choices).length > 0,
    choose, reset, setAccount, replaceDefaults
  });

  $effect.pre(() => {
    if (browser) {
      document.documentElement.dataset.apiBasePath = data.apiBasePath;
      for (const [key, value] of Object.entries(appearance)) document.documentElement.dataset[key] = value;
    }
  });

  onMount(() => {
    const revision = latestDefaults;
    const controller = new AbortController();
    void api<{ appearance: Appearance }>({ path: '/api/v1/appearance-defaults', signal: controller.signal }).then(result => {
      if (revision === latestDefaults && !controller.signal.aborted) replaceDefaults({ appearance: result.appearance });
    }).catch(() => {});
    return () => controller.abort();
  });
</script>

<svelte:window onstorage={event => {
  if (account && (event.key === null || event.key === appearanceStorageKey({ account }))) {
    choices = readPersonalAppearance({ account });
  }
}} />

{@render children()}
