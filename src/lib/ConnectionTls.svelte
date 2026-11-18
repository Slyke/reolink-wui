<script lang="ts">
  import { t } from './api.js';
  let { secure, ca = $bindable(''), verify = $bindable(true), disabled = false }: {
    secure: boolean; ca?: string; verify?: boolean; disabled?: boolean
  } = $props();
</script>

{#if secure}
  <label class="check"><input type="checkbox" bind:checked={verify} {disabled} />{t('connection-verify')}</label>
  <p class="muted">{t(verify ? 'connection-verified' : 'connection-unverified')}</p>
  <details>
    <summary>{t('connection-ca-optional')}</summary>
    <label>{t('connection-ca')}<textarea rows="5" bind:value={ca} disabled={disabled || !verify}></textarea></label>
  </details>
{:else}
  <p class="muted">{t('connection-plain')}</p>
{/if}
