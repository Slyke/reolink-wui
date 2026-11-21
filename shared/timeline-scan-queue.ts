type Pending<T> = {
  load: (signal:AbortSignal) => Promise<T>;
  resolve: (value:T) => void;
  reject: (error:unknown) => void;
};

// The selected day owns these requests. The pointer only changes which pending job starts next.
export class TimelineScanQueue<T> {
  private lifetime = new AbortController();
  private results = new Map<string, Promise<T>>();
  private pending = new Map<string, Pending<T>>();
  private preferred?: string;
  private running = 0;
  private takeOldest = false;
  private idleWaiters = new Set<() => void>();

  constructor(private concurrency:number) {}

  request(key:string, current:boolean, load:Pending<T>['load']): Promise<T> {
    if (this.lifetime.signal.aborted) return Promise.reject(this.lifetime.signal.reason);
    let result = this.results.get(key);
    if (!result) {
      result = new Promise<T>((resolve,reject) => this.pending.set(key,{load,resolve,reject}));
      this.results.set(key,result);
    }
    if (current && this.pending.has(key)) this.preferred = key;
    this.drain();
    return result;
  }

  private drain() {
    while (this.running < this.concurrency && this.pending.size) {
      const oldest = this.pending.keys().next().value!;
      const key = this.takeOldest ? oldest : this.preferred ?? oldest;
      // Alternate when the pointer competes with a backlog so a long drag makes progress on both.
      this.takeOldest = key !== oldest;
      if (key === this.preferred) this.preferred = undefined;
      const job = this.pending.get(key)!;
      this.pending.delete(key);
      this.running++;
      void this.run(key,job);
    }
    if (!this.pending.size && !this.running) {
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
  }

  private async run(key:string, job:Pending<T>) {
    try { job.resolve(await job.load(this.lifetime.signal)); }
    catch (error) { job.reject(error); }
    finally {
      this.results.delete(key);
      this.running--;
      this.drain();
    }
  }

  whenIdle() {
    if (!this.results.size) return Promise.resolve();
    return new Promise<void>(resolve => this.idleWaiters.add(resolve));
  }

  close() {
    this.lifetime.abort();
    for (const job of this.pending.values()) job.reject(this.lifetime.signal.reason);
    this.pending.clear();
    this.results.clear();
    this.preferred = undefined;
    this.drain();
  }
}
