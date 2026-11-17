<script lang="ts">
  import { t } from '$lib/api.js';
  import { useAdministration } from '$lib/workspace.js';
  import { permissions, presets, type Permission } from '../../../../../../shared/access.js';
  import SearchSelect from '$lib/SearchSelect.svelte';

  const admin = useAdministration();
  const data = $derived(admin.current());
  let account = $state(''), camera = $state('');
  let picked = $state<Permission[]>([]);
  const administrator = $derived(data.accounts.some(item => item.id === account && item.admin === 1));
  const grantPresets = { none: [] as Permission[], ...presets };
  const selectedPreset = $derived(Object.entries(grantPresets).find(([, items]) =>
    items.length === picked.length && items.every(item => picked.includes(item))
  )?.[0] ?? 'custom');
  let existingSubject = $state('');

  const loadGrant = () => {
    picked = [...(data.grants.find(item => item.account_id === account && item.camera_id === camera)?.permissions ?? [])];
  };
  const linkIdentity = async () => {
    if (await admin.mutate({ suffix: '/accounts/' + account + '/identities', body: { identity: { subject: existingSubject } } })) {
      existingSubject = '';
    }
  };
  const saveGrant = () => admin.mutate({
    suffix: '/accounts/' + account + '/grants/' + camera, method: 'PUT',
    body: { preset: 'none', allow: picked, deny: [] }
  });
</script>

<svelte:head><title>{t('grants')} · {t('title')}</title></svelte:head>

<section class="panel stack" aria-labelledby="grants-title">
  <h2 id="grants-title" class="panel-title">{t('grants')}</h2>
  <div class="form-grid">
    <SearchSelect label={t('account')} bind:value={account} onchange={loadGrant}
      options={data.accounts.map(item => ({ value: item.id, label: item.label, detail: item.username }))} />
    <SearchSelect label={t('camera-noun')} bind:value={camera} disabled={administrator} onchange={loadGrant}
      options={data.cameras.map(item => ({ value: item.id, label: item.label, group: data.bridges.find(bridge => bridge.id === item.bridge)?.label }))} />
  </div>
  {#if account && data.external}
    <form class="row" onsubmit={event => { event.preventDefault(); void linkIdentity(); }}>
      <label>{t('external-subject')}<input autocomplete="off" required bind:value={existingSubject} /></label>
      <button disabled={admin.busy()}>{t('account-external')}</button>
    </form>
  {/if}
  {#if administrator}
    <p class="muted">{t('admin-full-access')}</p>
  {:else if account && camera}
    <label>{t('grant-preset')}<select value={selectedPreset} onchange={event => {
      const preset = event.currentTarget.value as keyof typeof grantPresets;
      picked = [...grantPresets[preset]];
    }}>
      {#if selectedPreset === 'custom'}<option value="custom" disabled>{t('grant-custom')}</option>{/if}
      {#each Object.keys(grantPresets) as item}<option value={item}>{t('grant-' + item)}</option>{/each}
    </select></label>
    <fieldset class="grant-list">
      <legend>{t('grants')}</legend>
      {#each permissions as item}
        <label class="check"><input type="checkbox" value={item} bind:group={picked} />{t('grant-permission-' + item)}</label>
      {/each}
    </fieldset>
    <div class="row"><button class="primary" disabled={admin.busy()} onclick={saveGrant}>{t('save-grant')}</button></div>
  {:else if data.cameras.length}
    <p class="muted">{t('grant-choose')}</p>
  {:else}
    <p class="muted">{t('grant-no-inventory')} <a href="/settings/bridges">{t('bridges')}</a></p>
  {/if}
</section>
