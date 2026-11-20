import { execFile } from 'node:child_process';
import { Failure } from './errors.js';
import { responseBytes } from './net.js';

const limit = 512 * 1024;
const isJpeg = (data: Buffer) => data[0] === 0xff && data[1] === 0xd8 && data.at(-2) === 0xff && data.at(-1) === 0xd9;
const invalid = () => new Failure('MEDIA_UNAVAILABLE',502);

export async function timeLapseThumbnail(response: Response): Promise<Buffer> {
  const media = response.headers.get('content-type')?.split(';')[0];
  if (media === 'image/jpeg') {
    const jpeg = await responseBytes({response,limit});
    if (!isJpeg(jpeg)) throw invalid();
    return jpeg;
  }
  // Older bridges ignore the preview query and return the full PNG used for exports.
  if (media !== 'image/png') { await response.body?.cancel(); throw invalid(); }
  const png = await responseBytes({response,limit:128 * 1024 * 1024});
  if (png.length < 33 || !png.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) ||
      png.toString('ascii',12,16) !== 'IHDR') throw invalid();
  const pixels = png.readUInt32BE(16) * png.readUInt32BE(20);
  if (!pixels || pixels > 32_000_000) throw invalid();
  return new Promise((resolve,reject) => {
    const args = ['-nostdin','-v','error','-threads','1','-f','image2pipe','-c:v','png','-i','pipe:0',
      '-frames:v','1','-vf',"scale='min(480,iw)':'min(270,ih)':force_original_aspect_ratio=decrease",
      '-threads','1','-c:v','mjpeg','-q:v','5','-f','image2pipe','pipe:1'];
    const child = execFile('ffmpeg',args,{encoding:'buffer',maxBuffer:limit,timeout:12_000,killSignal:'SIGKILL'},(error,stdout) => {
      if (error || !isJpeg(stdout)) reject(invalid());
      else resolve(stdout);
    });
    child.stdin?.on('error',() => reject(invalid()));
    child.stdin?.end(png);
  });
}
