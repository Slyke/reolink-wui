<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import { t } from './api.js';
  const id = $props.id();
  let { secure, ca = $bindable(''), verify = $bindable(true), disabled = false }: {
    secure: boolean; ca?: string; verify?: boolean; disabled?: boolean
  } = $props();
</script>

{#if secure}
  <div class="field-heading"><label class="check" for={id}><input {id} type="checkbox" bind:checked={verify} {disabled} />{t('connection-verify')}</label>
    <InfoTip label={t('connection-verify')} text={t(verify ? 'connection-verified' : 'connection-unverified')} /></div>
  <details>
    <summary>{t('connection-ca-optional')}</summary>
    <label>{t('connection-ca')}<textarea rows="5" bind:value={ca} disabled={disabled || !verify}></textarea></label>
  </details>
{:else}
  <p class="muted">{t('connection-plain')}</p>
{/if}
