// app/api/admin/normalize-places/route.ts
import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

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

function tryParsePlace(raw: any): Place | null {
  let obj: any = raw;

  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (!obj) return null;

  const name = typeof obj.name === "string" ? obj.name : "";
  const lat = Number(obj.lat);
  const lon = Number(obj.lon);

  if (!name || Number.isNaN(lat) || Number.isNaN(lon)) return null;

  return { name: name.trim(), lat, lon };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token") || "";

    if (!process.env.ADMIN_TOKEN) {
      return NextResponse.json(
        { error: "ADMIN_TOKEN is not set on server" },
        { status: 500 }
      );
    }

    if (token !== process.env.ADMIN_TOKEN) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userIds = ((await redis.smembers("twr:users")) as string[]) || [];
    if (userIds.length === 0) {
      return NextResponse.json({
        status: "ok",
        message: "No users found in twr:users",
        usersProcessed: 0,
        placesProcessed: 0,
        placesUpdated: 0,
        placesEnrolledGlobal: 0,
      });
    }

    let usersProcessed = 0;
    let placesProcessed = 0;
    let placesUpdated = 0;
    let placesEnrolledGlobal = 0;

    for (const uid of userIds) {
      const userPlacesKey = `twr:user:${uid}:places`;
      const rawPlaces = (await redis.smembers(userPlacesKey)) as any[];

      if (!rawPlaces || rawPlaces.length === 0) {
        usersProcessed++;
        continue;
      }

      // Build normalized set for this user (dedupe by lat/lon after rounding)
      const normalizedMap = new Map<string, Place>();

      for (const raw of rawPlaces) {
        const p = tryParsePlace(raw);
        if (!p) continue;

        placesProcessed++;

        const nlat = round2(p.lat);
        const nlon = round2(p.lon);

        // Track if we changed coords
        if (nlat !== p.lat || nlon !== p.lon) {
          placesUpdated++;
        }

        const key = `${nlat},${nlon}`;
        // Keep the latest name we saw for that coordinate
        normalizedMap.set(key, { name: p.name, lat: nlat, lon: nlon });
      }

      const normalizedPlaces = Array.from(normalizedMap.values());

      // Rewrite user set safely:
      // - delete the set
      // - re-add normalized JSON
      // NOTE: This is safe because we are reconstructing from what was already there.
      await redis.del(userPlacesKey);

      if (normalizedPlaces.length > 0) {
        await Promise.all(
          normalizedPlaces.map((p) =>
            redis.sadd(userPlacesKey, JSON.stringify(p))
          )
        );

        // Ensure they are enrolled in global places set for snapshotting
        const addResults = await Promise.all(
          normalizedPlaces.map((p) => redis.sadd("twr:places", p))
        );

        // Upstash returns number of elements added (0 or 1 typically)
        for (const r of addResults as any[]) {
          if (typeof r === "number") placesEnrolledGlobal += r;
        }
      }

      usersProcessed++;
    }

    return NextResponse.json({
      status: "ok",
      usersProcessed,
      placesProcessed,
      placesUpdated,
      placesEnrolledGlobal,
      note: "Now run /api/snapshot once to seed today’s snapshots for any newly enrolled places.",
    });
  } catch (e: any) {
    console.error("normalize-places error:", e);
    return NextResponse.json(
      { error: "normalize-failed", detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}
