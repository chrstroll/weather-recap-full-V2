// app/api/snapshot/route.ts
import { Redis } from "@upstash/redis";
import { normalizePlaceName } from "../../../lib/normalizePlace";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

type Place = { name: string; lat: number; lon: number };

type SnapshotDaily = {
  time: string[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];

  // Keep existing (liquid-only) for backwards compatibility + debugging
  rain_sum: number[];

  // Total water
  precipitation_sum: number[];

  // Snow amount
  snowfall_sum: number[];

  relative_humidity_2m_mean: number[];
  windspeed_10m_max: number[];

  // Wind direction
  winddirection_10m_dominant: number[];
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function placeKey(lat: number, lon: number) {
  const rl = round2(lat);
  const rlo = round2(lon);
  return `${rl},${rlo}`;
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

async function fetchDaily(lat: number, lon: number): Promise<SnapshotDaily> {
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

  const res = await fetch(url, {
    cache: "no-store",
    headers: {
      "User-Agent": "WeatherRecap/1.0 (+vercel)",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`open-meteo-upstream:${res.status}:${text.slice(0, 200)}`);
  }

  const json = await res.json();
  const d = json?.daily;

  if (!d?.time || !Array.isArray(d.time)) {
    throw new Error("open-meteo-missing-daily");
  }

  return d as SnapshotDaily;
}

function extractYesterdayActuals(daily: SnapshotDaily) {
  // NOTE: This uses UTC day boundaries (matches snapshotDate = UTC).
  // That is OK as long as overview/accuracy logic consistently use snapshotDate/day keys.
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yDate = yesterday.toISOString().slice(0, 10);

  const idx = daily.time.findIndex((d) => d === yDate);
  if (idx < 0) return null;

  return {
    tmax: daily.temperature_2m_max?.[idx] ?? null,
    tmin: daily.temperature_2m_min?.[idx] ?? null,

    // Canonical wetness
    precip: daily.precipitation_sum?.[idx] ?? null,

    // Keep liquid-only for compatibility/debugging
    rain: daily.rain_sum?.[idx] ?? null,

    snow: daily.snowfall_sum?.[idx] ?? null,
    wind: daily.windspeed_10m_max?.[idx] ?? null,

    windDirDeg: daily.winddirection_10m_dominant?.[idx] ?? null,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryable(errMsg: string) {
  // retry 429 throttles + transient fetch failures
  return (
    errMsg.includes("open-meteo-upstream:429") ||
    errMsg.toLowerCase().includes("fetch failed") ||
    errMsg.toLowerCase().includes("network") ||
    errMsg.toLowerCase().includes("timeout")
  );
}

async function fetchDailyWithRetry(lat: number, lon: number, maxAttempts = 3): Promise<SnapshotDaily> {
  let lastErr: any = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchDaily(lat, lon);
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);

      const retry = attempt < maxAttempts && isRetryable(msg);
      if (!retry) break;

      // Exponential backoff + small jitter
      const base = 350 * Math.pow(2, attempt - 1); // 350ms, 700ms, 1400ms...
      const jitter = Math.floor(Math.random() * 150);
      await sleep(base + jitter);
    }
  }

  throw lastErr;
}

function chunk<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function GET() {
  try {
    // 1) Legacy global set
    const rawGlobal = (await redis.smembers("twr:places")) as any[];
    const globalPlaces = (rawGlobal || []).map(coercePlace).filter(Boolean) as Place[];

    // 2) Union in all per-user places
    const userIds = ((await redis.smembers("twr:users")) as string[]) || [];

    const userPlacesArrays = await Promise.all(
      userIds.map(async (uid) => {
        const raw = (await redis.smembers(`twr:user:${uid}:places`)) as any[];
        return (raw || []).map(coercePlace).filter(Boolean) as Place[];
      })
    );

    const allPlaces = [...globalPlaces, ...userPlacesArrays.flat()];

    // 3) De-dupe by rounded coords
    const map = new Map<string, Place>();
    for (const p of allPlaces) {
      map.set(placeKey(p.lat, p.lon), { name: p.name, lat: round2(p.lat), lon: round2(p.lon) });
    }
    const places = [...map.values()];

    if (places.length === 0) {
      return Response.json({ status: "no-places", count: 0 });
    }

    const today = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD

    // ---- THROTTLE CONTROL ----
    // Keep this modest to avoid Open-Meteo 429s.
    // 8–12 is usually safe; you can tune later.
    const CONCURRENCY = 10;

    const results: any[] = [];
    const batches = chunk(places, CONCURRENCY);

    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map(async (place) => {
          const { name, lat, lon } = place;
          try {
            const daily = await fetchDailyWithRetry(lat, lon, 3);
            const cleanName = await normalizePlaceName(lat, lon, name);

            const snapKey = `twr:snap:${today}:${lat},${lon}`;
            const payload = {
              place: { name: cleanName, lat, lon },
              snapshotDate: today,
              daily,
              yesterday: extractYesterdayActuals(daily),
            };

            await redis.set(snapKey, JSON.stringify(payload), { ex: 60 * 60 * 24 * 120 });
            await redis.sadd(`twr:index:${lat},${lon}`, snapKey);

            return { ok: true, lat, lon, key: snapKey };
          } catch (e: any) {
            return { ok: false, lat, lon, error: String(e?.message || e) };
          }
        })
      );

      results.push(...batchResults);

      // Small gap between batches helps prevent “bursty” throttling.
      await sleep(150);
    }

    const okCount = results.filter((r) => r.ok).length;
    const fail = results.filter((r) => !r.ok);

    return Response.json({
      status: fail.length ? "snapshotted-partial" : "snapshotted-redis",
      count: okCount,
      failedCount: fail.length,
      failed: fail.slice(0, 50),
    });
  } catch (e: any) {
    console.error("snapshot route error:", e);
    return Response.json(
      { error: "snapshot-failed", detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}