<script lang="ts">
  import { onDestroy } from 'svelte';
  import { api, t, url, errorText } from './api.js';
  import { recordingGaps, type RecordingGroup } from '../../shared/recording-groups.js';

  let { camera, date, recordings, photos, videos, complete }: {
    camera:string; date:string; recordings:RecordingGroup[]; photos:boolean; videos:boolean; complete:boolean
  } = $props();
  let range = $state('');
  let message = $state('');
  let error = $state('');
  let busy = $state(false);
  const gaps = $derived(complete && recordings.length ? recordingGaps(date,recordings) : []);
  let controller: AbortController | undefined;
  onDestroy(() => controller?.abort());
  async function download(kind: 'photos'|'videos') {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    message = ''; error = ''; busy = true;
    const params = new URLSearchParams({kind,date});
    if (kind === 'photos' && range) {
      const gap = gaps.find(g => g.from === range);
      if (!gap) { busy = false; return; }
      params.set('from',gap.from); params.set('to',gap.to);
    }
    const path = '/api/v1/cameras/' + camera + '/recordings/export?' + params;
    try {
      const {count} = await api<{count:number}>({path,signal:current.signal});
      if (current.signal.aborted) return;
      if (!count) {message = t(kind === 'photos' ? 'export-no-photos' : 'export-no-videos');return;}
      const a = document.createElement('a');
      a.href = url(path + '&download=1');
      a.download = '';
      document.body.append(a); a.click(); a.remove();
      message = t('export-started',{count});
    } catch (cause) {if (!current.signal.aborted) error = errorText(cause);}
    finally {if (current === controller) busy = false;}
  }
</script>

{#if photos || videos}
  <details class="recording-export">
    <summary>{t('export-recordings')}</summary>
    <div class="stack">
      <div class="row">
        {#if photos}
          <label>{t('export-png-range')}<select bind:value={range} disabled={busy} onchange={() => {message='';error='';}}>
            <option value="">{t('export-day')}</option>
            {#each gaps as gap (gap.from)}<option value={gap.from}>{gap.from} – {gap.to}</option>{/each}
          </select></label>
          <button disabled={busy} onclick={() => download('photos')}>{t('export-png')}</button>
        {/if}
        {#if videos}<button disabled={busy} onclick={() => download('videos')}>{t('export-mp4')}</button>{/if}
      </div>
      {#if photos}<small class="muted">{t('export-png-hint')}</small>{/if}
      {#if busy || message}<p role="status">{busy ? t('export-checking') : message}</p>{/if}
      {#if error}<p role="alert" class="error">{error}</p>{/if}
    </div>
  </details>
{/if}

<style>
  .recording-export > div {padding-block:var(--space-sm, .75rem);}
  .recording-export .row {align-items:end;}
  .recording-export label {min-width:min(100%,14rem);}
</style>
