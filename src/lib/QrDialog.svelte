<script lang="ts" module>
  export type QrDialogHandle = {
    show: (options: { code: string | Uint8ClampedArray }) => Promise<boolean>;
    close: () => void;
  };
</script>

<script lang="ts">
  import { onDestroy } from 'svelte';
  import QRCode from 'qrcode';
  import { t } from './api.js';
  import { dismissOnBackdrop } from './dialog.js';

  let { title, description, imageLabel, onclose }: {
    title: string; description: string; imageLabel: string; onclose?: () => void;
  } = $props();
  const id = $props.id();
  let dialog: HTMLDialogElement;
  let canvas: HTMLCanvasElement;
  let generation = 0;

  const clear = () => {
    generation++;
    if (canvas) canvas.width = 0;
  };

  export const close = () => {
    clear();
    if (dialog?.open) dialog.close();
  };

  export const show: QrDialogHandle['show'] = async ({ code }) => {
    const attempt = ++generation;
    const source = document.createElement('canvas');
    try {
      const input = typeof code === 'string' ? code : [{ data: code, mode: 'byte' as const }];
      await QRCode.toCanvas(source, input, { width: 640, margin: 4 });
      if (attempt !== generation) return false;
      canvas.width = source.width;
      canvas.height = source.height;
      canvas.getContext('2d')?.drawImage(source, 0, 0);
      if (!dialog.open) dialog.showModal();
      return true;
    } finally {
      source.width = 0;
      if (typeof code !== 'string') code.fill(0);
    }
  };
  onDestroy(clear);
</script>

<dialog
  class="qr-dialog"
  bind:this={dialog}
  aria-labelledby={id + '-title'}
  aria-describedby={id + '-description'}
  onclose={() => { clear(); onclose?.(); }}
  use:dismissOnBackdrop={close}
>
  <div class="stack qr-dialog-body">
    <div class="row between panel-title">
      <h2 id={id + '-title'}>{title}</h2>
      <form method="dialog"><button>{t('close')}</button></form>
    </div>
    <p class="muted" id={id + '-description'}>{description}</p>
    <canvas class="qr-code" bind:this={canvas} width="0" height="0" aria-label={imageLabel}>{imageLabel}</canvas>
  </div>
</dialog>
