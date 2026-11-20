<script lang="ts">
  import SettingsDisclosure from './SettingsDisclosure.svelte';
  import { api, errorText, operationId, outcomeText, t, type Outcome } from './api.js';
  import { dateFormats, isDisplayName, type DisplayFields } from '../../shared/display.js';

  let { base, csrf, available, writable, onrename }: {
    base: string; csrf: string; available: boolean; writable: boolean; onrename: () => void
  } = $props();
  let expanded = $state(false), busy = $state(false), error = $state(''), message = $state('');
  let saved = $state<DisplayFields>(), draft = $state<DisplayFields>({});
  let custom = $state({name:false,time:false});
  const anchors = [
    [1,1,'top-left'],[32768,1,'top-center'],[65536,1,'top-right'],
    [1,32768,'middle-left'],[32768,32768,'center'],[65536,32768,'middle-right'],
    [1,65536,'bottom-left'],[32768,65536,'bottom-center'],[65536,65536,'bottom-right']
  ] as const;
  const anchor = (x?: number,y?: number) => anchors.find(([a,b]) => Math.max(1,x ?? -1)===a && Math.max(1,y ?? -1)===b)?.[2] ?? 'custom';
  function place(group:'name'|'time', value: string) {
    custom[group] = value === 'custom';
    const chosen = anchors.find(([, ,key])=>key===value);
    if (chosen) { draft[group+'X' as 'nameX'|'timeX'] = chosen[0]; draft[group+'Y' as 'nameY'|'timeY'] = chosen[1]; }
  }
  export const working = () => busy;
  export async function refresh() {
    if (!expanded || !available || busy) return;
    busy = true; error = ''; message = '';
    try {
      const data = await api<{fields:DisplayFields}>({path:base+'/display'});
      saved = data.fields; draft = {...data.fields}; custom = {name:false,time:false};
    } catch (err) { error = errorText(err); }
    finally { busy = false; }
  }
  const edits = (general:boolean) => Object.fromEntries(Object.entries(draft).filter(([key,value]) =>
    ((key==='deviceName'||key==='dateFormat') === general) && saved && value!==saved[key as keyof DisplayFields]));
  const canSave = (general:boolean) => writable && !busy && Object.keys(edits(general)).length > 0
    && (general ? draft.deviceName === undefined || isDisplayName(draft.deviceName) : draft.name === undefined || isDisplayName(draft.name));
  async function save(general:boolean) {
    if (!canSave(general)) return;
    const fields = edits(general);
    busy = true; error = ''; message = '';
    try {
      const result = await api<Outcome>({path:base+'/display',method:'PUT',csrf,body:{operationId:operationId(),fields}});
      if (result.outcome === 'confirmed') {
        saved = {...saved,...result.data}; draft = {...draft,...result.data};
        if ('deviceName' in fields) onrename();
        message = outcomeText(result);
      } else error = outcomeText(result);
    } catch (err) { error = errorText(err); }
    finally { busy = false; }
  }
</script>

{#snippet position(group:'name'|'time',label:string)}
  {@const x = group+'X' as 'nameX'|'timeX'}
  {@const y = group+'Y' as 'nameY'|'timeY'}
  {#if saved?.[x] !== undefined && saved?.[y] !== undefined}
    {@const value = custom[group] ? 'custom' : anchor(draft[x],draft[y])}
    <label>{label}<select aria-label={label} value={value} onchange={event=>place(group,event.currentTarget.value)} disabled={!writable || busy}>
      {#each anchors as [, ,key]}<option value={key}>{t('osd-'+key)}</option>{/each}
      <option value="custom">{t('osd-custom')}</option>
    </select></label>
    {#if value === 'custom'}
      <div class="form-grid">
        <label>{t('osd-horizontal')}<input type="number" min="0" max="65536" step="1" required bind:value={draft[x]} disabled={!writable || busy} /></label>
        <label>{t('osd-vertical')}<input type="number" min="0" max="65536" step="1" required bind:value={draft[y]} disabled={!writable || busy} /></label>
      </div>
    {/if}
  {/if}
{/snippet}

<SettingsDisclosure title={t('osd-title')} ontoggle={show => { expanded = show; if (show) void refresh(); }}>
  {#if expanded}
    <div class="stack">
      {#if !available}<p class="muted">{t('osd-bridge-required')}</p>
      {:else}
        {#if busy && !saved}<p role="status">{t('loading')}</p>{/if}
        {#if saved}
          {#if 'deviceName' in saved || 'dateFormat' in saved}
            <form class="stack" onsubmit={e=>{e.preventDefault();void save(true);}}>
              {#if 'deviceName' in saved}<label>{t('osd-device-name')}<input bind:value={draft.deviceName} maxlength="31" required disabled={!writable || busy} /></label>{/if}
              {#if 'dateFormat' in saved}<label>{t('osd-date-format')}<select bind:value={draft.dateFormat} disabled={!writable || busy}>
                {#each dateFormats as format}<option value={format}>{format}</option>{/each}
              </select></label>{/if}
              {#if writable}<div class="row"><button class="primary" disabled={!canSave(true)}>{t('osd-save-device')}</button></div>{/if}
            </form>
          {/if}
          {#if Object.keys(saved).some(key=>key!=='deviceName' && key!=='dateFormat')}
            <form class="stack" onsubmit={e=>{e.preventDefault();void save(false);}}>
              {#if 'name' in saved}<label>{t('osd-overlay-name')}<input bind:value={draft.name} maxlength="31" required disabled={!writable || busy} /></label>{/if}
              {#if 'nameVisible' in saved}<label class="check"><input type="checkbox" bind:checked={draft.nameVisible} disabled={!writable || busy} />{t('osd-show-name')}</label>{/if}
              {@render position('name',t('osd-name-position'))}
              {#if 'timeVisible' in saved}<label class="check"><input type="checkbox" bind:checked={draft.timeVisible} disabled={!writable || busy} />{t('osd-show-time')}</label>{/if}
              {@render position('time',t('osd-time-position'))}
              {#if 'watermark' in saved}<label class="check"><input type="checkbox" bind:checked={draft.watermark} disabled={!writable || busy} />{t('osd-watermark')}</label>{/if}
              {#if 'background' in saved}<label class="check"><input type="checkbox" bind:checked={draft.background} disabled={!writable || busy} />{t('osd-background')}</label>{/if}
              {#if writable}<div class="row"><button class="primary" disabled={!canSave(false)}>{t('osd-save-overlay')}</button></div>{/if}
            </form>
          {:else if !Object.keys(saved).length}<p class="muted">{t('osd-unsupported')}</p>{/if}
        {/if}
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        {#if message}<p role="status">{message}</p>{/if}
        <div class="row"><button type="button" onclick={refresh} disabled={busy}>{t('osd-reload')}</button></div>
      {/if}
    </div>
  {/if}
</SettingsDisclosure>
