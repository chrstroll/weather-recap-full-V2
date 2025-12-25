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
  // NEW (optional for backwards compatibility with older snapshots)
  yesterday?: {
    tmax: number | null;
    tmin: number | null;
    rain: number | null;
    snow: number | null;
    wind: number | null;
  } | null;
};

const STARTER_PLACES: Place[] = [
  { name: "San Francisco, California, United States", lat: 37.77, lon: -122.42 },
  { name: "London, England, United Kingdom", lat: 51.51, lon: -0.13 },
];

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

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

  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  const lat = Number(obj.lat);
  const lon = Number(obj.lon);

  if (!name || Number.isNaN(lat) || Number.isNaN(lon)) return null;

  return { name, lat: round2(lat), lon: round2(lon) };
}

async function getLatestSnapshot(lat: number, lon: number): Promise<Snapshot | null> {
  const rl = round2(lat);
  const rlo = round2(lon);

  const today = new Date().toISOString().slice(0, 10);
  const todayKey = `twr:snap:${today}:${rl},${rlo}`;

  let snapJson: any = await redis.get(todayKey);

  if (!snapJson) {
    const indexKey = `twr:index:${rl},${rlo}`;
    const keys = (await redis.smembers(indexKey)) as string[];
    if (!keys || keys.length === 0) return null;

    const latestKey = keys.sort().at(-1)!;
    snapJson = await redis.get(latestKey);
    if (!snapJson) return null;
  }

  if (typeof snapJson === "string") {
    try {
      return JSON.parse(snapJson) as Snapshot;
    } catch {
      return null;
    }
  }

  return snapJson as Snapshot;
}

async function computeCompositeScore(lat: number, lon: number): Promise<number | null> {
  try {
    const accuracyUrl =
      `https://weather-recap-full-v2.vercel.app/api/accuracy` +
      `?lat=${lat}&lon=${lon}&horizon=1`;

    const res = await fetch(accuracyUrl, { cache: "no-store" });
    if (!res.ok) return null;

    const data = await res.json();

    // If accuracy isn't ready, don't invent a score
    if (data?.status !== "ok" || !Array.isArray(data?.rows) || data.rows.length === 0) {
      return null;
    }

    const tempMAE = typeof data.summary?.mae === "number" ? data.summary.mae : null; // °C
    const windMAE = typeof data.summary?.windMAE === "number" ? data.summary.windMAE : null; // km/h
    if (tempMAE == null || windMAE == null) return null;

    // Optional precip MAE from rows (rain deltas)
    const precipErrors: number[] = [];
    for (const r of data.rows) {
      if (typeof r?.deltas?.rain === "number") {
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
    return null;
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const userId = url.searchParams.get("userId");

    if (!userId) {
      return Response.json({ status: "missing-user-id", items: [] }, { status: 400 });
    }

    // Track users globally so snapshot job can union per-user places
    await redis.sadd("twr:users", userId);

    const placesKey = `twr:user:${userId}:places`;

    let rawPlaces = (await redis.smembers(placesKey)) as any[];

    // Seed starter places if empty
    if (!rawPlaces || rawPlaces.length === 0) {
      await Promise.all(STARTER_PLACES.map((p) => redis.sadd(placesKey, JSON.stringify(p))));
      rawPlaces = (await redis.smembers(placesKey)) as any[];
    }

    if (!rawPlaces || rawPlaces.length === 0) {
      return Response.json({ status: "no-places", items: [] });
    }

    // Parse & normalize places (rounded coords)
    const places = (rawPlaces || []).map(coercePlace).filter(Boolean) as Place[];

    if (places.length === 0) {
      return Response.json({ status: "no-places", items: [] });
    }

    // Ensure places are in global set in the same JSON-string format
    await Promise.all(
      places.map((p) => redis.sadd("twr:places", JSON.stringify(p)))
    );

    const today = new Date().toISOString().slice(0, 10);

    const items = await Promise.all(
      places.map(async (place) => {
        const snap = await getLatestSnapshot(place.lat, place.lon);

        if (!snap) {
          return {
            place,
            snapshotDate: today,
            score: null,
            yesterday: null,
          };
        }

        const score = await computeCompositeScore(place.lat, place.lon);

        return {
          place: snap.place,
          snapshotDate: snap.snapshotDate,
          score,
          yesterday: snap.yesterday ?? null,
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