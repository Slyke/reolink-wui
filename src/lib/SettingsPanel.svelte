<script lang="ts">
  import { onMount } from 'svelte';
  import { aiClasses, settingsGroups, type AiClass, type SettingsGroup } from '../../shared/access.js';
  import { api, errorText, operationId, outcomeText, t, type Outcome } from './api.js';
  import type { Camera } from './models.js';

  let { camera, base, csrf, online }: { camera: Camera; base: string; csrf: string; online: boolean } = $props();

  type Values = {
    image?: { hflip?: boolean; vflip?: boolean; rotation?: number };
    spotlight?: { enabled?: boolean; brightness?: number };
    leds?: { status_led?: boolean; ir_mode?: 'auto' | 'off' };
    motion_detection?: { enabled?: boolean; sensitivity?: number };
  } & Partial<Record<`ai_${AiClass}`, { sensitivity?: number; delay_seconds?: number }>>;
  type Rule = { id?: string; type?: string; name?: string; source: string; enabled?: boolean };
  type Field = 'brightness' | 'motionSensitivity' | 'aiSensitivity' | 'aiDelay';
  type ReadSettings = { group: SettingsGroup; fresh: boolean; alert?: boolean };

  const capabilities = $derived(camera.capabilities.settings);
  const shown = $derived(settingsGroups.filter(group => capabilities[group]?.read || capabilities[group]?.write));
  const bounds = $derived(capabilities.spotlight?.range as { min: number; max: number } | undefined);
  const classes = $derived((capabilities.ai?.classes ?? {}) as Partial<Record<AiClass, { sensitivity?: boolean; delaySeconds?: boolean }>>);
  let preferredClass = $state<AiClass>('person');
  const selectedClass = $derived(classes[preferredClass] ? preferredClass : aiClasses.find(value => classes[value]));

  let values = $state<Partial<Record<SettingsGroup, Values>>>({});
  let alertData = $state<{ values: Values; rules: Rule[] }>();
  let drafts = $state<Partial<Record<Field, number | null>>>({});
  let lightDuration = $state(60);
  let busy = $state(false), reading = $state(false), message = $state(''), failed = $state(false);
  let inFlight: Promise<void> | undefined;

  const lights = $derived(values.spotlight?.spotlight);
  const leds = $derived(values.leds?.leds);
  const motion = $derived(values.motion?.motion_detection);
  const ai = $derived(selectedClass ? values.ai?.[`ai_${selectedClass}`] : undefined);
  const alertMotion = $derived(motion?.enabled ?? alertData?.values.motion_detection?.enabled);
  const disabled = $derived(!online || busy || reading);
  const displayed = ({ field, reported }: { field: Field; reported?: number }) => {
    const draft = drafts[field];
    return draft === null ? undefined : draft ?? reported;
  };
  const edit = ({ field, input }: { field: Field; input: HTMLInputElement }) => {
    drafts[field] = Number.isNaN(input.valueAsNumber) ? null : input.valueAsNumber;
  };
  const changed = ({ field, reported }: { field: Field; reported?: number }) => {
    const draft = drafts[field];
    return typeof draft === 'number' && draft !== reported ? draft : undefined;
  };
  const brightness = $derived(changed({ field: 'brightness', reported: lights?.brightness }));
  const sensitivity = $derived(changed({ field: 'motionSensitivity', reported: motion?.sensitivity }));
  const aiSensitivity = $derived(changed({ field: 'aiSensitivity', reported: ai?.sensitivity }));
  const aiDelay = $derived(changed({ field: 'aiDelay', reported: ai?.delay_seconds }));

  const resetAi = () => {
    delete drafts.aiSensitivity;
    delete drafts.aiDelay;
  };
  const resetDrafts = ({ group }: { group: SettingsGroup }) => {
    if (group === 'spotlight') delete drafts.brightness;
    if (group === 'motion') delete drafts.motionSensitivity;
    if (group === 'ai') resetAi();
  };
  const read = async ({ group, fresh, alert }: ReadSettings) => {
    const path = base + (alert ? '/alerts' : '/settings/' + group) + (fresh ? '?fresh=true' : '');
    const data = await api<{ values: Values; rules?: Rule[] }>({ path });
    if (alert) alertData = { values: data.values, rules: data.rules ?? [] };
    else {
      values[group] = data.values;
      resetDrafts({ group });
    }
  };
  const load = async ({ manual = false }: { manual?: boolean } = {}) => {
    if (inFlight) await inFlight;
    if (busy) return;
    const groups = shown.filter(group => capabilities[group]?.read);
    const fresh = manual && online && camera.capabilities.freshSettings;
    reading = true;
    if (manual) { message = t('pending'); failed = false; }
    const reads = groups.map(group => read({ group, fresh }));
    if (camera.capabilities.alerts.read) reads.push(read({ group: 'motion', alert: true, fresh: fresh && !groups.includes('motion') }));
    const pending = Promise.allSettled(reads).then(results => {
      if (!manual) return;
      const failure = results.find(result => result.status === 'rejected');
      failed = !!failure;
      message = failure ? errorText(failure.reason) : t('settings-refreshed');
    });
    inFlight = pending;
    try { await pending; }
    finally {
      if (inFlight === pending) {
        inFlight = undefined;
        reading = false;
      }
    }
  };
  export const refresh = () => load({ manual: true });
  export const working = () => reading || busy;
  onMount(() => { void load(); });

  const merge = ({ group, received }: { group: SettingsGroup; received: Values }) => {
    const current = values[group] ?? {};
    values[group] = {
      ...current,
      ...Object.fromEntries(Object.entries(received).map(([key, value]) => [key, { ...current[key as keyof Values], ...value }]))
    };
  };

  const change = async ({ group, fields, alert = false }: { group: SettingsGroup; fields: Record<string, unknown>; alert?: boolean }) => {
    if (disabled) return;
    busy = true; message = t('pending'); failed = false;
    try {
      const value = await api<Outcome>({
        path: base + (alert ? '/alerts/motion' : '/settings/' + group), method: 'PATCH', csrf,
        body: { operationId: operationId(), change: fields }
      });
      message = outcomeText(value);
      failed = ['rejected', 'unknown'].includes(value.outcome);
      const received = value.data as Values | undefined;
      if (value.outcome === 'confirmed' && received) {
        if (alert && alertData) alertData = { ...alertData, values: { ...alertData.values, ...received } };
        if (!alert || capabilities.motion?.read) merge({ group, received });
        if (received.spotlight?.brightness !== undefined && fields.setting === 'spotlight_brightness') delete drafts.brightness;
        if (received.motion_detection?.sensitivity !== undefined && fields.sensitivity !== undefined) delete drafts.motionSensitivity;
        if (fields.setting === 'ai_detection') resetAi();
      }
    } catch (error) {
      message = errorText(error); failed = true;
    } finally { busy = false; }
  };
</script>

{#if shown.length || camera.capabilities.alerts.read || camera.capabilities.alerts.write}
  <section class="panel stack">
    <h2 class="panel-title">{t('settings')}</h2>
    {#if message}<p class:error={failed} role="status">{message}</p>{/if}
    <div class="grid">
      {#each shown as group (group)}
        {@const caps = capabilities[group]}
        <article class="panel stack">
          <h3>{t(group)}</h3>
          {#if group === 'spotlight'}
            {#if lights?.enabled !== undefined}<p class="muted">{t(lights.enabled ? 'on' : 'off')}</p>{/if}
            {#if caps?.write && caps.manual}
              <label>{t('seconds')}<input type="number" min="1" max="180" bind:value={lightDuration} /></label>
              <div class="row">
                <button disabled={disabled} onclick={() => change({ group, fields: { setting: 'spotlight', enabled: true, duration_seconds: lightDuration } })}>{t('turn-on')}</button>
                <button disabled={disabled} onclick={() => change({ group, fields: { setting: 'spotlight', enabled: false } })}>{t('turn-off')}</button>
              </div>
            {/if}
            {#if caps?.write && caps.brightness && bounds}
              <form class="stack" onsubmit={event => {
                event.preventDefault();
                if (brightness !== undefined) void change({ group, fields: { setting: 'spotlight_brightness', brightness } });
              }}>
                <label>{t('brightness')}
                  <input type="number" min={bounds.min} max={bounds.max} value={displayed({ field: 'brightness', reported: lights?.brightness })}
                    readonly={reading || busy} oninput={event => edit({ field: 'brightness', input: event.currentTarget })} />
                </label>
                <button disabled={disabled || brightness === undefined}>{t('save')}</button>
              </form>
            {:else if lights?.brightness !== undefined}
              <p>{t('brightness')} · {lights.brightness}</p>
            {/if}
          {:else if group === 'leds'}
            {#if caps?.statusLed}
              <p>{t('status-led')} · {t(leds?.status_led === undefined ? 'empty-value' : (leds.status_led ? 'on' : 'off'))}</p>
              {#if caps.write}
                <div class="row">
                  <button disabled={disabled} onclick={() => change({ group, fields: { setting: 'status_led', enabled: true } })}>{t('turn-on')}</button>
                  <button disabled={disabled} onclick={() => change({ group, fields: { setting: 'status_led', enabled: false } })}>{t('turn-off')}</button>
                </div>
              {/if}
            {/if}
            {#if caps?.irLed}
              <p>{t('infrared')} · {t(leds?.ir_mode ?? 'empty-value')}</p>
              {#if caps.write}
                <div class="row">
                  {#each ['auto','off'] as mode}
                    <button disabled={disabled} onclick={() => change({ group, fields: { setting: 'ir_led', mode } })}>{t(mode)}</button>
                  {/each}
                </div>
              {/if}
            {/if}
          {:else if group === 'motion'}
            {#if motion?.enabled !== undefined}<p class="muted">{t(motion.enabled ? 'on' : 'off')}</p>{/if}
            {#if caps?.write && caps.enabled}
              <div class="row">
                <button disabled={disabled} onclick={() => change({ group, fields: { setting: 'motion_detection', enabled: true } })}>{t('turn-on')}</button>
                <button disabled={disabled} onclick={() => change({ group, fields: { setting: 'motion_detection', enabled: false } })}>{t('turn-off')}</button>
              </div>
            {/if}
            {#if caps?.write && caps.sensitivity}
              <form class="stack" onsubmit={event => {
                event.preventDefault();
                if (sensitivity !== undefined) void change({ group, fields: { setting: 'motion_detection', sensitivity } });
              }}>
                <label>{t('sensitivity')}
                  <input type="number" min="1" max="50" value={displayed({ field: 'motionSensitivity', reported: motion?.sensitivity })}
                    readonly={reading || busy} oninput={event => edit({ field: 'motionSensitivity', input: event.currentTarget })} />
                </label>
                <button disabled={disabled || sensitivity === undefined}>{t('save')}</button>
              </form>
            {:else if motion?.sensitivity !== undefined}
              <p>{t('sensitivity')} · {motion.sensitivity}</p>
            {/if}
          {:else if group === 'image'}
            {#if values.image?.image}
              {@const orientation = values.image.image}
              <dl class="event-metadata">
                {#if orientation.hflip !== undefined}<dt>{t('image-hflip')}</dt><dd>{t(orientation.hflip ? 'on' : 'off')}</dd>{/if}
                {#if orientation.vflip !== undefined}<dt>{t('image-vflip')}</dt><dd>{t(orientation.vflip ? 'on' : 'off')}</dd>{/if}
                {#if orientation.rotation !== undefined}<dt>{t('image-rotation')}</dt><dd>{orientation.rotation}°</dd>{/if}
              </dl>
            {/if}
            {#if caps?.write}
              <div class="row">
                {#each ['hflip','vflip','clockwise','counterclockwise'] as action}
                  {#if (action === 'hflip' && caps.hflip) || (action === 'vflip' && caps.vflip) || (['clockwise','counterclockwise'].includes(action) && caps.rotation)}
                    <button disabled={disabled} onclick={() => change({ group, fields: { setting: 'image_orientation', action } })}>{t('image-' + action)}</button>
                  {/if}
                {/each}
              </div>
            {/if}
          {:else if selectedClass}
            {@const type = selectedClass}
            {@const name = t(type)}
            {@const allowSensitivity = !!(caps?.write && classes[type]?.sensitivity)}
            {@const allowDelay = !!(caps?.write && classes[type]?.delaySeconds)}
            <label>{t('ai-class')}
              <select value={type} disabled={busy || reading} onchange={event => {
                preferredClass = event.currentTarget.value as AiClass;
                resetAi();
              }}>
                {#each aiClasses.filter(item => classes[item]) as item}<option value={item}>{t(item)}</option>{/each}
              </select>
            </label>
            <form class="stack" onsubmit={event => {
              event.preventDefault();
              if (aiSensitivity !== undefined || aiDelay !== undefined) void change({
                group, fields: { setting: 'ai_detection', class: type, sensitivity: aiSensitivity, delay_seconds: aiDelay }
              });
            }}>
              <fieldset class="stack ai-settings">
                <legend>{t('ai-class-settings', { name })}</legend>
                {#if allowSensitivity}
                  <label>{t('ai-class-sensitivity', { name })}
                    <input type="number" min="0" max="100" value={displayed({ field: 'aiSensitivity', reported: ai?.sensitivity })}
                      readonly={reading || busy} oninput={event => edit({ field: 'aiSensitivity', input: event.currentTarget })} />
                  </label>
                {:else if ai?.sensitivity !== undefined}
                  <p>{t('sensitivity')} · {ai.sensitivity}</p>
                {/if}
                {#if allowDelay}
                  <label>{t('ai-class-delay', { name })}
                    <input type="number" min="0" max="8" value={displayed({ field: 'aiDelay', reported: ai?.delay_seconds })}
                      readonly={reading || busy} oninput={event => edit({ field: 'aiDelay', input: event.currentTarget })} />
                  </label>
                {:else if ai?.delay_seconds !== undefined}
                  <p>{t('delay')} · {ai.delay_seconds}</p>
                {/if}
              </fieldset>
              {#if allowSensitivity || allowDelay}
                <button disabled={disabled || (aiSensitivity === undefined && aiDelay === undefined)}>{t('ai-class-save', { name })}</button>
              {/if}
            </form>
          {/if}
        </article>
      {/each}
      {#if camera.capabilities.alerts.read || camera.capabilities.alerts.write}
        <article class="panel stack">
          <h3>{t('alerts')}</h3>
          {#if camera.capabilities.alerts.read}
            <ul class="events">
              {#each alertData?.rules ?? [] as rule}
                <li>{rule.name ?? rule.id ?? rule.type} · {rule.source} · {t(rule.enabled === undefined ? 'empty-value' : (rule.enabled ? 'on' : 'off'))}</li>
              {:else}
                <li class="muted">{t('no-rules')}</li>
              {/each}
            </ul>
            <p>{t('alert-settings')} · {t(alertMotion === undefined ? 'empty-value' : alertMotion ? 'on' : 'off')}</p>
          {/if}
          {#if camera.capabilities.alerts.write && capabilities.motion?.enabled}
            <div class="row">
              {#each [true,false] as enabled}
                <button disabled={disabled} onclick={() => change({ group: 'motion', alert: true, fields: { setting: 'motion_detection', enabled } })}>{t(enabled ? 'turn-on' : 'turn-off')}</button>
              {/each}
            </div>
          {/if}
        </article>
      {/if}
    </div>
  </section>
{/if}
