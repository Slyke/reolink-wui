<script lang="ts">
  import { t } from '$lib/api.js';
  import type { ExternalType } from '../../shared/sign-in.js';
  let { types, type = $bindable(), subject = $bindable(''), required = true }: {
    types: ExternalType[]; type?: ExternalType; subject?: string; required?: boolean
  } = $props();
</script>

{#if types.length > 1}
  <label>{t('sign-in-type')}<select value={type ?? types[0]} onchange={event => type = event.currentTarget.value as ExternalType}>
    {#each types as method}<option value={method}>{t('type-' + method)}</option>{/each}
  </select></label>
{/if}
<label>{t((type ?? types[0]) === 'headers' ? 'header-subject' : 'oauth-subject')}
  <input autocomplete="off" maxlength="180" bind:value={subject} {required} />
</label>
