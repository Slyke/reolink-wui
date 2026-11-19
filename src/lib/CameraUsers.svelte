<script lang="ts">
  import { tick } from 'svelte';
  import SettingsDisclosure from './SettingsDisclosure.svelte';
  import { api, errorText, t, operationId, outcomeText, type Outcome } from './api.js';
  type User = { username: string; administrator: boolean; bridgeLogin: boolean };
  type Accounts = { users: User[]; writable: boolean; manageAccounts: boolean; requiresUid: boolean; writeBlockReason?: string };
  type Action = 'add' | 'password' | 'remove';
  let { base, csrf, online, onrotation }: { base: string; csrf: string; online: boolean; onrotation?: (status: string) => void } = $props();
  let accounts = $state<Accounts>(), action = $state<Action>(), username = $state('');
  let role = $state<'user' | 'administrator'>('user'), password = $state(''), repeat = $state(''), uid = $state('');
  let busy = $state(false), failure = $state(''), message = $state('');
  let editor = $state<HTMLFormElement>();
  const target = $derived(accounts?.users.find(user => user.username === username));
  const primary = $derived(accounts?.users.some(user => user.bridgeLogin && user.username.toLowerCase() === 'admin'));
  const duplicate = $derived(action === 'add' && accounts?.users.some(user => user.username.toLowerCase() === username.toLowerCase()));
  const removable = (user: User) => !user.bridgeLogin && user.username.toLowerCase() !== 'admin' && (primary || !user.administrator);
  const permitted = $derived(action === 'password' ? !!target && accounts?.writable : accounts?.manageAccounts &&
    (action === 'remove' ? !!target && removable(target) : !!username.trim() && !duplicate && (role === 'user' || primary)));
  const valid = $derived(permitted && (action === 'remove' || (/^[ -~]{8,31}$/.test(password) && password === repeat)) &&
    (!accounts?.requiresUid || /^[a-zA-Z0-9]{8,40}$/.test(uid)));
  function clear() { action = undefined; username = ''; password = ''; repeat = ''; uid = ''; role = 'user'; }
  async function begin(next: Action, name = '') {
    clear(); action = next; username = name; failure = ''; message = '';
    await tick();
    (editor?.querySelector<HTMLElement>('input, select, button'))?.focus();
  }
  async function load() {
    busy = true; failure = ''; clear();
    try { accounts = await api<Accounts>({ path: base + '/users' }); }
    catch (error) { accounts = undefined; failure = errorText(error); }
    finally { busy = false; }
  }
  async function save() {
    if (!action || !valid || !online || !accounts || busy) return;
    const prompt = action === 'password' ? 'camera-user-confirm' : 'camera-user-' + action + '-confirm';
    if (!confirm(t(prompt, { name: username, role: t(role === 'administrator' ? 'camera-user-admin' : 'camera-user-member') }))) return;
    busy = true; failure = ''; message = '';
    try {
      const intent = { operationId: operationId(), username, uid: uid || undefined, confirmation: true };
      const data = action === 'add' ? { ...intent, action, role, password } : action === 'remove' ? { ...intent, action } : { ...intent, password };
      const value = await api<Outcome>({ path: base + (action === 'password' ? '/users/password' : '/users'), method: 'POST', csrf, body: data });
      const status = value.data?.status;
      if (action === 'password') {
        message = outcomeText(value) + (status ? ' · ' + t(status === 'recovery-required' ? 'camera-user-unknown' : 'enrollment-status-' + status) : '');
        if (target?.bridgeLogin && status) {
          onrotation?.(status);
          if (['restart-required', 'recovery-required', 'in-progress'].includes(status)) {
            accounts = { ...accounts, writable: false, manageAccounts: false };
          }
        }
        clear();
      } else {
        message = status === 'verified' ? t(action === 'add' ? 'camera-user-created' : 'camera-user-removed', { name: username }) :
          status === 'recovery-required' ? t('camera-user-list-unknown') : outcomeText(value);
        await load();
      }
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
    <div class="row">
      {#if accounts?.manageAccounts}
        <button class="primary" disabled={busy || !online} onclick={() => begin('add')}>{t('camera-user-add')}</button>
      {/if}
      <button disabled={busy} onclick={load}>{t('camera-users-reload')}</button>
    </div>
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
                <td><div class="row">
                  <button disabled={busy || !online} aria-label={t('camera-user-change') + ' · ' + user.username}
                    onclick={() => begin('password', user.username)}>{t('camera-user-change')}</button>
                  {#if accounts.manageAccounts && removable(user)}
                    <button class="danger" disabled={busy || !online} aria-label={t('camera-user-remove') + ' · ' + user.username}
                      onclick={() => begin('remove', user.username)}>{t('camera-user-remove')}</button>
                  {/if}
                </div></td>
              {/if}
            </tr>
          {:else}
            <tr><td colspan={accounts.writable ? 4 : 3}>{t('camera-users-empty')}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if !accounts.writable}<p class="muted">{t(accounts.writeBlockReason ? 'camera-user-block-'+accounts.writeBlockReason : 'camera-user-no-write')}</p>
    {:else if !accounts.manageAccounts}<p class="muted">{t('camera-users-upgrade')}</p>{/if}
    {#if action && accounts.writable}
      <form class="stack" bind:this={editor} onsubmit={event => { event.preventDefault(); void save(); }}>
        {#if action === 'add'}
          <div class="form-grid">
            <label>{t('username')}<input disabled={busy} bind:value={username} autocomplete="off" maxlength="64" required /></label>
            <label>{t('camera-user-role')}<select aria-label={t('camera-user-role')} bind:value={role} disabled={busy}>
              <option value="user">{t('camera-user-member')}</option>
              {#if primary}<option value="administrator">{t('camera-user-admin')}</option>{/if}
            </select></label>
          </div>
          {#if duplicate}<small class="error">{t('camera-user-duplicate')}</small>{/if}
        {:else}
          <strong>{username}</strong>
          {#if target?.bridgeLogin}<small>{t('camera-user-bridge-help')}</small>{/if}
        {/if}
        {#if accounts.requiresUid}
          <label>{t('camera-user-uid')}<input disabled={busy} bind:value={uid} autocomplete="off" minlength="8" maxlength="40" required /></label>
          <small>{t('camera-user-uid-help')}</small>
        {/if}
        {#if action !== 'remove'}
          <div class="form-grid">
            <label>{t('camera-user-new')}<input type="password" disabled={busy} bind:value={password} autocomplete="new-password" minlength="8" maxlength="31" required /></label>
            <label>{t('camera-user-repeat')}<input type="password" disabled={busy} bind:value={repeat} autocomplete="new-password" minlength="8" maxlength="31" required /></label>
          </div>
          <small>{t('camera-password-hint')}</small>
        {/if}
        <div class="row"><button class:danger={action !== 'add'} class:primary={action === 'add'} disabled={!valid || busy || !online}>
          {t(action === 'password' ? 'camera-user-change' : action === 'add' ? 'camera-user-create' : 'camera-user-remove')}</button>
          <button type="button" disabled={busy} onclick={clear}>{t('cancel')}</button></div>
      </form>
    {/if}
  {/if}
</SettingsDisclosure>
