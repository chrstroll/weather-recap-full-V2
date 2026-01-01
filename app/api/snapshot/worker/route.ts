// app/api/snapshot/worker/route.ts
import { Redis } from "@upstash/redis";
import { normalizePlaceName } from "../../../../lib/normalizePlace";
import { mapWithConcurrency, placeKey, round2, withRetry } from "../../../../lib/snapshotUtils";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

type SnapshotDaily = {
  time: string[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
  rain_sum: number[];
  precipitation_sum: number[];
  snowfall_sum: number[];
  relative_humidity_2m_mean: number[];
  windspeed_10m_max: number[];
  winddirection_10m_dominant: number[];
};

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
  const tz = json?.timezone;
  const d = json?.daily;

  if (typeof tz !== "string" || !tz) throw new Error("open-meteo-missing-timezone");
  if (!d?.time || !Array.isArray(d.time)) throw new Error("open-meteo-missing-daily");

  return { timezone: tz, daily: d as SnapshotDaily };
}

function ymdInTimeZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function extractYesterdayActuals(daily: SnapshotDaily, timeZone: string) {
  // Yesterday in the *location’s timezone*
  const now = new Date();
  const localToday = ymdInTimeZone(now, timeZone);

  // localYesterday = localToday - 1 day (UTC-safe math on YYYY-MM-DD)
  const t = new Date(localToday + "T00:00:00Z").getTime();
  const localYesterday = new Date(t - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const idx = daily.time.findIndex((d) => d === localYesterday);
  if (idx < 0) return null;

  return {
    tmax: daily.temperature_2m_max?.[idx] ?? null,
    tmin: daily.temperature_2m_min?.[idx] ?? null,
    precip: daily.precipitation_sum?.[idx] ?? null,
    rain: daily.rain_sum?.[idx] ?? null,
    snow: daily.snowfall_sum?.[idx] ?? null,
    wind: daily.windspeed_10m_max?.[idx] ?? null,
    windDirDeg: daily.winddirection_10m_dominant?.[idx] ?? null,
    // store which day these correspond to (super useful for debugging/UI)
    localYesterday,
    timeZone,
  };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);

    // Tuneable knobs:
    const batchSize = Math.max(1, Math.min(200, parseInt(url.searchParams.get("batch") || "50", 10)));
    const concurrency = Math.max(1, Math.min(8, parseInt(url.searchParams.get("concurrency") || "4", 10)));

    const todayUTC = new Date().toISOString().slice(0, 10);

    const queueKey = `twr:snap:queue:${todayUTC}`;
    const doneSet = `twr:snap:done:${todayUTC}`;
    const failHash = `twr:snap:fail:${todayUTC}`;
    const statsKey = `twr:snap:stats:${todayUTC}`;

    // Pop up to batchSize items
    const rawItems: string[] = [];
    for (let i = 0; i < batchSize; i++) {
      const v = (await redis.lpop(queueKey)) as any;
      if (!v) break;
      rawItems.push(typeof v === "string" ? v : JSON.stringify(v));
    }

    if (rawItems.length === 0) {
      return Response.json({ status: "empty", dateUTC: todayUTC });
    }

    const items = rawItems
      .map((s) => {
        try { return JSON.parse(s) as { lat: number; lon: number }; } catch { return null; }
      })
      .filter(Boolean) as { lat: number; lon: number }[];

    const results = await mapWithConcurrency(items, concurrency, async ({ lat, lon }) => {
      const rl = round2(lat);
      const rlo = round2(lon);
      const k = placeKey(rl, rlo);

      try {
        const { timezone, daily } = await withRetry(
          () => fetchDaily(rl, rlo),
          { retries: 4, baseDelayMs: 300 }
        );

        const cleanName = await normalizePlaceName(rl, rlo, "");
        const localToday = ymdInTimeZone(new Date(), timezone);

        // IMPORTANT:
        // - snapshotDate stays UTC “run day” (todayUTC) for indexing/history
        // - we also store localToday + tz in payload so the app/UI can reason about “what day” it is locally
        const snapKey = `twr:snap:${todayUTC}:${rl},${rlo}`;

        const payload = {
          place: { name: cleanName, lat: rl, lon: rlo },
          snapshotDate: todayUTC,    // UTC run date
          localToday,                // local day at fetch time
          timezone,
          daily,
          yesterday: extractYesterdayActuals(daily, timezone),
        };

        await redis.set(snapKey, JSON.stringify(payload), { ex: 60 * 60 * 24 * 120 });
        await redis.sadd(`twr:index:${rl},${rlo}`, snapKey);

        await redis.sadd(doneSet, k);
        await redis.hincrby(statsKey, "done", 1);

        return { ok: true, lat: rl, lon: rlo };
      } catch (e: any) {
        const err = String(e?.message || e);
        await redis.hset(failHash, { [k]: err });
        await redis.hincrby(statsKey, "fail", 1);
        return { ok: false, lat: rl, lon: rlo, error: err };
      }
    });

    await redis.hset(statsKey, { lastWorkerAt: new Date().toISOString() });

    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;

    return Response.json({
      status: "ok",
      dateUTC: todayUTC,
      batchSize: rawItems.length,
      concurrency,
      okCount,
      failCount,
      sampleFailures: results.filter((r) => !r.ok).slice(0, 10),
      remainingQueueApprox: "Use LLEN on queue key to see remaining",
    });
  } catch (e: any) {
    return Response.json({ status: "error", detail: String(e?.message || e) }, { status: 500 });
  }
}