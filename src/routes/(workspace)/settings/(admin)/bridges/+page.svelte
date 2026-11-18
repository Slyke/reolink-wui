<script lang="ts">
  import { t } from '$lib/api.js';
  import EventSourceSettings from '$lib/EventSourceSettings.svelte';
  import BridgeConnections from '$lib/BridgeConnections.svelte';
  import { minInventoryIntervalSeconds, maxInventoryIntervalSeconds } from '../../../../../../shared/upstreams.js';
  import { formatLocalTimestamp } from '$lib/dates.js';
  import { useAdministration } from '$lib/workspace.js';

  const admin = useAdministration();
  const bridges = $derived(admin.current().bridges);
  const interval = $derived(admin.current().inventoryIntervalSeconds);
  const initial = () => admin.current().inventoryIntervalSeconds;
  let intervalSeconds = $state<number | undefined>(initial());
  const saveInterval = async () => {
    if (intervalSeconds === undefined) return;
    if (await admin.mutate({ suffix: '/inventory-settings', method: 'PUT', body: { intervalSeconds } })) intervalSeconds = initial();
  };
</script>

<svelte:head><title>{t('bridges')} · {t('title')}</title></svelte:head>

<BridgeConnections />

<section class="panel stack" aria-labelledby="bridges-title">
  <div class="panel-title row between">
    <h2 id="bridges-title">{t('bridges')}</h2>
    <a href="/status">{t('status-page')}</a>
  </div>
  <form class="stack" onsubmit={event => { event.preventDefault(); void saveInterval(); }}>
    <div class="inventory-interval">
      <label>{t('inventory-interval')}
        <input type="number" min={minInventoryIntervalSeconds} max={maxInventoryIntervalSeconds} step="1" required
          bind:value={intervalSeconds} disabled={admin.busy()} />
      </label>
      <button class="primary" disabled={admin.busy() || intervalSeconds === interval || intervalSeconds === undefined}>{t('inventory-save-interval')}</button>
    </div>
    <p class="muted">{t('inventory-cadence', { seconds: interval })}</p>
  </form>
  {#if bridges.length}
    <ul class="bridge-settings">
      {#each bridges as bridge (bridge.id)}
        <li class="stack">
          <div class="row between">
            <div class="bridge-label">
              <span class="wrap">{bridge.label}</span>
              {#if bridge.refreshedAt}
                <time class="muted" aria-live="polite" datetime={bridge.refreshedAt}>
                  {t('inventory-refreshed', { time: formatLocalTimestamp(bridge.refreshedAt) })}
                </time>
              {/if}
            </div>
            <span class="pill" data-status={bridge.connected ? 'online' : 'offline'}>{t(bridge.connected ? 'online' : 'offline')}</span>
            <button disabled={admin.busy()} onclick={() => admin.mutate({ suffix: '/bridges/' + bridge.id + '/sync', body: {}, announce: false })}>{t('sync')}</button>
          </div>
          {#key bridge.eventSources.join(',')}<EventSourceSettings {bridge} />{/key}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="muted">{t('inventory-no-bridge')}</p>
  {/if}
</section>
