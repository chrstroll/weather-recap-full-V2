// lib/snapshotUtils.ts

export function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export function placeKey(lat: number, lon: number) {
  const rl = round2(lat);
  const rlo = round2(lon);
  return `${rl},${rlo}`;
}

export async function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: { retries?: number; baseDelayMs?: number }
): Promise<T> {
  const retries = opts?.retries ?? 4;
  const baseDelayMs = opts?.baseDelayMs ?? 300;

  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      // exponential backoff + jitter
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
      await sleep(delay);
    }
  }
  throw lastErr;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length) as any;
  let index = 0;

  async function runner() {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  }

  const runners = Array.from({ length: Math.max(1, concurrency) }, () => runner());
  await Promise.all(runners);
  return results;
}