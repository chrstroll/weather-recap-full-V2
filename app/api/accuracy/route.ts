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
      return NextResponse.json({ error: "Missing lat/lon" }, { status: 400 });
    }

    // Match snapshot rounding
    const rl = Math.round(lat * 100) / 100;
    const rlo = Math.round(lon * 100) / 100;

    const indexKey = `twr:index:${rl},${rlo}`;
    const snapKeys = (await redis.smembers(indexKey)) as string[];

    if (!snapKeys || snapKeys.length === 0) {
      return NextResponse.json({
        status: "insufficient-data",
        horizon,
        meta: {
          tempUnit: "C",
          windUnit: "km/h",
          precipUnit: "mm",
          humidityUnit: "%",
        },
        summary: { mae: null, bias: null, windMAE: null },
        rows: [],
      });
    }

    const snaps: Snapshot[] = [];
    for (const key of snapKeys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const snap =
        typeof raw === "string"
          ? (JSON.parse(raw) as Snapshot)
          : (raw as Snapshot);

      if (snap?.snapshotDate && snap.daily?.time) {
        snaps.push(snap);
      }
    }

    snaps.sort((a, b) =>
      a.snapshotDate < b.snapshotDate ? -1 : 1
    );

    const rows: any[] = [];

    for (let i = 0; i < snaps.length; i++) {
      const current = snaps[i];
      const j = i - horizon;
      if (j < 0) continue;

      const prev = snaps[j];

      if (dayDiff(current.snapshotDate, prev.snapshotDate) !== horizon) {
        continue;
      }

      const date = current.snapshotDate;
      const today = new Date().toISOString().slice(0, 10);
      if (date === today) continue;

      const idxActual = indexForDate(current.daily, date);
      const idxPred = indexForDate(prev.daily, date);
      if (idxActual < 0 || idxPred < 0) continue;

      const actual = {
        tmax: current.daily.temperature_2m_max[idxActual],
        wind: current.daily.windspeed_10m_max[idxActual],
      };

      const predicted = {
        tmax: prev.daily.temperature_2m_max[idxPred],
        wind: prev.daily.windspeed_10m_max[idxPred],
      };

      if (
        actual.tmax == null ||
        predicted.tmax == null ||
        actual.wind == null ||
        predicted.wind == null
      ) {
        continue;
      }

      rows.push({
        date,
        actual,
        predicted,
        deltas: {
          tmax: predicted.tmax - actual.tmax,
          wind: predicted.wind - actual.wind,
        },
      });
    }

    if (rows.length === 0) {
      return NextResponse.json({
        status: "insufficient-data",
        horizon,
        meta: {
          tempUnit: "C",
          windUnit: "km/h",
          precipUnit: "mm",
          humidityUnit: "%",
        },
        summary: { mae: null, bias: null, windMAE: null },
        rows: [],
      });
    }

    const mae = mean(rows.map((r) => Math.abs(r.deltas.tmax)));
    const bias = mean(rows.map((r) => r.deltas.tmax));
    const windMAE = mean(rows.map((r) => Math.abs(r.deltas.wind)));

    return NextResponse.json({
      status: "ok",
      horizon,
      meta: {
        tempUnit: "C",
        windUnit: "km/h",
        precipUnit: "mm",
        humidityUnit: "%",
      },
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
