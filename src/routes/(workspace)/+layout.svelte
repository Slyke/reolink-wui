<script lang="ts">
  import { afterNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onDestroy, onMount, setContext } from 'svelte';
  import { api, errorText, t } from '$lib/api.js';
  import { dismissOnBackdrop } from '$lib/dialog.js';
  import type { SessionView } from '$lib/models.js';
  import { useAppearance, workspaceKey, type SignedIn, type WorkspaceContext } from '$lib/workspace.js';

  let { children } = $props();
  const appearance = useAppearance();
  let session = $state<SignedIn>();
  let error = $state('');
  let busy = $state(false);
  let drawer = $state<HTMLDialogElement>();
  let menuOpen = $state(false);
  const closeMenu = () => { if (drawer?.open) drawer.close(); };
  afterNavigate(closeMenu);

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
  onMount(() => {
    void refreshSession();
    const mobile = window.matchMedia('(max-width: 800px)');
    const resize = () => { if (!mobile.matches) closeMenu(); };
    mobile.addEventListener('change',resize);
    return () => mobile.removeEventListener('change',resize);
  });
  onDestroy(() => appearance.setAccount({}));
  const links = [
    { href: '/dashboard', label: 'dashboard' },
    { href: '/monitor', label: 'monitor' },
    { href: '/recordings', label: 'recordings' },
    { href: '/settings', label: 'settings' },
    { href: '/status', label: 'status-page' }
  ];
</script>

{#snippet navigation()}
  {#each links as item (item.href)}
    <a class="button" href={item.href} onclick={closeMenu}
      aria-current={page.url.pathname === item.href || page.url.pathname.startsWith(item.href + '/') ? 'page' : undefined}>{t(item.label)}</a>
  {/each}
{/snippet}

<header class="mast">
  <div class="mast-inner">
    {#if session}
      <button class="icon-button mobile-menu-toggle" aria-label={t('open-menu')} title={t('open-menu')}
        aria-haspopup="dialog" aria-controls="workspace-drawer" aria-expanded={menuOpen}
        onclick={() => {drawer?.showModal(); menuOpen = true;}}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
      </button>
    {/if}
    <strong class="brand">{t('title')}</strong>
    {#if session}
      <nav class="row workspace-nav" aria-label={t('main-nav')}>{@render navigation()}</nav>
      <div class="row mast-account"><span class="muted wrap">{session.user.label}</span><button disabled={busy} onclick={signOut}>{t('sign-out')}</button></div>
    {/if}
  </div>
</header>
{#if session}
  <dialog id="workspace-drawer" class="workspace-drawer" bind:this={drawer} aria-labelledby="mobile-menu-title"
    onclose={() => menuOpen = false} use:dismissOnBackdrop={closeMenu}>
    <div class="row between panel-title">
      <h2 id="mobile-menu-title">{t('main-menu')}</h2>
      <button class="icon-button" aria-label={t('close-menu')} onclick={closeMenu}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button>
    </div>
    <nav class="stack" aria-label={t('main-nav')}>{@render navigation()}</nav>
    <div class="drawer-account stack"><span class="muted wrap">{session.user.label}</span><button disabled={busy} onclick={signOut}>{t('sign-out')}</button></div>
  </dialog>
{/if}

<main class="shell stack">
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if session}
    {@render children()}
  {:else if !error}
    <p role="status">{t('loading')}</p>
  {/if}
</main>
