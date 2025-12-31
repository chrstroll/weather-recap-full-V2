// app/api/accuracy/route.ts
import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

/**
 * IMPORTANT (v2 logic):
 * - We compare TWO snapshots, but we shift the target day by 1:
 *
 *   For a target day D (e.g., "yesterday"), we use:
 *     - ACTUALS from snapshot taken on D+1 (more "settled" daily aggregates)
 *     - PREDICTED from snapshot taken on (D - horizon)
 *
 *   In snapshot-index terms:
 *     current = snaps[i]           // snapshotDate = D+1
 *     prev    = snaps[i-(h+1)]     // snapshotDate = D-horizon
 *     target  = current.snapshotDate - 1 day = D
 *
 * - This reduces mismatch where the "same day" daily aggregates can still drift.
 *
 * - Precipitation can be bucketed as rain vs showers vs snow water-equivalent.
 *   We compute TOTAL PRECIP:
 *     precip = precipitation_sum
 *       OR (rain_sum + showers_sum)
 *       OR rain_sum (fallback for older snapshots)
 *
 * - CRITICAL:
 *   "Today" must be determined in the LOCATION'S TIMEZONE, not UTC.
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

  // new preferred fields (after snapshot job update)
  precipitation_sum?: number[];
  showers_sum?: number[];
};

type Snapshot = {
  place: { name: string; lat: number; lon: number };
  snapshotDate: string; // YYYY-MM-DD (your snapshot job uses UTC date here)
  daily: SnapshotDaily;
};

const META = {
  tempUnit: "C",
  windUnit: "km/h",
  precipUnit: "mm",
  humidityUnit: "%",
};

function insufficient(horizon: number, window: number, message: string) {
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

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function dayDiff(a: string, b: string): number {
  const toDate = (s: string) => new Date(s + "T00:00:00Z").getTime();
  const diffMs = toDate(a) - toDate(b);
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
}

function addDaysUTC(ymd: string, deltaDays: number): string {
  const t = new Date(ymd + "T00:00:00Z").getTime();
  const out = new Date(t + deltaDays * 24 * 60 * 60 * 1000);
  return out.toISOString().slice(0, 10);
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
  const p = numAt(daily.precipitation_sum, idx);
  if (p != null) return p;

  const r = numAt(daily.rain_sum, idx);
  const sh = numAt(daily.showers_sum, idx);
  if (r != null && sh != null) return r + sh;

  if (r != null) return r;
  return null;
}

/**
 * Fetch the IANA timezone name for the given lat/lon.
 * Lightweight: only needs `timezone` from Open-Meteo.
 */
async function fetchTimeZone(lat: number, lon: number): Promise<string> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&forecast_days=1&daily=temperature_2m_max&timezone=auto`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`open-meteo-timezone-upstream:${res.status}:${text.slice(0, 120)}`);
  }

  const json = await res.json();
  const tz = json?.timezone;
  if (typeof tz !== "string" || !tz.length) throw new Error("open-meteo-missing-timezone");
  return tz;
}

/**
 * Returns YYYY-MM-DD for "now" in the given IANA timezone.
 * Using `en-CA` yields stable YYYY-MM-DD.
 */
function ymdInTimeZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const lat = parseFloat(searchParams.get("lat") || "");
    const lon = parseFloat(searchParams.get("lon") || "");

    const horizon = Math.max(1, Math.min(5, parseInt(searchParams.get("horizon") || "1", 10)));
    const window = Math.max(1, Math.min(14, parseInt(searchParams.get("window") || "5", 10)));

    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      return NextResponse.json({ error: "Missing lat/lon" }, { status: 400 });
    }

    // Match snapshot rounding (same as the app)
    const rl = Math.round(lat * 100) / 100;
    const rlo = Math.round(lon * 100) / 100;

    // ✅ Determine "today" in the LOCATION'S timezone (not UTC)
    let localToday = "";
    try {
      const tz = await fetchTimeZone(rl, rlo);
      localToday = ymdInTimeZone(new Date(), tz);
    } catch {
      localToday = new Date().toISOString().slice(0, 10);
    }

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

    // ✅ NEW: use D+1 snapshot for actuals.
    // current.snapshotDate = D+1
    // targetDate = D = current.snapshotDate - 1
    // prev.snapshotDate should be (horizon+1) days behind current so that its forecast contains D at lead time "horizon".
    const requiredGap = horizon + 1;

    for (let i = 0; i < snaps.length; i++) {
      const current = snaps[i];

      const prevIndex = i - requiredGap;
      if (prevIndex < 0) continue;

      const prev = snaps[prevIndex];

      // Require snapshots exactly (horizon+1) days apart (handles missing days)
      if (dayDiff(current.snapshotDate, prev.snapshotDate) !== requiredGap) continue;

      const targetDate = addDaysUTC(current.snapshotDate, -1);

      // ✅ Skip incomplete days: local "today" and any future dates
      // (targetDate is the day we’re scoring)
      if (targetDate >= localToday) continue;

      const idxActual = indexForDate(current.daily, targetDate);
      const idxPred = indexForDate(prev.daily, targetDate);
      if (idxActual < 0 || idxPred < 0) continue;

      const actual = {
        tmax: numAt(current.daily.temperature_2m_max, idxActual),
        tmin: numAt(current.daily.temperature_2m_min, idxActual),
        wind: numAt(current.daily.windspeed_10m_max, idxActual),
        humidity: numAt(current.daily.relative_humidity_2m_mean as any, idxActual),

        // legacy fields still exposed
        rain: numAt(current.daily.rain_sum, idxActual),
        snow: numAt(current.daily.snowfall_sum, idxActual),

        // total precip (canonical)
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
      if (
        actual.tmax == null ||
        predicted.tmax == null ||
        actual.wind == null ||
        predicted.wind == null
      ) {
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

        precip:
          predicted.precip != null && actual.precip != null ? predicted.precip - actual.precip : null,
      };

      rows.push({ date: targetDate, actual, predicted, deltas });
    }

    // Sort ascending, keep only most recent "window"
    rows.sort((a, b) => (a.date < b.date ? -1 : 1));
    const windowedRows = rows.slice(Math.max(0, rows.length - window));

    const valid = windowedRows.filter((r) => r.deltas && typeof r.deltas.tmax === "number");

    if (valid.length === 0) {
      return insufficient(
        horizon,
        window,
        "Not enough history yet to compute accuracy (need at least 2 snapshots)."
      );
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