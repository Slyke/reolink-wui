export type RecordingFrame<Jpeg> = { jpeg: Jpeg; offsetMs: number };
type Entry<Jpeg> = { clip: string; frame: RecordingFrame<Jpeg>; size: number; expires: number };
export const recordingPreviewLifetime = 600_000;
const byteLimit = 32 * 1024 * 1024;
const entryLimit = 4096;

export class RecordingPreviewCache<Jpeg> {
  private entries = new Map<string, Entry<Jpeg>>();
  private bytes = 0;
  private expiry?: ReturnType<typeof setTimeout>;

  get full() { return this.bytes >= byteLimit - 512 * 1024 || this.entries.size >= entryLimit; }

  private remove(key: string, entry: Entry<Jpeg>) {
    this.bytes -= entry.size;
    this.entries.delete(key);
  }

  private scheduleExpiry() {
    if (this.expiry !== undefined || !this.entries.size) return;
    let first = Infinity;
    for (const entry of this.entries.values()) first = Math.min(first, entry.expires);
    this.expiry = setTimeout(() => {
      this.expiry = undefined;
      const now = Date.now();
      for (const [key, entry] of this.entries) if (entry.expires <= now) this.remove(key, entry);
      this.scheduleExpiry();
    }, Math.max(0, first - Date.now()));
  }

  exact(clip: string, offset: number) {
    const key = clip + '/' + offset;
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expires <= Date.now()) { this.remove(key, entry); return; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.frame;
  }

  nearest(clip: string, offset: number) {
    let closest: RecordingFrame<Jpeg> | undefined;
    const now = Date.now();
    for (const entry of this.entries.values()) {
      if (entry.clip === clip && entry.expires > now &&
        (!closest || Math.abs(entry.frame.offsetMs - offset) < Math.abs(closest.offsetMs - offset))) closest = entry.frame;
    }
    return closest;
  }

  store(clip: string, offset: number, frame: RecordingFrame<Jpeg>, size: number) {
    if (size > byteLimit) return;
    const key = clip + '/' + offset;
    const old = this.entries.get(key);
    if (old) this.remove(key, old);
    for (const [oldKey, entry] of this.entries) {
      if (this.bytes + size <= byteLimit && this.entries.size < entryLimit) break;
      this.remove(oldKey, entry);
    }
    this.entries.set(key, { clip, frame, size, expires: Date.now() + recordingPreviewLifetime });
    this.bytes += size;
    this.scheduleExpiry();
  }

  clear() {
    clearTimeout(this.expiry);
    this.expiry = undefined;
    this.entries.clear();
    this.bytes = 0;
  }
}
