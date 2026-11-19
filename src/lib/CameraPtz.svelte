<script lang="ts">
  import { onDestroy } from 'svelte';
  import { api, errorText, operationId, outcomeText, t, type Outcome } from './api.js';
  import type { Camera, CameraDetail } from './models.js';

  let { camera, csrf, reportedPosition }: { camera: Camera; csrf: string; reportedPosition?: CameraDetail['position'] } = $props();
  const base = $derived('/api/v1/cameras/' + camera.id);
  const online = $derived(camera.availability.online === true && !camera.availability.stale);
  const ptz = $derived(camera.capabilities.ptz);
  let moving = $state(false);
  let duration = $state(400), speed = $state<number>();
  let zoom = $state<number>(), preset = $state<number>();
  let position = $state<CameraDetail['position']>();
  let presets = $state<{ id: number; name?: string }[]>([]);
  let message = $state(''), error = $state('');
  let pointer: number | undefined;
  let movement: string | undefined;
  const ptzAction = async (action: Record<string, unknown>, quiet = false, id: string = operationId(), interrupts?: string) => {
    if (!quiet) { message = ''; error = ''; }
    try {
      const value = await api<Outcome>({ path: base + '/ptz', method: 'POST', csrf, keepalive: action.op === 'stop', body: { operationId: id, action, interrupts } });
      if (value.data?.presets) presets = value.data.presets;
      if (value.data?.position?.pan !== undefined || value.data?.position?.tilt !== undefined || value.data?.position?.zoom?.position !== undefined) {
        position = value.data;
      }
      if (!quiet || value.outcome === 'unknown' || value.outcome === 'rejected') message = outcomeText(value);
    } catch (err) { error = errorText(err); }
  };
  const move = async (direction: string) => {
    if (moving || !online) return;
    moving = true;
    movement = operationId();
    await ptzAction({ op: 'move', direction, duration_ms: duration, speed: ptz?.speed ? speed : undefined }, false, movement);
    moving = false;
    if (pointer === undefined) movement = undefined;
  };
  const stop = () => {
    pointer = undefined;
    const active = movement;
    movement = undefined;
    if (active) void ptzAction({ op: 'stop' }, true, operationId(), active);
  };
  const directions = $derived([
    ...(ptz?.pan ? ['left', 'right'] : []), ...(ptz?.tilt ? ['up', 'down'] : []),
    ...(ptz?.diagonal ? ['left_up', 'right_up', 'left_down', 'right_down'] : []),
    ...(ptz?.directionalZoom ? ['zoom_in', 'zoom_out'] : [])
  ]);
  onDestroy(stop);
</script>

<svelte:window onblur={stop} onpagehide={stop} />
<svelte:document onvisibilitychange={() => { if (document.hidden) stop(); }} />

{#if ptz}
  <section class="panel stack camera-ptz" aria-label={t('ptz')}>
    <h2 class="panel-title">{t('ptz')}</h2>
    {#if !ptz.supported}
      <p class="muted">{t(ptz.discovery === 'pending' ? 'ptz-pending' : 'not-supported')}</p>
    {:else}
      {#if ptz.write}
        <div class="form-grid">
          <label>{t('duration')}<input type="number" min={ptz.duration?.min} max={ptz.duration?.max} bind:value={duration} /></label>
          {#if ptz.speed}<label>{t('speed')}<input type="number" placeholder={t('default-speed')} min={ptz.speed.min} max={ptz.speed.max} bind:value={speed} /></label>{/if}
        </div>
        <div class="row">
          {#each directions as direction}
            <button disabled={!online} onpointerdown={event => {
              if (event.button !== 0 || !event.isPrimary || moving) return;
              pointer = event.pointerId;
              event.currentTarget.setPointerCapture(event.pointerId);
              void move(direction);
            }} onpointerup={stop} onpointercancel={stop} onlostpointercapture={() => { if (pointer !== undefined) stop(); }}
            onclick={event => { if (event.detail === 0) void move(direction); }}>{t('move-' + direction)}</button>
          {/each}
          <button class="danger" onclick={() => ptzAction({ op: 'stop' }, false, operationId(), movement)}>{t('stop')}</button>
        </div>
      {/if}
      <div class="row">
        {#if ptz.read}<button disabled={!online} onclick={() => ptzAction({ op: 'status' })}>{t('read-position')}</button>{/if}
        {#if ptz.read && ptz.presets}<button disabled={!online} onclick={() => ptzAction({ op: 'list_presets' })}>{t('load-presets')}</button>{/if}
        {#if ptz.write && presets.length}
          <select aria-label={t('presets')} bind:value={preset}>
            <option value={undefined}>{t('select-preset')}</option>
            {#each presets as item}<option value={item.id}>{item.name ?? item.id}</option>{/each}
          </select>
          <button disabled={!online || preset === undefined} onclick={() => ptzAction({ op: 'goto_preset', preset_id: preset })}>{t('recall')}</button>
        {/if}
      </div>
      {#if ptz.write && ptz.zoom}
        <div class="row">
          <label>{t('zoom')}<input type="number" bind:value={zoom} min={ptz.zoom.min} max={ptz.zoom.max} /></label>
          <button disabled={!online || zoom === undefined} onclick={() => ptzAction({ op: 'set_zoom', position: zoom })}>{t('set-zoom')}</button>
        </div>
      {/if}
      {@const pos = position ?? reportedPosition}
      {#if ptz.read && pos}
        <p class="muted">{t('position')}: {pos.position.pan ?? t('empty-value')} / {pos.position.tilt ?? t('empty-value')} / {pos.position.zoom.position ?? t('empty-value')}
          {#if pos.receivedAt} · {new Date(pos.receivedAt).toLocaleTimeString()}{/if}
        </p>
      {/if}
    {/if}
    {#if error}<p role="alert" class="error">{error}</p>{/if}
    {#if message}<p role="status">{message}</p>{/if}
  </section>
{/if}
