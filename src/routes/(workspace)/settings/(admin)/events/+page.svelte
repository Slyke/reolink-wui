<script lang="ts">
  import { onMount } from 'svelte';
  import { api, errorText, t } from '$lib/api.js';
  import SearchSelect from '$lib/SearchSelect.svelte';
  import { useAdministration } from '$lib/workspace.js';
  import { maxEventRetention } from '../../../../../../shared/events.js';
  import type { HistorySettings, HistoryStorage } from '../../../../../../shared/history.js';

  const admin = useAdministration();
  let settings = $state<HistorySettings>();
  let mode = $state<HistoryStorage['mode']>('defaults');
  let limit = $state<number>();
  let endpoint = $state(''), keyPrefix = $state('reolink-wui'), ca = $state(''), password = $state('');
  let passwordConfigured = $state(false), clearPassword = $state(false);
  let error = $state(''), loading = $state(true);
  const load = async () => {
    loading = true;
    try {
      const data = await api<HistorySettings>({ path: '/api/v1/admin/event-history' });
      settings = data;
      mode = data.storage.mode;
      limit = data.limit;
      const valkey = data.storage.valkey ?? data.defaults.valkey;
      endpoint = valkey?.url ?? '';
      keyPrefix = valkey?.keyPrefix ?? 'reolink-wui';
      ca = valkey?.ca ?? '';
      passwordConfigured = valkey?.passwordConfigured ?? false;
      password = '';
      clearPassword = false;
      error = '';
    } catch (err) { error = errorText(err); }
    finally { loading = false; }
  };
  const save = async () => {
    if (limit === undefined) return;
    const storage = mode === 'valkey' ? {
      mode, valkey: { url: endpoint, keyPrefix, ...(ca.trim() ? { ca: ca.trim() } : {}),
        ...(clearPassword || password ? { password: clearPassword ? '' : password } : {}) }
    } : { mode };
    if (await admin.mutate({ suffix: '/event-history', method: 'PUT', body: { limit, storage } })) await load();
  };
  onMount(() => { void load(); });
</script>

<svelte:head><title>{t('event-history')} · {t('title')}</title></svelte:head>
<section class="panel stack" aria-labelledby="history-title">
  <h2 id="history-title" class="panel-title">{t('event-history')}</h2>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if loading}<p role="status">{t('loading')}</p>
  {:else if settings}
    <form class="stack" onsubmit={event => { event.preventDefault(); void save(); }}>
      <SearchSelect label={t('history-storage')} value={mode} disabled={admin.busy()}
        options={['defaults','memory','valkey'].map(value => ({ value, label: t('history-mode-' + value) }))}
        onchange={({ value }) => mode = value as HistoryStorage['mode']} />
      {#if mode === 'defaults'}
        <p class="muted">{t('history-defaults', { backend: t('history-backend-' + settings.defaults.backend) })}</p>
        {#if settings.defaults.valkey}<code class="wrap">{settings.defaults.valkey.url}</code>{/if}
      {:else if mode === 'valkey'}
        <div class="form-grid">
          <label>{t('history-endpoint')}<input type="url" bind:value={endpoint} placeholder="redis://valkey:6379/0" required disabled={admin.busy()} /></label>
          <label>{t('history-key-prefix')}<input bind:value={keyPrefix} pattern="[a-zA-Z0-9:_-]+" maxlength="80" required disabled={admin.busy()} /></label>
        </div>
        <label>{t('password')}<input type="password" bind:value={password} autocomplete="new-password"
          placeholder={passwordConfigured ? t('secret-saved') : ''} disabled={admin.busy() || clearPassword} /></label>
        {#if passwordConfigured}<label class="check"><input type="checkbox" bind:checked={clearPassword} disabled={admin.busy()} />{t('secret-clear-password')}</label>{/if}
        <label>{t('connection-ca')}<textarea bind:value={ca} rows="5" placeholder="-----BEGIN CERTIFICATE-----" disabled={admin.busy()}></textarea></label>
      {/if}
      <label class="retention-field">{t('history-limit')}
        <input type="number" min="0" max={maxEventRetention} step="1" bind:value={limit} required disabled={admin.busy()} />
      </label>
      <p class="muted">{t('history-limit-hint')}</p>
      <p class="row"><span>{t('history-backend-' + settings.backend)}</span>
        <span class="pill" data-status={settings.connected ? 'online' : 'offline'}>{t(settings.connected ? 'online' : 'offline')}</span>
      </p>
      <div class="row"><button class="primary" disabled={admin.busy()}>{t('save')}</button></div>
    </form>
  {:else}<div class="row"><button onclick={load}>{t('refresh')}</button></div>{/if}
</section>
