// app/api/snapshot/dispatch/route.ts
import { Redis } from "@upstash/redis";
import { placeKey, round2 } from "../../../../lib/snapshotUtils";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

type Place = { name: string; lat: number; lon: number };

function coercePlace(item: any): Place | null {
  let obj: any = item;
  if (typeof item === "string") {
    try { obj = JSON.parse(item); } catch { return null; }
  }
  if (!obj) return null;

  const lat = Number(obj.lat);
  const lon = Number(obj.lon);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;

  return { name: String(obj.name || ""), lat: round2(lat), lon: round2(lon) };
}

export async function GET() {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const queueKey = `twr:snap:queue:${today}`;
    const enqSet = `twr:snap:enqueued:${today}`;
    const statsKey = `twr:snap:stats:${today}`;

    // Build pinned-only list: union all twr:user:<uid>:places
    const userIds = ((await redis.smembers("twr:users")) as string[]) || [];

    const perUser = await Promise.all(
      userIds.map(async (uid) => {
        const raw = (await redis.smembers(`twr:user:${uid}:places`)) as any[];
        return (raw || []).map(coercePlace).filter(Boolean) as Place[];
      })
    );

    const all = perUser.flat();

    // Dedup by rounded coords
    const uniq = new Map<string, { lat: number; lon: number }>();
    for (const p of all) {
      uniq.set(placeKey(p.lat, p.lon), { lat: round2(p.lat), lon: round2(p.lon) });
    }

    const places = [...uniq.values()];

    let enqueued = 0;
    for (const p of places) {
      const key = placeKey(p.lat, p.lon);
      // SADD returns 1 if new
      const added = await redis.sadd(enqSet, key);
      if (added) {
        await redis.rpush(queueKey, JSON.stringify({ lat: p.lat, lon: p.lon }));
        enqueued++;
      }
    }

    await redis.hincrby(statsKey, "enqueued", enqueued);
    await redis.hset(statsKey, { lastDispatchAt: new Date().toISOString() });

    return Response.json({
      status: "ok",
      date: today,
      users: userIds.length,
      uniquePinnedPlaces: places.length,
      newlyEnqueued: enqueued,
      queueKey,
    });
  } catch (e: any) {
    return Response.json({ status: "error", detail: String(e?.message || e) }, { status: 500 });
  }
}