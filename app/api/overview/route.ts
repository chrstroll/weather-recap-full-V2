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
    // ✅ If you ever need it later, snapshot now stores winddirection_10m_dominant in daily too,
    // but overview only needs yesterday.windDirDeg for the hero line.
    winddirection_10m_dominant?: number[];
  };
  yesterday?: {
    tmax: number | null;
    tmin: number | null;
    rain: number | null;
    snow: number | null;
    wind: number | null;
    // ✅ NEW
    windDirDeg?: number | null;
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

/* ---------------- NEW: Open-Meteo fallback for "yesterday" (landing page) ---------------- */

type SnapshotDailyFallback = {
  time: string[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
  precipitation_sum?: number[];
  rain_sum?: number[];
  snowfall_sum?: number[];
  relative_humidity_2m_mean?: number[];
  windspeed_10m_max?: number[];
  winddirection_10m_dominant?: number[];
};

async function fetchDailyFallback(lat: number, lon: number): Promise<{ timezone: string; daily: SnapshotDailyFallback }> {
  const daily = [
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_sum",
    "rain_sum",
    "snowfall_sum",
    "relative_humidity_2m_mean",
    "windspeed_10m_max",
    "winddirection_10m_dominant",
  ].join(",");

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&past_days=1&forecast_days=7&daily=${daily}&timezone=auto&models=ecmwf_ifs`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const json = await res.json();

  if (!json?.daily?.time || !json?.timezone) {
    throw new Error("open-meteo malformed response");
  }

  return { timezone: json.timezone as string, daily: json.daily as SnapshotDailyFallback };
}

function ymdInTZ(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function extractYesterdayFallback(daily: SnapshotDailyFallback, tz: string) {
  const todayLocal = ymdInTZ(new Date(), tz);
  const t = new Date(todayLocal + "T00:00:00Z").getTime();
  const yesterday = new Date(t - 86400000).toISOString().slice(0, 10);

  const idx = daily.time.findIndex((d) => d === yesterday);
  if (idx < 0) return null;

  // NOTE: This object is for the landing page card.
  // It mirrors snapshot/dispatch behavior but does not write a snapshot.
  return {
    tmax: daily.temperature_2m_max?.[idx] ?? null,
    tmin: daily.temperature_2m_min?.[idx] ?? null,
    precip: daily.precipitation_sum?.[idx] ?? null,
    rain: daily.rain_sum?.[idx] ?? null,
    snow: daily.snowfall_sum?.[idx] ?? null,
    wind: daily.windspeed_10m_max?.[idx] ?? null,
    windDirDeg: daily.winddirection_10m_dominant?.[idx] ?? null,
    localYesterday: yesterday,
    timeZone: tz,
  };
}

/* ---------------- existing score logic ---------------- */

async function computeCompositeScore(lat: number, lon: number): Promise<number | null> {
  try {
    const accuracyUrl =
      `https://weather-recap-full-v2.vercel.app/api/accuracy` +
      `?lat=${lat}&lon=${lon}&horizon=1`;

    const res = await fetch(accuracyUrl, { cache: "no-store" });
    if (!res.ok) return null;

    const data = await res.json();

    if (data?.status !== "ok" || !Array.isArray(data?.rows) || data.rows.length === 0) {
      return null;
    }

    const tempMAE = typeof data.summary?.mae === "number" ? data.summary.mae : null; // °C
    const windMAE = typeof data.summary?.windMAE === "number" ? data.summary.windMAE : null; // km/h
    if (tempMAE == null || windMAE == null) return null;

    const precipErrors: number[] = [];
    for (const r of data.rows) {
      if (typeof r?.deltas?.rain === "number") precipErrors.push(Math.abs(r.deltas.rain));
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

    const places = (rawPlaces || []).map(coercePlace).filter(Boolean) as Place[];

    if (places.length === 0) {
      return Response.json({ status: "no-places", items: [] });
    }

    await Promise.all(places.map((p) => redis.sadd("twr:places", JSON.stringify(p))));

    const today = new Date().toISOString().slice(0, 10);

    const items = await Promise.all(
      places.map(async (place) => {
        const snap = await getLatestSnapshot(place.lat, place.lon);

        if (!snap) {
          // ✅ NEW: provide "yesterday" immediately for brand new places (no snapshot yet)
          // Cache it briefly to avoid repeated Open-Meteo calls while user scrolls/reloads.
          const cacheKey = `twr:overview:yesterday:${place.lat},${place.lon}`;

          try {
            const cached: any = await redis.get(cacheKey);
            if (cached) {
              const y = typeof cached === "string" ? JSON.parse(cached) : cached;
              return { place, snapshotDate: today, score: null, yesterday: y ?? null };
            }

            const { timezone, daily } = await fetchDailyFallback(place.lat, place.lon);
            const y = extractYesterdayFallback(daily, timezone);

            // cache for 3 hours (tweak if you want)
            await redis.set(cacheKey, JSON.stringify(y ?? null), { ex: 60 * 60 * 3 });

            return { place, snapshotDate: today, score: null, yesterday: y ?? null };
          } catch {
            return { place, snapshotDate: today, score: null, yesterday: null };
          }
        }

        const score = await computeCompositeScore(place.lat, place.lon);

        return {
          place: snap.place,
          snapshotDate: snap.snapshotDate,
          score,
          yesterday: snap.yesterday ?? null, // ✅ now includes windDirDeg when snapshot has it
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