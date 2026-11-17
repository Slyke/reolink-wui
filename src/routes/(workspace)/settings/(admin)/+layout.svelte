<script lang="ts">
  import { onMount, setContext } from 'svelte';
  import { api, errorText, operationId, outcomeText, t, type Outcome } from '$lib/api.js';
  import { adminKey, useWorkspace, type AdminContext, type AdminData } from '$lib/workspace.js';

  let { children } = $props();
  const workspace = useWorkspace();
  let data = $state<AdminData>();
  let busy = $state(false), message = $state(''), error = $state('');
  const path = '/api/v1/admin';

  const refresh = async () => {
    if (!workspace.current().user.admin) return;
    try {
      data = await api<AdminData>({ path });
      error = '';
    } catch (err) {
      error = errorText(err);
    }
  };

  const mutate: AdminContext['mutate'] = async ({ suffix, body, method = 'POST', announce = true }) => {
    busy = true;
    message = '';
    error = '';
    try {
      const value = await api<Outcome>({
        path: path + suffix, method, csrf: workspace.current().csrf, body: { operationId: operationId(), ...body }
      });
      message = announce || value.outcome !== 'confirmed' ? outcomeText(value) : '';
      await refresh();
      return value.outcome === 'confirmed';
    } catch (err) {
      error = errorText(err);
      return false;
    } finally {
      busy = false;
    }
  };

  setContext<AdminContext>(adminKey, { current: () => data!, busy: () => busy, refresh, mutate });
  onMount(() => { void refresh(); });
</script>

{#if !workspace.current().user.admin}
  <p class="panel error" role="alert">{t('error-ACCESS_DENIED')}</p>
{:else}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if data}
    {@render children()}
  {:else if !error}
    <p role="status">{t('loading')}</p>
  {/if}
{/if}
