<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { t } from './api.js';
  import type { RecordingPreviews } from './recording-previews.js';

  let { previews, recording, available, offsetMs = 0, eager = false, photo = false }: {
    previews: RecordingPreviews; recording: string; available: boolean; offsetMs?: number; eager?: boolean; photo?: boolean
  } = $props();
  let element: HTMLDivElement;
  let visible = $state(false), failed = $state(false);
  let image = $state<{ cache: RecordingPreviews; recording: string; src: string; offset: number; jpeg: Blob; owned?:boolean }>();
  const cacheKey = $derived(photo ? 'photo/' + recording : recording);
  const offsetKey=$derived(eager && !photo ? Math.floor(offsetMs/1000)*1000 : offsetMs);
  const cached=$derived(eager && available ? previews.viewedFrame(cacheKey,offsetKey) : undefined);
  const shown = $derived(cached ?? (available && image?.cache === previews && image.recording === cacheKey ? image : undefined));
  const seconds = $derived(shown ? Math.round((offsetMs - shown.offset) / 1000) : 0);
  onMount(() => {
    if (eager || typeof IntersectionObserver === 'undefined') { visible = true; return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { visible = true; observer.disconnect(); }
    }, { rootMargin: '100px' });
    observer.observe(element);
    return () => observer.disconnect();
  });
  $effect(() => {
    const id = cacheKey, offset = offsetKey, cache = previews, timeline = eager;
    failed = false;
    if (!available || !visible) return;
    if (timeline) {
      let showing = true, exactShown = false;
      if (!photo && !cache.exact(id,offset)) {
        const nearby = cache.nearest(id,offset);
        if (nearby) void cache.keepViewed(id,nearby.offsetMs,nearby).then(frame => {
          if (showing && !exactShown) image = frame;
        }).catch(() => {});
      }
      void cache.scanFrame(id,offset,true).then(frame => {
        exactShown = true;
        if (showing) image = frame;
      }).catch(() => { if (showing) failed = true; });
      return () => { showing = false; };
    }
    const controller = new AbortController();
    const showCard = async () => {
      const frame = await cache.read(id,offset,controller.signal);
      if (controller.signal.aborted || untrack(() => image?.jpeg === frame.jpeg)) return;
      const src = URL.createObjectURL(frame.jpeg);
      try {
        const decoded = new Image(); decoded.src = src;
        await decoded.decode();
        if (controller.signal.aborted) { URL.revokeObjectURL(src); return; }
      } catch (error) { URL.revokeObjectURL(src); throw error; }
      if (image?.owned) URL.revokeObjectURL(image.src);
      image = { cache, recording:id, src, offset:frame.offsetMs, jpeg:frame.jpeg, owned:true };
    };
    void showCard().catch(() => { if (!controller.signal.aborted) failed = true; });
    return () => controller.abort();
  });
  onDestroy(() => { if (image?.owned) URL.revokeObjectURL(image.src); });
</script>

<div class="recording-preview" bind:this={element} aria-busy={available && !failed && !shown}>
  {#if shown}
    <img alt="" src={shown.src} />
    {#if eager && seconds !== 0}<small class="preview-earlier">{t(seconds > 0 ? 'recording-nearby-preview' : 'recording-later-preview', { seconds: Math.abs(seconds) })}</small>{/if}
  {:else}<span class="muted">{t(!available || failed ? 'recording-preview-failed' : 'loading')}</span>{/if}
</div>
