// app/api/overview/route.ts
import { Redis } from "@upstash/redis";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

type Place = {
  name: string;
  lat: number;
  lon: number;
};

type Snapshot = {
  place: Place;
  snapshotDate: string;
  daily: {
    time: string[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    rain_sum: number[];
    snowfall_sum: number[];
    relative_humidity_2m_mean: number[];
    windspeed_10m_max: number[];
  };
};

async function computeCompositeScore(lat: number, lon: number): Promise<number> {
  try {
    const accuracyUrl = `https://weather-recap-full-v2.vercel.app/api/accuracy?lat=${lat}&lon=${lon}&horizon=1`;
    const res = await fetch(accuracyUrl, { cache: "no-store" });
    if (!res.ok) return 50;

    const data = await res.json();
    const tempMAE = data.summary.mae ?? 0;     // °C
    const windMAE = data.summary.windMAE ?? 0; // km/h

    let precipErrors: number[] = [];
    for (const r of data.rows ?? []) {
      if (typeof r.deltas?.rain === "number") {
        precipErrors.push(Math.abs(r.deltas.rain));
      }
    }
    const precipMAE =
      precipErrors.length > 0
        ? precipErrors.reduce((a, b) => a + b, 0) / precipErrors.length
        : 0;

    const tempScore = Math.max(0, 100 - tempMAE * 10);
    const windScore = Math.max(0, 100 - windMAE * 2);
    const precipScore = Math.max(0, 100 - precipMAE * 20);

    const composite = 0.5 * tempScore + 0.3 * windScore + 0.2 * precipScore;
    return Math.round(composite);
  } catch {
    return 50;
  }
}

async function getLatestSnapshot(lat: number, lon: number): Promise<Snapshot | null> {
  const today = new Date().toISOString().slice(0, 10);
  const todayKey = `twr:snap:${today}:${lat},${lon}`;

  let snapJson = await redis.get(todayKey);

  if (!snapJson) {
    const indexKey = `twr:index:${lat},${lon}`;
    const keys = (await redis.smembers(indexKey)) as string[];
    if (!keys || keys.length === 0) return null;

    const latestKey = keys.sort().at(-1)!;
    snapJson = await redis.get(latestKey);
    if (!snapJson) return null;
  }

  if (typeof snapJson === "string") {
    return JSON.parse(snapJson) as Snapshot;
  }
  return snapJson as Snapshot;
}

const STARTER_PLACES: Place[] = [
  { name: "San Francisco, California, United States", lat: 37.77, lon: -122.42 },
  { name: "London, England, United Kingdom", lat: 51.51, lon: -0.13 },
];

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const userId = url.searchParams.get("userId");

    if (!userId) {
      return Response.json({ status: "missing-user-id", items: [] }, { status: 400 });
    }

    // ✅ Track user globally for snapshot unioning
    await redis.sadd("twr:users", userId);

    const placesKey = `twr:user:${userId}:places`;

    let rawPlaces = (await redis.smembers(placesKey)) as any[];

    if (!rawPlaces || rawPlaces.length === 0) {
      await Promise.all(STARTER_PLACES.map((p) => redis.sadd(placesKey, JSON.stringify(p))));
      rawPlaces = (await redis.smembers(placesKey)) as any[];
    }

    if (!rawPlaces || rawPlaces.length === 0) {
      return Response.json({ status: "no-places", items: [] });
    }

    const places: Place[] = rawPlaces.map((p) => (typeof p === "string" ? JSON.parse(p) : p));

    // ✅ Best-effort reconcile: ensure these places also exist in legacy global set
    // (safe/idempotent; does not change user experience)
    await Promise.all(
      places.map((p) => redis.sadd("twr:places", { name: p.name, lat: p.lat, lon: p.lon }))
    );

    const today = new Date().toISOString().slice(0, 10);

    const items = await Promise.all(
      places.map(async (place) => {
        const snap = await getLatestSnapshot(place.lat, place.lon);

        if (!snap) {
          return { place, snapshotDate: today, score: null };
        }

        const score = await computeCompositeScore(place.lat, place.lon);

        return {
          place: snap.place,
          snapshotDate: snap.snapshotDate,
          score,
        };
      })
    );

    return Response.json({ status: "ok", items });
  } catch (e: any) {
    return Response.json(
      { status: "error", detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}
