import type { Recording } from './recordings.js';

export type RecordingGroup = Recording & { variants: Recording[] };
export const recordingTime = (value: string) => Date.parse(value + 'Z');

// Main/sub encoders may cut the same recording a few seconds apart.
// Match both boundaries and consume each variant once; never merge adjacent clips.
export const groupRecordings = ({ recordings }: { recordings: Recording[] }): RecordingGroup[] => {
  const main = recordings.filter(item => item.stream === 'main').sort((a,b) => a.start.localeCompare(b.start));
  const used = new Set<string>();
  const groups: RecordingGroup[] = [];
  let lower = 0;
  for (const sub of recordings.filter(item => item.stream === 'sub').sort((a,b) => a.start.localeCompare(b.start))) {
    const start = recordingTime(sub.start), end = recordingTime(sub.end);
    while (lower < main.length && recordingTime(main[lower].start) < start - 4000) lower++;
    let best: Recording | undefined, score = Infinity;
    for (let index = lower; index < main.length; index++) {
      const item = main[index], otherStart = recordingTime(item.start), otherEnd = recordingTime(item.end);
      if (otherStart > start + 4000) break;
      const overlap = Math.min(end, otherEnd) - Math.max(start, otherStart);
      const distance = Math.abs(start - otherStart) + Math.abs(end - otherEnd);
      if (!used.has(item.id) && Math.abs(end - otherEnd) <= 4000
        && overlap > 0 && overlap >= Math.min(end - start, otherEnd - otherStart) * 0.8 && distance < score) {
        best = item; score = distance;
      }
    }
    const variants = best ? [sub,best] : [sub];
    if (best) used.add(best.id);
    groups.push({
      ...sub, variants, start: variants.map(item => item.start).sort()[0],
      end: variants.map(item => item.end).sort().at(-1)!,
      kind: [...new Set(variants.flatMap(item => item.kind?.split(',') ?? []))].filter(Boolean).join(',') || null
    });
  }
  for (const item of main) if (!used.has(item.id)) groups.push({ ...item, variants: [item] });
  return groups.sort((a,b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
};

export const recordingVariant = ({ group, stream }: { group: RecordingGroup; stream: 'main' | 'sub' }) => (
  group.variants.find(item => item.stream === stream) ?? group.variants[0]
);
