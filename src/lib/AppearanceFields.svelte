<script lang="ts">
  import { t } from './api.js';
  import { fontGroups, modes, palettes, widths, type Appearance } from '../../shared/appearance.js';

  let { settings, choose, disabled = false }: {
    settings: Appearance; choose: ({ key, value }: { key: keyof Appearance; value: string }) => void; disabled?: boolean
  } = $props();
</script>

<div class="appearance-fields">
  <label>{t('appearance-theme')}
    <select value={settings.palette} {disabled} onchange={event => choose({ key: 'palette', value: event.currentTarget.value })}>
      {#each palettes as item}<option value={item}>{t('palette-' + item)}</option>{/each}
    </select>
  </label>
  <label>{t('appearance-mode')}
    <select value={settings.theme} {disabled} onchange={event => choose({ key: 'theme', value: event.currentTarget.value })}>
      {#each modes as item}<option value={item}>{t(item)}</option>{/each}
    </select>
  </label>
</div>
<div class="form-grid">
  <label>{t('appearance-font')}
    <select value={settings.font} {disabled} onchange={event => choose({ key: 'font', value: event.currentTarget.value })}>
      {#each fontGroups as group}
        <optgroup label={t(group.label)}>
          {#each group.options as item}<option value={item}>{t('font-' + item)}</option>{/each}
        </optgroup>
      {/each}
    </select>
  </label>
  <label>{t('appearance-width')}
    <select value={settings.contentWidth} {disabled} onchange={event => choose({ key: 'contentWidth', value: event.currentTarget.value })}>
      {#each widths as item}<option value={item}>{t('width-' + item)}</option>{/each}
    </select>
  </label>
</div>
