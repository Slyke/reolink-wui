<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { api, errorText, operationId, outcomeText, t, type Outcome } from './api.js';
  import type { Camera } from './models.js';
  import { orderedPresets, type Preset } from '../../shared/presets.js';

  let { camera, csrf }: { camera: Camera; csrf: string } = $props();
  let slots = $state<Preset[]>([]), active = $state<number>(), photo = $state(''), error = $state('');
  let jpeg = $state(false);
  let photoSlot = $state<number>(), revision = $state(0), disposed = false;
  const online = $derived(camera.availability.online === true && !camera.availability.stale);
  const clear = () => { if (photo) URL.revokeObjectURL(photo); photo = ''; photoSlot = undefined; };
  $effect(() => {
    const id = camera.id, allowed = online;
    void revision;
    if (!allowed) return;
    const controller = new AbortController();
    untrack(() => {
      void api<Outcome>({path:'/api/v1/cameras/'+id+'/ptz',method:'POST',csrf,signal:controller.signal,
        body:{operationId:operationId(),action:{op:'list_presets'}}}).then(result=>{
        if (controller.signal.aborted) return;
        if (result.outcome === 'confirmed') {
          slots = orderedPresets(result.data?.presets ?? [],result.data?.preferences?.order ?? []).slice(0,8);
          error = '';
        } else { slots = []; error = outcomeText(result); }
      }).catch(err=>{ if (!controller.signal.aborted) { slots = []; error = errorText(err); } });
    });
    return () => controller.abort();
  });
  const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === camera.id) revision++; };
  onMount(() => {
    window.addEventListener('camera-presets',changed);
    return () => window.removeEventListener('camera-presets',changed);
  });
  const capture = async (id: number) => {
    if (active !== undefined) return;
    active = id; error = '';
    try {
      const result = await api<Blob | Outcome>({path:'/api/v1/cameras/'+camera.id+'/ptz/preset-snapshot',
        method:'POST',image:true,csrf,body:{operationId:operationId(),presetId:id}});
      if (disposed) return;
      if (result instanceof Blob) { clear(); jpeg = result.type === 'image/jpeg'; photo = URL.createObjectURL(result); photoSlot = id; }
      else error = outcomeText(result);
    } catch (err) { if (!disposed) error = errorText(err); }
    finally { if (!disposed) active = undefined; }
  };
  onDestroy(()=>{disposed = true; clear();});
</script>

{#if slots.length}
  <div class="preset-keys" role="group" aria-label={t('preset-shortcuts')}>
    {#each slots as slot (slot.id)}
      {@const label = t('preset-photo-at',{id:slot.id,name:slot.name ?? String(slot.id)})}
      <button type="button" disabled={!online || active !== undefined} aria-label={label} title={label} onclick={()=>capture(slot.id)}>{slot.id}</button>
    {/each}
  </div>
{/if}
{#if active !== undefined}<p role="status">{t('preset-photo-wait',{id:active})}</p>{/if}
{#if error}<p class="error" role="alert">{error}</p>{/if}
{#if photo}
  <img class="snapshot" src={photo} alt={t('snapshot-alt')} />
  <div class="row"><a href={photo} download={'preset-'+photoSlot+(jpeg ? '.jpg' : '.png')}>{t(jpeg ? 'download-jpeg' : 'download')}</a>
    <button type="button" aria-label={t('close-snapshot')} onclick={clear}>{t('close')}</button></div>
{/if}
