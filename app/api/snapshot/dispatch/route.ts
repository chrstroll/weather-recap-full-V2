// app/api/snapshot/dispatch/route.ts
import { Redis } from "@upstash/redis";
import { normalizePlaceName } from "../../../../lib/normalizePlace";
import { placeKey, round2, mapWithConcurrency, withRetry } from "../../../../lib/snapshotUtils";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

type Place = { name?: string; lat: number; lon: number };

type SnapshotDaily = {
  time: string[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
  precipitation_sum: number[];
  rain_sum: number[];
  snowfall_sum: number[];
  relative_humidity_2m_mean: number[];
  windspeed_10m_max: number[];
  winddirection_10m_dominant: number[];
};

const TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const MAX_PLACES_PER_RUN = 300;      // hard safety cap (free plan)
const CONCURRENCY = 3;               // safe for Open-Meteo free tier

/* ---------------- helpers ---------------- */

function coercePlace(item: any): Place | null {
  try {
    const obj = typeof item === "string" ? JSON.parse(item) : item;
    const lat = Number(obj?.lat);
    const lon = Number(obj?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const name = typeof obj?.name === "string" ? obj.name.trim() : undefined;
    return { name, lat: round2(lat), lon: round2(lon) };
  } catch {
    return null;
  }
}

async function fetchDaily(lat: number, lon: number): Promise<{ timezone: string; daily: SnapshotDaily }> {
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

  return { timezone: json.timezone, daily: json.daily as SnapshotDaily };
}

function ymdInTZ(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function extractYesterday(daily: SnapshotDaily, tz: string) {
  // Find "today" in the daily.time array (which is in the same timezone as `tz`).
  // If found, take the previous element as yesterday. If not found, fallback to
  // computing yesterday's yyyy-mm-dd in tz and searching for that string.
  const todayLocal = ymdInTZ(new Date(), tz);

  // prefer locating today in the array and using prior index — avoids TZ arithmetic issues
  const todayIdx = daily.time.findIndex((d) => d === todayLocal);
  let idx = -1;

  if (todayIdx > 0) {
    idx = todayIdx - 1;
  } else {
    // fallback: compute yesterday in the same timezone and look for it
    const yesterdayLocal = ymdInTZ(new Date(Date.now() - 86400000), tz);
    idx = daily.time.findIndex((d) => d === yesterdayLocal);
  }

  if (idx < 0) return null;

  return {
    tmax: daily.temperature_2m_max[idx] ?? null,
    tmin: daily.temperature_2m_min[idx] ?? null,
    precip: (daily.precipitation_sum as any)?.[idx] ?? null,
    rain: (daily.rain_sum as any)?.[idx] ?? null,
    snow: (daily.snowfall_sum as any)?.[idx] ?? null,
    wind: (daily.windspeed_10m_max as any)?.[idx] ?? null,
    windDirDeg: (daily.winddirection_10m_dominant as any)?.[idx] ?? null,
    localYesterday: daily.time[idx],
    timeZone: tz,
  };
}

/* ---------------- main ---------------- */

export async function GET() {
  try {
    const todayUTC = new Date().toISOString().slice(0, 10);

    const statsKey = `twr:snap:stats:${todayUTC}`;
    await redis.expire(statsKey, TTL_SECONDS);

    /* 1️⃣ Collect pinned places (pinned only) */
    const userIds = (await redis.smembers("twr:users")) as string[];

    const perUser = await Promise.all(
      userIds.map(async (uid) => {
        const raw = await redis.smembers(`twr:user:${uid}:places`);
        return (raw || []).map(coercePlace).filter(Boolean) as Place[];
      })
    );

    /* 2️⃣ Deduplicate by rounded coords */
    const uniq = new Map<string, Place>();
    for (const p of perUser.flat()) {
      const k = placeKey(p.lat, p.lon);
      if (!uniq.has(k)) uniq.set(k, p);
    }

    const places = [...uniq.values()].slice(0, MAX_PLACES_PER_RUN);

    /* 3️⃣ Snapshot sequentially with bounded concurrency */
    let ok = 0;
    let fail = 0;

    await mapWithConcurrency(places, CONCURRENCY, async (p) => {
      const k = placeKey(p.lat, p.lon);

      try {
        const { timezone, daily } = await withRetry(
          () => fetchDaily(p.lat, p.lon),
          { retries: 3, baseDelayMs: 400 }
        );

        const payload = {
          place: {
            name: await normalizePlaceName(p.lat, p.lon, p.name || ""),
            lat: p.lat,
            lon: p.lon,
          },
          snapshotDate: todayUTC,   // canonical index date
          localToday: ymdInTZ(new Date(), timezone),
          timezone,
          daily,
          yesterday: extractYesterday(daily, timezone),
        };

        const snapKey = `twr:snap:${todayUTC}:${p.lat},${p.lon}`;
        await redis.set(snapKey, JSON.stringify(payload), { ex: 60 * 60 * 24 * 120 });
        await redis.sadd(`twr:index:${p.lat},${p.lon}`, snapKey);

        ok++;
      } catch {
        fail++;
      }
    });

    await redis.hset(statsKey, {
      ok,
      fail,
      total: places.length,
      lastRunAt: new Date().toISOString(),
    });

    return Response.json({
      status: "ok",
      dateUTC: todayUTC,
      users: userIds.length,
      uniquePinnedPlaces: places.length,
      ok,
      fail,
      cappedAt: MAX_PLACES_PER_RUN,
    });
  } catch (e: any) {
    return Response.json(
      { status: "error", detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}