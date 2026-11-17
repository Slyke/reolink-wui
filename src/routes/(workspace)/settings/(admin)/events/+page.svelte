<script lang="ts">
  import { onMount } from 'svelte';
  import { api, errorText, t } from '$lib/api.js';
  import { useAdministration } from '$lib/workspace.js';
  import { maxEventRetention } from '../../../../../../shared/events.js';

  const admin = useAdministration();
  let backend = $state<'memory' | 'valkey'>();
  let limit = $state<number>();
  let error = $state('');
  let loading = $state(true);

  const load = async () => {
    loading = true;
    try {
      const settings = await api<{ backend: 'memory' | 'valkey'; limit: number }>({ path: '/api/v1/admin/event-history' });
      backend = settings.backend;
      limit = settings.limit;
      error = '';
    } catch (err) { error = errorText(err); }
    finally { loading = false; }
  };

  const save = async () => {
    if (await admin.mutate({ suffix: '/event-history', method: 'PUT', body: { limit } })) await load();
  };
  onMount(() => { void load(); });
</script>

<svelte:head><title>{t('event-history')} · {t('title')}</title></svelte:head>

<section class="panel stack" aria-labelledby="history-title">
  <h2 id="history-title" class="panel-title">{t('event-history')}</h2>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if loading}
    <p role="status">{t('loading')}</p>
  {:else if backend}
    <form class="stack" onsubmit={event => { event.preventDefault(); void save(); }}>
      <label class="retention-field">{t('history-limit')}
        <input type="number" min="0" max={maxEventRetention} step="1" bind:value={limit} required />
      </label>
      <p class="muted">{t('history-limit-hint')}</p>
      <p>{t(backend === 'valkey' ? 'history-valkey' : 'history-memory')}</p>
      <div class="row"><button class="primary" disabled={admin.busy()}>{t('save')}</button></div>
    </form>
  {:else}
    <div class="row"><button onclick={load}>{t('refresh')}</button></div>
  {/if}
</section>
