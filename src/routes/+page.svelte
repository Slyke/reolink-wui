<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { api, errorText, t, url } from '$lib/api.js';
  import type { SessionView } from '$lib/models.js';

  let session = $state<SessionView>();
  let loading = $state(true), busy = $state(false);
  let error = $state('');
  let username = $state(''), password = $state('');

  const loadSession = async () => {
    try {
      session = await api<SessionView>({ path: '/api/v1/session' });
      if (session.user) await goto('/monitor', { replaceState: true });
    } catch (err) {
      error = errorText(err);
    } finally {
      loading = false;
    }
  };
  const signIn = async ({ method }: { method: 'local' | 'proxy' }) => {
    busy = true;
    error = '';
    try {
      const body = method === 'local' ? { username, password } : undefined;
      await api({ path: '/api/v1/session/' + method, method: 'POST', body });
      await goto('/monitor');
    } catch (err) {
      error = errorText(err);
    } finally {
      busy = false;
      password = '';
    }
  };
  onMount(() => { void loadSession(); });
</script>

<svelte:head><title>{t('sign-in')} · {t('title')}</title></svelte:head>

<header class="mast">
  <div class="mast-inner"><strong class="brand">{t('title')}</strong></div>
</header>

<main class="shell">
  <section class="login panel stack" aria-labelledby="login-title">
    <h1 id="login-title">{t('sign-in')}</h1>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if loading}
      <p role="status">{t('loading')}</p>
    {:else if !session?.user}
      {#if session?.methods?.local}
        <form class="stack" onsubmit={event => { event.preventDefault(); void signIn({ method: 'local' }); }}>
          <label>{t('username')}<input autocomplete="username" bind:value={username} required /></label>
          <label>{t('password')}<input type="password" autocomplete="current-password" bind:value={password} required /></label>
          <button class="primary" disabled={busy}>{t('local-signin')}</button>
        </form>
      {/if}
      {#if session?.methods?.proxy}<button disabled={busy} onclick={() => signIn({ method: 'proxy' })}>{t('proxy-signin')}</button>{/if}
      {#if session?.methods?.oidc}<a class="button primary" href={url('/api/v1/session/oidc/start')}>{t('oidc-signin')}</a>{/if}
      {#if session?.methods && !Object.values(session.methods).some(Boolean)}<p class="muted">{t('no-signin')}</p>{/if}
    {/if}
  </section>
</main>
