<script lang="ts">
  import SettingsDisclosure from './SettingsDisclosure.svelte';
  import { api, errorText, t, operationId, outcomeText, type Outcome } from './api.js';
  type User = { username: string; administrator: boolean; bridgeLogin: boolean };
  type Accounts = { users: User[]; writable: boolean; requiresUid: boolean };
  let { base, csrf, online }: { base: string; csrf: string; online: boolean } = $props();
  let accounts = $state<Accounts>(), selected = $state('');
  let password = $state(''), repeat = $state(''), uid = $state('');
  let busy = $state(false), failure = $state(''), message = $state('');
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
  function toggle(expanded: boolean) {
    if (expanded && !accounts && !busy && !failure) void load();
  }
</script>
<SettingsDisclosure title={t('camera-users')} ontoggle={toggle}>
  <div class="row between">
    <p class="muted">{t('camera-users-help')}</p>
    <button disabled={busy} onclick={load}>{t('camera-users-reload')}</button>
  </div>
  {#if failure}<p class="error" role="alert">{failure}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if busy && !accounts}<p role="status">{t('loading')}</p>{/if}
  {#if accounts}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users can scroll the table horizontally.) -->
    <div class="table-scroll table-surface" role="region" aria-label={t('camera-users')} tabindex="0">
      <table class="status-table camera-accounts-table" aria-label={t('camera-users')}>
        <thead><tr>
          <th scope="col">{t('username')}</th>
          <th scope="col">{t('camera-user-role')}</th>
          <th scope="col">{t('camera-user-bridge')}</th>
          {#if accounts.writable}<th scope="col">{t('camera-user-actions')}</th>{/if}
        </tr></thead>
        <tbody>
          {#each accounts.users as user (user.username)}
            <tr>
              <th scope="row">{user.username}</th>
              <td>{t(user.administrator ? 'camera-user-admin' : 'camera-user-member')}</td>
              <td>{t(user.bridgeLogin ? 'yes' : 'no')}</td>
              {#if accounts.writable}
                <td><button disabled={busy || !online} aria-label={t('camera-user-change') + ' · ' + user.username}
                  onclick={() => { clear(); selected = user.username; message = ''; }}>{t('camera-user-change')}</button></td>
              {/if}
            </tr>
          {:else}
            <tr><td colspan={accounts.writable ? 4 : 3}>{t('camera-users-empty')}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
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
</SettingsDisclosure>
