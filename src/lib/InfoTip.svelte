<script lang="ts">
  import { onDestroy } from 'svelte';
  import { t } from './api.js';
  let { label, text, warning=false }: { label: string; text: string; warning?:boolean } = $props();
  const id = $props.id();
  let panel: HTMLDivElement, button: HTMLButtonElement;
  let opened = $state(false), pinned = false, left = $state(0), top = $state(0);
  let timer: ReturnType<typeof setTimeout>;
  const show = () => {
    clearTimeout(timer);
    const rect = button.getBoundingClientRect();
    left = Math.max(12,Math.min(window.innerWidth - Math.min(352,window.innerWidth - 24) - 12,rect.left));
    top = rect.bottom + 8;
    if (!panel.matches(':popover-open')) panel.showPopover();
    const height = panel.getBoundingClientRect().height;
    if (top + height > window.innerHeight - 12) top = Math.max(12,rect.top - height - 8);
  };
  const hide = () => { if (!pinned) timer = setTimeout(() => panel.hidePopover(),150); };
  onDestroy(() => clearTimeout(timer));
</script>

<span class="info-tip">
  <button class="info-button" type="button" bind:this={button} aria-label={t('help-about', { label })}
    aria-expanded={opened} aria-controls={id} aria-describedby={opened ? id : undefined}
    onpointerenter={show} onpointerleave={hide} onfocus={show} onblur={hide}
    onclick={() => { pinned = !pinned; if (pinned) show(); else panel.hidePopover(); }}>{warning?'!':'i'}</button>
  <div class="info-popover" {id} bind:this={panel} popover="auto" role="tooltip"
    style:left={left + 'px'} style:top={top + 'px'} onpointerenter={() => clearTimeout(timer)} onpointerleave={hide}
    ontoggle={event => { opened = event.newState === 'open'; if (!opened) pinned = false; }}>{text}</div>
</span>
