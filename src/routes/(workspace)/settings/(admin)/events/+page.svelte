<script lang="ts">
  import { onMount } from 'svelte';
  import { api, errorText, t } from '$lib/api.js';
  import ConnectionTls from '$lib/ConnectionTls.svelte';
  import SearchSelect from '$lib/SearchSelect.svelte';
  import { useAdministration, useWorkspace } from '$lib/workspace.js';
  import { maxEventRetention } from '../../../../../../shared/events.js';
  import type { HistorySettings, HistoryStorage, ValkeyTestResult } from '../../../../../../shared/history.js';

  const admin = useAdministration();
  const workspace = useWorkspace();
  let settings = $state<HistorySettings>();
  let mode = $state<HistoryStorage['mode']>('defaults');
  let limit = $state<number>();
  let endpoint = $state(''), keyPrefix = $state('reolink-wui'), ca = $state(''), password = $state('');
  let verify = $state(true), countEnabled = $state(true), timeoutEnabled = $state(false);
  let maxEvents = $state<number | undefined>(100), ttlSeconds = $state<number | undefined>(86400);
  const memorySelected = $derived(mode === 'memory' || (mode === 'defaults' && settings?.defaults.backend === 'memory'));
  let passwordConfigured = $state(false), clearPassword = $state(false);
  let error = $state(''), loading = $state(true);
  const connection = $derived({
    url: endpoint, rejectUnauthorized: verify,
    ...(ca.trim() ? { ca: ca.trim() } : {}),
    ...(clearPassword || password ? { password: clearPassword ? '' : password } : {})
  });
  const testDraft = $derived(mode === 'valkey' ? { mode, valkey: connection } :
    mode === 'defaults' && settings?.defaults.backend === 'valkey' ? { mode } : undefined);
  let testing = $state(false);
  let feedback = $state<{ text: string; failed: boolean }>();
  $effect(() => { void testDraft; feedback = undefined; });

  const testConnection = async () => {
    const draft = testDraft;
    if (!draft || testing) return;
    testing = true;
    feedback = undefined;
    try {
      const result = await api<ValkeyTestResult>({
        path: '/api/v1/admin/event-history/test', method: 'POST', body: draft, csrf: workspace.current().csrf
      });
      if (draft === testDraft) feedback = result.connected
        ? { text: t('history-test-passed', { ms: result.elapsedMs }), failed: false }
        : { text: t('history-test-' + result.failure), failed: true };
    } catch (err) {
      if (draft === testDraft) feedback = { text: errorText(err), failed: true };
    } finally { testing = false; }
  };

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
      verify = valkey?.rejectUnauthorized ?? true;
      countEnabled = valkey?.maxEvents !== null;
      timeoutEnabled = Boolean(valkey?.ttlSeconds);
      maxEvents = valkey?.maxEvents ?? data.limit;
      ttlSeconds = valkey?.ttlSeconds ?? 86400;
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
      mode, valkey: { ...connection, keyPrefix, maxEvents: countEnabled ? maxEvents : null, ttlSeconds: timeoutEnabled ? ttlSeconds : null }
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
        <ConnectionTls secure={endpoint.toLowerCase().startsWith('rediss:')} bind:ca bind:verify disabled={admin.busy()} />
        <fieldset class="stack">
          <legend>{t('history-valkey-retention')}</legend>
          <label class="check"><input type="checkbox" bind:checked={countEnabled} disabled={admin.busy()} />{t('history-valkey-count-enabled')}</label>
          {#if countEnabled}
            <label>{t('history-valkey-count')}<input type="number" min="0" max="1000000" step="1" bind:value={maxEvents} required disabled={admin.busy()} /></label>
          {/if}
          <label class="check"><input type="checkbox" bind:checked={timeoutEnabled} disabled={admin.busy()} />{t('history-valkey-time-enabled')}</label>
          {#if timeoutEnabled}
            <label>{t('history-valkey-time')}<input type="number" min="1" max={365 * 86400} step="1" bind:value={ttlSeconds} required disabled={admin.busy()} /></label>
          {/if}
          <p class="muted">{t('history-valkey-hint')}</p>
          {#if !countEnabled && !timeoutEnabled}<p class="error">{t('history-valkey-require-limit')}</p>{/if}
        </fieldset>
      {/if}
      {#if memorySelected}
      <label class="retention-field">{t('history-limit')}
        <input type="number" min="0" max={maxEventRetention} step="1" bind:value={limit} required disabled={admin.busy()} />
      </label>
      <p class="muted">{t('history-limit-hint')}</p>
      {:else if mode === 'defaults'}
        <p class="muted">{t('history-default-valkey-limits', {
          count: settings.defaults.valkey?.maxEvents === null ? t('disabled') : settings.defaults.valkey?.maxEvents ?? settings.limit,
          seconds: settings.defaults.valkey?.ttlSeconds ?? t('disabled')
        })}</p>
      {/if}
      <p class="row"><span>{t('history-backend-' + settings.backend)}</span>
        <span class="pill" data-status={settings.connected ? 'online' : 'offline'}>{t(settings.connected ? 'online' : 'offline')}</span>
      </p>
      <div class="row">
        <button class="primary" disabled={admin.busy() || testing || (mode === 'valkey' && !countEnabled && !timeoutEnabled)}>{t('save')}</button>
        {#if testDraft}
          <button type="button" onclick={testConnection} disabled={admin.busy() || testing || (mode === 'valkey' && !endpoint.trim())}>
            {t(testing ? 'history-testing' : 'history-test')}
          </button>
        {/if}
      </div>
      {#if feedback}<p class:error={feedback.failed} role={feedback.failed ? 'alert' : 'status'}>{feedback.text}</p>{/if}
    </form>
  {:else}<div class="row"><button onclick={load}>{t('refresh')}</button></div>{/if}
</section>
