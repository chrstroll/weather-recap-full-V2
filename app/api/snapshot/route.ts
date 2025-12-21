import { Redis } from "@upstash/redis";
import { normalizePlaceName } from "../../../lib/normalizePlace";

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

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function coercePlace(item: any): Place | null {
  // Upstash can return either raw objects or strings depending on how data was inserted.
  // We tolerate both to avoid silently skipping snapshots.
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

  return { name, lat, lon };
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
    const rawItems = (await redis.smembers("twr:places")) as any[];

    const places: Place[] = (rawItems || [])
      .map(coercePlace)
      .filter((p): p is Place => Boolean(p))
      .map((p) => ({
        ...p,
        // Normalize key precision so snapshot keys match track keys
        lat: round2(p.lat),
        lon: round2(p.lon),
      }));

    if (places.length === 0) {
      return Response.json({ status: "no-places" });
    }

    // Use UTC date for snapshot partitioning (stable)
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    await Promise.all(
      places.map(async (place) => {
        const { name, lat, lon } = place;

        const daily = await fetchDaily(lat, lon);

        // Normalize the name when writing the snapshot
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
