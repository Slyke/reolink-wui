<script lang="ts">
  import { t } from './api.js';
  import SearchSelect from './SearchSelect.svelte';
  import BridgeConnectionForm from './BridgeConnectionForm.svelte';
  import { useAdministration } from './workspace.js';
  const admin = useAdministration();
  const bridges = $derived(admin.current().bridges);
  let selected = $state(''), adding = $state(false);
  const bridge = $derived(bridges.find(item => item.id === selected) ?? bridges[0]);
  const saved = (id: string) => { selected = id; adding = false; };
</script>

<section class="panel stack" aria-labelledby="connection-settings-title">
  <div class="row between panel-title">
    <h2 id="connection-settings-title">{t('bridge-connections')}</h2>
    <button type="button" disabled={admin.busy()} onclick={() => adding = true}>{t('bridge-add')}</button>
  </div>
  {#if !adding && bridges.length}
    <SearchSelect label={t('bridge')} value={bridge?.id ?? ''} disabled={admin.busy()}
      options={bridges.map(item => ({value:item.id,label:item.label,detail:item.id}))}
      onchange={({value}) => selected = value} />
  {/if}
  {#if adding || !bridges.length}
    {#key 'new'}<BridgeConnectionForm onsaved={saved} oncancel={bridges.length ? () => adding = false : undefined} />{/key}
  {:else if bridge}
    {#key bridge.id + JSON.stringify(bridge.connections)}
      <BridgeConnectionForm configuration={bridge.connections} onsaved={saved} />
    {/key}
  {/if}
</section>
