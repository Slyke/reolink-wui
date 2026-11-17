<script lang="ts">
  import { t } from '$lib/api.js';
  import type { Account } from '$lib/models.js';
  import { useAdministration, useWorkspace } from '$lib/workspace.js';

  const admin = useAdministration();
  const workspace = useWorkspace();
  const data = $derived(admin.current());
  const defaultLocal = () => admin.current().local;
  let local = $state(defaultLocal());
  let label = $state(''), username = $state(''), password = $state(''), subject = $state('');

  const create = async () => {
    try {
      const body = {
        label,
        local: local ? { username, password } : undefined,
        identity: subject ? { subject } : undefined
      };
      if (await admin.mutate({ suffix: '/accounts', body })) {
        label = '';
        username = '';
        subject = '';
      }
    } finally {
      password = '';
    }
  };

  const toggle = ({ item }: { item: Account }) => {
    if (item.enabled && !confirm(t('confirm-disable'))) return;
    void admin.mutate({ suffix: '/accounts/' + item.id, method: 'PATCH', body: { enabled: !item.enabled, confirmation: true } });
  };
</script>

<svelte:head><title>{t('accounts')} · {t('title')}</title></svelte:head>

<section class="panel stack" aria-labelledby="accounts-title">
  <h2 id="accounts-title" class="panel-title">{t('accounts')}</h2>
  <ul class="events">
    {#each data.accounts as item (item.id)}
      <li class="row between">
        <span class="wrap">{item.label} {#if item.username}<small>· {item.username}</small>{/if}</span>
        {#if item.admin}
          <small class="pill">{t('instance-administrator')}</small>
        {:else if item.id !== workspace.current().user.id}
          <button disabled={admin.busy()} onclick={() => toggle({ item })}>{t(item.enabled ? 'account-disable' : 'account-enable')}</button>
        {/if}
      </li>
    {/each}
  </ul>
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
    {#if data.external}<label>{t('external-subject')}<input autocomplete="off" bind:value={subject} required={!local} /></label>{/if}
    <div class="row"><button class="primary" disabled={admin.busy()}>{t('new-account')}</button></div>
  </form>
</section>
