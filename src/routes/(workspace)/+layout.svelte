<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onDestroy, onMount, setContext } from 'svelte';
  import { api, errorText, t } from '$lib/api.js';
  import type { SessionView } from '$lib/models.js';
  import { useAppearance, workspaceKey, type SignedIn, type WorkspaceContext } from '$lib/workspace.js';

  let { children } = $props();
  const appearance = useAppearance();
  let session = $state<SignedIn>();
  let error = $state('');
  let busy = $state(false);

  const refreshSession = async () => {
    try {
      const current = await api<SessionView>({ path: '/api/v1/session' });
      if (current.user && current.csrf) {
        appearance.setAccount({ id: current.user.id });
        session = { user: current.user, csrf: current.csrf };
        error = '';
        return;
      }
      session = undefined;
      appearance.setAccount({});
      await goto('/', { replaceState: true });
    } catch (err) {
      session = undefined;
      appearance.setAccount({});
      error = errorText(err);
    }
  };

  const signOut = async () => {
    busy = true;
    try {
      await api({ path: '/api/v1/session', method: 'DELETE', csrf: session?.csrf });
      session = undefined;
      await goto('/');
    } catch (err) {
      error = errorText(err);
    } finally {
      busy = false;
    }
  };
  setContext<WorkspaceContext>(workspaceKey, { current: () => session!, refreshSession });
  onMount(() => { void refreshSession(); });
  onDestroy(() => appearance.setAccount({}));
  const links = [
    { href: '/dashboard', label: 'dashboard' },
    { href: '/monitor', label: 'monitor' },
    { href: '/settings', label: 'settings' },
    { href: '/status', label: 'status-page' }
  ];
</script>

<header class="mast">
  <div class="mast-inner">
    <strong class="brand">{t('title')}</strong>
    {#if session}
      <nav class="row workspace-nav" aria-label={t('main-nav')}>
        {#each links as item (item.href)}
          <a class="button" href={item.href} aria-current={page.url.pathname === item.href || page.url.pathname.startsWith(item.href + '/') ? 'page' : undefined}>
            {t(item.label)}
          </a>
        {/each}
      </nav>
      <span class="spacer"></span>
      <span class="muted wrap">{session.user.label}</span>
      <button disabled={busy} onclick={signOut}>{t('sign-out')}</button>
    {/if}
  </div>
</header>

<main class="shell stack">
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if session}
    {@render children()}
  {:else if !error}
    <p role="status">{t('loading')}</p>
  {/if}
</main>
