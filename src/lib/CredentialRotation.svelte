<script lang="ts">
  import SettingsDisclosure from './SettingsDisclosure.svelte';
  import { api, errorText, operationId, outcomeText, t, type Outcome } from './api.js';

  let { base, csrf, online }: { base: string; csrf: string; online: boolean } = $props();
  let busy = $state(false), status = $state(''), message = $state(''), error = $state('');

  const rotate = async ({ action }: { action?: 'rotate' | 'reconcile' } = {}) => {
    if (action === 'rotate' && !confirm(t('rotate-confirm'))) return;
    busy = true;
    error = '';
    try {
      const path = base + '/rotation';
      if (action) {
        const value = await api<Outcome>({ path, method: 'POST', csrf, body: { operationId: operationId(), action, confirmation: true } });
        status = value.data?.status ?? '';
        message = status === 'not-started' ? '' : outcomeText(value);
      } else {
        status = (await api<{ status: string }>({ path })).status;
        message = '';
      }
    } catch (err) {
      error = errorText(err);
    } finally {
      busy = false;
    }
  };
</script>

<SettingsDisclosure title={t('rotation')}>
  <p class="muted">{t('rotation-help')}</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if status}<p role="status">{t('enrollment-status-' + status)}</p>{/if}
  <div class="row">
    <button disabled={busy} onclick={() => rotate()}>{t('refresh')}</button>
    <button class="danger" disabled={busy || !online || ['recovery-required', 'in-progress', 'restart-required'].includes(status)}
      onclick={() => rotate({ action: 'rotate' })}>{t('rotate')}</button>
    <button disabled={busy} onclick={() => rotate({ action: 'reconcile' })}>{t('reconcile')}</button>
  </div>
</SettingsDisclosure>
