<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { api, errorText, operationId, outcomeText, t, UiError, type Outcome } from './api.js';
  import type { Camera, CameraDetail } from './models.js';
  import { defaultPresetPreferences, orderedPresets, type Preset, type PresetPreferences } from '../../shared/presets.js';

  let { camera, csrf, reportedPosition }: { camera: Camera; csrf: string; reportedPosition?: CameraDetail['position'] } = $props();
  const base = $derived('/api/v1/cameras/' + camera.id);
  const online = $derived(camera.availability.online === true && !camera.availability.stale);
  const ptz = $derived(camera.capabilities.ptz);
  let duration = $state<number | undefined>(400), speed = $state<number>();
  let zoom = $state<number>(), preset = $state<number>();
  let slot = $state<number | undefined>(1), name = $state('');
  let position = $state<CameraDetail['position']>();
  let presets = $state<Preset[]>([]);
  let preferences = $state<PresetPreferences>(defaultPresetPreferences());
  const ordered = $derived(orderedPresets(presets, preferences.order));
  const presetChanged = () => window.dispatchEvent(new CustomEvent('camera-presets', { detail: camera.id }));
  const reloadPresets = () => ptzAction({op:'list_presets'}).then(result => {
    if (result.outcome !== 'confirmed') message = outcomeText(result);
  }).catch(report);
  onMount(() => {
    const changed = (event: Event) => {
      if (canListPresets && (event as CustomEvent<string>).detail === camera.id) void reloadPresets();
    };
    window.addEventListener('camera-presets',changed);
    return () => window.removeEventListener('camera-presets',changed);
  });
  const removePreset = () => {
    const item = presets.find(item => item.id === preset);
    if (item && confirm(t('preset-delete-confirm',{id:item.id,name:item.name ?? String(item.id)}))) {
      void action({op:'delete_preset',preset_id:item.id});
    }
  };
  const reorder = (index: number, delta: number) => {
    const ids = ordered.map(item => item.id);
    [ids[index], ids[index+delta]] = [ids[index+delta], ids[index]];
    preferences = {...preferences,order:ids};
  };
  const savePreferences = async () => {
    busy = true;
    try {
      preferences = await api<PresetPreferences>({path:base+'/ptz/preferences',method:'PUT',csrf,body:preferences});
      message = t('preset-options-saved'); error = ''; presetChanged();
    } catch (err) { report(err); } finally { busy = false; }
  };
  let message = $state(''), error = $state(''), busy = $state(false);
  let destroyed = false, reconcileError = false;
  let readGeneration = 0, presetGeneration = 0, positionWatch = 0;
  let recovering = $state(false), recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  const ptzAction = async (action: Record<string, unknown>, id: string = operationId(), interrupts?: string) => {
    const presetRequest = ['list_presets','save_preset','delete_preset'].includes(String(action.op));
    const listGeneration = presetRequest ? ++presetGeneration : presetGeneration;
    const generation = action.op === 'status' || action.op === 'set_zoom' ? ++readGeneration : readGeneration;
    const result = await api<Outcome>({ path: base + '/ptz', method: 'POST', csrf, keepalive: action.op === 'stop',
      body: { operationId: id, action, interrupts } });
    if (!destroyed && result.data) {
      if (listGeneration === presetGeneration && presetRequest && result.data.presets) {
        presets = result.data.presets;
        if (preset !== undefined && !presets.some(item=>item.id===preset)) preset = undefined;
        if (result.data.preferences) preferences = result.data.preferences;
      }
      if (action.op === 'status' && generation === readGeneration && result.outcome === 'confirmed') {
        scheduleRecovery(result.data.retryAfterMs ?? 0);
        if (!recovering && reconcileError && error) {
          error = ''; reconcileError = false; message = t('ptz-ready-after-check');
        }
      }
      const pos = result.data.position;
      if (generation === readGeneration && (pos?.pan !== undefined || pos?.tilt !== undefined || pos?.zoom?.position !== undefined)) position = result.data;
    }
    return result;
  };
  const readPosition = async () => {
    if (ptz?.read && !destroyed) {
      const result = await ptzAction({op:'status'});
      if (result.outcome !== 'confirmed') error = outcomeText(result);
      return result.data?.position;
    }
  };
  const report = (value: unknown) => {
    if (destroyed) return;
    reconcileError = value instanceof UiError && value.reason === 'RECONCILE_REQUIRED';
    error = errorText(value);
  };
  const observePosition = () => readPosition().catch(report);
  function scheduleRecovery(delay:number) {
    clearTimeout(recoveryTimer);
    recovering = delay > 0;
    if (recovering && !destroyed) recoveryTimer = setTimeout(async () => {
      recoveryTimer = undefined;
      await observePosition();
      if (recovering && !destroyed && !recoveryTimer) scheduleRecovery(3000);
    }, Math.min(96_000,Math.max(100,delay)));
  }
  const wait = (ms:number) => new Promise<void>(resolve => setTimeout(resolve,ms));
  // Preset recall acknowledges the command while the camera can still be moving.
  const observeRecall = async (watch:number) => {
    let previous: string | undefined;
    for (let i=0; i<8 && !destroyed; i++) {
      await wait(350);
      if (destroyed || watch !== positionWatch || press) return;
      const sample = await readPosition();
      if (!sample) return;
      const current = JSON.stringify([sample.pan,sample.tilt,sample.zoom?.position]);
      if (current === previous) return;
      previous = current;
    }
  };
  const canListPresets = $derived(!!ptz?.read && !!ptz.presets && online);
  $effect(() => {
    if (canListPresets) untrack(() => {
      void reloadPresets();
    });
  });
  const action = async (command: Record<string,unknown>) => {
    if (busy) return;
    const watch = ++positionWatch;
    busy = true; message = ''; error = '';
    try {
      const result = await ptzAction(command);
      message = command.op === 'save_preset' && result.outcome === 'confirmed' ? t('preset-saved',{id:String(command.preset_id)}) : outcomeText(result);
      if (result.outcome === 'confirmed' && (command.op === 'save_preset' || command.op === 'delete_preset')) {
        if (command.op === 'save_preset') preset = Number(command.preset_id);
        else { preset = undefined; message = t('preset-deleted',{id:Number(command.preset_id)}); }
        presetChanged();
      }
    } catch (err) { report(err); }
    finally {
      if (command.op !== 'status') await observePosition();
      if (command.op === 'goto_preset' && ptz?.read && watch === positionWatch) void observeRecall(watch).catch(report);
      busy = false;
    }
  };

  const directions = [
    { key:'left', angle:270, column:1, row:2 }, { key:'right', angle:90, column:3, row:2 },
    { key:'up', angle:0, column:2, row:1 }, { key:'down', angle:180, column:2, row:3 },
    { key:'left_up', angle:315, column:1, row:1 }, { key:'right_up', angle:45, column:3, row:1 },
    { key:'left_down', angle:225, column:1, row:3 }, { key:'right_down', angle:135, column:3, row:3 }
  ];
  const validStep = $derived(duration !== undefined && Number.isInteger(duration) && duration >= (ptz?.duration?.min ?? 50) && duration <= (ptz?.duration?.max ?? 3000)
    && (speed === undefined || !ptz?.speed || (Number.isInteger(speed) && speed >= ptz.speed.min && speed <= ptz.speed.max)));
  type Press = { direction: string; input: number | string; timer?: ReturnType<typeof setTimeout>; held: boolean; release: () => void; released: Promise<void> };
  let press = $state.raw<Press>();
  let movement: string | undefined, stopping: Promise<void> | undefined;
  const stopMotor = (force = false) => {
    if (stopping) return stopping;
    if (!movement && !force) return Promise.resolve();
    stopping = ptzAction({op:'stop'}, operationId(), movement).then(result => {
      if (result.outcome === 'unknown' || result.outcome === 'rejected') message = outcomeText(result);
    }).catch(report).finally(() => { stopping = undefined; });
    return stopping;
  };
  const run = async (direction: string, hold?: Press) => {
    if (busy || stopping || recovering || !online || !validStep || duration === undefined) return;
    positionWatch++;
    busy = true; message = ''; error = '';
    const ms = hold ? (ptz?.duration?.max ?? 3000) : duration;
    try {
      do {
        const start = performance.now();
        movement = operationId();
        const result = await ptzAction({op:'move', direction, duration_ms:ms, speed:ptz?.speed ? speed : undefined}, movement);
        if (result.data?.startAcknowledged === false && !result.data.interrupted) {
          message = t('ptz-start-unconfirmed') + (result.bridgeCorrelationId ? ' · '+t('correlation')+' '+result.bridgeCorrelationId : '');
          break;
        }
        if (result.outcome !== 'confirmed' && result.outcome !== 'unverified') { message = outcomeText(result); break; }
        message = outcomeText(result);
        if (!hold || press !== hold || destroyed || !online) break;
        // Some bridges acknowledge before the requested move duration has elapsed.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([hold.released,new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0,ms - (performance.now()-start))); })]);
        clearTimeout(timer);
      } while (hold && press === hold && !destroyed && online);
    } catch (err) { report(err); }
    finally {
      await stopping;
      movement = undefined;
      await observePosition();
      busy = false;
    }
  };
  const begin = (direction: string, input: number | string) => {
    if (press || busy || stopping || recovering || !validStep || !online) return false;
    positionWatch++;
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const current: Press = {direction,input,held:false,released,release};
    press = current;
    current.timer = setTimeout(() => {
      if (press === current) { current.held = true; void run(direction,current); }
    },300);
    return true;
  };
  const end = (input?: number | string, cancel = false) => {
    const current = press;
    if (!current || (input !== undefined && input !== current.input)) return;
    clearTimeout(current.timer); press = undefined; current.release();
    if (current.held) void stopMotor();
    else if (!cancel) void run(current.direction);
  };
  const cancel = () => { end(undefined,true); if (movement) void stopMotor(); };
  const stop = async () => {
    positionWatch++;
    end(undefined,true);
    await stopMotor(true);
    if (!busy) await observePosition();
  };
  const canSave = $derived(slot !== undefined && Number.isInteger(slot) && slot >= 0 && slot <= 255 && name.trim().length > 0 && new TextEncoder().encode(name.trim()).length <= 32);
  onDestroy(() => { destroyed = true; clearTimeout(recoveryTimer); cancel(); });
</script>

<svelte:window onblur={cancel} onpagehide={cancel} />
<svelte:document onvisibilitychange={() => { if (document.hidden) cancel(); }} />

{#snippet moveButton(key: string, angle = 0, column = 1, row = 1)}
  <button type="button" class="ptz-arrow" style:grid-column={column} style:grid-row={row}
    disabled={!online || !validStep || recovering || (busy && !press)} aria-label={t('move-' + key)} title={t('move-' + key)}
    onpointerdown={e => { if (e.button === 0 && e.isPrimary && begin(key,e.pointerId)) { e.currentTarget.setPointerCapture(e.pointerId); } }}
    onpointerup={e => end(e.pointerId)} onpointercancel={e => end(e.pointerId,true)} onlostpointercapture={e => end(e.pointerId,true)}
    oncontextmenu={e => e.preventDefault()}
    onkeydown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!e.repeat) begin(key,e.key); } }}
    onkeyup={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); end(e.key); } }}
    onblur={() => { if (typeof press?.input === 'string') cancel(); }}
    onclick={e => { if (e.detail === 0 && !press) void run(key); }}>
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      {#if key.startsWith('zoom_')}
        <circle cx="10" cy="10" r="7"/><path d="m15 15 6 6M7 10h6"/>{#if key === 'zoom_in'}<path d="M10 7v6"/>{/if}
      {:else}<path transform={'rotate(' + angle + ' 12 12)'} d="M12 20V4m-7 7 7-7 7 7"/>{/if}
    </svg>
  </button>
{/snippet}

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
        <div class="ptz-pad" role="group" aria-label={t('ptz')}>
          {#each directions as d (d.key)}
            {#if d.key.includes('_') ? ptz.diagonal : d.row === 2 ? ptz.pan : ptz.tilt}
              {@render moveButton(d.key,d.angle,d.column,d.row)}
            {/if}
          {/each}
          <button type="button" class="ptz-arrow danger" style:grid-column={2} style:grid-row={2} aria-label={t('stop')} title={t('stop')} onclick={stop}>
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>
          </button>
        </div>
        {#if ptz.directionalZoom}<div class="row">{@render moveButton('zoom_out')}{@render moveButton('zoom_in')}</div>{/if}
      {/if}
      <div class="row">
        {#if ptz.read}<button disabled={busy} onclick={() => action({op:'status'})}>{t('read-position')}</button>{/if}
        {#if ptz.write && ptz.presets}
          <select aria-label={t('presets')} bind:value={preset} disabled={!presets.length}>
            <option value={undefined}>{t(presets.length ? 'select-preset' : 'presets-empty')}</option>
            {#each ordered as item}<option value={item.id}>{item.id} · {item.name ?? item.id}</option>{/each}
          </select>
          <div class="row ptz-recall">
            <button disabled={!online || busy || recovering || preset === undefined} onclick={() => action({op:'goto_preset',preset_id:preset})}>{t('recall')}</button>
            {#if ptz.deletePresets}<button class="icon-button danger" aria-label={t('preset-delete')} title={t('preset-delete')}
              disabled={!online || busy || recovering || preset === undefined} onclick={removePreset}>×</button>{/if}
          </div>
        {/if}
      </div>
      {#if ptz.read && ptz.write && ptz.presets}
        <details class="ptz-save"><summary>{t('preset-options')}</summary>
          <form class="stack" onsubmit={e => { e.preventDefault(); void savePreferences(); }}>
            <ol class="preset-order" aria-label={t('preset-order')}>
              {#each ordered as item,i (item.id)}
                <li><span>{item.id} · {item.name ?? item.id}</span><div class="row">
                  <button type="button" aria-label={t('preset-earlier',{id:item.id})} disabled={busy || i===0} onclick={()=>reorder(i,-1)}>↑</button>
                  <button type="button" aria-label={t('preset-later',{id:item.id})} disabled={busy || i===ordered.length-1} onclick={()=>reorder(i,1)}>↓</button>
                </div></li>
              {/each}
            </ol>
            <label>{t('preset-go-back')}<select bind:value={preferences.returnPreset}>
              <option value={null}>{t('preset-stay')}</option>
              {#each ordered as item}<option value={item.id}>{item.id} · {item.name ?? item.id}</option>{/each}
            </select></label>
            {#if preferences.returnPreset !== null}
              <label>{t('preset-return-delay')}<input type="number" min="1" max="86400" step="1" required bind:value={preferences.returnSeconds} /></label>
            {/if}
            <button class="primary" disabled={busy}>{t('save')}</button>
          </form>
        </details>
      {/if}
      {#if ptz.write && ptz.savePresets}
        <details class="ptz-save"><summary>{t('preset-save-disclosure')}</summary>
        <form class="stack" onsubmit={e => { e.preventDefault(); if (canSave) void action({op:'save_preset',preset_id:slot,name:name.trim(),replace:presets.some(item => item.id === slot)}); }}>
          <div class="form-grid">
            <label>{t('preset-slot')}<input type="number" min="0" max="255" bind:value={slot} required /></label>
            <label>{t('preset-name')}<input bind:value={name} maxlength="32" required /></label>
          </div>
          <button disabled={!online || busy || recovering || !canSave}>{t(presets.some(item => item.id === slot) ? 'preset-replace' : 'preset-save')}</button>
        </form>
        </details>
      {/if}
      {#if ptz.write && ptz.zoom}
        <div class="row">
          <label>{t('zoom')}<input type="number" bind:value={zoom} min={ptz.zoom.min} max={ptz.zoom.max} /></label>
          <button disabled={!online || busy || recovering || zoom === undefined} onclick={() => action({op:'set_zoom',position:zoom})}>{t('set-zoom')}</button>
        </div>
      {/if}
      {@const pos = reportedPosition?.receivedAt && position?.receivedAt && reportedPosition.receivedAt > position.receivedAt ? reportedPosition : position ?? reportedPosition}
      {#if ptz.read}
        <p class="muted ptz-position">{t('position')} · {pos?.position.pan ?? t('empty-value')} / {pos?.position.tilt ?? t('empty-value')} / {pos?.position.zoom.position ?? t('empty-value')}
          {#if pos?.receivedAt} · {new Date(pos.receivedAt).toLocaleTimeString()}{/if}
        </p>
      {/if}
    {/if}
    {#if ptz.supported}
      <div class="ptz-feedback" role="status" aria-label={t('ptz-command-status')} aria-atomic="true">
        <strong>{t('ptz-command-status')}</strong>
        <span class:error={!!error}>{error || message || t('ptz-no-command')}</span>
        {#if recovering}<span> {t('ptz-recovering')}</span>{/if}
      </div>
    {/if}
  </section>
{/if}
