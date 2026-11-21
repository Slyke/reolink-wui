<script lang="ts">
  import SettingsDisclosure from './SettingsDisclosure.svelte';
  import { api, errorText, t } from './api.js';
  import { formatLocalTimestamp } from './dates.js';
  type Kind = 'video' | 'timeLapse';
  type Rule = { kind:Kind;days:number;last_checked:string|null;last_deleted:number;last_skipped:number;last_error:string|null;last_reference:string|null };
  type View = { rules:Rule[];support:Record<Kind,boolean>|null;unavailable?:boolean };
  let { base,csrf }:{base:string;csrf:string}=$props();
  const kinds:Kind[]=['video','timeLapse'];
  let view=$state<View>(), busy=$state(false), error=$state(''), saved=$state(false), expanded=$state(false);
  let values=$state<Record<Kind,number|null>>({video:null,timeLapse:null});
  const original=(kind:Kind)=>view?.rules.find(r=>r.kind===kind)?.days ?? null;
  const dirty=$derived(kinds.some(kind=>values[kind]!==original(kind)));
  const valid=$derived(kinds.every(kind=>values[kind]===null || (Number.isInteger(values[kind]) && Number(values[kind]) >= 1 && Number(values[kind]) <= 36500)));
  export const working=()=>busy;
  function apply(next:View) {
    view=next;
    for (const kind of kinds) values[kind]=next.rules.find(rule=>rule.kind===kind)?.days ?? null;
  }
  export async function refresh(){
    if (!expanded || busy) return;
    busy=true; error=''; saved=false;
    try {apply(await api<View>({path:base+'/media-retention'}));}
    catch(cause) {error=errorText(cause);}
    finally{busy=false;}
  }
  async function save(){
    if (!view || !valid || !dirty || busy) return;
    busy=true; error=''; saved=false;
    try {
      const result=await api<{rules:Rule[]}>({path:base+'/media-retention',method:'PUT',csrf,
        body:{video:values.video??null,timeLapse:values.timeLapse??null}});
      apply({...view,rules:result.rules}); saved=true;
    } catch(cause) {error=errorText(cause);}
    finally{busy=false;}
  }
</script>

<SettingsDisclosure title={t('media-retention')} managed ontoggle={open=>{expanded=open;if(open)void refresh();}}>
  {#if view}
    <form class="stack" onsubmit={event=>{event.preventDefault();void save();}}>
      {#if !view.support}<p class="notice">{t(view.unavailable?'retention-offline':'retention-upgrade')}</p>{/if}
      <div class="form-grid">
        {#each kinds as kind}
          {@const rule=view.rules.find(row=>row.kind===kind)}
          <div class="stack">
            <label>{t('retention-days-'+kind)}
              <input type="number" min="1" max="36500" step="1" placeholder={t('off')} bind:value={values[kind]}
                disabled={busy || (!view.support?.[kind] && original(kind)===null)} oninput={()=>{saved=false;}} />
            </label>
            {#if view.support && !view.support[kind]}<p class="muted">{t('retention-unsupported-'+kind)}</p>{/if}
            {#if rule?.last_checked}
              <small class="muted">{t('retention-last-check',{time:formatLocalTimestamp(rule.last_checked),deleted:rule.last_deleted,skipped:rule.last_skipped})}</small>
              {#if rule.last_error}<p class="error" role="alert">{t('error-'+rule.last_error)} · {t('correlation')} {rule.last_reference}</p>{/if}
            {/if}
          </div>
        {/each}
      </div>
      <div class="row"><button class="primary" disabled={busy || !dirty || !valid}>{t('retention-save')}</button></div>
    </form>
  {/if}
  {#if busy}<p role="status">{t('loading')}</p>{:else if saved}<p role="status">{t('retention-saved')}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</SettingsDisclosure>
