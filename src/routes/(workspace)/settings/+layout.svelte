<script lang="ts">
  import { page } from '$app/state';
  import { t } from '$lib/api.js';
  import { useWorkspace } from '$lib/workspace.js';

  let { children } = $props();
  const workspace = useWorkspace();
  const general = [
    { path: 'appearance', label: 'appearance' },
    { path: 'cameras', label: 'camera-settings' }
  ];
  const administration = [
    { path: 'appearance-defaults', label: 'appearance-defaults' },
    { path: 'accounts', label: 'accounts' },
    { path: 'access', label: 'grants' },
    { path: 'events', label: 'event-history' },
    { path: 'bridges', label: 'bridges' },
    { path: 'callbacks', label: 'callbacks' },
    { path: 'enrollment', label: 'enrollment-nav' }
  ];
</script>

<h1>{t('settings')}</h1>
<div class="settings-layout">
  <nav class="panel stack settings-nav" aria-label={t('settings-nav')}>
    {#each general as section (section.path)}
      {@const href = '/settings/' + section.path}
      <a class="button" {href} aria-current={page.url.pathname === href ? 'page' : undefined}>{t(section.label)}</a>
    {/each}
    {#if workspace.current().user.admin}
      <div class="nav-divider"></div>
      <p class="muted">{t('administration')}</p>
      {#each administration as section (section.path)}
        {@const href = '/settings/' + section.path}
        <a class="button" {href} aria-current={page.url.pathname === href ? 'page' : undefined}>{t(section.label)}</a>
      {/each}
    {/if}
  </nav>
  <div class="stack settings-content">
    {@render children()}
  </div>
</div>
