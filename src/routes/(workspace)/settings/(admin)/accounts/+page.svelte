<script lang="ts">
  import { t } from '$lib/api.js';
  import ExternalIdentityFields from '$lib/ExternalIdentityFields.svelte';
  import type { Account } from '$lib/models.js';
  import { useAdministration, useWorkspace } from '$lib/workspace.js';
  import type { AccountType, ExternalType, GroupPolicy } from '../../../../../../shared/sign-in.js';

  const admin = useAdministration();
  const workspace = useWorkspace();
  const data = $derived(admin.current());
  let local = $state(admin.current().local);
  let label = $state(''), username = $state(''), password = $state(''), subject = $state('');
  let createType = $state<ExternalType>();
  let editing = $state(''), method = $state<AccountType>('local');
  let linkSubject = $state(''), linkUsername = $state(''), linkPassword = $state('');
  let groups = $state(admin.current().oidcGroups?.requiredGroups.join('\n') ?? '');
  let match = $state<GroupPolicy['requiredGroupsMode']>(admin.current().oidcGroups?.requiredGroupsMode ?? 'any');
  const requiredGroups = $derived(groups.split('\n').map(group => group.trim()).filter(Boolean));
  const groupChanged = $derived(data.oidcGroups && (match !== data.oidcGroups.requiredGroupsMode ||
    JSON.stringify(requiredGroups) !== JSON.stringify(data.oidcGroups.requiredGroups)));

  const create = async () => {
    try {
      if (await admin.mutate({ suffix: '/accounts', body: {
        label, local: local ? { username, password } : undefined,
        identity: subject ? { type: createType ?? data.externalTypes[0], subject } : undefined
      } })) { label = ''; username = ''; subject = ''; }
    } finally { password = ''; }
  };

  const available = (item: Account): AccountType[] => data.local && !item.types.includes('local')
    ? ['local', ...data.externalTypes] : data.externalTypes;
  const edit = (item?: Account) => {
    editing = item?.id ?? '';
    method = item ? available(item)[0] : 'local';
    linkSubject = ''; linkUsername = ''; linkPassword = '';
  };
  const link = async () => {
    const base = '/accounts/' + editing;
    try {
      const linked = method === 'local'
        ? await admin.mutate({ suffix: base + '/local', method: 'PUT', body: { username: linkUsername, password: linkPassword } })
        : await admin.mutate({ suffix: base + '/identities', body: { identity: { type: method, subject: linkSubject } } });
      if (linked) edit();
    } finally { linkPassword = ''; }
  };
  const toggle = (item: Account) => {
    if (item.enabled && !confirm(t('confirm-disable'))) return;
    void admin.mutate({ suffix: '/accounts/' + item.id, method: 'PATCH', body: { enabled: !item.enabled, confirmation: true } });
  };
  const remove = async (item: Account) => {
    if (!confirm(t('account-delete-confirm', { name: item.label }))) return;
    if (await admin.mutate({ suffix: '/accounts/' + item.id, method: 'DELETE', body: { confirmation: true } }) && editing === item.id) edit();
  };
  const saveGroups = async () => {
    if (await admin.mutate({ suffix: '/oidc-groups', method: 'PUT', body: { requiredGroups, requiredGroupsMode: match } })) {
      await workspace.refreshSession();
    }
  };
</script>

<svelte:head><title>{t('accounts')} · {t('title')}</title></svelte:head>

<section class="panel stack" aria-labelledby="accounts-title">
  <h2 id="accounts-title" class="panel-title">{t('accounts')}</h2>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users can scroll the table horizontally.) -->
  <div class="table-scroll table-surface" role="region" aria-labelledby="accounts-title" tabindex="0">
    <table class="status-table">
      <thead><tr><th scope="col">{t('account')}</th><th scope="col">{t('sign-in-type')}</th><th scope="col">{t('camera-user-actions')}</th></tr></thead>
      <tbody>{#each data.accounts as item (item.id)}
        <tr>
          <th scope="row" class="wrap">{item.label}
            {#if item.username && item.label !== item.username}<small> · {item.username}</small>{/if}
            {#if item.admin}<small class="pill">{t('instance-administrator')}</small>{/if}
            {#if !item.enabled}<small class="pill">{t('disabled')}</small>{/if}
          </th>
          <td>{item.types.map(type => t('type-' + type)).join(', ')}</td>
          <td><div class="row">
            {#if available(item).length}<button disabled={admin.busy()} onclick={() => edit(item)}>{t('account-add-method')}</button>{/if}
            {#if item.id !== workspace.current().user.id}
              {#if !item.admin}<button disabled={admin.busy()} onclick={() => toggle(item)}>{t(item.enabled ? 'account-disable' : 'account-enable')}</button>{/if}
              <button class="danger" disabled={admin.busy()} onclick={() => remove(item)}>{t('account-delete')}</button>
            {/if}
          </div></td>
        </tr>
        {#if editing === item.id}
          <tr><td colspan="3"><form class="stack" onsubmit={event => { event.preventDefault(); void link(); }}>
            <fieldset class="stack"><legend>{t('account-method-for', { name: item.label })}</legend>
              <div class="form-grid">
                <label>{t('sign-in-type')}<select bind:value={method}>{#each available(item) as type}<option value={type}>{t('type-' + type)}</option>{/each}</select></label>
                {#if method === 'local'}
                  <label>{t('username')}<input autocomplete="off" bind:value={linkUsername} required /></label>
                  <label>{t('password')}<input type="password" autocomplete="new-password" minlength="12" bind:value={linkPassword} required /></label>
                {:else}
                  <ExternalIdentityFields types={[method]} bind:subject={linkSubject} />
                {/if}
              </div>
              <div class="row"><button class="primary" disabled={admin.busy()}>{t('account-add-method')}</button>
                <button type="button" onclick={() => edit()}>{t('cancel')}</button></div>
            </fieldset>
          </form></td></tr>
        {/if}
      {/each}</tbody>
    </table>
  </div>
</section>

<section class="panel stack" aria-labelledby="add-account-title">
  <h2 id="add-account-title" class="panel-title">{t('new-account')}</h2>
  <form class="stack" onsubmit={event => { event.preventDefault(); void create(); }}>
    <label>{t('account-name')}<input autocomplete="off" maxlength="80" bind:value={label} required /></label>
    {#if data.local && data.external}
      <label class="check"><input type="checkbox" bind:checked={local} /> {t('account-local')}</label>
    {/if}
    {#if local}
      <div class="form-grid">
        <label>{t('username')}<input type="text" autocomplete="off" bind:value={username} required /></label>
        <label>{t('password')}<input type="password" autocomplete="new-password" minlength="12" bind:value={password} required /></label>
      </div>
    {/if}
    {#if data.external}<ExternalIdentityFields types={data.externalTypes} bind:type={createType} bind:subject required={!local} />{/if}
    <div class="row"><button class="primary" disabled={admin.busy()}>{t('new-account')}</button></div>
  </form>
</section>

{#if data.oidcGroups}
  <section class="panel stack" aria-labelledby="oauth-title">
    <h2 id="oauth-title" class="panel-title">{t('oidc-admission')}</h2>
    <form class="stack" onsubmit={event => { event.preventDefault(); void saveGroups(); }}>
      <label>{t('oidc-group')}<textarea rows="3" bind:value={groups} readonly={data.oidcGroups.fromConfig}></textarea></label>
      <label>{t('oidc-groups-match')}<select bind:value={match} disabled={data.oidcGroups.fromConfig}>
        <option value="any">{t('oidc-groups-any')}</option><option value="all">{t('oidc-groups-all')}</option>
      </select></label>
      <p class="muted">{t(data.oidcGroups.fromConfig ? 'oidc-group-config' : 'oidc-group-help')}</p>
      {#if !data.oidcGroups.fromConfig}<div class="row"><button class="primary" disabled={admin.busy() || !groupChanged}>{t('oidc-group-save')}</button></div>{/if}
    </form>
  </section>
{/if}
