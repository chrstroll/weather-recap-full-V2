import { NextResponse } from "next/server";

const REST_URL = process.env.UPSTASH_REDIS_REST_URL!;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN!;

function mmToIn(mm: number) { return mm / 25.4; }
function cmToIn(cm: number) { return cm / 2.54; }
function kmhToMph(kmh: number) { return kmh * 0.621371; }
function cToF(c: number) { return c * 9/5 + 32; }

async function redis(cmd: string, args: any[] = []) {
  const res = await fetch(REST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${REST_TOKEN}`,
    },
    body: JSON.stringify([cmd, ...args]),
  });

  const json = await res.json();
  return json.result;
}

async function scanKeys(match: string) {
  let cursor = "0";
  const keys: string[] = [];

  while (true) {
    const r = await redis("SCAN", [cursor, "MATCH", match, "COUNT", "1000"]);
    const next = String(r?.[0] ?? "0");
    const batch = r?.[1] ?? [];
    keys.push(...batch);
    if (next === "0") break;
    cursor = next;
  }

  return keys;
}

function parseKey(key: string) {
  const m = /^twr:snap:(\d{4}-\d{2}-\d{2}):(.+)$/.exec(key);
  if (!m) return null;
  return { date: m[1], loc: m[2] };
}

function getDailyVal(snap: any, key: string, idx: number) {
  const arr = snap?.daily?.[key];
  if (!Array.isArray(arr)) return null;
  return arr[idx];
}

function extractActuals(snap: any) {
  return {
    tmax: getDailyVal(snap, "temperature_2m_max", 0),
    tmin: getDailyVal(snap, "temperature_2m_min", 0),
    wind: getDailyVal(snap, "windspeed_10m_max", 0),
    rain: getDailyVal(snap, "rain_sum", 0),
    snow: getDailyVal(snap, "snowfall_sum", 0),
  };
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const topN = Number(searchParams.get("topN") ?? 3);

    // 1. find latest date
    const keys = await scanKeys("twr:snap:*");

    const dates = new Set<string>();
    for (const k of keys) {
      const p = parseKey(k);
      if (p) dates.add(p.date);
    }

    const sortedDates = Array.from(dates).sort();
    const targetDate = sortedDates.at(-1);

    if (!targetDate) {
      return NextResponse.json({ error: "no data" });
    }

    // 2. fetch that date
    const dayKeys = await scanKeys(`twr:snap:${targetDate}:*`);

    const rows: any[] = [];

    for (const key of dayKeys) {
      const raw = await redis("GET", [key]);
      if (!raw) continue;

      const snap = JSON.parse(raw);
      const actual = extractActuals(snap);

      rows.push({
        place: snap.place?.name ?? key,
        date: targetDate,
        rain: actual.rain,
        snow: actual.snow,
        wind: actual.wind,
        tmax: actual.tmax,
        tmin: actual.tmin,
      });
    }

    // 3. compute top lists
    const top = {
      rain: rows.filter(r => r.rain != null)
        .sort((a,b)=>b.rain-a.rain).slice(0, topN)
        .map(r => ({ ...r, rain_in: mmToIn(r.rain) })),

      snow: rows.filter(r => r.snow != null)
        .sort((a,b)=>b.snow-a.snow).slice(0, topN)
        .map(r => ({ ...r, snow_in: cmToIn(r.snow) })),

      wind: rows.filter(r => r.wind != null)
        .sort((a,b)=>b.wind-a.wind).slice(0, topN)
        .map(r => ({ ...r, wind_mph: kmhToMph(r.wind) })),

      hot: rows.filter(r => r.tmax != null)
        .sort((a,b)=>b.tmax-a.tmax).slice(0, topN)
        .map(r => ({ ...r, tmax_f: cToF(r.tmax) })),

      cold: rows.filter(r => r.tmin != null)
        .sort((a,b)=>a.tmin-b.tmin).slice(0, topN)
        .map(r => ({ ...r, tmin_f: cToF(r.tmin) })),
    };

    return NextResponse.json({
      status: "ok",
      date: targetDate,
      top,
    });

  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}