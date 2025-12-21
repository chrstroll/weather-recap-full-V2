import { Redis } from "@upstash/redis";
import { normalizePlaceName } from "../../../lib/normalizePlace";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function POST(req: Request) {
  try {
    const { name, lat, lon, userId } = await req.json();

    if (typeof lat !== "number" || typeof lon !== "number" || !userId) {
      return new Response("Bad request", { status: 400 });
    }

    // round ~1km to dedupe & avoid precision noise
    const rl = Math.round(lat * 100) / 100;
    const rlo = Math.round(lon * 100) / 100;

    const fallbackName = (name as string) || "";
    const cleanName = await normalizePlaceName(rl, rlo, fallbackName);

    const placeObject = { name: cleanName, lat: rl, lon: rlo };

    // Track the user globally so snapshot job can union all user places
    await redis.sadd("twr:users", userId);

    // Per-user set
    const userPlacesKey = `twr:user:${userId}:places`;
    await redis.sadd(userPlacesKey, JSON.stringify(placeObject));

    // Legacy global set (keep, but snapshot job will no longer depend solely on it)
    await redis.sadd("twr:places", placeObject);

    return new Response("ok");
  } catch (e: any) {
    console.error("track route error:", e);
    return new Response(e?.message || "error", { status: 500 });
  }
}
