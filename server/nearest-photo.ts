// Older bridges can list JPEGs without capture timestamps. The camera can still
// identify the photos in an inclusive, camera-local time window.
export async function nearestUndatedPhoto(second: number, maxDistance: number, read: (from:number,to:number) => Promise<string[]>) {
  const end = 86_399;
  const windows = new Map<string,string[]>();
  const ids = async (from:number,to:number) => {
    const key = from+'/'+to;
    let result = windows.get(key);
    if (!result) {result = await read(from,to);windows.set(key,result);}
    return result;
  };
  const around = (radius:number) => ids(Math.max(0,second-radius),Math.min(end,second+radius));
  const limit = Math.min(maxDistance,Math.max(second,end-second));
  let low = -1, high = Math.min(30,limit);
  while (!(await around(high)).length) {
    if (high === limit) return null;
    low = high;
    high = Math.min(high*2,limit);
  }
  while (high-low > 1) {
    const middle = Math.floor((low+high)/2);
    if ((await around(middle)).length) high = middle;
    else low = middle;
  }
  for (const time of new Set([second-high,second+high])) {
    if (time < 0 || time > end) continue;
    const matches = await ids(time,time);
    if (!matches.length) continue;
    // Firmware that ignores the range must not assign the cursor's time to a photo.
    const neighbor = time === end ? time-1 : time+1;
    const adjacent = new Set(await ids(neighbor,neighbor));
    const id = matches.find(candidate => !adjacent.has(candidate));
    if (id) return {id,time};
  }
  return null;
}
