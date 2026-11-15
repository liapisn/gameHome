import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient, getUser } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";
import type { FloorPlan } from "@/lib/floorplan";
import type { RoomEstimate } from "@/lib/tour/estimate-room";
import { MEDIA_BUCKET, thumbPathFor } from "./media-paths";
import { ACTIVE_WORKSPACE_COOKIE } from "./workspace-cookie";

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

export type MemberRole = Database["public"]["Enums"]["member_role"];
export type Workspace = { id: string; name: string; role: MemberRole };

/** Signed-in user, the workspace they're working in, and every workspace they belong to. Redirects to /login when signed out. */
export const requireSession = cache(async () => {
  const user = await getUser();
  if (!user) redirect("/login");

  const supabase = await createClient();
  const { data: memberships, error } = await supabase
    .from("memberships")
    .select("role, organizations ( id, name )")
    .eq("user_id", user.id)
    .order("created_at");
  if (error) throw error;

  const joined: Workspace[] = (memberships ?? []).flatMap((m) =>
    m.organizations ? [{ id: m.organizations.id, name: m.organizations.name, role: m.role }] : [],
  );
  if (joined.length === 0) {
    throw new Error("Signed-in user has no workspace. The signup trigger should have created one.");
  }

  // The active workspace is the one picked in the switcher; the oldest membership otherwise.
  const picked = (await cookies()).get(ACTIVE_WORKSPACE_COOKIE)?.value;
  const active = joined.find((w) => w.id === picked) ?? joined[0];
  const workspaces = [...joined].sort((a, b) => a.name.localeCompare(b.name));

  return { supabase, user, org: { id: active.id, name: active.name }, role: active.role, workspaces };
});

/** Like requireSession, but only for owners of the active workspace. */
export async function requireOwner() {
  const session = await requireSession();
  if (session.role !== "owner") throw new Error("Only owners of this workspace can do that.");
  return session;
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
    .select("id, org_id, title, levels ( id, name, sort, floorplan_path, plan ), media ( id, kind, storage_path, level_id, hint, room_type, room_id, room_estimate, sort, width, height )")
    .eq("id", id)
    .order("sort", { referencedTable: "levels" })
    .order("sort", { referencedTable: "media" })
    .maybeSingle();
  if (error) throw error;
  if (!property) return null;

  // Each floor's latest plan read (src/workflows/read-plan.ts): shown while it runs, or if it failed.
  const { data: reads } = await supabase
    .from("jobs")
    .select("status, error, progress, created_at")
    .eq("property_id", id)
    .eq("type", "read_plan")
    .order("created_at", { ascending: false })
    .limit(50);
  const readOf = (levelId: string, path: string | null) => {
    const j = reads?.find((r) => (r.progress as { levelId?: string }).levelId === levelId);
    if (!j || (j.progress as { floorplanPath?: string }).floorplanPath !== path) return null;
    if (j.status === "queued" || j.status === "running") return { status: "reading" as const, since: j.created_at, error: null };
    if (j.status === "failed") return { status: "failed" as const, since: j.created_at, error: j.error ?? "Reading the plan failed." };
    return null;
  };

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
      read: readOf(l.id, l.floorplan_path),
    })),
    photos: photos.map((p) => ({
      id: p.id,
      levelId: p.level_id,
      hint: p.hint ?? "",
      roomType: p.room_type,
      roomId: p.room_id,
      roomEstimate: (p.room_estimate as unknown as RoomEstimate | null) ?? null,
      thumbUrl: urls.get(thumbPathFor(p.storage_path)) ?? urls.get(p.storage_path) ?? null,
      fullUrl: urls.get(p.storage_path) ?? null,
    })),
  };
}

export type PropertyMedia = NonNullable<Awaited<ReturnType<typeof getPropertyMedia>>>;

/** Default name of the floor `floor` storeys above the ground (0 = ground floor, -1 = basement). */
export function defaultLevelName(floor: number) {
  if (floor === 0) return "Ground floor";
  if (floor < 0) return floor === -1 ? "Basement" : `Basement ${-floor}`;
  const teen = floor % 100 >= 11 && floor % 100 <= 13;
  const last = floor % 10;
  const suffix = teen ? "th" : last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th";
  return `${floor}${suffix} floor`;
}
