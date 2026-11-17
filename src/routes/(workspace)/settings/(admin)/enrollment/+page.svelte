<script lang="ts">
  import { t } from '$lib/api.js';
  import { useAdministration, useWorkspace } from '$lib/workspace.js';
  import Enrollment from '$lib/Enrollment.svelte';

  const admin = useAdministration();
  const workspace = useWorkspace();
</script>

<svelte:head><title>{t('enrollment-nav')} · {t('title')}</title></svelte:head>

<Enrollment csrf={workspace.current().csrf} bridges={admin.current().bridges} />
