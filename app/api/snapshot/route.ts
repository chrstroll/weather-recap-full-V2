import { Redis } from "@upstash/redis";
import { normalizePlaceName } from "../../../lib/normalizePlace";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

type Place = { name: string; lat: number; lon: number };

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

  const name = typeof obj.name === "string" ? obj.name : "";
  const lat = Number(obj.lat);
  const lon = Number(obj.lon);

  if (!name || Number.isNaN(lat) || Number.isNaN(lon)) return null;

  return { name, lat: round2(lat), lon: round2(lon) };
}

function placeKey(p: Place) {
  return `${p.lat},${p.lon}`;
}

async function fetchDaily(lat: number, lon: number) {
  const daily = [
    "temperature_2m_max",
    "temperature_2m_min",
    "rain_sum",
    "snowfall_sum",
    "relative_humidity_2m_mean",
    "windspeed_10m_max",
  ].join(",");

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&forecast_days=7&daily=${daily}&timezone=auto`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("upstream");
  return (await res.json())?.daily;
}

export async function GET() {
  try {
    // 1) Start with legacy global places
    const rawGlobal = (await redis.smembers("twr:places")) as any[];
    const globalPlaces = (rawGlobal || []).map(coercePlace).filter(Boolean) as Place[];

    // 2) Union in all per-user places (robust fix)
    const userIds = ((await redis.smembers("twr:users")) as string[]) || [];

    const userPlacesArrays = await Promise.all(
      userIds.map(async (uid) => {
        const raw = (await redis.smembers(`twr:user:${uid}:places`)) as any[];
        return (raw || []).map(coercePlace).filter(Boolean) as Place[];
      })
    );

    const allPlaces = [...globalPlaces, ...userPlacesArrays.flat()];

    // De-dupe by lat,lon
    const map = new Map<string, Place>();
    for (const p of allPlaces) map.set(placeKey(p), p);
    const places = [...map.values()];

    if (places.length === 0) {
      return Response.json({ status: "no-places" });
    }

    const today = new Date().toISOString().slice(0, 10);

    await Promise.all(
      places.map(async (place) => {
        const { name, lat, lon } = place;
        const daily = await fetchDaily(lat, lon);
        const cleanName = await normalizePlaceName(lat, lon, name);

        const key = `twr:snap:${today}:${lat},${lon}`;
        const payload = {
          place: { name: cleanName, lat, lon },
          snapshotDate: today,
          daily,
        };

        await redis.set(key, JSON.stringify(payload), { ex: 60 * 60 * 24 * 120 });
        await redis.sadd(`twr:index:${lat},${lon}`, key);
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
