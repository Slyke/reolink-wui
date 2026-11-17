<script lang="ts">
  import { api, errorText, operationId, outcomeText, t, type Outcome } from './api.js';
  import type { BridgeSummary, CameraSummary } from './models.js';
  import SearchSelect from './SearchSelect.svelte';

  let { bridges, cameras, csrf }: { bridges: BridgeSummary[]; cameras: CameraSummary[]; csrf: string } = $props();
  type Callback = { id: string; destination: string; events: string[]; cameras?: string[] };
  let bridge = $state(''), callbackId = $state(''), edit = $state(false), destination = $state('');
  let selected = $state<string[]>([]), filters = $state('');
  let list = $state<Callback[]>([]), destinations = $state<string[]>([]);
  let busy = $state(false), error = $state(''), message = $state('');
  const endpoint = () => '/api/v1/admin/bridges/' + bridge + '/callbacks';
  let generation = 0;
  const load = async () => {
    const current = ++generation;
    list = []; destinations = [];
    if (!bridge) return;
    try {
      const data = await api<{ callbacks: Callback[]; destinations: string[] }>({ path: endpoint() });
      if (current !== generation) return;
      list = data.callbacks;
      destinations = data.destinations;
    } catch (err) { if (current === generation) error = errorText(err); }
  };
  const select = ({ item }: { item: Callback }) => {
    callbackId = item.id;
    filters = item.events.join(', ');
    selected = [...(item.cameras ?? [])];
    destination = '';
    edit = true;
  };
  const change = async (action: 'add' | 'update' | 'remove', id: string) => {
    if (action === 'remove' && !confirm(t('callback-confirm'))) return;
    busy = true; error = ''; message = '';
    try {
      const value = await api<Outcome>({
        path: endpoint(), method: 'POST', csrf,
        body: {
          operationId: operationId(), action, id,
          ...(action === 'remove' ? { confirmation: true } : { destination, cameras: selected, events: filters.split(',').map(value => value.trim()).filter(Boolean) })
        }
      });
      message = outcomeText(value);
      if (value.outcome === 'confirmed') {
        callbackId = ''; edit = false; selected = []; filters = ''; destination = '';
      }
      await load();
    } catch (err) { error = errorText(err); }
    finally { busy = false; }
  };
</script>

{#if bridges.some(item => item.callbacks)}
  <section class="panel stack">
    <h2 class="panel-title">{t('callbacks')}</h2>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if message}<p role="status">{message}</p>{/if}
    <SearchSelect label={t('bridge')} bind:value={bridge} disabled={busy}
      options={bridges.filter(item => item.callbacks).map(item => ({ value: item.id, label: item.label }))}
      onchange={() => { edit = false; callbackId = ''; selected = []; destination = ''; void load(); }} />
    {#if bridge}
      <ul class="events">
        {#each list as item (item.id)}
          <li class="row between">
            <div class="wrap"><strong>{item.id}</strong> · <small>{item.destination}</small></div>
            <div class="row">
              <button onclick={() => select({ item })} disabled={busy}>{t('callback-edit')}</button>
              <button class="danger" onclick={() => change('remove', item.id)} disabled={busy}>{t('callback-delete')}</button>
            </div>
          </li>
        {/each}
      </ul>
      <form class="stack" onsubmit={event => { event.preventDefault(); void change(edit ? 'update' : 'add', callbackId); }}>
        <div class="form-grid">
          <label>{t('callback-id')}<input bind:value={callbackId} pattern="[A-Za-z0-9_-]+" required readonly={edit} /></label>
          <SearchSelect label={t('callback-destination')} bind:value={destination}
            options={destinations.map(item => ({ value: item, label: item }))} />
        </div>
        <label>{t('callback-event-filter')}<input bind:value={filters} /></label>
        <fieldset>
          <legend>{t('callback-camera-filter')}</legend>
          {#each cameras.filter(item => item.bridge === bridge) as item}
            <label class="check"><input type="checkbox" value={item.id} bind:group={selected} />{item.label}</label>
          {/each}
        </fieldset>
        <div class="row">
          <button class="primary" disabled={busy || !destination}>{t(edit ? 'callback-edit' : 'callback-new')}</button>
          {#if edit}<button type="button" onclick={() => { edit = false; callbackId = ''; selected = []; destination = ''; }}>{t('callback-new')}</button>{/if}
        </div>
      </form>
    {/if}
  </section>
{/if}
