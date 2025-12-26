// app/api/accuracy/route.ts
import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

type SnapshotDaily = {
  time: string[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
  windspeed_10m_max: number[];
  relative_humidity_2m_mean: number[];
  rain_sum: number[];
  snowfall_sum: number[];
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

const META = { tempUnit: "C", windUnit: "km/h", precipUnit: "mm", humidityUnit: "%" };

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

    // "window" = how many most-recent target days to return (apples-to-apples)
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
      const snap =
        typeof raw === "string" ? (JSON.parse(raw) as Snapshot) : (raw as Snapshot);
      if (snap?.snapshotDate && snap.daily?.time) snaps.push(snap);
    }

    snaps.sort((a, b) => (a.snapshotDate < b.snapshotDate ? -1 : 1));

    const rows: any[] = [];

    // "today" as UTC date string (your snapshots are keyed by UTC YYYY-MM-DD too)
    const today = new Date().toISOString().slice(0, 10);

    for (let i = 0; i < snaps.length; i++) {
      const current = snaps[i];
      const j = i - horizon;
      if (j < 0) continue;

      const prev = snaps[j];

      // Require the snapshots to be exactly horizon days apart (handles missing days)
      if (dayDiff(current.snapshotDate, prev.snapshotDate) !== horizon) continue;

      const date = current.snapshotDate;

      // Always skip today; return up to yesterday
      if (date === today) continue;

      const idxActual = indexForDate(current.daily, date);
      const idxPred = indexForDate(prev.daily, date);
      if (idxActual < 0 || idxPred < 0) continue;

      const actual = {
        tmax: current.daily.temperature_2m_max?.[idxActual] ?? null,
        tmin: current.daily.temperature_2m_min?.[idxActual] ?? null,
        wind: current.daily.windspeed_10m_max?.[idxActual] ?? null,
        humidity: current.daily.relative_humidity_2m_mean?.[idxActual] ?? null,
        rain: current.daily.rain_sum?.[idxActual] ?? null,
        snow: current.daily.snowfall_sum?.[idxActual] ?? null,
      };

      const predicted = {
        tmax: prev.daily.temperature_2m_max?.[idxPred] ?? null,
        tmin: prev.daily.temperature_2m_min?.[idxPred] ?? null,
        wind: prev.daily.windspeed_10m_max?.[idxPred] ?? null,
        humidity: prev.daily.relative_humidity_2m_mean?.[idxPred] ?? null,
        rain: prev.daily.rain_sum?.[idxPred] ?? null,
        snow: prev.daily.snowfall_sum?.[idxPred] ?? null,
      };

      // Require at least key values so summaries don’t become junk
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
      };

      rows.push({ date, actual, predicted, deltas });
    }

    // Sort by date ascending, then keep only the most recent "window" target dates
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
      horizon,     // lead time (days)
      window,      // how many target days returned
      meta: META,
      summary: { mae, bias, windMAE },
      rows: windowedRows,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Unknown error" }, { status: 500 });
  }
}