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
  rain_sum: number[];
  snowfall_sum: number[];
  relative_humidity_2m_mean: number[];
  windspeed_10m_max: number[];
  winddirection_10m_dominant: number[]; // ✅ NEW
};

type YesterdayActuals = {
  tmax: number | null;
  tmin: number | null;
  rain: number | null;
  snow: number | null;
  wind: number | null;
  windDirDeg: number | null; // ✅ NEW
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
  // ✅ include winddirection_10m_dominant so we can show wind direction in the hero
  const daily = [
    "temperature_2m_max",
    "temperature_2m_min",
    "rain_sum",
    "snowfall_sum",
    "relative_humidity_2m_mean",
    "windspeed_10m_max",
    "winddirection_10m_dominant",
  ].join(",");

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&past_days=1&forecast_days=7&daily=${daily}&timezone=auto`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("open-meteo-upstream");

  const json = await res.json();
  const d = json?.daily;

  if (!d?.time || !Array.isArray(d.time)) {
    throw new Error("open-meteo-missing-daily");
  }

  // Minimal shape check so we fail loudly if upstream changes
  if (!Array.isArray(d.windspeed_10m_max) || !Array.isArray(d.winddirection_10m_dominant)) {
    throw new Error("open-meteo-missing-winddirection");
  }

  return d as SnapshotDaily;
}

function extractYesterdayActuals(daily: SnapshotDaily): YesterdayActuals | null {
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yDate = yesterday.toISOString().slice(0, 10);

  const idx = daily.time.findIndex((d) => d === yDate);
  if (idx < 0) return null;

  return {
    tmax: daily.temperature_2m_max?.[idx] ?? null,
    tmin: daily.temperature_2m_min?.[idx] ?? null,
    rain: daily.rain_sum?.[idx] ?? null,
    snow: daily.snowfall_sum?.[idx] ?? null,
    wind: daily.windspeed_10m_max?.[idx] ?? null,
    windDirDeg: daily.winddirection_10m_dominant?.[idx] ?? null, // ✅ NEW
  };
}

export async function GET() {
  try {
    // 1) Legacy global set
    const rawGlobal = (await redis.smembers("twr:places")) as any[];
    const globalPlaces = (rawGlobal || []).map(coercePlace).filter(Boolean) as Place[];

    // 2) Union in all per-user places (robust)
    const userIds = ((await redis.smembers("twr:users")) as string[]) || [];

    const userPlacesArrays = await Promise.all(
      userIds.map(async (uid) => {
        const raw = (await redis.smembers(`twr:user:${uid}:places`)) as any[];
        return (raw || []).map(coercePlace).filter(Boolean) as Place[];
      })
    );

    const allPlaces = [...globalPlaces, ...userPlacesArrays.flat()];

    // 3) De-dupe by canonical (rounded) coords
    const map = new Map<string, Place>();
    for (const p of allPlaces) {
      map.set(placeKey(p.lat, p.lon), { name: p.name, lat: round2(p.lat), lon: round2(p.lon) });
    }
    const places = [...map.values()];

    if (places.length === 0) {
      return Response.json({ status: "no-places", count: 0 });
    }

    const today = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD

    await Promise.all(
      places.map(async (place) => {
        const { name, lat, lon } = place;

        const daily = await fetchDaily(lat, lon);

        // Normalize display name
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
      })
    );

    return Response.json({ status: "snapshotted-redis", count: places.length });
  } catch (e: any) {
    console.error("snapshot route error:", e);
    return Response.json(
      { error: "snapshot-failed", detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}