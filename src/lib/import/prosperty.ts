import "server-only";
import { z } from "zod";
import type { PropertyKind } from "@/lib/admin/data";

/**
 * Reads a listing from theprosperty.com. Their site loads each listing from this JSON
 * endpoint, so we read that instead of the page. It's undocumented: if they change it,
 * the schema below fails loudly rather than importing half a property.
 */
const API = "https://api-marketplace.theprosperty.com/v1/listings/";

/** The listing id of a Prosperty link (`theprosperty.com/listings/16042/...`), or null. */
export function prospertyListingId(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim().startsWith("http") ? input.trim() : `https://${input.trim()}`);
  } catch {
    return null;
  }
  if (url.hostname !== "theprosperty.com" && !url.hostname.endsWith(".theprosperty.com")) return null;
  return url.pathname.match(/\/listings\/(\d{1,9})(?:\/|$)/)?.[1] ?? null;
}

const Localized = z.array(z.object({ locale: z.string(), value: z.string() }));
const Image = z.object({ id: z.number(), sizes: z.object({ xxl: z.url() }) });
const n = z.number().nullish();

const Listing = z.object({
  data: z.object({
    id: z.number(),
    aggregations: z.object({ bedrooms: n, bathrooms: n, levels: n }).partial(),
    listingInfo: z.object({
      title: Localized,
      description: Localized,
      price: z.object({ amount: n }).nullish(),
      commercializationType: z.string().nullish(),
    }),
    mediaInfo: z.object({
      images: z.object({ photos: z.array(Image).default([]), floorPlans: z.array(Image).default([]) }),
      externalMedia: z.array(z.object({ url: z.string() })).default([]),
    }),
    propertyInfo: z.object({
      type: z.string().nullish(),
      size: n,
      address: z.object({
        coordinates: z.object({ lat: z.number(), lng: z.number() }).nullish(),
        locations: z.array(z.string()).default([]),
      }),
      units: z
        .array(
          z
            .object({ bedrooms: n, bathrooms: n, floor: z.object({ numeric: n }).nullish(), energyClass: z.string().nullish() })
            .partial(),
        )
        .default([]),
      building: z.object({ buildYear: n }).partial().nullish(),
    }),
  }),
});

export interface ProspertyListing {
  id: string;
  url: string;
  title: string;
  kind: PropertyKind;
  city: string | null;
  area: string | null;
  lat: number | null;
  lng: number | null;
  totalAreaM2: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  levels: number;
  description: string | null;
  /** Largest size Prosperty serves (3744 px wide), in listing order. */
  photoUrls: string[];
  floorplanUrls: string[];
  /** Useful, but no column for it yet. */
  extras: { price: number | null; floor: number | null; buildYear: number | null; energyClass: string | null; tourUrl: string | null };
}

const KINDS: Record<string, PropertyKind> = {
  apartment: "apartment",
  flat: "apartment",
  studio: "studio",
  maisonette: "maisonette",
  house: "house",
  detachedHouse: "house",
  villa: "villa",
};

const pick = (texts: z.infer<typeof Localized>, locale: string) =>
  (texts.find((t) => t.locale === locale) ?? texts[0])?.value.trim() || null;

/** `piraeus-suburbs-nikaia-aspra-chomata` under `piraeus-suburbs-nikaia` → "Aspra Chomata". */
function placeName(slug: string | undefined, parent: string | undefined): string | null {
  if (!slug) return null;
  const own = parent && slug.startsWith(`${parent}-`) ? slug.slice(parent.length + 1) : slug;
  return own
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export async function fetchProspertyListing(id: string, locale = "en"): Promise<ProspertyListing> {
  const res = await fetch(`${API}${encodeURIComponent(id)}`, {
    headers: { accept: "application/json", "accept-language": locale },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) throw new Error("Prosperty has no listing with that link.");
  if (!res.ok) throw new Error(`Prosperty answered ${res.status}. Try again in a moment.`);
  const parsed = Listing.safeParse(await res.json());
  if (!parsed.success) throw new Error("Prosperty's listing format has changed; the importer needs updating.");

  const { aggregations: agg, listingInfo, mediaInfo, propertyInfo: info } = parsed.data.data;
  const unit = info.units[0] ?? {};
  // locations run from region to neighbourhood: [region, region-city, region-city-area]
  const [, cityPath, areaPath] = info.address.locations;
  const regionPath = info.address.locations[0];

  return {
    id,
    url: `https://theprosperty.com/listings/${id}`,
    title: pick(listingInfo.title, locale) ?? `Prosperty listing ${id}`,
    kind: KINDS[info.type ?? ""] ?? "other",
    city: placeName(cityPath, regionPath),
    area: placeName(areaPath, cityPath),
    lat: info.address.coordinates?.lat ?? null,
    lng: info.address.coordinates?.lng ?? null,
    totalAreaM2: info.size ?? null,
    bedrooms: agg.bedrooms ?? unit.bedrooms ?? null,
    bathrooms: agg.bathrooms ?? unit.bathrooms ?? null,
    levels: Math.min(10, Math.max(1, agg.levels ?? 1)),
    description: pick(listingInfo.description, locale),
    photoUrls: mediaInfo.images.photos.map((p) => p.sizes.xxl),
    floorplanUrls: mediaInfo.images.floorPlans.map((p) => p.sizes.xxl),
    extras: {
      price: listingInfo.price?.amount ?? null,
      floor: unit.floor?.numeric ?? null,
      buildYear: info.building?.buildYear ?? null,
      energyClass: unit.energyClass?.toUpperCase() ?? null,
      tourUrl: mediaInfo.externalMedia.find((m) => /matterport/.test(m.url))?.url ?? null,
    },
  };
}
