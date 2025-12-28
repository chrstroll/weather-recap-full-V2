// app/api/accuracy/route.ts
import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

/**
 * IMPORTANT:
 * - This route compares TWO snapshots:
 *   current snapshot provides "actuals" for that date,
 *   prior snapshot (horizon days earlier) provides "predicted" for that same date.
 *
 * - Precipitation in Open-Meteo can be bucketed as rain vs showers vs snow.
 *   To avoid "it rained but rain_sum == 0" cases, we compute TOTAL PRECIP:
 *     precip = precipitation_sum
 *       OR (rain_sum + showers_sum)
 *       OR rain_sum (fallback for older snapshots)
 */

type SnapshotDaily = {
  time: string[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
  windspeed_10m_max: number[];
  relative_humidity_2m_mean: number[];

  // legacy fields (existing snapshots)
  rain_sum?: number[];
  snowfall_sum?: number[];

  // new preferred fields (after you update snapshot job)
  precipitation_sum?: number[];
  showers_sum?: number[];
};

type Snapshot = {
  place: { name: string; lat: number; lon: number };
  snapshotDate: string; // YYYY-MM-DD
  daily: SnapshotDaily;
};

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function dayDiff(a: string, b: string): number {
  const toDate = (s: string) => new Date(s + "T00:00:00Z").getTime();
  const diffMs = toDate(a) - toDate(b);
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
}

function indexForDate(daily: SnapshotDaily, date: string): number {
  return daily.time?.findIndex((t) => t === date) ?? -1;
}

function numAt(arr: number[] | undefined, idx: number): number | null {
  if (!arr) return null;
  const v = arr[idx];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function precipAt(daily: SnapshotDaily, idx: number): number | null {
  // Prefer total precip if the snapshot stored it
  const p = numAt(daily.precipitation_sum, idx);
  if (p != null) return p;

  // Otherwise, rain + showers if available
  const r = numAt(daily.rain_sum, idx);
  const sh = numAt(daily.showers_sum, idx);
  if (r != null && sh != null) return r + sh;

  // Fallback to rain only (older snapshots)
  if (r != null) return r;

  return null;
}

const META = {
  tempUnit: "C",
  windUnit: "km/h",
  precipUnit: "mm",
  humidityUnit: "%",
};

function insufficient(horizon: number, window: number, message: string) {
  // Keep numeric summary fields so Swift decoding never breaks
  return NextResponse.json({
    status: "insufficient-data",
    message,
    horizon,
    window,
    meta: META,
    summary: { mae: 0, bias: 0, windMAE: 0 },
    rows: [],
  });
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const lat = parseFloat(searchParams.get("lat") || "");
    const lon = parseFloat(searchParams.get("lon") || "");

    // "horizon" = lead time (days)
    const horizon = Math.max(1, Math.min(5, parseInt(searchParams.get("horizon") || "1", 10)));

    // "window" = how many most-recent target days to return
    const window = Math.max(1, Math.min(14, parseInt(searchParams.get("window") || "5", 10)));

    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      return NextResponse.json({ error: "Missing lat/lon" }, { status: 400 });
    }

    // Match snapshot rounding (same as the app)
    const rl = Math.round(lat * 100) / 100;
    const rlo = Math.round(lon * 100) / 100;

    const indexKey = `twr:index:${rl},${rlo}`;
    const snapKeys = (await redis.smembers(indexKey)) as string[];

    if (!snapKeys || snapKeys.length === 0) {
      return insufficient(horizon, window, "No snapshots found yet for this location.");
    }

    // Load snapshots
    const snaps: Snapshot[] = [];
    for (const key of snapKeys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const snap = typeof raw === "string" ? (JSON.parse(raw) as Snapshot) : (raw as Snapshot);
      if (snap?.snapshotDate && snap.daily?.time) snaps.push(snap);
    }

    snaps.sort((a, b) => (a.snapshotDate < b.snapshotDate ? -1 : 1));

    const rows: any[] = [];

    // today as UTC date string (snapshots keyed by UTC YYYY-MM-DD)
    const today = new Date().toISOString().slice(0, 10);

    for (let i = 0; i < snaps.length; i++) {
      const current = snaps[i];
      const j = i - horizon;
      if (j < 0) continue;

      const prev = snaps[j];

      // Require snapshots exactly horizon days apart (handles missing days)
      if (dayDiff(current.snapshotDate, prev.snapshotDate) !== horizon) continue;

      const date = current.snapshotDate;

      // Skip today (need completed day)
      if (date === today) continue;

      const idxActual = indexForDate(current.daily, date);
      const idxPred = indexForDate(prev.daily, date);
      if (idxActual < 0 || idxPred < 0) continue;

      const actual = {
        tmax: numAt(current.daily.temperature_2m_max, idxActual),
        tmin: numAt(current.daily.temperature_2m_min, idxActual),
        wind: numAt(current.daily.windspeed_10m_max, idxActual),
        humidity: numAt(current.daily.relative_humidity_2m_mean as any, idxActual),
        // legacy fields still exposed
        rain: numAt(current.daily.rain_sum, idxActual),
        snow: numAt(current.daily.snowfall_sum, idxActual),
        // NEW: total precip (for consistency)
        precip: precipAt(current.daily, idxActual),
      };

      const predicted = {
        tmax: numAt(prev.daily.temperature_2m_max, idxPred),
        tmin: numAt(prev.daily.temperature_2m_min, idxPred),
        wind: numAt(prev.daily.windspeed_10m_max, idxPred),
        humidity: numAt(prev.daily.relative_humidity_2m_mean as any, idxPred),
        rain: numAt(prev.daily.rain_sum, idxPred),
        snow: numAt(prev.daily.snowfall_sum, idxPred),
        precip: precipAt(prev.daily, idxPred),
      };

      // Require at least key values
      if (actual.tmax == null || predicted.tmax == null || actual.wind == null || predicted.wind == null) {
        continue;
      }

      const deltas = {
        tmax: predicted.tmax - actual.tmax,
        tmin: predicted.tmin != null && actual.tmin != null ? predicted.tmin - actual.tmin : null,
        wind: predicted.wind - actual.wind,
        humidity:
          predicted.humidity != null && actual.humidity != null
            ? predicted.humidity - actual.humidity
            : null,
        rain: predicted.rain != null && actual.rain != null ? predicted.rain - actual.rain : null,
        snow: predicted.snow != null && actual.snow != null ? predicted.snow - actual.snow : null,
        // NEW: total precip delta
        precip:
          predicted.precip != null && actual.precip != null ? predicted.precip - actual.precip : null,
      };

      rows.push({ date, actual, predicted, deltas });
    }

    // Sort ascending, keep only most recent "window"
    rows.sort((a, b) => (a.date < b.date ? -1 : 1));
    const windowedRows = rows.slice(Math.max(0, rows.length - window));

    const valid = windowedRows.filter((r) => r.deltas && typeof r.deltas.tmax === "number");

    if (valid.length === 0) {
      return insufficient(horizon, window, "Not enough history yet to compute accuracy (need at least 2 snapshots).");
    }

    const mae = mean(valid.map((r) => Math.abs(r.deltas.tmax)));
    const bias = mean(valid.map((r) => r.deltas.tmax as number));
    const windMAE = mean(
      valid
        .filter((r) => typeof r.deltas.wind === "number")
        .map((r) => Math.abs(r.deltas.wind as number))
    );

    return NextResponse.json({
      status: "ok",
      horizon,
      window,
      meta: META,
      summary: { mae, bias, windMAE },
      rows: windowedRows,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Unknown error" }, { status: 500 });
  }
}