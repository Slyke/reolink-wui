<script lang="ts">
  import type { Snippet } from 'svelte';
  import SettingsDisclosure from './SettingsDisclosure.svelte';
  import { api,errorText,operationId,outcomeText,t,type Outcome } from './api.js';
  import { optionTypes,type OptionGroup,type OptionValue,type OptionView } from '../../shared/device-options.js';

  let {base,csrf,online,group,linked=[],title,access,children,extra}:{
    base:string;csrf:string;online:boolean;group:OptionGroup;linked?:OptionGroup[];title?:string;access?:{read:boolean;write:boolean};children?:Snippet;extra?:Snippet<[OptionView,(next:OptionView)=>void]>
  }=$props();
  const groups=$derived([group,...linked]);
  let expanded=$state(false), busy=$state(false);
  let views=$state<Partial<Record<OptionGroup,OptionView>>>({});
  let drafts=$state<Partial<Record<OptionGroup,Record<string,OptionValue>>>>({});
  let errors=$state<Partial<Record<OptionGroup,string>>>({}), messages=$state<Partial<Record<OptionGroup,string>>>({});
  const depends:Record<string,string>={redGain:'whiteBalance',blueGain:'whiteBalance',dayHighlight:'dayTone',dayShadow:'dayTone',nightHighlight:'nightTone',nightShadow:'nightTone'};
  function dependsOnManual(section:OptionGroup,key:string){
    const mode=depends[key];
    return mode && views[section]?.fields[mode] && (drafts[section]?.[mode]??views[section]?.fields[mode].value)!=='manual';
  }
  function value(section:OptionGroup,key:string){return drafts[section]?.[key]??views[section]?.fields[key]?.value;}
  function edit(section:OptionGroup,key:string,next:OptionValue){
    drafts[section]={...drafts[section],[key]:next};messages[section]='';errors[section]='';
  }
  function changes(section:OptionGroup){
    return Object.fromEntries(Object.entries(drafts[section]??{}).filter(([key,item])=>!dependsOnManual(section,key) && item!==views[section]?.fields[key]?.value));
  }
  const choiceText=(key:string,item:string)=>t('device-choice-'+(key==='hdr'?'hdr-':'')+item);
  export function working(){return busy;}
  export async function refresh(){
    if(!expanded || !access?.read || busy)return;
    busy=true;
    try{
      for(const section of groups){
        errors[section]='';messages[section]='';
        try{views[section]=await api<OptionView>({path:base+'/options/'+section});drafts[section]={};}
        catch(err){errors[section]=errorText(err);}
      }
    }finally{busy=false;}
    return groups.every(section=>!errors[section]);
  }
  function open(show:boolean){expanded=show;if(show && groups.some(section=>!views[section]))void refresh();}
  async function save(section:OptionGroup){
    const fields=changes(section);
    if(!online || !access?.write || busy || !Object.keys(fields).length)return;
    busy=true;errors[section]='';messages[section]='';
    try{
      const result=await api<Outcome>({path:base+'/options/'+section,method:'PUT',csrf,body:{operationId:operationId(),fields}});
      if(result.outcome==='confirmed'){views[section]=result.data;drafts[section]={};messages[section]=outcomeText(result);}
      else errors[section]=outcomeText(result);
    }catch(err){errors[section]=errorText(err);}
    finally{busy=false;}
  }
</script>

<SettingsDisclosure title={t(title??'device-group-'+group)} ontoggle={open}>
  {#if expanded}
    {@render children?.()}
    {#if access && !access.read}<p class="muted">{t('device-read-required')}</p>
    {:else if access}
      {#each groups as section (section)}
        {@const view=views[section]}
        {#if view && Object.keys(view.fields).length}
          <form class="stack device-options" onsubmit={e=>{e.preventDefault();void save(section);}}>
            {#if groups.length>1}<h4>{t('device-group-'+section)}</h4>{/if}
            {#if section==='privacy' && view.privacyZones!==undefined}<p class="muted">{view.privacyZones?t('device-privacy-count',{count:String(view.privacyZones)}):t('device-privacy-empty')}</p>{/if}
            {#if ['email','push','siren'].includes(section)}<p class="muted">{t('device-help-'+section)}</p>{/if}
            <div class="form-grid">
              {#each Object.keys(optionTypes[section]).filter(key=>view.fields[key]) as key (key)}
                {@const field=view.fields[key]}
                {@const disabled=busy || !online || !access?.write || !!dependsOnManual(section,key)}
                {#if 'choices' in field}
                  <label>{t('device-field-'+key)}
                    <select aria-label={t('device-field-'+key)} value={String(value(section,key))} disabled={disabled || field.choices.length<2}
                      onchange={e=>edit(section,key,e.currentTarget.value)}>
                      {#each field.choices as item}<option value={item}>{choiceText(key,item)}</option>{/each}
                    </select>
                  </label>
                {:else if 'min' in field}
                  <label>{t('device-field-'+key)}
                    <input type="number" min={field.min} max={field.max} step="1" required value={Number(value(section,key))}
                      disabled={disabled || field.min===field.max} oninput={e=>edit(section,key,e.currentTarget.valueAsNumber)}/>
                  </label>
                {:else}
                  <label class="check"><input type="checkbox" disabled={disabled || (key==='maskEnabled' && !field.value && !view.privacyZones)}
                    checked={value(section,key)===true} onchange={e=>edit(section,key,e.currentTarget.checked)}/>{t('device-field-'+key)}</label>
                {/if}
              {/each}
            </div>
            {#if access.write}<div class="row"><button class="primary" disabled={busy || !online || !Object.keys(changes(section)).length}>{t('save')}</button></div>{/if}
          </form>
          {@render extra?.(view,(next)=>{views[section]=next;drafts[section]={};})}
        {:else if view && groups.length===1}<p class="muted">{t('device-options-empty')}</p>{/if}
        {#if errors[section]}<p class="error" role="alert">{t('device-group-'+section)} · {errors[section]}</p>{/if}
        {#if messages[section]}<p role="status">{messages[section]}</p>{/if}
      {/each}
      {#if groups.length>1 && groups.every(section=>views[section] && !Object.keys(views[section]!.fields).length)}<p class="muted">{t('device-options-empty')}</p>{/if}
      <div class="row"><button disabled={busy} onclick={refresh}>{t('device-reload-options')}</button></div>
      {#if busy}<p role="status">{t('loading')}</p>{/if}
    {/if}
  {/if}
</SettingsDisclosure>
