<script lang="ts">
  import { onMount } from 'svelte';
  import { api, errorText, t, operationId, outcomeText, type Outcome } from './api.js';
  type User = { username: string; administrator: boolean; bridgeLogin: boolean };
  type Accounts = { users: User[]; writable: boolean; requiresUid: boolean };
  let { base, csrf, online }: { base: string; csrf: string; online: boolean } = $props();
  let accounts = $state<Accounts>(), selected = $state('');
  let password = $state(''), repeat = $state(''), uid = $state('');
  let busy = $state(false), failure = $state(''), message = $state('');
  const id = $props.id();
  const target = $derived(accounts?.users.find(user => user.username === selected));
  const valid = $derived(!!target && /^[ -~]{8,31}$/.test(password) && password === repeat && (!accounts?.requiresUid || /^[a-zA-Z0-9]{8,40}$/.test(uid)));
  const clear = () => { password = ''; repeat = ''; uid = ''; selected = ''; };
  async function load() {
    busy = true; failure = ''; clear();
    try { accounts = await api<Accounts>({ path: base + '/users' }); }
    catch (error) { accounts = undefined; failure = errorText(error); }
    finally { busy = false; }
  }
  async function change() {
    if (!valid || !online || !accounts?.writable || busy || !confirm(t('camera-user-confirm', { name: selected }))) return;
    busy = true; failure = ''; message = '';
    try {
      const value = await api<Outcome>({ path: base + '/users/password', method: 'POST', csrf,
        body: { operationId: operationId(), username: selected, password, uid: uid || undefined, confirmation: true } });
      const status = value.data?.status;
      message = outcomeText(value) + (status ? ' · ' + t(status === 'recovery-required' ? 'camera-user-unknown' : 'enrollment-status-' + status) : '');
      if (status === 'restart-required' || status === 'recovery-required' && target?.bridgeLogin) accounts = { ...accounts, writable: false };
      clear();
    } catch (error) { failure = errorText(error); password = ''; repeat = ''; }
    finally { busy = false; }
  }
  onMount(() => { void load(); });
</script>
<section class="panel stack" aria-labelledby={id}>
  <div class="row between panel-title"><h2 id={id}>{t('camera-users')}</h2><button disabled={busy} onclick={load}>{t('camera-users-reload')}</button></div>
  <p class="muted">{t('camera-users-help')}</p>
  {#if failure}<p class="error" role="alert">{failure}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if accounts}
    <ul class="events">{#each accounts.users as user (user.username)}
      <li class="row"><strong>{user.username}</strong><span>{t(user.administrator ? 'camera-user-admin' : 'camera-user-member')}</span>
        {#if user.bridgeLogin}<small>{t('camera-user-bridge')}</small>{/if}
        {#if accounts.writable}
          <button disabled={busy || !online} aria-label={t('camera-user-change') + ' · ' + user.username}
            onclick={() => { clear(); selected = user.username; message = ''; }}>{t('camera-user-change')}</button>
        {/if}
      </li>
    {/each}</ul>
    {#if !accounts.writable}<p class="muted">{t('camera-user-no-write')}</p>{/if}
    {#if target && accounts.writable}
      <form class="stack" onsubmit={event => { event.preventDefault(); void change(); }}>
        <strong>{target.username}</strong>
        {#if target.bridgeLogin}<small>{t('camera-user-bridge-help')}</small>{/if}
        {#if accounts.requiresUid}
          <label>{t('camera-user-uid')}<input bind:value={uid} autocomplete="off" minlength="8" maxlength="40" required /></label>
          <small>{t('camera-user-uid-help')}</small>
        {/if}
        <div class="form-grid">
          <label>{t('camera-user-new')}<input type="password" bind:value={password} autocomplete="new-password" minlength="8" maxlength="31" required /></label>
          <label>{t('camera-user-repeat')}<input type="password" bind:value={repeat} autocomplete="new-password" minlength="8" maxlength="31" required /></label>
        </div>
        <small>{t('camera-password-hint')}</small>
        <div class="row"><button class="danger" disabled={!valid || busy || !online}>{t('camera-user-change')}</button>
          <button type="button" disabled={busy} onclick={clear}>{t('cancel')}</button></div>
      </form>
    {/if}
  {/if}
</section>
