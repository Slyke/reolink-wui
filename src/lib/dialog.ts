import type { Action } from 'svelte/action';

export const dismissOnBackdrop: Action<HTMLDialogElement, (() => void) | undefined> = (dialog, close) => {
  let startedOutside = false;
  const onBackdrop = (event: MouseEvent) => {
    if (event.target !== dialog) return false;
    const { left, right, top, bottom } = dialog.getBoundingClientRect();
    return event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom;
  };
  const start = (event: PointerEvent) => {
    startedOutside = event.isPrimary && event.button === 0 && onBackdrop(event);
  };
  const cancel = () => { startedOutside = false; };
  const finish = (event: MouseEvent) => {
    if (startedOutside && dialog.open && onBackdrop(event)) {
      if (close) close();
      else dialog.close();
    }
    cancel();
  };
  dialog.addEventListener('pointerdown', start);
  dialog.addEventListener('pointercancel', cancel);
  dialog.addEventListener('click', finish);
  return {
    destroy: () => {
      dialog.removeEventListener('pointerdown', start);
      dialog.removeEventListener('pointercancel', cancel);
      dialog.removeEventListener('click', finish);
    }
  };
};
