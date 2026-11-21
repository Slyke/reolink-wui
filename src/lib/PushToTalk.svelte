<script lang="ts">
  import { onMount } from 'svelte';
  import { api, errorText, operationId, t } from './api.js';
  import type { TalkCapability, TalkFormat } from '../../shared/talk.js';
  import workletUrl from './talk-capture.worklet.js?url&no-inline';

  let {base,csrf}:{base:string;csrf:string}=$props();
  let format=$state<TalkFormat>();
  let lookupError=$state(''), notice=$state(''), phase=$state<'idle'|'starting'|'talking'>('idle');
  let lookup:AbortController|undefined;
  type Call = {
    path:string; csrf:string; audio:AudioContext; stream?:MediaStream; capture?:AudioWorkletNode;
    claimed:boolean; pending:ArrayBuffer[]; sending:boolean; sequence:number; abort:AbortController
  };
  let call:Call|undefined;
  let pointer:number|undefined;
  let key:string|undefined;

  async function check() {
    lookup?.abort();
    const request=new AbortController();
    lookup=request; lookupError='';
    try {
      const result=await api<TalkCapability>({path:base+'/talk',signal:request.signal});
      if(!request.signal.aborted) format=result.available?result:undefined;
    } catch(e) { if(!request.signal.aborted) lookupError=errorText(e); }
  }
  function relinquish(session:Call) {
    return api({path:session.path,csrf:session.csrf,method:'DELETE',keepalive:true}).catch(e=>{
      if(!call) notice=errorText(e);
    });
  }
  function release() {
    const previous=call;
    call=undefined; pointer=undefined; key=undefined; phase='idle';
    if(!previous) return;
    previous.abort.abort();
    previous.pending.length=0;
    previous.capture?.port.close();
    previous.capture?.disconnect();
    previous.stream?.getTracks().forEach(track=>track.stop());
    void previous.audio.close().catch(()=>{});
    if(previous.claimed) void relinquish(previous);
  }
  async function flush(session:Call) {
    if(session.sending) return;
    session.sending=true;
    try {
      while(call===session && session.pending.length) {
        const pcm=new Uint8Array(session.pending.shift()!);
        await api({path:session.path,csrf:session.csrf,method:'PUT',
          body:{sequence:session.sequence++,pcm:btoa(String.fromCharCode(...pcm))},
          signal:AbortSignal.any([session.abort.signal,AbortSignal.timeout(4000)])});
      }
    } catch(e) {
      if(call===session){release();notice=errorText(e);}
    } finally {session.sending=false;}
  }
  async function begin() {
    if(call || !format) return;
    notice='';
    if(!navigator.mediaDevices?.getUserMedia || typeof AudioContext==='undefined' || typeof AudioWorkletNode==='undefined') {
      notice=t('talk-unavailable-browser');return;
    }
    let audio:AudioContext;
    try {audio=new AudioContext();} catch {notice=t('talk-microphone-failed');return;}
    const session:Call={audio,path:base+'/talk/'+operationId(),csrf,claimed:false,pending:[],sending:false,sequence:0,abort:new AbortController()};
    call=session;
    phase='starting';
    try {
      // Request both permissions from the initial press. A late permission prompt must never leave the mic open.
      const streamReady=navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true}})
        .then(stream=>{
          if(call===session) session.stream=stream;
          else stream.getTracks().forEach(track=>track.stop());
        });
      await Promise.all([streamReady,audio.resume(),audio.audioWorklet.addModule(workletUrl)]);
      if(call!==session || !session.stream) return;
      session.claimed=true;
      const accepted=await api<TalkFormat>({path:session.path,csrf,method:'POST',signal:AbortSignal.timeout(18_000)});
      if(call!==session){await relinquish(session);return;}
      const chunkSamples=accepted.blockSamples*(accepted.blockSamples/accepted.sampleRate<=0.1?2:1);
      const capture=new AudioWorkletNode(audio,'camera-talk-capture',{
        channelCount:1,channelCountMode:'explicit',numberOfInputs:1,numberOfOutputs:1,
        processorOptions:{targetRate:accepted.sampleRate,chunkSamples}
      });
      session.capture=capture;
      capture.onprocessorerror=()=>{if(call===session){release();notice=t('talk-microphone-failed');}};
      capture.port.onmessage=({data}:{data:ArrayBuffer})=>{
        if(call!==session) return;
        if(session.pending.length>=3){release();notice=t('error-TALK_BUSY');return;}
        session.pending.push(data);void flush(session);
      };
      for(const track of session.stream.getAudioTracks()) track.addEventListener('ended',()=>{if(call===session)release();},{once:true});
      audio.createMediaStreamSource(session.stream).connect(capture);
      capture.connect(audio.destination);
      phase='talking';
    } catch(e) {
      if(call===session){
        release();
        notice=e instanceof DOMException ? t(e.name==='NotAllowedError'?'talk-microphone-denied':'talk-microphone-failed') : errorText(e);
      }
    }
  }
  onMount(()=>{
    void check();
    return ()=>{lookup?.abort();release();};
  });
</script>

<svelte:window onblur={release} onpagehide={release} />
<svelte:document onvisibilitychange={()=>{if(document.hidden)release();}} />
{#if format}
  <div class="row talk-controls">
    <button type="button" class:active={phase==='talking'} aria-pressed={phase==='talking'}
      onpointerdown={e=>{
        if(!e.isPrimary || e.button!==0 || key || pointer!==undefined)return;
        e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);pointer=e.pointerId;void begin();
      }}
      onpointerup={e=>{if(e.pointerId===pointer)release();}} onpointercancel={e=>{if(e.pointerId===pointer)release();}}
      onlostpointercapture={e=>{if(e.pointerId===pointer)release();}}
      onkeydown={e=>{if(e.key===' ' || e.key==='Enter'){e.preventDefault();if(!e.repeat && !key && pointer===undefined){key=e.key;void begin();}}}}
      onkeyup={e=>{if(key===e.key){e.preventDefault();release();}}} onblur={()=>{if(key)release();}}
      oncontextmenu={e=>e.preventDefault()}>{t('talk-hold')}</button>
    <span role="status">{phase==='talking'?t('talk-live'):phase==='starting'?t('talk-request'):notice}</span>
  </div>
{:else if lookupError}
  <div class="row talk-controls"><button onclick={check}>{t('talk-retry')}</button><span role="status">{lookupError}</span></div>
{/if}
<style>
  .talk-controls button { touch-action: none; user-select: none; }
  .talk-controls { min-height: 2.5rem; }
</style>
