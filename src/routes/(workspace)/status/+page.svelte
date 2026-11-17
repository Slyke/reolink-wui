<script lang="ts">
  import { onMount } from 'svelte';
  import { api, errorText, t } from '$lib/api.js';
  import { useWorkspace } from '$lib/workspace.js';
  import type { Upstream } from '../../../../shared/upstreams.js';

  const workspace = useWorkspace();
  let upstreams = $state<Upstream[]>([]);
  let busy = $state(false);
  let loaded = $state(false);
  let error = $state('');

  const refresh = async () => {
    if (busy) return;
    busy = true;
    try {
      upstreams = (await api<{ upstreams: Upstream[] }>({ path: '/api/v1/status' })).upstreams;
      error = '';
    } catch (err) {
      upstreams = [];
      error = errorText(err);
    } finally {
      busy = false;
      loaded = true;
    }
  };

  onMount(() => {
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    return () => clearInterval(timer);
  });
</script>

<svelte:head><title>{t('status-page')} · {t('title')}</title></svelte:head>

<div class="row between">
  <h1>{t('status-page')}</h1>
  <button disabled={busy} onclick={refresh}>{t('refresh')}</button>
</div>
{#if error}<p class="error" role="alert">{error}</p>{/if}
<section class="panel stack" aria-labelledby="upstream-title">
  <h2 class="panel-title" id="upstream-title">{t('upstream-connections')}</h2>
  {#if !loaded}
    <p role="status">{t('loading')}</p>
  {:else if upstreams.length}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (The scroll region must accept keyboard focus.) -->
    <div class="table-scroll" role="region" aria-labelledby="upstream-title" tabindex="0">
      <table class="status-table">
        <thead>
          <tr>
            <th scope="col">{t('upstream')}</th>
            <th scope="col">{t('transport')}</th>
            <th scope="col">{t('connection-use')}</th>
            <th scope="col">{t('connection-state')}</th>
          </tr>
        </thead>
        <tbody>
          {#each upstreams as upstream (upstream.id)}
            {#each upstream.connections as connection (connection.id)}
              <tr>
                <th scope="row">
                  {upstream.label}{#if connection.id === 'mqtt'}{' '}<sup class="muted status-via">({t('via')})</sup>{' '}{t('upstream-broker')}{/if}
                </th>
                <td><code>{connection.transport}</code></td>
                <td>
                  {connection.uses.map(use => t('connection-' + use)).join(', ')}
                  {#if connection.feed}<small class="muted"> · {t('connection-feed-' + connection.feed)}</small>{/if}
                </td>
                <td><span class="pill" data-status={connection.state}>{t(connection.state)}</span></td>
              </tr>
            {/each}
          {/each}
        </tbody>
      </table>
    </div>
  {:else if !error}
    <p class="muted">{t(workspace.current().user.admin ? 'inventory-no-bridge' : 'status-no-upstreams')}</p>
    {#if workspace.current().user.admin}
      <div class="row"><a class="button" href="/settings/bridges">{t('bridges')}</a></div>
    {/if}
  {/if}
</section>
