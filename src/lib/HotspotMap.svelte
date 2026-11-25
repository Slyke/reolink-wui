<script lang="ts">
  import type { DetectionZone } from '../../shared/detection-zones.js';
  import { height,width,type HeatMap } from './hotspot-video.js';
  import { t } from './api.js';
  let { map,zone,label }:{map:HeatMap;zone?:DetectionZone;label:string}=$props();
  let canvas:HTMLCanvasElement;
  $effect(()=>{
    const ctx=canvas?.getContext('2d');if(!ctx)return;
    const image=new ImageData(width,height);
    for(let i=0;i<map.sum.length;i++){
      const heat=Math.min(1,map.sum[i]/map.pairs/6);
      const p=i*4, x=i%width,y=Math.floor(i/width);
      const shade=zone && zone.cells[Math.floor(y*zone.height/height)*zone.width+Math.floor(x*zone.width/width)]==='0'?.25:1;
      const opacity=Math.min(.96,Math.sqrt(heat));
      for(let c=0;c<3;c++){
        const color=c===0?255:c===1?Math.round(124+100*heat):16;
        image.data[p+c]=shade*(map.picture.data[p+c]*(1-opacity)*.80+color*opacity);
      }
      image.data[p+3]=255;
    }
    ctx.putImageData(image,0,0);
  });
</script>
<figure>
  <figcaption><strong>{label}</strong> · {t('hotspot-sample-count',{pairs:map.pairs,clips:map.clips})}</figcaption>
  <canvas bind:this={canvas} {width} {height} aria-label={label}></canvas>
  {#if map.missed}<small>{t('hotspot-skipped',{count:map.missed})}</small>{/if}
</figure>
<style>
  figure{margin:0;min-width:0}canvas{display:block;width:100%;height:auto;margin-top:.5rem}
</style>
