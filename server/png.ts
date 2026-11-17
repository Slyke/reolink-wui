import { crc32, inflateSync } from 'node:zlib';
import { record } from './bridge-channels.js';
import { Failure } from './errors.js';

export const validatePng = ({ result }: { result: unknown }) => {
  const invalid = () => new Failure('SNAPSHOT_INVALID', 502);
  const image = record(result);
  const text = image.data_base64;
  if (image.content_type !== 'image/png' || image.encoding !== 'base64' || typeof text !== 'string'
    || text.length > 25_165_824 || text.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(text)) throw invalid();
  const bytes = Buffer.from(text, 'base64');
  if (bytes.toString('base64') !== text || bytes.length < 57 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw invalid();

  const compressed: Buffer[] = [];
  let header = false;
  let end = false;
  let width = 0;
  let height = 0;
  let stride = 0;
  for (let offset = 8, count = 0; offset < bytes.length; count++) {
    if (count >= 8192 || bytes.length - offset < 12 || end) throw invalid();
    const length = bytes.readUInt32BE(offset);
    const next = offset + 12 + length;
    if (next > bytes.length || crc32(bytes.subarray(offset + 4, next - 4)) !== bytes.readUInt32BE(next - 4)) throw invalid();
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, next - 4);
    if (count === 0 && type !== 'IHDR') throw invalid();
    if (type === 'IHDR') {
      if (header || length !== 13) throw invalid();
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (width < 1 || width > 1920 || height < 1 || height > 1080 || width !== image.width || height !== image.height
        || data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] || data[11] || data[12]) throw invalid();
      stride = width * (data[9] === 2 ? 3 : 4) + 1;
      header = true;
    } else if (type === 'IDAT') {
      if (length === 0) throw invalid();
      compressed.push(data);
    } else if (type === 'IEND') {
      if (length !== 0 || compressed.length === 0) throw invalid();
      end = true;
    } else {
      // Rust image's RGB encoder does not need ancillary chunks; refuse unneeded metadata.
      throw invalid();
    }
    offset = next;
  }
  if (!end) throw invalid();
  try {
    const expanded = inflateSync(Buffer.concat(compressed), { maxOutputLength: stride * height });
    if (expanded.length !== stride * height) throw invalid();
    for (let i = 0; i < expanded.length; i += stride) if (expanded[i] > 4) throw invalid();
  } catch { throw invalid(); }
  return bytes;
};
