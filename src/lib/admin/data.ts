import "server-only";
import { redirect } from "next/navigation";
import { createClient, getUser } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";
import type { FloorPlan } from "@/lib/floorplan";
import { MEDIA_BUCKET, thumbPathFor } from "./media-paths";

export type Property = Database["public"]["Tables"]["properties"]["Row"];
export type Level = Database["public"]["Tables"]["levels"]["Row"];
export type PropertyKind = Database["public"]["Enums"]["property_kind"];
export type PropertyStatus = Database["public"]["Enums"]["property_status"];

export const PROPERTY_KINDS: { value: PropertyKind; label: string }[] = [
  { value: "apartment", label: "Apartment" },
  { value: "house", label: "House" },
  { value: "maisonette", label: "Maisonette" },
  { value: "studio", label: "Studio" },
  { value: "villa", label: "Villa" },
  { value: "other", label: "Other" },
];

/** Signed-in user + their organization. Redirects to /login when signed out. */
export async function requireSession() {
  const user = await getUser();
  if (!user) redirect("/login");

  const supabase = await createClient();
  const { data: membership } = await supabase
    .from("memberships")
    .select("role, organizations ( id, name )")
    .eq("user_id", user.id)
    .order("created_at")
    .limit(1)
    .single();

  if (!membership?.organizations) {
    throw new Error("Signed-in user has no organization. The signup trigger should have created one.");
  }
  return { supabase, user, org: membership.organizations, role: membership.role };
}

export async function listProperties() {
  const { supabase, org } = await requireSession();
  const { data, error } = await supabase
    .from("properties")
    .select("id, title, kind, city, area, total_area_m2, bedrooms, status, updated_at")
    .eq("org_id", org.id)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data;
}

export const isUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export async function getProperty(id: string) {
  if (!isUuid(id)) return null;
  const { supabase } = await requireSession();
  const { data, error } = await supabase
    .from("properties")
    .select("*, levels ( * )")
    .eq("id", id)
    .order("sort", { referencedTable: "levels" })
    .maybeSingle();
  if (error) throw error;
  return data;
}

const SIGNED_URL_TTL = 60 * 60; // 1 hour

/** Property + floors + photos with short-lived signed URLs for display. */
export async function getPropertyMedia(id: string) {
  if (!isUuid(id)) return null;
  const { supabase } = await requireSession();
  const { data: property, error } = await supabase
    .from("properties")
    .select("id, org_id, title, levels ( id, name, sort, floorplan_path, plan ), media ( id, kind, storage_path, level_id, hint, room_type, room_id, sort, width, height )")
    .eq("id", id)
    .order("sort", { referencedTable: "levels" })
    .order("sort", { referencedTable: "media" })
    .maybeSingle();
  if (error) throw error;
  if (!property) return null;

  const photos = property.media.filter((m) => m.kind === "photo");
  const paths = [
    ...photos.flatMap((p) => [p.storage_path, thumbPathFor(p.storage_path)]),
    ...property.levels.flatMap((l) => (l.floorplan_path ? [l.floorplan_path] : [])),
  ];

  const urls = new Map<string, string>();
  if (paths.length) {
    const { data: signed, error: signError } = await supabase.storage
      .from(MEDIA_BUCKET)
      .createSignedUrls(paths, SIGNED_URL_TTL);
    if (signError) throw signError;
    for (const s of signed ?? []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
  }

  return {
    id: property.id,
    orgId: property.org_id,
    title: property.title,
    levels: property.levels.map((l) => ({
      id: l.id,
      name: l.name,
      floorplanUrl: l.floorplan_path ? (urls.get(l.floorplan_path) ?? null) : null,
      plan: (l.plan as unknown as FloorPlan | null) ?? null,
    })),
    photos: photos.map((p) => ({
      id: p.id,
      levelId: p.level_id,
      hint: p.hint ?? "",
      roomType: p.room_type,
      roomId: p.room_id,
      thumbUrl: urls.get(thumbPathFor(p.storage_path)) ?? urls.get(p.storage_path) ?? null,
      fullUrl: urls.get(p.storage_path) ?? null,
    })),
  };
}

export type PropertyMedia = NonNullable<Awaited<ReturnType<typeof getPropertyMedia>>>;

export function defaultLevelName(index: number) {
  if (index === 0) return "Ground floor";
  const suffix = index === 1 ? "st" : index === 2 ? "nd" : index === 3 ? "rd" : "th";
  return `${index}${suffix} floor`;
}
