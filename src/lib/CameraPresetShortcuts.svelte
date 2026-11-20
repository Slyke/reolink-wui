<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { api, errorText, operationId, outcomeText, t, type Outcome } from './api.js';
  import type { Camera } from './models.js';
  import { orderedPresets, type Preset } from '../../shared/presets.js';

  let { camera, csrf, onframe, onnotice }: {
    camera: Camera; csrf: string; onframe: (frame: Blob) => void; onnotice: (text: string, failed: boolean) => void
  } = $props();
  let slots = $state<Preset[]>([]), active = $state<number>(), revision = $state(0), disposed = false;
  const online = $derived(camera.availability.online === true && !camera.availability.stale);

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
        } else { onnotice(outcomeText(result), true); }
      }).catch(err=>{ if (!controller.signal.aborted) { onnotice(errorText(err), true); } });
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
    active = id;
    onnotice(t('preset-photo-wait', { id }), false);
    try {
      const result = await api<Blob | Outcome>({path:'/api/v1/cameras/'+camera.id+'/ptz/preset-snapshot',
        method:'POST',image:true,csrf,body:{operationId:operationId(),presetId:id}});
      if (disposed) return;
      if (result instanceof Blob) { onframe(result); onnotice('', false); }
      else onnotice(outcomeText(result), true);
    } catch (err) { if (!disposed) onnotice(errorText(err), true); }
    finally { if (!disposed) active = undefined; }
  };
  onDestroy(()=>{disposed = true; onnotice('', false);});
</script>

{#if slots.length}
  <div class="preset-keys" role="group" aria-label={t('preset-shortcuts')}>
    {#each slots as slot (slot.id)}
      {@const label = t('preset-photo-at',{id:slot.id,name:slot.name ?? String(slot.id)})}
      <button type="button" disabled={!online || active !== undefined} aria-label={label} title={label} onclick={()=>capture(slot.id)}>{slot.id}</button>
    {/each}
  </div>
{/if}
