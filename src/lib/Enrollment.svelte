<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { IScannerControls } from '@zxing/browser';
  import { api, errorText, operationId, outcomeText, t, type Outcome } from './api.js';
  import type { BridgeSummary } from './models.js';
  import QrDialog, { type QrDialogHandle } from './QrDialog.svelte';
  import SearchSelect from './SearchSelect.svelte';
  import { enrollmentText, parseDeviceLabel, validIdentifiers, wifiBytes } from './qr.js';

  let { csrf, bridges }: { csrf: string; bridges: BridgeSummary[] } = $props();
  let uid = $state(''), serial = $state('');
  let bridge = $state(''), target = $state(''), method = $state('initialize'), confirmed = $state(false);
  let targets = $state<string[]>([]), targetsLoaded = $state(false);
  let ssid = $state(''), password = $state(''), code = $state('');
  let wifiDialog: QrDialogHandle, identityDialog: QrDialogHandle;
  let video: HTMLVideoElement;
  let scanOn = $state(false), scanner: IScannerControls | undefined;
  let renew: ReturnType<typeof setTimeout> | undefined;
  let scanGeneration = 0, targetGeneration = 0;
  let message = $state(''), failure = $state(''), busy = $state(false);
  let selected = $state('');
  let enrollments = $state<{ id: string; bridge_id: string }[]>([]);
  let status = $state('');
  const verified = $derived(validIdentifiers({ uid, serial }));
  const uidSuffix = (value: string) => value && validIdentifiers({uid:value,serial:''}) ? value.slice(-4) : '';
  const setUid = (value: string) => { uid = value; code = uidSuffix(value); };

  const closeWifi = () => {
    clearTimeout(renew);
    wifiDialog?.close();
  };
  const wipeWifi = () => {
    ssid = '';
    password = '';
    code = '';
    closeWifi();
  };
  const generateWifi = async () => {
    failure = '';
    try {
      const payload = wifiBytes({ ssid, password, code });
      if (await wifiDialog.show({ code: payload })) {
        clearTimeout(renew);
        renew = setTimeout(closeWifi, 120_000);
      }
    } catch {
      closeWifi();
      failure = t('wifi-invalid');
    }
  };
  const makeIdentity = async () => {
    try {
      await identityDialog.show({ code: enrollmentText({ uid, serial }) });
    } catch {
      failure = t('error-BAD_INPUT');
    }
  };
  const stopScan = () => {
    scanGeneration++;
    scanner?.stop();
    scanner = undefined;
    if (video?.srcObject instanceof MediaStream) video.srcObject.getTracks().forEach(track => track.stop());
    if (video) video.srcObject = null;
    scanOn = false;
  };
  const scan = async () => {
    if (scanOn) { stopScan(); return; }
    scanOn = true; failure = '';
    const generation = ++scanGeneration;
    try {
      const { BrowserQRCodeReader } = await import('@zxing/browser');
      if (generation !== scanGeneration) return;
      const reader = new BrowserQRCodeReader();
      const controls = await reader.decodeFromVideoDevice(undefined, video, (result, _, controls) => {
        if (!result || generation !== scanGeneration) return;
        const parsed = parseDeviceLabel({ value: result.getText() });
        if (parsed) { setUid(parsed.uid); serial = parsed.serial; stopScan(); controls.stop(); }
      });
      if (generation !== scanGeneration) controls.stop();
      else scanner = controls;
    } catch { stopScan(); failure = t('error-BAD_INPUT'); }
  };
  const loadTargets = async () => {
    targets = []; target = ''; targetsLoaded = false; confirmed = false; failure = '';
    const generation = ++targetGeneration;
    if (!bridge) return;
    try {
      const data = await api<{ targets: string[] }>({ path: '/api/v1/admin/bridges/' + bridge + '/enrollment-targets' });
      if (generation === targetGeneration) {
        targets = data.targets;
        target = targets.length === 1 ? targets[0] : '';
        targetsLoaded = true;
      }
    } catch (error) { if (generation === targetGeneration) failure = errorText(error); }
  };
  const load = async () => {
    try { enrollments = (await api<{ enrollments: typeof enrollments }>({ path: '/api/v1/enrollments' })).enrollments; }
    catch (error) { failure = errorText(error); }
  };
  const enroll = async (action: 'start' | 'resume' | 'import' | 'status') => {
    busy = true; failure = ''; message = ''; status = '';
    const id = operationId();
    try {
      if (action === 'start') {
        selected = id;
        const value = await api<Outcome>({
          path: '/api/v1/enrollments', method: 'POST', csrf,
          body: { operationId: id, bridge, target, uid: uid || undefined, serial: serial || undefined, method, confirmation: confirmed }
        });
        status = value.data?.status ?? '';
        message = outcomeText(value);
        wipeWifi(); confirmed = false; identityDialog?.close();
        await load();
      } else if (selected) {
        const path = '/api/v1/enrollments/' + selected;
        if (action === 'status') {
          status = (await api<{status: string}>({ path })).status;
        } else {
          const value = await api<Outcome>({ path: path + '/resume', method: 'POST', csrf, body: { operationId: id, method: action === 'import' ? 'import' : undefined } });
          status = value.data?.status ?? '';
          message = outcomeText(value);
        }
      }
    } catch (error) { failure = errorText(error); }
    finally { busy = false; }
  };
  onMount(() => {
    void load();
    const available = bridges.filter(item => item.enrollment);
    if (available.length === 1) { bridge = available[0].id; void loadTargets(); }
  });
  onDestroy(() => { wipeWifi(); if (typeof MediaStream !== 'undefined') stopScan(); });
</script>

<svelte:window onpagehide={wipeWifi} />

<section class="panel stack">
  <h2 class="panel-title">{t('enrollment')}</h2>
  <p class="muted">{t('enrollment-copy')}</p>
  {#if failure}<p class="error" role="alert">{failure}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  <div class="grid">
    <div class="stack">
      <div class="form-grid">
        <label>{t('uid')}<input value={uid} oninput={event => setUid(event.currentTarget.value)} maxlength="40" autocomplete="off" /></label>
        <label>{t('serial')}<input bind:value={serial} maxlength="64" autocomplete="off" /></label>
      </div>
      <div class="row">
        <button onclick={scan}>{t(scanOn ? 'stop-scan' : 'scan')}</button>
        <button disabled={!verified} onclick={makeIdentity}>{t('enrollment-qr')}</button>
      </div>
      <div class="scan" hidden={!scanOn}><video muted playsinline bind:this={video} aria-label={t('scan')}></video></div>

    </div>
    <details class="panel" ontoggle={event => { if (!event.currentTarget.open) closeWifi(); else if (!code) code = uidSuffix(uid); }}>
      <summary>{t('wifi')}</summary>
      <form class="stack" autocomplete="off" onsubmit={event => { event.preventDefault(); void generateWifi(); }}>
        <small>{t('wifi-verified')} {t('wifi-ethernet')}</small>
        <p class="notice">{t('wifi-copy')}</p>
        <label>{t('wifi-ssid')}<input bind:value={ssid} autocomplete="off" maxlength="32" required /></label>
        <label>{t('wifi-password')}<input type="password" bind:value={password} autocomplete="off" maxlength="64" /></label>
        <label>{t('wifi-code')}<input bind:value={code} autocomplete="off" minlength="4" maxlength="4" required /></label>
        <div class="row">
          <button class="primary">{t('wifi-generate')}</button>
          <button type="button" onclick={wipeWifi}>{t('wifi-clear')}</button>
        </div>
      </form>
    </details>
  </div>
  {#if bridges.some(item => item.enrollment)}
    <div class="form-grid">
      <SearchSelect label={t('bridge')} bind:value={bridge} onchange={loadTargets}
        options={bridges.filter(item => item.enrollment).map(item => ({ value: item.id, label: item.label }))} />
      <SearchSelect label={t('enrollment-target')} bind:value={target} disabled={!targets.length}
        options={targets.map(item => ({ value: item, label: item }))} />
      <label>{t('enrollment-method')}<select bind:value={method}>
        <option value="initialize">{t('enrollment-init')}</option>
        <option value="import">{t('enrollment-import')}</option>
      </select></label>
    </div>
    {#if targetsLoaded && !targets.length}
      <p class="notice" role="status">{t('enrollment-no-targets')}</p>
    {/if}
    <p class="muted">{t(method === 'initialize' ? 'enrollment-init-help' : 'enrollment-import-help')}</p>
    <label class="check"><input type="checkbox" bind:checked={confirmed} />{t('enrollment-confirm')}</label>
    <div class="row"><button class="primary" disabled={busy || !verified || !bridge || !target || !confirmed || (method === 'initialize' && !uid)} onclick={() => enroll('start')}>{t('enrollment-start')}</button></div>
  {:else}
    <p class="muted">{t('enrollment-unavailable')}</p>
  {/if}
  {#if enrollments.length || selected}
    <SearchSelect label={t('enrollment-open')} bind:value={selected}
      options={enrollments.map(item => ({ value: item.id, label: item.bridge_id + ' · ' + item.id.slice(0, 8) }))} />
    <div class="row">
      <button disabled={!selected || busy} onclick={() => enroll('status')}>{t('refresh')}</button>
      <button disabled={!selected || busy} onclick={() => enroll('resume')}>{t('enrollment-resume')}</button>
      {#if status === 'local-setup-required'}<button disabled={busy} onclick={() => enroll('import')}>{t('enrollment-switch')}</button>{/if}
    </div>
  {/if}
  {#if status}<p class="notice" role="status">{t('enrollment-status-' + status)}</p>{/if}
</section>

<QrDialog bind:this={identityDialog} title={t('enrollment-qr-alt')} description={t('enrollment-qr-copy')} imageLabel={t('enrollment-qr-alt')} />
<QrDialog bind:this={wifiDialog} title={t('wifi')} description={t('wifi-copy')} imageLabel={t('wifi-alt')} onclose={() => clearTimeout(renew)} />
