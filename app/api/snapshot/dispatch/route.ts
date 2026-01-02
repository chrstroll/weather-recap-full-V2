// app/api/snapshot/dispatch/route.ts
import { Redis } from "@upstash/redis";
import { placeKey, round2 } from "../../../../lib/snapshotUtils";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

type Place = { name: string; lat: number; lon: number };
type QueueItem = { name: string; lat: number; lon: number };

const TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function coercePlace(item: any): Place | null {
  let obj: any = item;

  if (typeof item === "string") {
    try {
      obj = JSON.parse(item);
    } catch {
      return null;
    }
  }
  if (!obj) return null;

  const lat = Number(obj.lat);
  const lon = Number(obj.lon);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;

  const name =
    typeof obj.name === "string" ? obj.name.trim() : String(obj.name || "").trim();
  if (!name) return null;

  return { name, lat: round2(lat), lon: round2(lon) };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);

    // Drain settings (tunable from query string)
    const batch = Math.max(1, Math.min(200, parseInt(url.searchParams.get("batch") || "25", 10)));
    const concurrency = Math.max(1, Math.min(8, parseInt(url.searchParams.get("concurrency") || "3", 10)));
    const maxBatches = Math.max(1, Math.min(250, parseInt(url.searchParams.get("maxBatches") || "40", 10)));

    const todayUTC = new Date().toISOString().slice(0, 10);

    const queueKey = `twr:snap:queue:${todayUTC}`;
    const enqSetKey = `twr:snap:enqueued:${todayUTC}`;
    const statsKey = `twr:snap:stats:${todayUTC}`;

    // Ensure daily keys don't live forever
    await Promise.all([
      redis.expire(queueKey, TTL_SECONDS),
      redis.expire(enqSetKey, TTL_SECONDS),
      redis.expire(statsKey, TTL_SECONDS),
    ]);

    // Build pinned-only list: union all twr:user:<uid>:places
    const userIds = ((await redis.smembers("twr:users")) as string[]) || [];

    const perUser = await Promise.all(
      userIds.map(async (uid) => {
        const raw = (await redis.smembers(`twr:user:${uid}:places`)) as any[];
        return (raw || []).map(coercePlace).filter(Boolean) as Place[];
      })
    );

    const all = perUser.flat();

    // Dedup by rounded coords; keep a "best" name (prefer longer/more specific)
    const uniq = new Map<string, QueueItem>();
    for (const p of all) {
      const rl = round2(p.lat);
      const rlo = round2(p.lon);
      const k = placeKey(rl, rlo);

      const existing = uniq.get(k);
      if (!existing) {
        uniq.set(k, { name: p.name, lat: rl, lon: rlo });
      } else {
        const cur = (existing.name || "").trim();
        const next = (p.name || "").trim();
        if (next.length > cur.length) {
          uniq.set(k, { name: next, lat: rl, lon: rlo });
        }
      }
    }

    const places = [...uniq.values()];

    let enqueued = 0;

    // Enqueue sequentially (gentler on Redis)
    for (const p of places) {
      const k = placeKey(p.lat, p.lon);

      // SADD returns 1 if new
      const added = await redis.sadd(enqSetKey, k);
      if (!added) continue;

      await redis.rpush(queueKey, JSON.stringify(p));
      enqueued++;
    }

    await Promise.all([
      redis.hincrby(statsKey, "enqueued", enqueued),
      redis.hset(statsKey, { lastDispatchAt: new Date().toISOString() }),
    ]);

    // --- CRITICAL FIX (free-plan safe): drain the queue by calling worker repeatedly ---
    const origin = new URL(req.url).origin;

    let drainedBatches = 0;
    let drainedOk = 0;
    let drainedFail = 0;
    let lastWorker: any = null;

    for (let i = 0; i < maxBatches; i++) {
      const workerURL =
        `${origin}/api/snapshot/worker?batch=${batch}&concurrency=${concurrency}&_=${Date.now()}`;

      const res = await fetch(workerURL, { cache: "no-store" });
      const json = await res.json();
      lastWorker = json;

      // Worker returns {status:"empty"} when queue is empty
      if (json?.status === "empty") break;

      drainedBatches++;
      drainedOk += Number(json?.okCount || 0);
      drainedFail += Number(json?.failCount || 0);

      // Safety: if worker didn't pop anything, stop
      if (Number(json?.batchSize || 0) === 0) break;
    }

    await redis.hset(statsKey, { lastDrainAt: new Date().toISOString() });

    return Response.json({
      status: "ok",
      dateUTC: todayUTC,
      users: userIds.length,
      uniquePinnedPlaces: places.length,
      newlyEnqueued: enqueued,
      queueKey,
      ttlSeconds: TTL_SECONDS,
      drain: {
        batch,
        concurrency,
        maxBatches,
        drainedBatches,
        drainedOk,
        drainedFail,
        lastWorkerSample: lastWorker,
      },
    });
  } catch (e: any) {
    return Response.json(
      { status: "error", detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}