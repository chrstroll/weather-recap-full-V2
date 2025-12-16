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
  place: {
    name: string;
    lat: number;
    lon: number;
  };
  snapshotDate: string; // YYYY-MM-DD
  daily: SnapshotDaily;
};

// Helper: mean of an array
function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Helper: difference in whole days between two YYYY-MM-DD strings
function dayDiff(a: string, b: string): number {
  const toDate = (s: string) => new Date(s + "T00:00:00Z").getTime();
  const diffMs = toDate(a) - toDate(b);
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
}

// Helper: find index for a given date in the daily.time array
function indexForDate(daily: SnapshotDaily, date: string): number {
  return daily.time?.findIndex((t) => t === date) ?? -1;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const lat = parseFloat(searchParams.get("lat") || "");
    const lon = parseFloat(searchParams.get("lon") || "");
    const horizon = Math.max(
      1,
      Math.min(5, parseInt(searchParams.get("horizon") || "1", 10))
    );

    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      return NextResponse.json(
        { error: "Missing lat/lon" },
        { status: 400 }
      );
    }

    // Match the rounding we use when storing snapshots
    const rl = Math.round(lat * 100) / 100;
    const rlo = Math.round(lon * 100) / 100;

    const indexKey = `twr:index:${rl},${rlo}`;
    const snapKeys = (await redis.smembers(indexKey)) as string[];

    if (!snapKeys || snapKeys.length === 0) {
      return NextResponse.json({
        horizon,
        meta: { tempUnit: "C", windUnit: "km/h", precipUnit: "mm", humidityUnit: "%" },
        summary: { mae: 0, bias: 0, windMAE: 0 },
        rows: [],
      });
    }

    // Load all snapshots and sort by snapshotDate
    const snaps: Snapshot[] = [];
    for (const key of snapKeys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const snap = typeof raw === "string" ? (JSON.parse(raw) as Snapshot) : (raw as Snapshot);
      if (snap?.snapshotDate && snap.daily?.time) {
        snaps.push(snap);
      }
    }

    snaps.sort((a, b) => (a.snapshotDate < b.snapshotDate ? -1 : 1));

    // Build accuracy rows by comparing snapshot at D with snapshot at D - horizon
    const rows: any[] = [];

    for (let i = 0; i < snaps.length; i++) {
      const current = snaps[i];
      const j = i - horizon;
      if (j < 0) continue;

      const prev = snaps[j];

      // Make sure these snapshots are exactly `horizon` days apart
      if (dayDiff(current.snapshotDate, prev.snapshotDate) !== horizon) {
        continue;
      }

      const date = current.snapshotDate;
      // Skip today; we only show up to yesterday
      const today = new Date().toISOString().slice(0, 10);
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

      if (
        actual.tmax == null ||
        predicted.tmax == null ||
        actual.wind == null ||
        predicted.wind == null
      ) {
        // Skip if we are missing key values
        continue;
      }

      const deltas = {
        tmax: predicted.tmax - actual.tmax,
        tmin:
          predicted.tmin != null && actual.tmin != null
            ? predicted.tmin - actual.tmin
            : null,
        wind: predicted.wind - actual.wind,
        humidity:
          predicted.humidity != null && actual.humidity != null
            ? predicted.humidity - actual.humidity
            : null,
        rain:
          predicted.rain != null && actual.rain != null
            ? predicted.rain - actual.rain
            : null,
        snow:
          predicted.snow != null && actual.snow != null
            ? predicted.snow - actual.snow
            : null,
      };

      rows.push({ date, actual, predicted, deltas });
    }

    const valid = rows.filter((r) => r.deltas && typeof r.deltas.tmax === "number");

    const mae = mean(valid.map((r) => Math.abs(r.deltas.tmax)));
    const bias = mean(valid.map((r) => r.deltas.tmax as number));
    const windMAE = mean(
      valid
        .filter((r) => typeof r.deltas.wind === "number")
        .map((r) => Math.abs(r.deltas.wind as number))
    );

    return NextResponse.json({
      horizon,
      meta: { tempUnit: "C", windUnit: "km/h", precipUnit: "mm", humidityUnit: "%" },
      summary: { mae, bias, windMAE },
      rows,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
